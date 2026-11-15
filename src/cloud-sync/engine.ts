/** Pure vault sync data/crypto helpers. No store, filesystem, transport, or lock access. */
import { createHash } from 'node:crypto'
import { decrypt, deriveKey, encrypt, newKdfParams, safeEqual, type KdfParams } from '../crypto.ts'
import type { VaultEntry } from '../store.ts'
import type { VaultSyncChannel, VaultSyncSnapshot } from './types.ts'

const MAX_PLAINTEXT = 10 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_FIELDS = 10_000
const MAX_DOCUMENT = MAX_PLAINTEXT * 2 + 64 * 1024
const BAD_JSON = 'vault sync: invalid JSON data'
const BAD_ENTRIES = 'vault sync: invalid entry data'
const BAD_SNAPSHOT = 'vault sync: password is incorrect or snapshot is invalid'
const BAD_RESOLUTION = 'vault sync: invalid merge resolution'
const OUTER_FORMAT = '1pass-cloud-snapshot-v1' as const
const INNER_FORMAT = '1pass-vault-data-v1' as const
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CHANNELS = new Set(['git', 'webdav', 's3', 'gist'])
type Dict = Record<string, unknown>

function invalid(): never { throw new Error(BAD_JSON) }
function plain(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function assert(value: unknown): asserts value { if (!value) invalid() }

/** Sorted JSON with JSON's undefined-object omission / undefined-array null semantics.
 * Rejects non-JSON values, accessors, exotic prototypes, cycles, and unsafe map keys.
 * Unlike semantic entry comparison this includes updatedAt (also suitable for CAS).
 */
function encodeCanonical(value: unknown, maxBytes = MAX_DOCUMENT): string {
  const chunks: string[] = []
  const seen = new Set<object>()
  let bytes = 0
  let nodes = 0
  const add = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8')
    assert(bytes <= maxBytes)
    chunks.push(text)
  }
  const visit = (item: unknown, depth: number): void => {
    assert(depth <= 32 && ++nodes <= 1_000_000)
    if (item === null) { add('null'); return }
    if (typeof item === 'string') {
      assert(item.length <= maxBytes)
      add(JSON.stringify(item)); return
    }
    if (typeof item === 'boolean') { add(item ? 'true' : 'false'); return }
    if (typeof item === 'number') { assert(Number.isFinite(item)); add(JSON.stringify(item)); return }
    assert(typeof item === 'object' && item !== null && !seen.has(item))
    assert(Object.getOwnPropertySymbols(item).length === 0)
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        assert(item.length <= 1_000_000)
        const keys = Object.keys(item)
        assert(keys.every(key => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length))
        add('[')
        for (let i = 0; i < item.length; i++) {
          if (i) add(',')
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
          assert(!descriptor || ('value' in descriptor && descriptor.enumerable))
          const child: unknown = descriptor?.value
          if (child === undefined) add('null')
          else visit(child, depth + 1)
        }
        add(']')
      } else {
        assert(plain(item))
        add('{')
        let first = true
        for (const key of Object.getOwnPropertyNames(item).sort()) {
          assert(!UNSAFE_KEYS.has(key))
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!
          assert('value' in descriptor && descriptor.enumerable)
          if (descriptor.value === undefined) continue
          if (!first) add(',')
          first = false
          assert(key.length <= maxBytes)
          add(JSON.stringify(key)); add(':'); visit(descriptor.value, depth + 1)
        }
        add('}')
      }
    } finally { seen.delete(item) }
  }
  try { visit(value, 0); return chunks.join('') }
  catch { throw new Error(BAD_JSON) }
}
export function canonical(value: unknown): string { return encodeCanonical(value) }
export function syncHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}
function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T }
function exactKeys(value: Dict, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  assert(required.every(key => Object.hasOwn(value, key)))
  assert(Object.keys(value).every(key => allowed.has(key)))
}
function text(value: unknown, max = MAX_PLAINTEXT): value is string {
  return typeof value === 'string' && value.length <= max
}
function named(value: unknown, max = 1024): value is string { return text(value, max) && value.length > 0 }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function hex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value)
}
function hashHex(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }
function matchesHash(expected: string, actual: string): boolean {
  return safeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}
