import { afterEach, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { onVaultPersist, openVault, VaultStore, type VaultEntry } from '../src/store.ts'
import * as cryptoModule from '../src/crypto.ts'

// Real encryption and real atomic local fixture writes; hooks only pause/fail
// the exact temporary vault's commit, never touch a user's vault or the network.
const hooks = vi.hoisted(() => ({
  target: '', writes: 0,
  lock: undefined as (() => Promise<void>) | undefined,
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  afterWrite: undefined as (() => Promise<void>) | undefined,
  afterLock: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    withFileLock: async <T>(path: string, run: () => Promise<T>): Promise<T> => {
      const result = await actual.withFileLock(path, async () => {
        if (path === hooks.target && hooks.lock) { const hook = hooks.lock; hooks.lock = undefined; await hook() }
        return run()
      })
      if (path === hooks.target && hooks.afterLock) { const hook = hooks.afterLock; hooks.afterLock = undefined; await hook() }
      return result
    },
    writeFileAtomic: async (path: string, data: string, options: { mode: number; dirMode?: number }): Promise<void> => {
      if (path === hooks.target) {
        hooks.writes++
        if (hooks.beforeWrite) { const hook = hooks.beforeWrite; hooks.beforeWrite = undefined; await hook() }
      }
      await actual.writeFileAtomic(path, data, options)
      if (path === hooks.target && hooks.afterWrite) { const hook = hooks.afterWrite; hooks.afterWrite = undefined; await hook() }
    },
  }
})
const fixtures: Array<{ dir: string; store: VaultStore }> = []
afterEach(async () => {
  hooks.target = ''; hooks.writes = 0; hooks.lock = undefined; hooks.beforeWrite = undefined; hooks.afterWrite = undefined; hooks.afterLock = undefined
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const { dir, store } of fixtures.splice(0)) {
    await store.lock()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vault-sync-store-'))
  const path = join(dir, 'vault.json')
  const store = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  fixtures.push({ dir, store })
  await store.add({ title: 'Local fixture', password: 'SYNTHETIC-LOCAL-PASSWORD', fields: { nested: { b: 2, a: ['one', 3] } } })
  hooks.target = path; hooks.writes = 0
  return { dir, path, store, before: await readFile(path, 'utf8') }
}
function remoteEntry(id = 'remote-id'): VaultEntry {
  return { id, title: 'Remote fixture', password: 'SYNTHETIC-REMOTE-PASSWORD', createdAt: 101, updatedAt: 202 }
}
const noop = () => {}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}

test('snapshot is detached, includes trash, and fingerprint is canonical without I/O, audit or touch', async () => {
  const { store, before, path } = await fixture()
  const trash: VaultEntry = { ...remoteEntry('a-trash'), deletedAt: 303, fields: { z: true, a: { y: 2, x: 1 } } }
  store.insertDirect(trash)
  const history = store.getHistory()
  const stamp = (store as unknown as { lastActivity: number }).lastActivity
  const snapshot = store.syncSnapshot()
  const expected = hash(canonical(snapshot.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  expect(store.syncFingerprint()).toBe(expected)
  snapshot.find(e => e.id === 'a-trash')!.fields!.a = 'changed clone'
  expect(store.getIncludingTrash('a-trash')!.fields!.a).toEqual({ y: 2, x: 1 })
  expect(store.listTrash()).toHaveLength(1)
  expect(hooks.writes).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(store.getHistory()).toEqual(history)
  expect((store as unknown as { lastActivity: number }).lastActivity).toBe(stamp)
  const original = store.getIncludingTrash('a-trash')!
  store.insertDirect({ updatedAt: original.updatedAt, createdAt: original.createdAt, password: original.password!, fields: { a: { x: 1, y: 2 }, z: true }, deletedAt: original.deletedAt!, title: original.title, id: original.id })
  expect(store.syncFingerprint()).toBe(expected)
  original.fields!.a = ['the detached old entry is not current']
  expect(store.syncFingerprint()).toBe(expected)
  const reordered = new VaultStore(path, 'not-used')
  Object.assign(reordered, { key: (store as unknown as { key: Buffer }).key, kdf: (store as unknown as { kdf: unknown }).kdf })
  for (const entry of store.syncSnapshot().reverse()) reordered.insertDirect(entry)
  expect(reordered.syncFingerprint()).toBe(expected)
})

test('locked, expired, uninitialized and in-flight locking handles refuse every sync secret accessor', async () => {
  const { store, path } = await fixture()
  const sealed = store.sealLocalSyncState({ marker: 'SYNTHETIC-SIDECAR-SECRET' })
  const assertLocked = (target: VaultStore) => {
    expect(() => target.syncSnapshot()).toThrow('SYNC_LOCKED')
    expect(() => target.syncFingerprint()).toThrow('SYNC_LOCKED')
    expect(() => target.syncDiskHash()).toThrow('SYNC_LOCKED')
    expect(() => target.sealLocalSyncState({})).toThrow('SYNC_LOCKED')
    expect(() => target.unsealLocalSyncState(sealed)).toThrow('SYNC_LOCKED')
  }
  assertLocked(new VaultStore(path, 'never-loaded'))
  store.setAutoLock(1)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100)
  assertLocked(store)
  await expect(store.replaceForSync([], '0'.repeat(64), noop)).rejects.toThrow('SYNC_LOCKED')
  vi.restoreAllMocks(); store.setAutoLock(undefined)
  const locking = store.lock()
  assertLocked(store)
  await locking
  assertLocked(store)
})

test('sealed local state authenticates format and ciphertext and works across same-vault restarts', async () => {
  const { store, path } = await fixture()
  const state = { ancestor: [remoteEntry()], nested: { z: false, a: null }, token: 'SYNTHETIC-SIDECAR-SECRET' }
  const raw = store.sealLocalSyncState(state)
  expect(raw).not.toContain('SYNTHETIC-SIDECAR-SECRET')
  expect(raw).not.toContain('SYNTHETIC-REMOTE-PASSWORD')
  expect(raw).not.toContain('ancestor')
  expect(store.unsealLocalSyncState(raw)).toEqual(state)
  expect(store.sealLocalSyncState(state)).not.toBe(raw)
  const restarted = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  expect(restarted.unsealLocalSyncState(raw)).toEqual(state)
  await restarted.lock()
  const doc = JSON.parse(raw) as { magic: string; dataHex: string }
  doc.dataHex = (doc.dataHex.startsWith('00') ? '01' : '00') + doc.dataHex.slice(2)
  expect(() => store.unsealLocalSyncState(JSON.stringify(doc))).toThrow('SYNC_INVALID_STATE')
  expect(() => store.unsealLocalSyncState(JSON.stringify({ ...JSON.parse(raw), magic: 'foreign' }))).toThrow('SYNC_INVALID_STATE')
  expect(() => store.unsealLocalSyncState('{SYNTHETIC-SIDECAR-SECRET')).toThrow('SYNC_INVALID_STATE')
  expect(() => store.unsealLocalSyncState('null')).toThrow('SYNC_INVALID_STATE')
  const circular: Record<string, unknown> = {}; circular.self = circular
  expect(() => store.sealLocalSyncState(circular)).toThrow('SYNC_INVALID_STATE')
  expect(() => store.sealLocalSyncState(undefined)).toThrow('SYNC_INVALID_STATE')
})

test('replacement preserves exact ids, timestamps, all secrets and trash with generic encrypted audit', async () => {
  const { store, path, before } = await fixture()
  const originalKdf = JSON.parse(before).kdf
  const next: VaultEntry[] = [
    { ...remoteEntry('kept-trash'), deletedAt: 303, passwordHistory: [{ password: 'SYNTHETIC-OLD-PASSWORD', at: 99 }], fields: { nested: { b: 2, a: 1 } }, attachments: { 'fixture.txt': { name: 'fixture.txt', data: 'RklYVFVSRQ==', size: 7 } } },
    { ...remoteEntry('active'), kind: 'cookie', apiKey: 'SYNTHETIC-API-SECRET', cookies: [{ name: 'session', value: 'SYNTHETIC-COOKIE-SECRET', domain: 'example.invalid', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] },
  ]
  const observed: string[] = []; const off = onVaultPersist(p => observed.push(p))
  try {
    const fingerprint = store.syncFingerprint()
    const pending = store.replaceForSync(next, fingerprint, noop, hash(before))
    next[0]!.password = 'caller changed after validation'
    await pending
    const expected = structuredClone(next); expected[0]!.password = 'SYNTHETIC-REMOTE-PASSWORD'
    expect(store.syncSnapshot()).toEqual(expected)
    expect(store.listTrash().map(e => e.id)).toEqual(['kept-trash'])
    expect(store.list().map(e => e.id)).toEqual(['active'])
    expect(hooks.writes).toBe(1)
    expect(observed).toEqual([resolve(path)])
    expect(store.getHistory()[0]).toEqual({ action: 'sync', at: expect.any(Number) })
    const disk = await readFile(path, 'utf8')
    expect(JSON.parse(disk).kdf).toEqual(originalKdf)
    expect(disk).not.toContain('SYNTHETIC')
    const audit = await readFile(path.replace(/\.json$/, '-audit.json'), 'utf8')
    expect(audit).not.toContain('Remote fixture'); expect(audit).not.toContain('SYNTHETIC')
    const restarted = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
    expect(restarted.syncSnapshot()).toEqual(expected)
    expect(restarted.getHistory()[0]).toEqual({ action: 'sync', at: expect.any(Number) })
    await restarted.lock()
  } finally { off() }
})

test.each([
  ['duplicate id', () => [remoteEntry(), remoteEntry()]],
  ['blank title', () => [{ ...remoteEntry(), title: '' }]],
  ['missing timestamp', () => [{ ...remoteEntry(), createdAt: undefined }]],
  ['bad timestamp', () => [{ ...remoteEntry(), deletedAt: 'SYNTHETIC-INVALID' }]],
  ['bad password', () => [{ ...remoteEntry(), password: { secret: 'SYNTHETIC-INVALID' } }]],
  ['bad kind', () => [{ ...remoteEntry(), kind: 'SYNTHETIC-INVALID' }]],
  ['bad environment key', () => [{ ...remoteEntry(), envKeys: ['SYNTHETIC-INVALID!'] }]],
  ['bad nested number', () => [{ ...remoteEntry(), fields: { broken: NaN } }]],
  ['bad nested value', () => [{ ...remoteEntry(), fields: { broken: new Date() } }]],
  ['bad cookie', () => [{ ...remoteEntry(), cookies: [{ name: 'x', value: 'y', domain: 'z' }] }]],
  ['bad attachment', () => [{ ...remoteEntry(), attachments: { secret: { data: 'SYNTHETIC', size: -1 } } }]],
  ['unknown field', () => [{ ...remoteEntry(), unrecognized: 'SYNTHETIC-INVALID' }]],
  ['cyclic record', () => { const entry: Record<string, unknown> = remoteEntry() as unknown as Record<string, unknown>; entry.fields = entry; return [entry] }],
] as const)('validates the entire result before queueing: %s', async (_label, build) => {
  const { store, path, before } = await fixture()
  const previous = store.syncSnapshot(); const authorize = vi.fn(noop)
  await expect(store.replaceForSync([remoteEntry('first-valid'), ...build()] as VaultEntry[], store.syncFingerprint(), authorize)).rejects.toThrow('SYNC_INVALID_INPUT')
  expect(store.syncSnapshot()).toEqual(previous); expect(authorize).not.toHaveBeenCalled(); expect(hooks.writes).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('getter inputs fail generically without evaluating or logging the getter', async () => {
  const { store } = await fixture()
  const getter = vi.fn(() => { throw new Error('SYNTHETIC-LEAK') })
  const bad = Object.defineProperty(remoteEntry(), 'password', { enumerable: true, get: getter })
  const log = vi.spyOn(console, 'error').mockImplementation(noop)
  await expect(store.replaceForSync([bad], store.syncFingerprint(), noop)).rejects.toThrow('SYNC_INVALID_INPUT')
  expect(getter).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
})

test('read-only authorization and queued revocation never write or publish', async () => {
  const { store, path, before } = await fixture()
  const snapshot = store.syncSnapshot(); const fingerprint = store.syncFingerprint()
  await expect(store.replaceForSync([remoteEntry()], fingerprint, () => { throw new Error('SYNTHETIC-READONLY') })).rejects.toThrow('SYNC_NOT_AUTHORIZED')
  let release!: () => void
  const queue = new Promise<void>(resolve => { release = resolve })
  ;(store as unknown as { persistChain: Promise<unknown> }).persistChain = queue
  let revoked = false
  const pending = store.replaceForSync([remoteEntry()], fingerprint, () => { if (revoked) throw new Error('SYNTHETIC-REVOKED') })
  revoked = true; release()
  await expect(pending).rejects.toThrow('SYNC_NOT_AUTHORIZED')
  expect(store.syncSnapshot()).toEqual(snapshot); expect(hooks.writes).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('changed memory fingerprint, including a concurrent ordinary update before queue dispatch, is not lost', async () => {
  const { store, path } = await fixture()
  const fingerprint = store.syncFingerprint(); const id = store.list()[0]!.id
  const pending = store.replaceForSync([remoteEntry()], fingerprint, noop)
  const update = store.update(id, { notes: 'ordinary edit wins' })
  await expect(pending).rejects.toThrow('SYNC_LOCAL_CHANGED'); await update
  expect(store.get(id)!.notes).toBe('ordinary edit wins'); expect(store.get(remoteEntry().id)).toBeUndefined()
  const restarted = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  expect(restarted.get(id)!.notes).toBe('ordinary edit wins'); await restarted.lock()
})

test('disk CAS reads actual bytes under lock, detecting same-key external writes with stale memory', async () => {
  const { store, path, before } = await fixture()
  const other = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  await other.add({ title: 'External process fixture', password: 'SYNTHETIC-EXTERNAL' })
  const external = await readFile(path, 'utf8'); hooks.writes = 0
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop, hash(before))).rejects.toThrow('SYNC_LOCAL_CHANGED')
  expect(await readFile(path, 'utf8')).toBe(external); expect(hooks.writes).toBe(0)
  expect(store.list()).toHaveLength(1); await other.lock()
})

test('file-lock wait rechecks authorization, fingerprint, and immediate lock revocation', async () => {
  const { store, path, before } = await fixture()
  let revoked = false
  hooks.lock = async () => { revoked = true }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), () => { if (revoked) throw new Error('SYNTHETIC-REVOKED') })).rejects.toThrow('SYNC_NOT_AUTHORIZED')
  hooks.lock = async () => { store.list()[0]!.notes = 'direct reference changed during await' }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop)).rejects.toThrow('SYNC_LOCAL_CHANGED')
  hooks.lock = async () => { await store.lock() }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop)).rejects.toThrow('SYNC_LOCKED')
  expect(hooks.writes).toBe(0); expect(await readFile(path, 'utf8')).toBe(before)
})

