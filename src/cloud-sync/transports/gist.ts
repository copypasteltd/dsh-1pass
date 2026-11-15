/** Gist transport adapted from dsh-config-manager 0.8.2 (MIT), see LICENSE.reference. */
import type { VaultSyncMeta, VaultSyncSnapshot, VaultSyncTransport } from '../types.ts'
import { assertExpectedHead, canonical, checkedDownload, fail, metaFromSnapshot, parseIndex, parseJson, record, safeId, safePrefix, serializeIndex, text, validateSnapshot } from './documents.ts'
import { endpoint, request, secret, success } from './http.ts'
import type { HostTransportOptions } from './http.ts'

type GistState = { files: Record<string, unknown>; entries: VaultSyncMeta[]; missing: boolean; public: boolean }
const WARNING = 'WARNING: Gist PATCH has no atomic CAS (no If-Match headers). Post-write GET verifies all observed entries, up to 3 cycles. Writes unseen between GET and PATCH can still be lost. Gist history retains encrypted content.'
export class GistTransport implements VaultSyncTransport {
  readonly type = 'gist' as const
  private readonly url: URL
  private readonly prefix: string
  private readonly indexName: string
  private seenContent = false
  constructor(private readonly o: HostTransportOptions) {
    const id = text(o.config.gistId, 128)
    if (!/^[a-fA-F0-9]{1,128}$/.test(id)) fail('invalid-config', 'Invalid Gist id.')
    const base = endpoint(o.config.apiBaseUrl ?? 'https://api.github.com', o)
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    this.url = new URL('gists/' + id, base)
    this.prefix = safePrefix(o.config.filePrefix ?? '1pass')
    if (this.prefix.includes('/')) fail('invalid-config', 'Gist prefix must be a single safe filename component.')
    this.indexName = this.prefix + '-index.json'
  }
  private name(id: string): string { return this.prefix + '-' + safeId(id) + '.json' }
  private async headers(): Promise<Record<string, string>> {
    return { authorization: 'Bearer ' + await secret(this.o), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  }
  private async file(files: Record<string, unknown>, name: string): Promise<string> {
    if (!Object.hasOwn(files, name)) fail('not-found', 'Gist vault document is missing.')
    const f = record(files[name])
    if (f.truncated === true) {
      const url = endpoint(f.raw_url, this.o, true)
      // Never send a token to raw content. Limit server-chosen raw targets to the API origin or GitHub raw host.
      if (url.origin !== this.url.origin && url.hostname !== 'gist.githubusercontent.com') fail('unsafe-redirect', 'Unapproved Gist raw content origin.')
      const r = await request(this.o, 'GET', url)
      success(r, 'Read Gist raw vault document')
      return r.body
    }
    if (typeof f.content !== 'string') fail('invalid-document', 'Gist file has no complete content.')
    return f.content
  }
  private async read(): Promise<GistState> {
    const r = await request(this.o, 'GET', this.url, await this.headers())
    success(r, 'Read Gist')
    const data = record(parseJson(r.body))
    if (data.truncated === true || typeof data.public !== 'boolean') fail('invalid-document', 'Incomplete or invalid Gist metadata.')
    const files = record(data.files)
    if (Object.keys(files).length > 5002) fail('size-limit', 'Gist exceeds vault file-count limit.')
    const missing = !Object.hasOwn(files, this.indexName)
    const entries = missing ? [] : parseIndex(await this.file(files, this.indexName), this.type)
    if (!missing) this.seenContent = true
    return { files, entries, missing, public: data.public }
  }
  private assertWritable(state: GistState): void {
    if (state.missing && (this.seenContent || Object.keys(state.files).some(k => k.startsWith(this.prefix + '-') && k.endsWith('.json')))) fail('index-missing-with-content', 'Gist vault index is missing after prior content; repair before writing or deleting.')
  }
  async list(): Promise<VaultSyncMeta[]> { return (await this.read()).entries }
  async download(value: string): Promise<VaultSyncSnapshot> {
    const id = safeId(value)
    const state = await this.read()
    const meta = state.entries.find(m => m.id === id)
    if (!meta) fail('not-found', 'Snapshot is not in the authoritative Gist vault index.')
    return checkedDownload(await this.file(state.files, this.name(id)), id, meta, this.type)
  }
  async upload(value: VaultSyncSnapshot, expectedHead?: string): Promise<VaultSyncMeta> {
    const snapshot = validateSnapshot(parseJson(canonical(validateSnapshot(value, this.type))), this.type)
    const meta = metaFromSnapshot(snapshot)
    const raw = canonical(snapshot)
    await this.mutate(snapshot.id, meta, raw, expectedHead)
    return meta
  }
  async delete(value: string): Promise<void> { await this.mutate(safeId(value)) }
  private async mutate(id: string, added?: VaultSyncMeta, raw?: string, expectedHead?: string): Promise<void> {
    const observed = new Map<string, VaultSyncMeta>()
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.read()
      assertExpectedHead(before.entries, expectedHead)
      this.assertWritable(before)
      const sameId = before.entries.find(m => m.id === id)
      if (added && sameId && canonical(sameId) !== canonical(added)) fail('snapshot-id-conflict', 'Snapshot id already names different Gist content.')
      if (added && Object.hasOwn(before.files, this.name(id))) checkedDownload(await this.file(before.files, this.name(id)), id, added, this.type)
      for (const m of before.entries) {
        const prior = observed.get(m.id)
        if (prior && canonical(prior) !== canonical(m)) fail('index-conflict', 'Previously observed Gist metadata changed concurrently.')
        observed.set(m.id, m)
      }
      if (added && sameId && attempt === 0) {
        checkedDownload(await this.file(before.files, this.name(id)), id, added, this.type)
        return
      }
      if (!added && !sameId && attempt === 0) return
      const expected = [...observed.values()].filter(m => m.id !== id)
      if (added) expected.push(added)
      const index = serializeIndex(expected, this.type)
      const files = { [this.indexName]: { content: index }, [this.name(id)]: added ? { content: raw! } : null }
      // Gist rejects conditional headers on PATCH; do not imply atomicity by adding fake CAS.
      success(await request(this.o, 'PATCH', this.url, { ...await this.headers(), 'content-type': 'application/json' }, canonical({ files })), 'Write Gist vault documents')
      const after = await this.read()
      if (after.missing) continue
      const actual = new Map(after.entries.map(m => [m.id, canonical(m)]))
      const preserved = expected.every(m => actual.get(m.id) === canonical(m) && Object.hasOwn(after.files, this.name(m.id)))
      if (preserved && (added ? actual.get(id) === canonical(added) : !actual.has(id) && !Object.hasOwn(after.files, this.name(id)))) {
        if (added) checkedDownload(await this.file(after.files, this.name(id)), id, added, this.type)
        return
      }
    }
    fail('index-conflict', 'Gist post-write verification failed after 3 cycles. Concurrent loss remains possible; inspect remote state before retrying.')
  }
  async probe(): Promise<{ message: string; hint: string; snapshotCount: number }> {
    const state = await this.read()
    return { message: 'Gist is readable; write permission has not been verified.', hint: WARNING + (state.public ? ' This Gist is PUBLIC; private storage is recommended even for encrypted data.' : ''), snapshotCount: state.entries.length }
  }
}
