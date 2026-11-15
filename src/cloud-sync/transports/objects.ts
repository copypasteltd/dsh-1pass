/** WebDAV/S3 index-last upload and conditional index mutations. See LICENSE.reference. */
import type { VaultSyncChannel, VaultSyncMeta, VaultSyncSnapshot, VaultSyncTransport } from '../types.ts'
import { assertExpectedHead, canonical, checkedDownload, fail, metaFromSnapshot, parseIndex, parseJson, safeId, serializeIndex, validateSnapshot } from './documents.ts'
import { success } from './http.ts'
import type { Reply } from './http.ts'

export const MARKER = 'content-present.json'
const MARKER_BODY = '{"format":"1pass-vault-content-present-v1"}'
export interface IndexState { entries: VaultSyncMeta[]; missing: boolean; etag?: string }
export abstract class ObjectTransport implements VaultSyncTransport {
  abstract readonly type: VaultSyncChannel
  protected noEtag = false
  protected seenContent = false
  protected abstract send(method: string, key: string, headers?: Record<string, string>, body?: string): Promise<Reply>
  protected abstract condition(index: IndexState): Record<string, string>
  protected abstract snapshotCondition(): Record<string, string>
  protected async prepare(): Promise<string[]> { return [] }
  protected async beforeIndexWrite(_index: IndexState): Promise<void> {}
  protected abstract hint(): string
  protected async readIndex(): Promise<IndexState> {
    const r = await this.send('GET', 'index.json')
    if (r.status === 404) return { entries: [], missing: true }
    success(r, 'Read vault index')
    const entries = parseIndex(r.body, this.type)
    this.seenContent = true
    const etag = r.headers.get('etag') || undefined
    if (!etag || etag.startsWith('W/')) this.noEtag = true
    return { entries, missing: false, ...(etag && !etag.startsWith('W/') ? { etag } : {}) }
  }
  /** The durable marker is written BEFORE snapshot bytes and is never deleted by this transport. */
  protected async assertWritable(index: IndexState): Promise<void> {
    if (!index.missing) return
    const marker = await this.send('GET', MARKER)
    if (this.seenContent || marker.status !== 404) fail('index-missing-with-content', 'Vault index is missing after prior content; repair the remote index before writing or deleting.')
  }
  async list(): Promise<VaultSyncMeta[]> { return (await this.readIndex()).entries }
  async upload(value: VaultSyncSnapshot, expectedHead?: string): Promise<VaultSyncMeta> {
    const snapshot = validateSnapshot(parseJson(canonical(validateSnapshot(value, this.type))), this.type)
    const meta = metaFromSnapshot(snapshot)
    const raw = canonical(snapshot)
    // Validate merged index limits before putting any remote content.
    const before = await this.readIndex()
    assertExpectedHead(before.entries, expectedHead)
    await this.assertWritable(before)
    const existing = before.entries.find(m => m.id === meta.id)
    if (existing) {
      if (canonical(existing) !== canonical(meta)) fail('snapshot-id-conflict', 'Snapshot id already names different content; create a unique id.')
      await this.download(meta.id)
      return meta
    }
    const indexBody = serializeIndex([...before.entries, meta], this.type)
    await this.prepare()
    success(await this.send('PUT', MARKER, { 'content-type': 'application/json' }, MARKER_BODY), 'Write vault content marker')
    const put = await this.send('PUT', safeId(meta.id) + '.json', { 'content-type': 'application/json', ...this.snapshotCondition() }, raw)
    if (put.status === 409 || put.status === 412) {
      const prior = await this.send('GET', meta.id + '.json')
      success(prior, 'Read existing snapshot')
      checkedDownload(prior.body, meta.id, meta, this.type)
    } else success(put, 'Upload encrypted vault snapshot')
    await this.beforeIndexWrite(before)
    success(await this.send('PUT', 'index.json', { 'content-type': 'application/json', ...this.condition(before) }, indexBody), 'Write vault index')
    this.seenContent = true
    return meta
  }
  async download(value: string): Promise<VaultSyncSnapshot> {
    const id = safeId(value)
    const index = await this.readIndex()
    const meta = index.entries.find(m => m.id === id)
    if (!meta) fail('not-found', 'Snapshot is not in the authoritative vault index.')
    const r = await this.send('GET', id + '.json')
    success(r, 'Download encrypted vault snapshot')
    return checkedDownload(r.body, id, meta, this.type)
  }
  async delete(value: string): Promise<void> {
    const id = safeId(value)
    const before = await this.readIndex()
    await this.assertWritable(before)
    if (!before.entries.some(m => m.id === id)) return
    const remaining = serializeIndex(before.entries.filter(m => m.id !== id), this.type)
    await this.beforeIndexWrite(before)
    // Remove the authoritative reference before the object; CAS failure must not destroy its bytes.
    success(await this.send('PUT', 'index.json', { 'content-type': 'application/json', ...this.condition(before) }, remaining), 'Remove vault index entry')
    const r = await this.send('DELETE', id + '.json')
    if (r.status !== 404) success(r, 'Delete encrypted vault snapshot')
  }
  async probe(): Promise<{ message: string; hint: string; snapshotCount: number; createdCollections: string[] }> {
    const createdCollections = await this.prepare()
    const index = await this.readIndex()
    return { message: 'Vault remote is readable; write permission has not been verified.', hint: this.hint(), snapshotCount: index.entries.length, createdCollections }
  }
}