test('failed atomic replacement leaves memory, disk, history and notifications untouched and allows retry', async () => {
  const { store, path, before } = await fixture()
  const previous = store.syncSnapshot(); const history = store.getHistory(); const observed = vi.fn(noop)
  const off = onVaultPersist(observed)
  try {
    hooks.beforeWrite = async () => { throw new Error('SYNTHETIC-WRITER-SECRET') }
    await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop, hash(before))).rejects.toThrow('SYNC_WRITE_FAILED')
    expect(store.syncSnapshot()).toEqual(previous); expect(store.getHistory()).toEqual(history)
    expect(await readFile(path, 'utf8')).toBe(before); expect(observed).not.toHaveBeenCalled()
    await store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop, hash(before))
    expect(store.syncSnapshot()).toEqual([remoteEntry()]); expect(observed).toHaveBeenCalledTimes(1)
  } finally { off() }
})

test.each(['authorization', 'lock', 'expiry'] as const)('revocation during atomic write rolls back encrypted original bytes: %s', async mode => {
  const { store, path, before } = await fixture()
  const previous = store.syncSnapshot(); let revoked = false
  const observed = vi.fn(noop); const off = onVaultPersist(observed)
  try {
    hooks.afterWrite = async () => {
      if (mode === 'lock') await store.lock()
      else if (mode === 'expiry') { store.setAutoLock(1); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100) }
      else revoked = true
    }
    await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), () => { if (revoked) throw new Error('SYNTHETIC-REVOKED') })).rejects.toThrow(mode === 'authorization' ? 'SYNC_NOT_AUTHORIZED' : 'SYNC_LOCKED')
    expect(await readFile(path, 'utf8')).toBe(before); expect(hooks.writes).toBe(2); expect(observed).not.toHaveBeenCalled()
    vi.restoreAllMocks(); store.setAutoLock(undefined)
    if (store.isLocked) await store.unlock()
    expect(store.syncSnapshot()).toEqual(previous)
  } finally { off() }
})

