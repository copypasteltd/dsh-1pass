/** Encrypted-only vault wire documents. See LICENSE.reference for transport attribution. */
import { createHash } from 'node:crypto'
import type { VaultSyncChannel, VaultSyncMeta, VaultSyncSnapshot } from '../types.ts'

export const MAX_BYTES = 21 * 1024 * 1024
export const MAX_WIRE_BYTES = 20 * 1024 * 1024 + 64 * 1024
export const MAX_CIPHERTEXT_HEX = 20 * 1024 * 1024
export const MAX_INDEX_BYTES = 10 * 1024 * 1024
export const MAX_ENTRIES = 5000
export class VaultTransportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'VaultTransportError' }
}
export function fail(code: string, message: string): never { throw new VaultTransportError(code, message) }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-document', 'Invalid vault document object.')
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !('value' in d) || !d.enumerable) fail('invalid-document', 'Invalid vault document property.')
  }
  return value as Record<string, unknown>
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const obj = record(value)
  if (Object.keys(obj).length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) fail('invalid-document', 'Invalid vault document fields; generic configuration snapshots are not accepted.')
  return obj
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('invalid-config', 'Invalid text field.')
  return value
}
export function safeId(value: unknown): string {
  const id = text(value, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || ['index', 'content-present', 'blobs', 'blobs-index'].includes(id.toLowerCase()) || id.endsWith('.') || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(id)) fail('invalid-id', 'Invalid or reserved snapshot id.')
  return id
}
export function safePrefix(value: unknown): string {
  const prefix = text(value, 512)
  if (!prefix.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(p))) fail('invalid-config', 'Use a safe nonempty relative namespace.')
  return prefix
}
function iso(value: unknown): string {
  const t = text(value, 32)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t) || !Number.isFinite(Date.parse(t)) || new Date(t).toISOString() !== t) fail('invalid-document', 'Invalid snapshot timestamp.')
  return t
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid-document', 'Invalid snapshot content hash.')
  return value
}
function manifest(value: unknown, channel?: VaultSyncChannel): VaultSyncSnapshot['manifest'] {
  const m = exact(value, ['schemaVersion', 'encrypted', 'transport', 'vaultName', 'deviceId', 'deviceName', 'platform', 'dshVersion', 'sections'])
  if (m.schemaVersion !== 1 || m.encrypted !== true || !['git', 'webdav', 's3', 'gist'].includes(String(m.transport)) || (channel && m.transport !== channel)) fail('invalid-document', 'Only encrypted vault snapshots for this channel are accepted.')
  for (const k of ['vaultName', 'deviceId', 'deviceName', 'platform', 'dshVersion']) text(m[k])
  if (!Array.isArray(m.sections) || m.sections.length !== 1 || m.sections[0] !== 'vault') fail('invalid-document', 'Only the passwordvault section is accepted.')
  return m as unknown as VaultSyncSnapshot['manifest']
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const obj = record(value)
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function validateCore(value: unknown, channel?: VaultSyncChannel): void {
  const s = record(value)
  if (s.format !== '1pass-cloud-snapshot-v1') fail('invalid-document', 'Not an encrypted passwordvault snapshot.')
  safeId(s.id); iso(s.createdAt); manifest(s.manifest, channel)
  const e = exact(s.encryptedPayload, ['version', 'kdf', 'nonce', 'ciphertext', 'tag'])
  const k = exact(e.kdf, ['algo', 'n', 'r', 'p', 'saltHex'])
  if (e.version !== 1 || k.algo !== 'scrypt' || k.n !== 32768 || k.r !== 8 || k.p !== 1 || typeof k.saltHex !== 'string' || !/^[a-f0-9]{32}$/.test(k.saltHex)) fail('invalid-document', 'Unsupported encrypted vault KDF.')
  if (typeof e.nonce !== 'string' || !/^[a-f0-9]{24}$/.test(e.nonce) || typeof e.tag !== 'string' || !/^[a-f0-9]{32}$/.test(e.tag) || typeof e.ciphertext !== 'string' || e.ciphertext.length > MAX_CIPHERTEXT_HEX || e.ciphertext.length % 2 !== 0 || !/^[a-f0-9]+$/.test(e.ciphertext)) fail('invalid-document', 'Invalid encrypted vault payload.')
}
/** Hash canonical complete envelope excluding contentHash (never decrypts). */
export function snapshotContentHash(value: unknown): string {
  validateCore(value)
  const s = record(value)
  const allowed = ['format', 'id', 'createdAt', 'manifest', 'encryptedPayload', ...(Object.hasOwn(s, 'contentHash') ? ['contentHash'] : [])]
  exact(s, allowed)
  const { contentHash: _ignored, ...core } = s
  const raw = canonical(core)
  if (Buffer.byteLength(raw) > MAX_WIRE_BYTES) fail('size-limit', 'Vault snapshot exceeds its encrypted wire bound.')
  return sha256(raw)
}
export function validateSnapshot(value: unknown, channel?: VaultSyncChannel): VaultSyncSnapshot {
  exact(value, ['format', 'contentHash', 'id', 'createdAt', 'manifest', 'encryptedPayload'])
  validateCore(value, channel)
  const s = value as VaultSyncSnapshot
  if (hash(s.contentHash) !== snapshotContentHash(s)) fail('hash-mismatch', 'Vault snapshot content hash does not match.')
  if (Buffer.byteLength(canonical(s)) > MAX_WIRE_BYTES) fail('size-limit', 'Vault snapshot exceeds its encrypted wire bound.')
  return s
}
export function metaFromSnapshot(value: VaultSyncSnapshot): VaultSyncMeta {
  const s = validateSnapshot(value)
  return { id: s.id, createdAt: s.createdAt, contentHash: s.contentHash, manifest: s.manifest, sectionCount: 1 }
}
export function parseJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > MAX_BYTES) fail('size-limit', 'Response exceeds 21 MiB.')
  try { return JSON.parse(raw) } catch { fail('invalid-document', 'Invalid remote JSON document.') }
}
export function parseIndex(raw: string, channel: VaultSyncChannel): VaultSyncMeta[] {
  if (Buffer.byteLength(raw) > MAX_INDEX_BYTES) fail('size-limit', 'Vault index exceeds 10 MiB.')
  const data = parseJson(raw)
  if (!Array.isArray(data) || data.length > MAX_ENTRIES) fail('invalid-index', 'Invalid or oversized vault index.')
  const ids = new Set<string>()
  for (const item of data) {
    const m = exact(item, ['id', 'createdAt', 'contentHash', 'manifest', 'sectionCount'])
    const id = safeId(m.id); iso(m.createdAt); hash(m.contentHash); manifest(m.manifest, channel)
    if (m.sectionCount !== 1 || ids.has(id)) fail('invalid-index', 'Malformed or duplicate vault index metadata.')
    ids.add(id)
  }
  return (data as VaultSyncMeta[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}
/** Version the WHOLE observed index, not a clock-skew-prone newest snapshot id. */
export function remoteIndexVersion(entries: readonly VaultSyncMeta[]): string {
  if (entries.length === 0) return ''
  const tuples = [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(m => [m.id, m.contentHash])
  return sha256(canonical(tuples))
}
export function assertExpectedHead(entries: readonly VaultSyncMeta[], expectedHead: string | undefined): void {
  if (expectedHead === undefined) return
  if (typeof expectedHead !== 'string' || remoteIndexVersion(entries) !== expectedHead) fail('SYNC_REMOTE_CHANGED', 'SYNC_REMOTE_CHANGED')
}
export function serializeIndex(entries: VaultSyncMeta[], channel: VaultSyncChannel): string {
  const raw = canonical(entries)
  parseIndex(raw, channel)
  return raw
}
export function checkedDownload(raw: string, id: string, meta: VaultSyncMeta, channel: VaultSyncChannel): VaultSyncSnapshot {
  const s = validateSnapshot(parseJson(raw), channel)
  if (s.id !== id || canonical(metaFromSnapshot(s)) !== canonical(meta)) fail('hash-mismatch', 'Snapshot does not match authoritative index metadata.')
  return s
}
