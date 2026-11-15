/** GUI-only preview capabilities. Source/passwords never go into metadata, logs, or preview JSON. */
import { randomUUID } from 'node:crypto'
import { parseQuickImport, type QuickImportEntry, type QuickImportOptions } from './quick-import.ts'
import type { QuickImportCommitResult, QuickImportPreview, QuickImportPreviewRow } from './quick-import-types.ts'

interface ImportContext {
  identity: object
  path: string
  vaultName: string
  entries: Array<{ kind?: string; title: string; username?: string; host?: string; ip?: string; port?: string }>
  write(entries: QuickImportEntry[]): Promise<boolean[]>
}
interface Session {
  token: string; expiresAt: number; context: ImportContext
  entries: Map<number, QuickImportEntry>; lines: Set<number>
  signature?: string; pending?: Promise<QuickImportCommitResult> | undefined; result?: QuickImportCommitResult
}
export function quickImportIdentity(entry: { kind?: string; username?: string; host?: string; ip?: string; port?: string }): string {
  return JSON.stringify([entry.kind ?? 'login', entry.username ?? '', (entry.host ?? '').toLowerCase(), (entry.ip ?? '').toLowerCase(), String(entry.port || (entry.kind === 'ssh' ? '22' : ''))])
}

export class QuickImportSessions {
  private session: Session | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private generation = 0
  private runningCommit: Promise<QuickImportCommitResult> | undefined
  constructor(private readonly context: (write: boolean) => Promise<ImportContext>, private readonly now: () => number = Date.now) {}

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.session?.entries.clear()
    this.session = undefined
  }
  /** Lock/switch/unload revokes pending previews before any later re-unlock. */
  revoke(): void { this.generation++; this.clear() }
  discard(token: string): { discarded: boolean } {
    if (this.session?.token !== token || this.session.pending) return { discarded: false }
    this.generation++
    this.clear(); return { discarded: true }
  }
  async preview(text: string, options: QuickImportOptions): Promise<QuickImportPreview> {
    if (this.disposed) throw new Error('QUICK_IMPORT_UNAVAILABLE')
    if (this.runningCommit) throw new Error('QUICK_IMPORT_BUSY')
    const generation = ++this.generation
    const parsed = parseQuickImport(text, options)
    const context = await this.context(false)
    if (this.disposed || generation !== this.generation) throw new Error('QUICK_IMPORT_UNAVAILABLE')
    if (this.runningCommit) throw new Error('QUICK_IMPORT_BUSY')
    this.clear()
    const existing = new Set(context.entries.map(quickImportIdentity))
    const incoming = new Set<string>()
    const entries = new Map<number, QuickImportEntry>()
    let duplicates = 0
    const rows: QuickImportPreviewRow[] = parsed.rows.map(row => {
      if (!row.entry) return { line: row.line, status: 'invalid', ...(row.error ? { error: row.error } : {}) }
      const entry = row.entry
      const key = quickImportIdentity(entry)
      const duplicate = existing.has(key) || incoming.has(key)
      incoming.add(key)
      if (duplicate) duplicates++
      else entries.set(row.line, entry)
      return { line: row.line, title: entry.title, username: entry.username, host: entry.host,
        ...(entry.ip !== undefined ? { ip: entry.ip } : {}), ...(entry.port !== undefined ? { port: entry.port } : {}),
        tags: [...entry.tags], hasPassword: entry.password.length > 0, status: duplicate ? 'duplicate' : 'ready',
        ...(row.warning ? { warning: row.warning } : {}) }
    })
    const token = randomUUID()
    const expiresAt = this.now() + 5 * 60000
    this.session = { token, expiresAt, context, entries, lines: new Set(entries.keys()) }
    this.timer = setTimeout(() => { if (!this.session?.pending) this.clear() }, 5 * 60000)
    this.timer.unref?.()
    return { token, expiresAt, vaultName: context.vaultName, rows, valid: entries.size, invalid: parsed.invalid, duplicates, ignored: parsed.ignored }
  }

  async commit(token: string, selected: number[], confirm: boolean): Promise<QuickImportCommitResult> {
    if (this.disposed) throw new Error('QUICK_IMPORT_UNAVAILABLE')
    const session = this.session
    if (typeof token !== 'string' || token.length > 64 || !session || token !== session.token || this.now() >= session.expiresAt) {
      if (session && this.now() >= session.expiresAt && !session.pending) this.clear()
      throw new Error('QUICK_IMPORT_PREVIEW_EXPIRED')
    }
    if (confirm !== true) throw new Error('QUICK_IMPORT_CONFIRM_REQUIRED')
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > 500
      || selected.some(line => !Number.isSafeInteger(line) || !session.lines.has(line)) || new Set(selected).size !== selected.length) throw new Error('QUICK_IMPORT_INVALID_SELECTION')
    const lines = [...selected].sort((a, b) => a - b)
    const signature = JSON.stringify(lines)
    if (session.signature !== undefined && signature !== session.signature) throw new Error('QUICK_IMPORT_SELECTION_CHANGED')
    // Authorization/lock/vault affinity are rechecked even for a cached result.
    const context = await this.context(true)
    if (this.disposed || this.session !== session || this.now() >= session.expiresAt) throw new Error('QUICK_IMPORT_PREVIEW_EXPIRED')
    if (context.identity !== session.context.identity || context.path !== session.context.path) throw new Error('QUICK_IMPORT_VAULT_CHANGED')
    if (session.signature !== undefined && signature !== session.signature) throw new Error('QUICK_IMPORT_SELECTION_CHANGED')
    if (session.result) return structuredClone(session.result)
    if (session.pending) return session.pending
    session.signature = signature
    const work = async (): Promise<QuickImportCommitResult> => {
      const existing = new Set(context.entries.map(quickImportIdentity))
      const patches: QuickImportEntry[] = []
      const outcomes: QuickImportCommitResult['lines'] = []
      for (const line of lines) {
        const entry = session.entries.get(line)
        if (!entry) throw new Error('QUICK_IMPORT_INVALID_SELECTION')
        const key = quickImportIdentity(entry)
        if (existing.has(key)) outcomes.push({ line, status: 'skipped' })
        else { existing.add(key); patches.push(entry); outcomes.push({ line, status: 'added' }) }
      }
      let written: boolean[]
      try { written = await context.write(patches) }
      catch { throw new Error('QUICK_IMPORT_WRITE_FAILED') }
      let index = 0
      for (const outcome of outcomes) {
        if (outcome.status === 'added' && written[index++] !== true) outcome.status = 'skipped'
      }
      const added = outcomes.filter(row => row.status === 'added').length
      const result: QuickImportCommitResult = { added, skipped: outcomes.length - added, lines: outcomes, note: 'QUICK_IMPORT_COMPLETE' }
      session.result = result
      // Retain only idempotency result, not submitted password values, after commit.
      session.entries.clear()
      return structuredClone(result)
    }
    const pending = work().finally(() => { session.pending = undefined; this.runningCommit = undefined; if (this.session === session && this.now() >= session.expiresAt) this.clear() })
    session.pending = pending
    this.runningCommit = pending
    return pending
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    const pending = this.runningCommit
    if (pending) await pending.catch(() => {})
    this.clear()
  }
}