test('an atomic rollback failure is generic, is never reported committed, and does not publish memory', async () => {
  const { store } = await fixture(); const previous = store.syncSnapshot(); let revoked = false
  hooks.afterWrite = async () => { revoked = true; hooks.beforeWrite = async () => { throw new Error('SYNTHETIC-ROLLBACK-SECRET') } }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), () => { if (revoked) throw new Error() })).rejects.toThrow('SYNC_ROLLBACK_FAILED')
  expect(store.syncSnapshot()).toEqual(previous); expect(store.getHistory().some(e => e.action === 'sync')).toBe(false)
})

test('every ordinary mutator and key-changing entry point rejects retryably during sync atomic I/O', async () => {
  const { store } = await fixture(); const id = store.list()[0]!.id
  const exported = await store.exportEncrypted('synthetic-export-fixture-password')
  const rejected: string[] = []
  hooks.beforeWrite = async () => {
    const calls: Array<[string, () => unknown]> = [
      ['add', () => store.add({ title: 'blocked' })], ['update', () => store.update(id, { password: 'blocked' })],
      ['delete', () => store.delete(id)], ['restore', () => store.restore(id)], ['restoreRecent', () => store.restoreRecent()],
      ['purge', () => store.purge(id)], ['favorite', () => store.setFavorite(id, true)], ['merge', () => store.merge(id, id)],
      ['markUsed', () => store.markUsed(id)], ['rollbackPassword', () => store.rollbackPassword(id, 1)],
      ['insertDirect', () => store.insertDirect(remoteEntry('blocked'))], ['addMany', () => store.addMany([{ title: 'blocked' }])],
      ['import', () => store.importEncrypted(exported, 'synthetic-export-fixture-password')],
      ['rekey', () => store.rekey()], ['load', () => store.load()], ['unlock', () => store.unlock()],
    ]
    for (const [name, call] of calls) {
      try { await call(); throw new Error('did not reject') }
      catch (error) { expect((error as Error).message).toBe('SYNC_BUSY'); rejected.push(name) }
    }
  }
  await store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop)
  expect(rejected).toHaveLength(16); expect(store.syncSnapshot()).toEqual([remoteEntry()])
  await store.add({ title: 'retry succeeds' }); expect(store.list()).toHaveLength(2)
})

