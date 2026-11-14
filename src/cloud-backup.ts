/** Cloud orchestration: reads only the encrypted vault document, never exports plaintext. */
import { readFile, stat, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { uploadCloudBackup, validateCloudBackupSettings } from './cloud-backup-providers.ts'
import type { CloudBackupSettings, CloudBackupSnapshot, CloudBackupTarget, CloudBackupTargetStatus, CloudBackupUploadResult, CloudBackupView } from './cloud-backup-types.ts'

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024
const CHANGE_DELAY_MS = 2000
const RUN_TIMEOUT_MS = 120000

export function cloudBackupConfigPath(vaultPath: string): string {
  const id = createHash('sha256').update(resolve(vaultPath)).digest('hex').slice(0, 24)
  return join(dirname(vaultPath), '.cloud-backup', id + '.json')
}

/** Serialized vault file lifecycle for cloud configuration and owned timers. */
type CloudVaultObserver = (phase: 'pause' | 'resume', paths: string[]) => Promise<void>
const lifecycleObservers = new Set<CloudVaultObserver>()
let lifecycleChain: Promise<unknown> = Promise.resolve()
export function onCloudVaultLifecycle(observer: CloudVaultObserver): () => void {
  lifecycleObservers.add(observer)
  return () => { lifecycleObservers.delete(observer) }
}

/** Rename migrates opt-in; deletion revokes opt-in. Remote snapshots are never deleted here. */
export function changeCloudBackupVault(source: string, target: string | undefined, mutate: () => Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    const paths = [resolve(source), ...(target === undefined ? [] : [resolve(target)])]
    const observers = [...lifecycleObservers]
    const sourceConfig = cloudBackupConfigPath(source)
    const targetConfig = target === undefined ? undefined : cloudBackupConfigPath(target)
    let moved = false
    let sourceRaw: string | undefined
    try {
      for (const observer of observers) await observer('pause', paths)
      try { sourceRaw = await readFile(sourceConfig, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (targetConfig !== undefined) {
        try { await stat(targetConfig); throw new Error('Cloud backup destination settings already exist; remove them before renaming.') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (sourceRaw !== undefined) { await rename(sourceConfig, targetConfig); moved = true }
      } else if (sourceRaw !== undefined) {
        await unlink(sourceConfig)
      }
      try { await mutate() } catch (error) {
        if (moved && targetConfig !== undefined) await rename(targetConfig, sourceConfig)
        else if (targetConfig === undefined && sourceRaw !== undefined) await writeFileAtomic(sourceConfig, sourceRaw, { mode: 0o600, dirMode: 0o700 })
        throw error
      }
    } finally {
      const results = await Promise.allSettled(observers.map(observer => observer('resume', paths)))
      if (results.some(result => result.status === 'rejected')) throw new Error('Cloud backup lifecycle could not fully resume; restart the DSH host before further vault changes.')
    }
  }
  const work = lifecycleChain.then(run, run)
  lifecycleChain = work.catch(() => {})
  return work
}

export async function readCloudBackupSnapshot(vaultPath: string): Promise<CloudBackupSnapshot> {
  try {
    if ((await stat(vaultPath)).size > MAX_SNAPSHOT_BYTES) throw new Error('size')
    const data = await readFile(vaultPath, 'utf8')
    if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) throw new Error('size')
    const parsed = JSON.parse(data) as { version?: number; kdf?: { algo?: string; saltHex?: string }; entries?: unknown[]; verify?: unknown }
    if (parsed.version !== 1 || parsed.kdf?.algo !== 'scrypt' || typeof parsed.kdf.saltHex !== 'string'
      || !/^[a-f0-9]{32}$/i.test(parsed.kdf.saltHex) || !Array.isArray(parsed.entries) || !parsed.verify) throw new Error('format')
    const vaultId = 'vault-' + createHash('sha256').update(parsed.kdf.saltHex).digest('hex').slice(0, 24)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return { vaultId, filename: 'snapshot-' + stamp + '-' + randomUUID() + '.json', data }
  } catch {
    throw new Error('Cloud backup could not read a valid encrypted vault snapshot (maximum 20 MiB).')
  }
}

interface ManagerOptions {
  load: () => Promise<unknown>
  save: (settings: CloudBackupSettings) => Promise<void>
  snapshot: () => Promise<CloudBackupSnapshot>
  canRun: () => boolean | Promise<boolean>
  upload?: (target: CloudBackupTarget, snapshot: CloudBackupSnapshot, retention: number, signal: AbortSignal) => Promise<CloudBackupUploadResult>
}

export class CloudBackupManager {
  private settings: CloudBackupSettings = { enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] }
  private readonly statuses = new Map<string, CloudBackupTargetStatus>()
  private readonly ready: Promise<void>
  private intervalTimer: ReturnType<typeof setTimeout> | undefined
  private changeTimer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<CloudBackupView> | undefined
  private controller: AbortController | undefined
  private stopped = false
  private revision = 0
  private dirty = false
  private updating = false
  private nextRunAt: number | undefined
  private lastRunAt: number | undefined
  private warning: string | undefined
  private updateChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ManagerOptions) { this.ready = this.load() }

  private async load(): Promise<void> {
    try { this.settings = validateCloudBackupSettings(await this.options.load()) }
    catch { this.warning = 'Cloud backup configuration could not be loaded. Automation is disabled; save valid settings to recover.' }
    this.resetStatuses()
    this.scheduleInterval()
  }

  private resetStatuses(): void {
    this.statuses.clear()
    for (const target of this.settings.targets) this.statuses.set(target.id, { id: target.id, provider: target.provider, state: 'idle' })
  }

  private view(): CloudBackupView {
    return structuredClone({ config: this.settings, statuses: [...this.statuses.values()], running: this.pending !== undefined,
      ...(this.lastRunAt !== undefined ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.nextRunAt !== undefined ? { nextRunAt: this.nextRunAt } : {}),
      ...(this.warning !== undefined ? { warning: this.warning } : {}) })
  }

  async status(): Promise<CloudBackupView> { await this.ready; await this.updateChain; return this.view() }

  async configure(input: unknown): Promise<CloudBackupView> {
    const settings = validateCloudBackupSettings(input)
    const update = async (): Promise<CloudBackupView> => {
      await this.ready
      if (this.stopped) throw new Error('Cloud backup manager has stopped.')
      this.updating = true
      this.revision++
      // Preserve already queued writes; commit decides whether on-change remains authorized.
      this.clearTimers()
      this.controller?.abort()
      try {
        if (this.pending) await this.pending
        try { await this.options.save(settings) } catch { throw new Error('Cloud backup settings could not be saved.') }
        this.clearTimers()
        this.settings = structuredClone(settings)
        this.warning = undefined
        this.resetStatuses()
      } finally {
        this.updating = false
        this.scheduleInterval()
        if (this.dirty) this.armChange()
      }
      return this.view()
    }
    const result = this.updateChain.then(update, update)
    this.updateChain = result.catch(() => {})
    return result
  }

  /** Every successful atomic vault write, not only GUI add/update/delete. */
  notifyChange(): void {
    void this.ready.then(() => {
      if (this.stopped) return
      if (this.updating) { this.dirty = true; return }
      if (!this.settings.enabled || !this.settings.onChange) return
      this.dirty = true
      this.armChange()
    }).catch(() => {})
  }

  private armChange(): void {
    if (this.stopped || this.updating || !this.settings.enabled || !this.settings.onChange || this.pending || this.changeTimer) return
    const revision = this.revision
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      if (revision === this.revision && this.settings.onChange) void this.run(false, revision, 'change').catch(() => {})
    }, CHANGE_DELAY_MS)
    this.changeTimer.unref?.()
  }

  private scheduleInterval(): void {
    if (this.intervalTimer) clearTimeout(this.intervalTimer)
    this.intervalTimer = undefined
    this.nextRunAt = undefined
    if (this.stopped || !this.settings.enabled || this.settings.intervalMinutes === 0
      || !this.settings.targets.some(t => t.enabled)) return
    const delay = this.settings.intervalMinutes * 60000
    this.nextRunAt = Date.now() + delay
    const revision = this.revision
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = undefined
      this.nextRunAt = undefined
      if (revision === this.revision && this.settings.intervalMinutes > 0) void this.run(false, revision, 'interval').catch(() => {})
    }, delay)
    this.intervalTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.intervalTimer) clearTimeout(this.intervalTimer)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.intervalTimer = undefined
    this.changeTimer = undefined
    this.nextRunAt = undefined
  }

  async run(manual = true, expectedRevision?: number, trigger?: 'change' | 'interval'): Promise<CloudBackupView> {
    await this.ready
    await this.updateChain
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return this.view()
    if (this.stopped) throw new Error('Cloud backup manager has stopped.')
    if (this.pending) return this.pending
    if (!this.settings.enabled || !this.settings.targets.some(t => t.enabled)) {
      if (manual) throw new Error('Cloud backup is disabled or has no enabled target. Save an enabled configuration first.')
      this.scheduleInterval()
      return this.view()
    }
    if (!await this.options.canRun()) {
      this.warning = 'Cloud backup is paused in readonly mode.'
      this.scheduleInterval()
      if (manual) throw new Error('Cloud backup upload is disabled in readonly mode.')
      return this.view()
    }
    // The timer's authority must still match after every awaited prerequisite.
    await this.updateChain
    if (expectedRevision !== undefined && (expectedRevision !== this.revision
      || (trigger === 'change' && !this.settings.onChange) || (trigger === 'interval' && this.settings.intervalMinutes === 0))) return this.view()
    if (this.pending) return this.pending
    if (this.stopped) throw new Error('Cloud backup manager has stopped.')
    if (!this.settings.enabled) throw new Error('Cloud backup is disabled.')
    this.clearTimers()
    this.dirty = false
    const revision = this.revision
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
    timeout.unref?.()
    const work = this.perform(controller.signal, revision).finally(() => {
      clearTimeout(timeout)
      this.pending = undefined
      this.controller = undefined
      if (!this.stopped && this.revision === revision) {
        this.scheduleInterval()
        if (this.dirty) this.notifyChange()
      }
    }).then(() => this.view())
    this.pending = work
    return work
  }

  private async perform(signal: AbortSignal, revision: number): Promise<void> {
    this.lastRunAt = Date.now()
    this.warning = undefined
    const targets = this.settings.targets.filter(t => t.enabled)
    let snapshot: CloudBackupSnapshot
    try { snapshot = await this.options.snapshot() } catch {
      for (const target of targets) this.statuses.set(target.id, { id: target.id, provider: target.provider, state: 'error', lastAttemptAt: Date.now(), lastError: 'Cloud backup could not read a valid encrypted vault snapshot (maximum 20 MiB).' })
      return
    }
    const upload = this.options.upload ?? ((target, data, retention, currentSignal) => uploadCloudBackup(target, data, retention, { signal: currentSignal }))
    for (const target of targets) {
      if (signal.aborted || this.stopped || revision !== this.revision) return
      const previous = this.statuses.get(target.id)
      const base = { id: target.id, provider: target.provider, lastAttemptAt: Date.now(),
        ...(previous?.lastSuccessAt !== undefined ? { lastSuccessAt: previous.lastSuccessAt } : {}) }
      this.statuses.set(target.id, { ...base, state: 'running' })
      try {
        const result = await upload(target, snapshot, this.settings.retention, signal)
        if (revision !== this.revision || this.stopped) return
        this.statuses.set(target.id, { ...base, state: 'success', lastSuccessAt: Date.now(), lastObjectKey: result.objectKey,
          ...(result.warning !== undefined ? { warning: result.warning } : {}) })
      } catch {
        if (revision !== this.revision || this.stopped) return
        this.statuses.set(target.id, { ...base, state: 'error', lastError: 'Cloud backup upload failed. Check credential environment variables, private repository or bucket permissions, endpoint and connectivity; retry here.' })
      }
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.revision++
    this.clearTimers()
    this.controller?.abort()
    await this.ready
    await this.updateChain
    if (this.pending) await this.pending
  }
}

export function createCloudBackupManager(vaultPath: string, canRun: () => boolean | Promise<boolean>): CloudBackupManager {
  const configPath = cloudBackupConfigPath(vaultPath)
  return new CloudBackupManager({ canRun,
    load: async () => {
      try {
        if ((await stat(configPath)).size > 65536) throw new Error('size')
        return JSON.parse(await readFile(configPath, 'utf8')) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    save: async settings => { await writeFileAtomic(configPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 }) },
    snapshot: () => readCloudBackupSnapshot(vaultPath),
  })
}