function isoDate(value: unknown): value is string {
  if (!text(value, 40)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

const STRING_FIELDS = new Set([
  'id', 'title', 'icon', 'color', 'username', 'email', 'phone', 'password', 'host', 'port',
  'privateKey', 'ip', 'certificate', 'keyPassphrase', 'apiKey', 'secret', 'accessToken',
  'refreshToken', 'envKey', 'otpSecret', 'cardNumber', 'cardExpiry', 'cardCvv', 'cardHolder', 'url', 'notes',
])
const ENTRY_KEYS = new Set([...STRING_FIELDS, 'kind', 'sensitivity', 'sshAuth', 'rotationDays',
  'deletedAt', 'favorite', 'expiresAt', 'envKeys', 'tags', 'cookies', 'passwordHistory',
  'attachments', 'fields', 'createdAt', 'updatedAt'])

function validateFields(value: unknown, depth: number, budget: { count: number }): void {
  assert(depth <= 20 && ++budget.count <= MAX_FIELDS + 1) // root map is not one of its fields
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') { assert(Number.isFinite(value)); return }
  if (Array.isArray(value)) {
    assert(value.length <= MAX_FIELDS)
    for (const item of value) validateFields(item, depth + 1, budget)
    return
  }
  assert(plain(value))
  for (const key of Object.keys(value)) {
    assert(!UNSAFE_KEYS.has(key))
    validateFields(value[key], depth + 1, budget)
  }
}
function validateEntry(value: unknown): asserts value is VaultEntry {
  assert(plain(value) && Object.keys(value).every(key => ENTRY_KEYS.has(key)))
  assert(named(value.id, 512) && text(value.title) && timestamp(value.createdAt) && timestamp(value.updatedAt))
  for (const key of STRING_FIELDS) if (Object.hasOwn(value, key)) assert(text(value[key]))
  if ('kind' in value) assert(['login', 'ssh', 'api-key', 'secret', 'oauth', 'cookie', 'card', 'custom'].includes(value.kind as string))
  if ('sensitivity' in value) assert(value.sensitivity === 'normal' || value.sensitivity === 'high')
  if ('sshAuth' in value) assert(value.sshAuth === 'password' || value.sshAuth === 'certificate')
  if ('favorite' in value) assert(typeof value.favorite === 'boolean')
  if ('deletedAt' in value) assert(timestamp(value.deletedAt))
  for (const key of ['rotationDays', 'expiresAt']) {
    if (key in value) assert(typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0)
  }
  for (const key of ['tags', 'envKeys']) {
    if (!(key in value)) continue
    const list = value[key]
    assert(Array.isArray(list) && list.length <= MAX_FIELDS && list.every(item => text(item)))
  }
  if ('fields' in value) {
    assert(plain(value.fields))
    validateFields(value.fields, 0, { count: 0 })
  }
  if ('cookies' in value) {
    assert(Array.isArray(value.cookies) && value.cookies.length <= MAX_FIELDS)
    for (const cookie of value.cookies) {
      assert(plain(cookie))
      exactKeys(cookie, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure'], ['sameSite'])
      assert(['name', 'value', 'domain', 'path'].every(key => text(cookie[key])))
      assert(typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires >= -1)
      assert(typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean')
      if ('sameSite' in cookie) assert(['Strict', 'Lax', 'None'].includes(cookie.sameSite as string))
    }
  }
  if ('passwordHistory' in value) {
    assert(Array.isArray(value.passwordHistory) && value.passwordHistory.length <= MAX_FIELDS)
    for (const history of value.passwordHistory) {
      assert(plain(history)); exactKeys(history, ['password', 'at'])
      assert(text(history.password) && timestamp(history.at))
    }
  }
  if ('attachments' in value) {
    assert(plain(value.attachments) && Object.keys(value.attachments).length <= MAX_FIELDS)
    for (const attachment of Object.values(value.attachments)) {
      assert(plain(attachment)); exactKeys(attachment, ['data', 'name', 'size'], ['mime'])
      assert(text(attachment.data) && text(attachment.name) && timestamp(attachment.size))
      if ('mime' in attachment) assert(text(attachment.mime))
    }
  }
}
/** Copies before any async boundary; no caller-owned data can change during scrypt. */
function entryList(value: unknown): VaultEntry[] {
  try {
    assert(Array.isArray(value) && value.length <= MAX_ENTRIES)
    const entries: unknown[] = JSON.parse(encodeCanonical(value, MAX_PLAINTEXT))
    const ids = new Set<string>()
    for (const entry of entries) {
      validateEntry(entry)
      assert(!ids.has(entry.id)); ids.add(entry.id)
    }
    return entries as VaultEntry[]
  } catch { throw new Error(BAD_ENTRIES) }
}
function validateKdf(value: unknown): asserts value is KdfParams {
  assert(plain(value)); exactKeys(value, ['algo', 'n', 'r', 'p', 'saltHex'])
  // v1 has one allowed cost tuple, not merely a generous maxmem ceiling.
  assert(value.algo === 'scrypt' && value.n === 32768 && value.r === 8 && value.p === 1)
  assert(128 * value.n * value.r <= 64 * 1024 * 1024 && value.n * value.r * value.p <= 262144)
  assert(hex(value.saltHex, 16))
}
function validateManifest(value: unknown): asserts value is VaultSyncSnapshot['manifest'] {
  assert(plain(value))
  exactKeys(value, ['schemaVersion', 'encrypted', 'transport', 'vaultName', 'deviceId', 'deviceName', 'platform', 'dshVersion', 'sections'])
  assert(value.schemaVersion === 1 && value.encrypted === true && CHANNELS.has(value.transport as string))
  assert(['vaultName', 'deviceId', 'deviceName'].every(key => named(value[key])))
  assert(named(value.platform, 128) && named(value.dshVersion, 128))
  assert(Array.isArray(value.sections) && value.sections.length === 1 && value.sections[0] === 'vault')
}
function snapshotBody(snapshot: VaultSyncSnapshot): Omit<VaultSyncSnapshot, 'contentHash'> {
  const { contentHash: _, ...body } = snapshot
  return body
}
function checkedSnapshot(input: unknown): VaultSyncSnapshot {
  const value: unknown = clone(input)
  assert(plain(value)); exactKeys(value, ['format', 'contentHash', 'id', 'createdAt', 'manifest', 'encryptedPayload'])
  assert(value.format === OUTER_FORMAT && hashHex(value.contentHash) && named(value.id, 512) && isoDate(value.createdAt))
  validateManifest(value.manifest)
  const envelope = value.encryptedPayload
  assert(plain(envelope)); exactKeys(envelope, ['version', 'kdf', 'nonce', 'ciphertext', 'tag'])
  assert(envelope.version === 1); validateKdf(envelope.kdf)
  assert(hex(envelope.nonce, 12) && hex(envelope.tag, 16))
  assert(typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > 0
    && envelope.ciphertext.length <= MAX_PLAINTEXT * 2 && envelope.ciphertext.length % 2 === 0
    && /^[0-9a-f]+$/i.test(envelope.ciphertext))
  const snapshot = value as unknown as VaultSyncSnapshot
  assert(matchesHash(snapshot.contentHash, syncHash(snapshotBody(snapshot))))
  return snapshot
}

export interface VaultSyncSnapshotMetadata {
  id: string
  createdAt: string
  transport: VaultSyncChannel
  vaultName: string
  deviceId: string
  deviceName: string
}

/** Encrypts every entry, including trash, password history, cookies and attachments. */
export async function sealSyncSnapshot(entries: VaultEntry[], password: string, meta: VaultSyncSnapshotMetadata): Promise<VaultSyncSnapshot> {
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    assert(named(password))
    const data = entryList(entries)
    const metadata = clone(meta)
    assert(plain(metadata)); exactKeys(metadata, ['id', 'createdAt', 'transport', 'vaultName', 'deviceId', 'deviceName'])
    assert(named(metadata.id, 512) && isoDate(metadata.createdAt) && CHANNELS.has(metadata.transport))
    assert(['vaultName', 'deviceId', 'deviceName'].every(name => named((metadata as unknown as Dict)[name])))
    const manifest: VaultSyncSnapshot['manifest'] = {
      schemaVersion: 1, encrypted: true, transport: metadata.transport,
      vaultName: metadata.vaultName, deviceId: metadata.deviceId, deviceName: metadata.deviceName,
      platform: process.platform, dshVersion: 'unknown', sections: ['vault'],
    }
    const body = { format: INNER_FORMAT, id: metadata.id, createdAt: metadata.createdAt, manifest, entries: data }
    const checksum = syncHash(body)
    plaintext = Buffer.from(encodeCanonical({ ...body, checksum }, MAX_PLAINTEXT), 'utf8')
    const kdf = newKdfParams(); validateKdf(kdf)
    key = await deriveKey(password, kdf)
    const encrypted = encrypt(plaintext, key)
    const snapshot: VaultSyncSnapshot = {
      format: OUTER_FORMAT, contentHash: '', id: metadata.id, createdAt: metadata.createdAt, manifest,
      encryptedPayload: { version: 1, kdf, nonce: encrypted.ivHex, ciphertext: encrypted.dataHex, tag: encrypted.tagHex },
    }
    snapshot.contentHash = syncHash(snapshotBody(snapshot))
    return snapshot
  } catch { throw new Error(BAD_SNAPSHOT) }
  finally { key?.fill(0); plaintext?.fill(0) }
}

/** Untrusted input is bounded/validated before scrypt; all failures share one safe error. */
export async function openSyncSnapshot(input: VaultSyncSnapshot, password: string): Promise<VaultEntry[]> {
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    assert(named(password))
    const snapshot = checkedSnapshot(input)
    const envelope = snapshot.encryptedPayload
    key = await deriveKey(password, envelope.kdf)
    plaintext = decrypt({ ivHex: envelope.nonce, tagHex: envelope.tag, dataHex: envelope.ciphertext }, key)
    assert(plaintext.length <= MAX_PLAINTEXT)
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    assert(plain(payload)); exactKeys(payload, ['format', 'id', 'createdAt', 'manifest', 'entries', 'checksum'])
    assert(payload.format === INNER_FORMAT && payload.id === snapshot.id && payload.createdAt === snapshot.createdAt)
    assert(canonical(payload.manifest) === canonical(snapshot.manifest))
    assert(hashHex(payload.checksum))
    const { checksum, ...body } = payload
    assert(matchesHash(checksum as string, syncHash(body)))
    return entryList(payload.entries)
  } catch { throw new Error(BAD_SNAPSHOT) }
  finally { key?.fill(0); plaintext?.fill(0) }
}

export type VaultMergeDecision = 'skip' | 'keepLocal' | 'useRemote' | 'merge' | 'conflict'
export interface VaultMergeConflict {
  /** RFC 6901 JSON Pointer; empty string means the whole entry. No values in diagnostics. */
  path: string
  reason: 'both-modified' | 'modify-delete' | 'delete-modify' | 'no-ancestor'
}
export interface VaultMergeItem {
  id: string
  decision: VaultMergeDecision
  conflicts: VaultMergeConflict[]
  local?: VaultEntry
  remote?: VaultEntry
  ancestor?: VaultEntry
  /** Safe field candidate, retaining local values at conflict paths. Absent for entry-level conflicts. */
  merged?: VaultEntry
}
export interface VaultMergePlan { entries: VaultEntry[]; items: VaultMergeItem[] }
export interface VaultMergeResolution { id: string; action: 'keepLocal' | 'useRemote' | 'useMerged' | 'skip' }
export interface VaultMergeResult { entries: VaultEntry[]; pending: string[] }

function equal(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined ? a === b : canonical(a) === canonical(b)
}
function semantic(entry: VaultEntry | undefined): unknown {
  if (!entry) return undefined
  const { updatedAt: _, ...data } = entry
  return data
}
function same(a: VaultEntry | undefined, b: VaultEntry | undefined): boolean { return equal(semantic(a), semantic(b)) }
function pointer(path: string, key: string): string { return path + '/' + key.replace(/~/g, '~0').split('/').join('~1') }
function mergeField(local: unknown, remote: unknown, ancestor: unknown, path: string, recurse: boolean, conflicts: VaultMergeConflict[]): unknown {
  if (equal(local, remote)) return local
  if (equal(local, ancestor)) return remote
  if (equal(remote, ancestor)) return local
  if (recurse && plain(local) && plain(remote) && (ancestor === undefined || plain(ancestor))) {
    const base = ancestor === undefined ? {} : ancestor
    const result: Dict = {}
    for (const key of [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])].sort()) {
      const value = mergeField(local[key], remote[key], base[key], pointer(path, key), true, conflicts)
      if (value !== undefined) result[key] = value
    }
    return result
  }
  const reason = local === undefined && ancestor !== undefined ? 'delete-modify'
    : remote === undefined && ancestor !== undefined ? 'modify-delete' : 'both-modified'
  conflicts.push({ path, reason })
  return local
}
function selected(item: VaultMergeItem): VaultEntry | undefined {
  if (item.decision === 'useRemote') return item.remote
  if (item.decision === 'merge') return item.merged
  return item.local
}