test('async import already deriving a key cannot mutate halfway through sync commit', async () => {
  const { store } = await fixture()
  const blob = await store.exportEncrypted('synthetic-export-fixture-password')
  const derive = cryptoModule.deriveKey
  let derived!: () => void, release!: () => void
  const didDerive = new Promise<void>(resolve => { derived = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(cryptoModule, 'deriveKey').mockImplementationOnce(async (...args) => { const key = await derive(...args); derived(); await gate; return key })
  const importing = store.importEncrypted(blob, 'synthetic-export-fixture-password', true)
  const rejectedImport = expect(importing).rejects.toThrow('SYNC_BUSY')
  await didDerive
  // Complete derivation only AFTER the sync writer owns its commit gate.
  hooks.beforeWrite = async () => { release(); await rejectedImport }
  try { await store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop); await rejectedImport }
  finally { release() }
  expect(store.syncSnapshot()).toEqual([remoteEntry()])
})

test('sync refuses key transitions that started before queue dispatch', async () => {
  const { store, before, path } = await fixture()
  const fingerprint = store.syncFingerprint()
  const rekeying = store.rekey()
  await expect(store.replaceForSync([remoteEntry()], fingerprint, noop)).rejects.toThrow('SYNC_LOCKED')
  await rekeying
  expect(store.list()[0]!.title).toBe('Local fixture')
  expect(await readFile(path, 'utf8')).not.toBe(before)
})

// Exhaustive finite-domain permutations: no dependency install is needed for
// the canonicalizer's order-invariance and the sealing roundtrip properties.
test('fingerprints are invariant under all entry permutations and nested key permutations; sealed JSON roundtrips', async () => {
  const { store } = await fixture()
  const ids = ['permutation-a', 'permutation-b', 'permutation-c']
  const permutations = <T>(values: T[]): T[][] => values.length === 0 ? [[]] : values.flatMap((value, i) => permutations(values.filter((_, j) => j !== i)).map(rest => [value, ...rest]))
  let expected: string | undefined
  for (const order of permutations(ids)) {
    for (const entry of store.syncSnapshot()) await store.purge(entry.id)
    for (const keys of permutations(['__proto__', '2', '10', 'unicode-雪'])) {
      for (const id of order) {
        const fields = Object.fromEntries(keys.map(key => [key, [null, false, 0, -0, 'nested value', { z: 2, a: 1 }]]))
        store.insertDirect({ ...remoteEntry(id), fields })
      }
      const fingerprint = store.syncFingerprint()
      expected ??= fingerprint
      expect(fingerprint).toBe(expected)
      const snapshot = store.syncSnapshot()
      expect(store.unsealLocalSyncState(store.sealLocalSyncState(snapshot))).toEqual(snapshot)
    }
  }
  const entry = store.get(ids[0]!)!; entry.fields!.changed = true
  expect(store.syncFingerprint()).not.toBe(expected)
})

test('a lock/unlock cycle while queued revokes sync even when final memory is unchanged', async () => {
  const { store, path, before } = await fixture(); const fingerprint = store.syncFingerprint()
  let release!: () => void
  ;(store as unknown as { persistChain: Promise<unknown> }).persistChain = new Promise<void>(resolve => { release = resolve })
  const pending = store.replaceForSync([remoteEntry()], fingerprint, noop)
  await store.lock(); await store.unlock(); release()
  await expect(pending).rejects.toThrow('SYNC_LOCKED')
  expect(store.syncFingerprint()).toBe(fingerprint); expect(await readFile(path, 'utf8')).toBe(before)
})

test('ordinary mutations remain available during the file-lock wait and force a stale sync to fail', async () => {
  const { store, path } = await fixture()
  let update: Promise<VaultEntry | undefined> | undefined
  const id = store.list()[0]!.id
  hooks.lock = async () => { update = store.update(id, { notes: 'ordinary edit during lock wait' }) }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop)).rejects.toThrow('SYNC_LOCAL_CHANGED')
  await update
  const restarted = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  expect(restarted.get(id)!.notes).toBe('ordinary edit during lock wait'); await restarted.lock()
})


test('lock cleanup failure after publication reports uncertain commit, not a retryable write failure', async () => {
  const { store, path } = await fixture(); const observed = vi.fn(noop); const off = onVaultPersist(observed)
  try {
    hooks.afterLock = async () => { throw new Error('SYNTHETIC-LOCK-CLEANUP-SECRET') }
    await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop)).rejects.toThrow('SYNC_COMMIT_UNCERTAIN')
    expect(store.syncSnapshot()).toEqual([remoteEntry()]); expect(observed).toHaveBeenCalledTimes(1)
    const restarted = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
    expect(restarted.syncSnapshot()).toEqual([remoteEntry()]); await restarted.lock()
  } finally { off() }
})

test('external write before preview cannot bless stale cached memory by supplying the latest disk hash', async () => {
  const { store, path, before } = await fixture()
  const knownRevision = store.syncDiskHash()
  expect(knownRevision).toBe(hash(before))
  const other = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  try {
    const externalEntry = await other.add({ title: 'External before preview', password: 'SYNTHETIC-EXTERNAL-BEFORE-PREVIEW' })
    // Capture AFTER the external commit: the cached entries are still stale.
    const staleEntries = store.syncSnapshot(); const staleFingerprint = store.syncFingerprint()
    const actualDisk = await readFile(path, 'utf8'); const latestDiskHash = hash(actualDisk)
    expect(staleEntries.some(entry => entry.id === externalEntry.id)).toBe(false)
    expect(store.syncDiskHash()).toBe(knownRevision); expect(store.syncDiskHash()).not.toBe(latestDiskHash)
    hooks.writes = 0
    await expect(store.replaceForSync(staleEntries, staleFingerprint, noop, latestDiskHash)).rejects.toThrow('SYNC_LOCAL_CHANGED')
    await expect(store.replaceForSync(staleEntries, staleFingerprint, noop, knownRevision)).rejects.toThrow('SYNC_LOCAL_CHANGED')
    await expect(store.replaceForSync(staleEntries, staleFingerprint, noop)).rejects.toThrow('SYNC_LOCAL_CHANGED')
    expect(hooks.writes).toBe(0); expect(await readFile(path, 'utf8')).toBe(actualDisk)
    const reloaded = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
    expect(reloaded.get(externalEntry.id)!.password).toBe('SYNTHETIC-EXTERNAL-BEFORE-PREVIEW')
    expect(reloaded.syncDiskHash()).toBe(latestDiskHash); await reloaded.lock()
  } finally { await other.lock() }
})