/** Entry identity, never titles or ciphertext, is the join key. Timestamp-only edits are semantic no-ops. */
export function mergeVaultEntries(local: VaultEntry[], remote: VaultEntry[], ancestor?: VaultEntry[]): VaultMergePlan {
  const locals = new Map(entryList(local).map(entry => [entry.id, entry]))
  const remotes = new Map(entryList(remote).map(entry => [entry.id, entry]))
  const ancestors = new Map((ancestor === undefined ? [] : entryList(ancestor)).map(entry => [entry.id, entry]))
  const ids = [...new Set([...locals.keys(), ...remotes.keys(), ...ancestors.keys()])].sort()
  const items: VaultMergeItem[] = []
  for (const id of ids) {
    const left = locals.get(id), right = remotes.get(id), base = ancestors.get(id)
    const item: VaultMergeItem = { id, decision: 'skip', conflicts: [],
      ...(left ? { local: left } : {}), ...(right ? { remote: right } : {}), ...(base ? { ancestor: base } : {}) }
    if (same(left, right)) { /* retain local (including its original updatedAt) */ }
    else if (!base) {
      if (!left) item.decision = 'useRemote'
      else if (!right) item.decision = 'keepLocal'
      else { item.decision = 'conflict'; item.conflicts.push({ path: '', reason: 'no-ancestor' }) }
    } else if (same(left, base)) item.decision = 'useRemote'
    else if (same(right, base)) item.decision = 'keepLocal'
    else if (!left || !right) {
      item.decision = 'conflict'
      item.conflicts.push({ path: '', reason: left ? 'modify-delete' : 'delete-modify' })
    } else if ((right.deletedAt !== undefined && right.deletedAt !== base.deletedAt)
      || (left.deletedAt !== undefined && left.deletedAt !== base.deletedAt)) {
      // Trash is a deletion, not an ordinary field to combine with a concurrent edit.
      item.decision = 'conflict'
      item.conflicts.push({ path: '', reason: right.deletedAt !== undefined && right.deletedAt !== base.deletedAt ? 'modify-delete' : 'delete-modify' })
    } else {
      const merged: Dict = { id, updatedAt: Math.max(left.updatedAt, right.updatedAt) }
      const l = left as unknown as Dict, r = right as unknown as Dict, b = base as unknown as Dict
      for (const key of [...new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])].sort()) {
        if (key === 'id' || key === 'updatedAt') continue
        const value = mergeField(l[key], r[key], b[key], pointer('', key), key === 'fields', item.conflicts)
        if (value !== undefined) merged[key] = value
      }
      item.merged = merged as unknown as VaultEntry
      item.decision = item.conflicts.length ? 'conflict' : 'merge'
    }
    items.push(item)
  }
  return { entries: items.flatMap(item => { const entry = selected(item); return entry ? [clone(entry)] : [] }), items }
}