test('disk revision tracks exact loaded bytes and every successful document mutation path', async () => {
  const { store, path } = await fixture()
  const check = async () => expect(store.syncDiskHash()).toBe(createHash('sha256').update(await readFile(path)).digest('hex'))
  await check()
  const beforeRead = store.syncDiskHash(); const history = store.getHistory(); const stamp = (store as unknown as { lastActivity: number }).lastActivity
  expect(store.syncDiskHash()).toBe(beforeRead); expect(store.getHistory()).toEqual(history); expect((store as unknown as { lastActivity: number }).lastActivity).toBe(stamp)
  await store.update(store.list()[0]!.id, { notes: 'ordinary update' }); await check()
  await store.addMany([{ title: 'Batch revision fixture' }]); await check()
  const exported = await store.exportEncrypted('synthetic-revision-export-password')
  await store.importEncrypted(exported, 'synthetic-revision-export-password', true); await check()
  await store.persist(); await check()
  await store.replaceForSync(store.syncSnapshot(), store.syncFingerprint(), noop, store.syncDiskHash()); await check()
  await store.rekey(); await check()
  await store.lock(); await store.unlock(); await check()
  // Formatting is part of the exact revision, not a re-serialized approximation.
  const pretty = JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2) + '\n'
  await writeFile(path, pretty, 'utf8')
  const loaded = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  expect(loaded.syncDiskHash()).toBe(hash(pretty)); expect(loaded.syncSnapshot()).toEqual(store.syncSnapshot()); await loaded.lock()
})

test('new empty vault revision is established by initial persist before it is returned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-sync-revision-empty-')); const path = join(dir, 'vault.json')
  const store = await openVault({ path, masterPassword: 'synthetic-empty-revision-password' }); fixtures.push({ dir, store })
  expect(store.syncSnapshot()).toEqual([])
  expect(store.syncDiskHash()).toBe(createHash('sha256').update(await readFile(path)).digest('hex'))
})

test('failed sync write preserves cached disk revision and failed rollback invalidates it', async () => {
  const { store, path } = await fixture(); const before = store.syncDiskHash()
  hooks.beforeWrite = async () => { throw new Error('SYNTHETIC-FAIL-BEFORE-COMMIT') }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), noop, before)).rejects.toThrow('SYNC_WRITE_FAILED')
  expect(store.syncDiskHash()).toBe(before)
  let revoked = false
  hooks.afterWrite = async () => { revoked = true; hooks.beforeWrite = async () => { throw new Error('SYNTHETIC-ROLLBACK-FAIL') } }
  await expect(store.replaceForSync([remoteEntry()], store.syncFingerprint(), () => { if (revoked) throw new Error() }, before)).rejects.toThrow('SYNC_ROLLBACK_FAILED')
  expect(() => store.syncDiskHash()).toThrow('SYNC_LOCAL_CHANGED')
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).not.toBe(before)
})