function conflictId(item: VaultMergeItem, path: string): string { return path ? item.id + '::' + path : item.id }
function getPath(entry: VaultEntry | undefined, path: string): unknown {
  let value: unknown = entry
  for (const key of path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!plain(value)) return undefined
    value = Object.hasOwn(value, key) ? value[key] : undefined
  }
  return value
}
function setPath(entry: VaultEntry, path: string, value: unknown): void {
  const keys = path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current = entry as unknown as Dict
  for (const key of keys.slice(0, -1)) {
    assert(!UNSAFE_KEYS.has(key))
    if (!plain(current[key])) current[key] = {}
    current = current[key] as Dict
  }
  const last = keys[keys.length - 1]!
  assert(!UNSAFE_KEYS.has(last))
  if (value === undefined) delete current[last]
  else current[last] = clone(value)
}

/** No resolution means keep the entire local conflicted entry and report pending IDs.
 * Field resolutions address exact conflict pointers: entryId::/fields/nested/key.
 * Resolving only some fields leaves remaining conflict values local in the candidate.
 * Whole-entry choices take precedence over field choices. Explicit skip means keep local.
 * There is no magic global 'vault' ID (it could be a real entry ID); the controller maps globals.
 */
export function resolveVaultMerge(plan: VaultMergePlan, resolutions: VaultMergeResolution[]): VaultMergeResult {
  try {
    assert(Array.isArray(resolutions) && Array.isArray(plan.items))
    const choices = new Map<string, VaultMergeResolution['action']>()
    const validIds = new Set<string>()
    const ambiguousIds = new Set<string>()
    for (const item of plan.items) {
      for (const id of new Set([item.id, ...item.conflicts.map(conflict => conflictId(item, conflict.path))])) {
        if (validIds.has(id)) ambiguousIds.add(id)
        validIds.add(id)
      }
    }
    for (const resolution of resolutions) {
      // Arbitrary imported entry IDs must not impersonate another entry's field pointer.
      assert(!ambiguousIds.has(resolution.id))
      assert(plain(resolution) && typeof resolution.id === 'string' && validIds.has(resolution.id) && !choices.has(resolution.id))
      assert(['keepLocal', 'useRemote', 'useMerged', 'skip'].includes(resolution.action))
      choices.set(resolution.id, resolution.action)
    }
    const entries: VaultEntry[] = []
    const pending: string[] = []
    for (const item of plan.items) {
      const action = choices.get(item.id)
      let entry: VaultEntry | undefined
      if (action && (action !== 'useMerged' || item.merged || !item.conflicts.length)) {
        entry = action === 'useRemote' ? item.remote : action === 'useMerged' ? item.merged ?? selected(item) : item.local
      } else if (!item.conflicts.length) entry = selected(item)
      else {
        const fieldChoices = item.conflicts.filter(conflict => conflict.path && choices.has(conflictId(item, conflict.path)))
        entry = fieldChoices.length && item.merged ? clone(item.merged) : item.local
        for (const conflict of item.conflicts) {
          const id = conflictId(item, conflict.path)
          const choice = conflict.path ? choices.get(id) : undefined
          if (!choice || !entry || !item.merged) { pending.push(id); continue }
          const source = choice === 'useRemote' ? item.remote : choice === 'useMerged' ? item.merged : item.local
          setPath(entry, conflict.path, getPath(source, conflict.path))
        }
      }
      if (entry) entries.push(clone(entry))
    }
    // Revalidate even caller-mutated plans; no malformed result can reach a store.
    return { entries: entryList(entries), pending }
  } catch { throw new Error(BAD_RESOLUTION) }
}