test('load refresh waits for admitted local writes and replaces rather than merges the entry map', async () => {
  const { store, path } = await fixture()
  const admitted = store.add({ title: 'Admitted before reload' })
  const loading = store.load()
  await expect(store.add({ title: 'Must retry during reload' })).rejects.toThrow('SYNC_BUSY')
  await expect(store.persist()).rejects.toThrow('SYNC_BUSY')
  await admitted; await loading
  expect(store.list().some(entry => entry.title === 'Admitted before reload')).toBe(true)
  expect(store.syncDiskHash()).toBe(createHash('sha256').update(await readFile(path)).digest('hex'))
  const other = await openVault({ path, masterPassword: 'synthetic-sync-fixture-password' })
  try {
    for (const entry of other.list()) await other.purge(entry.id)
    expect(store.list().length).toBeGreaterThan(0)
    await store.load()
    expect(store.syncSnapshot()).toEqual([])
    expect(store.syncDiskHash()).toBe(other.syncDiskHash())
  } finally { await other.lock() }
})



test.each(['batch', 'rekey'] as const)('failed %s publication cannot bless its newer encrypted disk revision', async mode => {
  const { store, path } = await fixture(); const before = store.syncDiskHash()
  hooks.afterLock = async () => { throw new Error('SYNTHETIC-POSTWRITE-LOCK-CLEANUP') }
  if (mode === 'batch') await expect(store.addMany([{ title: 'Unpublished batch' }])).rejects.toThrow()
  else await expect(store.rekey()).rejects.toThrow()
  const actual = createHash('sha256').update(await readFile(path)).digest('hex')
  expect(store.syncDiskHash()).toBe(before); expect(actual).not.toBe(before)
  await expect(store.replaceForSync(store.syncSnapshot(), store.syncFingerprint(), noop, actual)).rejects.toThrow('SYNC_LOCAL_CHANGED')
})

test('failed reload invalidates cached revision and only a successful authenticated reload reestablishes it', async () => {
  const { store, path, before } = await fixture(); const revision = store.syncDiskHash()
  const invalid = JSON.parse(before) as { verify: { dataHex: string } }
  invalid.verify.dataHex = (invalid.verify.dataHex.startsWith('00') ? '01' : '00') + invalid.verify.dataHex.slice(2)
  await writeFile(path, JSON.stringify(invalid), 'utf8')
  await expect(store.load()).rejects.toThrow()
  expect(() => store.syncDiskHash()).toThrow('SYNC_LOCAL_CHANGED')
  await writeFile(path, before, 'utf8'); await store.load()
  expect(store.syncDiskHash()).toBe(revision)
})
