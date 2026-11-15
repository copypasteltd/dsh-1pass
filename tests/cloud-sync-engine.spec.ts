import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as crypto from '../src/crypto.ts'
import type { FieldValue, VaultEntry } from '../src/store.ts'
import type { VaultSyncSnapshot } from '../src/cloud-sync/types.ts'
import {
  canonical, syncHash, sealSyncSnapshot, openSyncSnapshot, mergeVaultEntries, resolveVaultMerge,
  type VaultSyncSnapshotMetadata,
} from '../src/cloud-sync/engine.ts'

// Synthetic fixtures only: never open a VaultStore, contact a provider or read real credentials.
const PASSWORD = 'synthetic sync test passphrase'
const SECRET = 'synthetic-secret-sentinel'
const ERROR = 'vault sync: password is incorrect or snapshot is invalid'
const metadata: VaultSyncSnapshotMetadata = {
  id: 'synthetic-snapshot-01', createdAt: '2026-11-15T00:00:00.000Z', transport: 'git',
  vaultName: 'synthetic-vault', deviceId: 'synthetic-device-a', deviceName: 'Device A',
}
function entry(patch: Partial<VaultEntry> = {}): VaultEntry {
  return { id: 'entry-a', title: 'Synthetic account', password: SECRET, createdAt: 100, updatedAt: 100, ...patch }
}
function copy<T>(value: T): T { return structuredClone(value) }
function rehash(snapshot: VaultSyncSnapshot): VaultSyncSnapshot {
  const { contentHash: _, ...body } = snapshot
  snapshot.contentHash = syncHash(body)
  return snapshot
}
function assertSafeError(error: unknown, ...extra: string[]): void {
  expect(error).toBeInstanceOf(Error)
  const diagnostic = String(error)
  expect(diagnostic).toContain(ERROR)
  for (const secret of [PASSWORD, SECRET, 'entry-a', ...extra]) expect(diagnostic).not.toContain(secret)
  expect((error as Error).cause).toBeUndefined()
}
afterEach(() => vi.restoreAllMocks())

describe('canonical JSON and exact CAS hashing', () => {
  test('sorts every object, not arrays, including numeric keys; handles optional undefined', () => {
    expect(canonical({ z: { c: 2, b: 1 }, a: [2, 1], optional: undefined, '10': true, '2': false }))
      .toBe('{"10":true,"2":false,"a":[2,1],"z":{"b":1,"c":2}}')
    expect(canonical([undefined, null, -0])).toBe('[null,null,0]')
    expect(syncHash({ b: 2, a: 1 })).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'))
    expect(syncHash(entry())).not.toBe(syncHash(entry({ updatedAt: 101 })))
  })
  test('rejects exotic values, unsafe keys, accessors, cycles and non-finite numbers safely', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const getter = vi.fn(() => SECRET)
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: getter })
    for (const value of [new Date(), new Map(), Infinity, NaN, 1n, cycle, accessor,
      JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: SECRET }, { nested: { prototype: SECRET } }]) {
      expect(() => canonical(value)).toThrow('vault sync: invalid JSON data')
    }
    expect(getter).not.toHaveBeenCalled()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  test('generated key-order invariance and canonical roundtrip without another dependency', () => {
    // The workspace has no PBT library; deterministic generated coverage adds no package/install.
    for (let i = 0; i < 150; i++) {
      const fields = Array.from({ length: i % 15 }, (_, j) => ['k' + ((j * 7) % 17), { n: i * j, text: '例/~' + i, list: [null, true, j] }] as const)
      const forward = Object.fromEntries(fields), backward = Object.fromEntries([...fields].reverse())
      expect(canonical(forward)).toBe(canonical(backward))
      expect(canonical(JSON.parse(canonical(forward)))).toBe(canonical(forward))
      expect(syncHash(forward)).toBe(syncHash(backward))
    }
  })
})

describe('authenticated encrypted vault snapshots', () => {
  let snapshot: VaultSyncSnapshot
  const allData = entry({
    kind: 'ssh', sensitivity: 'high', username: 'synthetic-user', email: 'fixture@example.invalid',
    phone: '+000000', icon: '🔒', color: '#111', host: 'fixture.invalid', port: '22',
    privateKey: 'synthetic-key', sshAuth: 'certificate', certificate: 'synthetic-cert',
    keyPassphrase: 'synthetic-key-pass', ip: '192.0.2.1', apiKey: 'synthetic-api',
    secret: 'synthetic-shared', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
    expiresAt: 100000, rotationDays: 30, envKey: 'SYNTHETIC', envKeys: ['SYNTHETIC', 'SYNTHETIC_NEXT'],
    otpSecret: 'synthetic-otp', cardNumber: 'synthetic-card', cardCvv: 'synthetic-cvv',
    cardExpiry: '12/99', cardHolder: 'Synthetic User', url: 'https://example.invalid',
    notes: 'synthetic notes', tags: ['fixture'], favorite: true, deletedAt: 200,
    cookies: [{ name: 'session', value: 'synthetic-cookie', domain: 'example.invalid', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
    passwordHistory: [{ password: 'synthetic-previous-password', at: 150 }],
    attachments: { 'example.txt': { name: 'example.txt', data: 'dGVzdA==', size: 4, mime: 'text/plain' } },
    fields: { region: 'fixture-region', nested: { list: [null, 1, true] } }, updatedAt: 300,
  })
  beforeAll(async () => { snapshot = await sealSyncSnapshot([allData], PASSWORD, metadata) })

  test('roundtrips all data, trash, history, cookie and attachment bytes; envelope has no entry IDs/secrets', async () => {
    expect(await openSyncSnapshot(snapshot, PASSWORD)).toEqual([allData])
    expect(snapshot.manifest.sections).toEqual(['vault'])
    expect(snapshot.encryptedPayload.kdf).toMatchObject({ algo: 'scrypt', n: 32768, r: 8, p: 1 })
    expect(snapshot.encryptedPayload.nonce).toMatch(/^[a-f0-9]{24}$/)
    expect(snapshot.encryptedPayload.tag).toMatch(/^[a-f0-9]{32}$/)
    expect(snapshot.encryptedPayload.ciphertext).toMatch(/^(?:[a-f0-9]{2})+$/)
    const { contentHash, ...body } = snapshot
    expect(contentHash).toBe(syncHash(body))
    const wire = JSON.stringify(snapshot)
    for (const secret of [SECRET, 'entry-a', 'synthetic-previous-password', 'synthetic-cookie', 'synthetic-api']) expect(wire).not.toContain(secret)
  })
  test('uses fresh salts/nonces and decrypts generated Unicode/optional fixtures including empty lists', async () => {
    let previous: VaultSyncSnapshot | undefined
    for (let i = 0; i < 4; i++) {
      const entries = Array.from({ length: i }, (_, j) => entry({ id: 'generated-' + j, title: '例/~' + i, fields: { n: i, empty: [], bool: true, null: null }, tags: [String(j)] }))
      const sealed = await sealSyncSnapshot(entries, PASSWORD, { ...metadata, id: 'generated-snapshot-' + i })
      expect(await openSyncSnapshot(sealed, PASSWORD)).toEqual(entries)
      if (previous) {
        expect(sealed.encryptedPayload.kdf.saltHex).not.toBe(previous.encryptedPayload.kdf.saltHex)
        expect(sealed.encryptedPayload.nonce).not.toBe(previous.encryptedPayload.nonce)
      }
      previous = sealed
    }
  }, 15000)
  test('copies data and metadata before the async derivation boundary', async () => {
    const data = [entry()], meta = { ...metadata }
    const pending = sealSyncSnapshot(data, PASSWORD, meta)
    data[0]!.password = 'changed-after-call'; meta.deviceName = 'Changed device'
    const sealed = await pending
    expect((await openSyncSnapshot(sealed, PASSWORD))[0]?.password).toBe(SECRET)
    expect(sealed.manifest.deviceName).toBe(metadata.deviceName)
    const unsealing = openSyncSnapshot(sealed, PASSWORD)
    sealed.manifest.deviceName = 'Changed again'; sealed.encryptedPayload.tag = '0'.repeat(32)
    expect((await unsealing)[0]?.password).toBe(SECRET)
  })
  test('wrong password and ciphertext/tag/nonce corruption share one secret-free error', async () => {
    const mutations: Array<(s: VaultSyncSnapshot) => void> = [
      s => { s.encryptedPayload.tag = (s.encryptedPayload.tag.startsWith('0') ? '1' : '0') + s.encryptedPayload.tag.slice(1) },
      s => { s.encryptedPayload.nonce = (s.encryptedPayload.nonce.startsWith('0') ? '1' : '0') + s.encryptedPayload.nonce.slice(1) },
      s => { s.encryptedPayload.ciphertext = (s.encryptedPayload.ciphertext.startsWith('0') ? '1' : '0') + s.encryptedPayload.ciphertext.slice(1) },
    ]
    await openSyncSnapshot(snapshot, 'synthetic-wrong-password').then(() => { throw new Error('must reject') }, e => assertSafeError(e, 'synthetic-wrong-password'))
    for (const mutate of mutations) {
      const altered = copy(snapshot); mutate(altered); rehash(altered)
      await openSyncSnapshot(altered, PASSWORD).then(() => { throw new Error('must reject') }, e => assertSafeError(e))
    }
  })
  test('outer hash is mandatory and verified before any derivation', async () => {
    const spy = vi.spyOn(crypto, 'deriveKey')
    const altered = copy(snapshot); altered.contentHash = '0'.repeat(64)
    await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
    expect(spy).not.toHaveBeenCalled()
  })
  test('binds every outer metadata field inside encryption even if attacker recomputes outer hash', async () => {
    const mutations: Array<(s: VaultSyncSnapshot) => void> = [
      s => { s.id = 'other-snapshot' }, s => { s.createdAt = '2026-11-16T00:00:00.000Z' },
      ...(['transport', 'vaultName', 'deviceId', 'deviceName', 'platform', 'dshVersion'] as const).map(key => (s: VaultSyncSnapshot) => {
        if (key === 'transport') s.manifest.transport = 's3'
        else s.manifest[key] = 'changed-metadata'
      }),
    ]
    for (const mutate of mutations) {
      const altered = copy(snapshot); mutate(altered); rehash(altered)
      await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
    }
  }, 15000)
  test('rejects foreign formats, sections and malformed encryption fields before deriving', async () => {
    const spy = vi.spyOn(crypto, 'deriveKey')
    const changes: Array<(s: any) => void> = [
      s => { s.format = 'dsh-config-snapshot-v1' }, s => { s.manifest.sections = ['settings'] },
      s => { s.manifest.encrypted = false }, s => { s.manifest.extra = SECRET },
      s => { s.extra = SECRET }, s => { s.contentHash = 'g'.repeat(64) },
      s => { s.createdAt = 'not-a-date' }, s => { s.id = null },
      s => { s.encryptedPayload.version = 2 }, s => { s.encryptedPayload.tag = '0'.repeat(30) },
      s => { s.encryptedPayload.nonce = 'g'.repeat(24) }, s => { s.encryptedPayload.ciphertext = 'a' },
      s => { s.encryptedPayload.ciphertext = 'zz' }, s => { s.encryptedPayload.kdf.saltHex = '0'.repeat(30) },
    ]
    for (const change of changes) {
      const altered = copy(snapshot); change(altered)
      await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
    }
    expect(spy).not.toHaveBeenCalled()
  })
  test('KDF is an exact bounded tuple, not a trusted remote resource request', async () => {
    const spy = vi.spyOn(crypto, 'deriveKey')
    for (const tuple of [{ n: 2 ** 30 }, { n: 16384 }, { n: -32768 }, { n: '32768' }, { r: 2 ** 30 }, { r: 0 }, { p: 2 }, { p: 0 }, { algo: 'argon2' }, { extra: 1 }]) {
      const altered = copy(snapshot)
      Object.assign(altered.encryptedPayload.kdf, tuple); rehash(altered)
      await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
    }
    expect(spy).not.toHaveBeenCalled()
  })
  test('wipes derived keys in success and exception paths using real AES-GCM/scrypt', async () => {
    const original = crypto.deriveKey
    const keys: Buffer[] = []
    vi.spyOn(crypto, 'deriveKey').mockImplementation(async (...args) => { const key = await original(...args); keys.push(key); return key })
    const sealed = await sealSyncSnapshot([entry()], PASSWORD, metadata)
    expect(keys.at(-1)?.every(byte => byte === 0)).toBe(true)
    await openSyncSnapshot(sealed, PASSWORD)
    expect(keys.at(-1)?.every(byte => byte === 0)).toBe(true)
    await expect(openSyncSnapshot(sealed, 'synthetic-wrong-password')).rejects.toThrow(ERROR)
    expect(keys.at(-1)?.every(byte => byte === 0)).toBe(true)
    vi.spyOn(crypto, 'encrypt').mockImplementation(() => { throw new Error(SECRET) })
    await expect(sealSyncSnapshot([entry()], PASSWORD, metadata)).rejects.toThrow(ERROR)
    expect(keys.at(-1)?.every(byte => byte === 0)).toBe(true)
  })
  test('enforces entry count and complete plaintext 10MiB bound before deriving', async () => {
    const spy = vi.spyOn(crypto, 'deriveKey')
    const tooMany = Array.from({ length: 10001 }, (_, i) => entry({ id: 'count-' + i }))
    await expect(sealSyncSnapshot(tooMany, PASSWORD, metadata)).rejects.toThrow(ERROR)
    // entries alone may fit, but payload+checksum+manifest overhead must also be bounded.
    await expect(sealSyncSnapshot([entry({ notes: 'x'.repeat(10 * 1024 * 1024) })], PASSWORD, metadata)).rejects.toThrow(ERROR)
    const altered = copy(snapshot); altered.encryptedPayload.ciphertext = '00'.repeat(10 * 1024 * 1024 + 1)
    await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
    expect(spy).not.toHaveBeenCalled()
  })
  test('accepts the exact plaintext, entry-count and field-count maxima', async () => {
    const limit = 10 * 1024 * 1024
    const empty = await sealSyncSnapshot([entry({ notes: '' })], PASSWORD, metadata)
    const overhead = empty.encryptedPayload.ciphertext.length / 2
    const full = entry({ notes: 'x'.repeat(limit - overhead) })
    const sealed = await sealSyncSnapshot([full], PASSWORD, metadata)
    expect(sealed.encryptedPayload.ciphertext.length).toBe(limit * 2)
    expect(await openSyncSnapshot(sealed, PASSWORD)).toEqual([full])
    const spy = vi.spyOn(crypto, 'deriveKey')
    await expect(sealSyncSnapshot([entry({ notes: 'x'.repeat(limit - overhead + 1) })], PASSWORD, metadata)).rejects.toThrow(ERROR)
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore()
    const fields = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['field-' + i, i]))
    const many = Array.from({ length: 10000 }, (_, i) => entry({ id: 'entry-' + i, ...(i === 0 ? { fields } : {}) }))
    const manySealed = await sealSyncSnapshot(many, PASSWORD, metadata)
    expect(await openSyncSnapshot(manySealed, PASSWORD)).toEqual(many)
  }, 20000)
  test('rejects duplicate IDs, invalid fixed types, oversized/deep fields and pollution without secret errors', async () => {
    const deep: Record<string, FieldValue> = {}; let node = deep
    for (let i = 0; i < 21; i++) { const child: Record<string, FieldValue> = {}; node.next = child; node = child }
    const invalid: unknown[] = [
      [entry(), entry()], [entry({ password: 1 as any })], [entry({ id: '' })],
      [entry({ title: [] as any })], [entry({ createdAt: -1 })], [entry({ updatedAt: Infinity })],
      [entry({ deletedAt: 'wrong' as any })], [entry({ favorite: 'yes' as any })],
      [entry({ kind: 'foreign' as any })], [entry({ tags: [1] as any })],
      [entry({ fields: [] as any })], [entry({ fields: deep })],
      [entry({ fields: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => ['field-' + i, i])) })],
      [entry({ passwordHistory: [{ password: SECRET, at: 'wrong' as any }] })],
      [entry({ attachments: { bad: { name: 'bad', data: SECRET, size: -1 } } })],
      [entry({ cookies: [{ name: 'x' } as any] })], [Object.assign(entry(), { unknownField: SECRET })],
      [entry({ fields: JSON.parse('{"__proto__":{"secret":"synthetic-secret-sentinel"}}') })],
      [entry({ fields: { nested: { constructor: SECRET } } })],
    ]
    const spy = vi.spyOn(crypto, 'deriveKey')
    for (const data of invalid) {
      await sealSyncSnapshot(data as VaultEntry[], PASSWORD, metadata).then(() => { throw new Error('must reject') }, e => assertSafeError(e))
    }
    expect(spy).not.toHaveBeenCalled()
    expect(({} as Record<string, unknown>).secret).toBeUndefined()
  })
  test('authenticates inner magic, checksum and manifest; validates entries after decrypt too', async () => {
    const key = await crypto.deriveKey(PASSWORD, snapshot.encryptedPayload.kdf)
    try {
      const plaintext = crypto.decrypt({ ivHex: snapshot.encryptedPayload.nonce, tagHex: snapshot.encryptedPayload.tag, dataHex: snapshot.encryptedPayload.ciphertext }, key)
      const payload = JSON.parse(plaintext.toString('utf8')); plaintext.fill(0)
      const variants = [
        { ...payload, format: 'dsh-settings' }, { ...payload, checksum: '0'.repeat(64) },
        { ...payload, entries: [entry(), entry()] },
        { ...payload, entries: [entry({ fields: { nested: { constructor: SECRET } } })] },
        { ...payload, entries: [entry({ password: 123 as any })] },
      ]
      for (let i = 0; i < variants.length; i++) {
        const candidate = variants[i]!
        if (i >= 2) {
          const { checksum: _, ...body } = candidate
          // Poisoned-map payload must be encoded by an untrusted writer, not our validator.
          if (i === 3) candidate.checksum = '0'.repeat(64)
          else candidate.checksum = syncHash(body)
        }
        const raw = Buffer.from(JSON.stringify(candidate)), encrypted = crypto.encrypt(raw, key); raw.fill(0)
        const altered = copy(snapshot)
        altered.encryptedPayload = { ...altered.encryptedPayload, nonce: encrypted.ivHex, tag: encrypted.tagHex, ciphertext: encrypted.dataHex }
        rehash(altered)
        await expect(openSyncSnapshot(altered, PASSWORD)).rejects.toThrow(ERROR)
      }
    } finally { key.fill(0) }
  })
})

describe('entry-ID three-way merge', () => {
  test('joins IDs, keeps same-title different entries, and reports equal entries as skip', () => {
    const local = [entry({ id: 'two' }), entry()], remote = [entry(), entry({ id: 'three' })]
    const plan = mergeVaultEntries(local, remote)
    expect(plan.items.map(item => [item.id, item.decision])).toEqual([['entry-a', 'skip'], ['three', 'useRemote'], ['two', 'keepLocal']])
    expect(plan.entries.map(e => e.id)).toEqual(['entry-a', 'three', 'two'])
    expect(resolveVaultMerge(plan, [])).toEqual({ entries: plan.entries, pending: [] })
  })
  test('without ancestor neither overwrite nor infer purge from absence', () => {
    const local = entry({ password: 'device-a-password' }), remote = entry({ password: 'device-b-password' })
    const plan = mergeVaultEntries([local], [remote])
    expect(plan.items[0]).toMatchObject({ decision: 'conflict', conflicts: [{ path: '', reason: 'no-ancestor' }] })
    expect(plan.entries).toEqual([local])
    expect(resolveVaultMerge(plan, [])).toEqual({ entries: [local], pending: [local.id] })
    expect(mergeVaultEntries([local], []).entries).toEqual([local])
    expect(mergeVaultEntries([], [remote]).entries).toEqual([remote])
    expect(mergeVaultEntries([local], [remote], []).items[0]?.decision).toBe('conflict')
  })
  test('ignores updatedAt only for semantic equality; keeps createdAt and exact chosen timestamps', () => {
    const base = entry(), newer = entry({ updatedAt: 900 })
    expect(mergeVaultEntries([base], [newer], [base]).items[0]?.decision).toBe('skip')
    expect(mergeVaultEntries([base], [newer], [base]).entries).toEqual([base])
    const remote = entry({ password: 'changed', updatedAt: 800 })
    expect(mergeVaultEntries([newer], [remote], [base]).entries).toEqual([remote])
    expect(syncHash(base)).not.toBe(syncHash(newer))
    expect(mergeVaultEntries([base], [entry({ createdAt: 500 })]).items[0]?.decision).toBe('conflict')
  })
  test('merges independent devices/fields with max update time, retaining original creation', () => {
    const base = entry({ username: 'base-user', fields: { region: 'base', nested: { a: 1, b: 1 } } })
    const local = { ...base, username: 'local-user', fields: { region: 'base', nested: { a: 2, b: 1 } }, updatedAt: 200 }
    const remote = { ...base, notes: 'remote-note', fields: { region: 'remote', nested: { a: 1, b: 2 } }, updatedAt: 300 }
    const plan = mergeVaultEntries([local], [remote], [base])
    expect(plan.items[0]?.decision).toBe('merge')
    expect(plan.entries).toEqual([{ ...base, username: 'local-user', notes: 'remote-note', fields: { region: 'remote', nested: { a: 2, b: 2 } }, updatedAt: 300 }])
    expect(resolveVaultMerge(plan, []).pending).toEqual([])
    const reverse = mergeVaultEntries([remote], [local], [base])
    expect(reverse.entries).toEqual(plan.entries)
  })
  test('password conflict preserves the full local entry until explicit resolution', () => {
    const base = entry(), local = entry({ password: 'device-a', updatedAt: 200 }), remote = entry({ password: 'device-b', notes: 'remote-note', updatedAt: 300 })
    const plan = mergeVaultEntries([local], [remote], [base])
    expect(plan.items[0]?.conflicts).toEqual([{ path: '/password', reason: 'both-modified' }])
    expect(plan.entries).toEqual([local])
    expect(plan.items[0]?.merged).toEqual({ ...local, notes: 'remote-note', updatedAt: 300 })
    expect(resolveVaultMerge(plan, [])).toEqual({ entries: [local], pending: ['entry-a::/password'] })
    expect(resolveVaultMerge(plan, [{ id: 'entry-a::/password', action: 'useRemote' }])).toEqual({ entries: [{ ...remote }], pending: [] })
    expect(resolveVaultMerge(plan, [{ id: 'entry-a', action: 'keepLocal' }])).toEqual({ entries: [local], pending: [] })
    expect(resolveVaultMerge(plan, [{ id: 'entry-a', action: 'useMerged' }])).toEqual({ entries: [plan.items[0]?.merged], pending: [] })
    const diagnostic = JSON.stringify(plan.items[0]?.conflicts)
    expect(diagnostic).not.toContain('device-a'); expect(diagnostic).not.toContain('device-b')
  })
  test('arrays, password history and attachment maps are atomic and cannot silently discard concurrent data', () => {
    const base = entry({ tags: ['base'], passwordHistory: [{ password: 'previous', at: 50 }], attachments: { base: { name: 'base', data: 'YQ==', size: 1 } } })
    const local = { ...base, tags: ['local'], passwordHistory: [{ password: 'local-previous', at: 200 }], attachments: { ...base.attachments, local: { name: 'local', data: 'Yg==', size: 1 } }, updatedAt: 200 }
    const remote = { ...base, tags: ['remote'], passwordHistory: [{ password: 'remote-previous', at: 300 }], attachments: { ...base.attachments, remote: { name: 'remote', data: 'Yw==', size: 1 } }, updatedAt: 300 }
    const plan = mergeVaultEntries([local], [remote], [base])
    expect(plan.items[0]?.conflicts.map(c => c.path)).toEqual(['/attachments', '/passwordHistory', '/tags'])
    expect(plan.entries).toEqual([local])
  })
  test('purge wins over unchanged ancestor, but purge versus modification conflicts in both directions', () => {
    const base = entry(), edited = entry({ notes: 'changed', updatedAt: 200 })
    expect(mergeVaultEntries([base], [], [base]).entries).toEqual([])
    expect(mergeVaultEntries([], [base], [base]).entries).toEqual([])
    expect(mergeVaultEntries([], [], [base]).items[0]?.decision).toBe('skip')
    const remotePurge = mergeVaultEntries([edited], [], [base])
    expect(remotePurge.items[0]?.conflicts).toEqual([{ path: '', reason: 'modify-delete' }])
    expect(remotePurge.entries).toEqual([edited])
    expect(resolveVaultMerge(remotePurge, [{ id: edited.id, action: 'useRemote' }])).toEqual({ entries: [], pending: [] })
    const localPurge = mergeVaultEntries([], [edited], [base])
    expect(localPurge.items[0]?.conflicts).toEqual([{ path: '', reason: 'delete-modify' }])
    expect(resolveVaultMerge(localPurge, [])).toEqual({ entries: [], pending: [edited.id] })
    expect(resolveVaultMerge(localPurge, [{ id: edited.id, action: 'useRemote' }])).toEqual({ entries: [edited], pending: [] })
  })
  test('trash is explicit deletion: concurrent edit cannot become an automatically trashed or resurrected entry', () => {
    const base = entry(), trashed = entry({ deletedAt: 200, updatedAt: 200 }), edited = entry({ notes: 'edited', updatedAt: 300 })
    expect(mergeVaultEntries([base], [trashed], [base]).entries).toEqual([trashed])
    expect(mergeVaultEntries([trashed], [base], [base]).entries).toEqual([trashed])
    for (const [local, remote, reason] of [[edited, trashed, 'modify-delete'], [trashed, edited, 'delete-modify']] as const) {
      const plan = mergeVaultEntries([local], [remote], [base])
      expect(plan.items[0]?.decision).toBe('conflict')
      expect(plan.items[0]?.conflicts).toEqual([{ path: '', reason }])
      expect(plan.entries).toEqual([local])
      expect(resolveVaultMerge(plan, [{ id: 'entry-a', action: 'useMerged' }]).pending).toEqual(['entry-a'])
    }
  })
  test('nested fields support deletions, escaped pointer keys, and partial explicit choices', () => {
    const base = entry({ fields: { 'a/b~c': { x: 1, y: 1 }, removed: 1 } })
    const local = entry({ fields: { 'a/b~c': { x: 2, y: 2 } }, updatedAt: 200 })
    const remote = entry({ fields: { 'a/b~c': { x: 3, y: 3 }, removed: 2 }, notes: 'remote-note', updatedAt: 300 })
    const plan = mergeVaultEntries([local], [remote], [base])
    expect(plan.items[0]?.conflicts).toEqual([
      { path: '/fields/a~1b~0c/x', reason: 'both-modified' }, { path: '/fields/a~1b~0c/y', reason: 'both-modified' },
      { path: '/fields/removed', reason: 'delete-modify' },
    ])
    const partial = resolveVaultMerge(plan, [{ id: 'entry-a::/fields/a~1b~0c/x', action: 'useRemote' }])
    expect(partial.pending).toEqual(['entry-a::/fields/a~1b~0c/y', 'entry-a::/fields/removed'])
    expect(partial.entries[0]?.fields).toEqual({ 'a/b~c': { x: 3, y: 2 } })
    expect(partial.entries[0]?.notes).toBe('remote-note')
    const settled = resolveVaultMerge(plan, plan.items[0]!.conflicts.map(c => ({ id: 'entry-a::' + c.path, action: 'useRemote' as const })))
    expect(settled).toEqual({ entries: [remote], pending: [] })
  })
  test('top-level and nested optional field removals merge when only one side changes them', () => {
    const base = entry({ notes: 'old', fields: { a: 1, b: 1 } }), local = entry({ fields: { b: 1 }, updatedAt: 200 })
    const remote = entry({ notes: 'old', fields: { a: 1, b: 2 }, updatedAt: 300 })
    const plan = mergeVaultEntries([local], [remote], [base])
    expect(plan.entries).toEqual([entry({ fields: { b: 2 }, updatedAt: 300 })])
    expect(plan.items[0]?.decision).toBe('merge')
  })
  test('resolver is pure; entry choice precedence, literal vault ID, and invalid choices are safe', () => {
    const base = entry(), local = entry({ password: 'local' }), remote = entry({ password: 'remote', notes: 'remote' })
    const plan = mergeVaultEntries([local], [remote], [base]), before = canonical(plan)
    expect(resolveVaultMerge(plan, [{ id: 'entry-a', action: 'skip' }])).toEqual({ entries: [local], pending: [] })
    expect(resolveVaultMerge(plan, [{ id: 'entry-a', action: 'keepLocal' }, { id: 'entry-a::/password', action: 'useRemote' }]).entries).toEqual([local])
    const result = resolveVaultMerge(plan, [{ id: 'entry-a::/password', action: 'useRemote' }]); result.entries[0]!.title = 'modified return'
    expect(canonical(plan)).toBe(before)
    const vaultPlan = mergeVaultEntries([entry({ id: 'vault' })], [entry({ id: 'vault', notes: 'changed' })])
    expect(resolveVaultMerge(vaultPlan, [{ id: 'vault', action: 'useRemote' }]).entries).toEqual(vaultPlan.items.map(i => i.remote))
    for (const resolutions of [[{ id: 'missing', action: 'useRemote' }], [{ id: 'entry-a', action: 'bad' }], [{ id: 'entry-a', action: 'skip' }, { id: 'entry-a', action: 'keepLocal' }]]) {
      expect(() => resolveVaultMerge(plan, resolutions as any)).toThrow('vault sync: invalid merge resolution')
    }
  })
  test('does not let arbitrary entry IDs impersonate another entry field resolution', () => {
    const base = [entry(), entry({ id: 'entry-a::/password' })]
    const local = [entry({ password: 'local' }), entry({ id: 'entry-a::/password', password: 'local-second' })]
    const remote = [entry({ password: 'remote' }), entry({ id: 'entry-a::/password', password: 'remote-second' })]
    const plan = mergeVaultEntries(local, remote, base)
    expect(resolveVaultMerge(plan, []).entries).toEqual(local)
    expect(() => resolveVaultMerge(plan, [{ id: 'entry-a::/password', action: 'useRemote' }])).toThrow('vault sync: invalid merge resolution')
  })
  test('useMerged on each automatic item means its safe automatic decision, not a pending conflict', () => {
    const base = entry(), remote = entry({ notes: 'remote change' })
    const cases = [mergeVaultEntries([base], [remote], [base]), mergeVaultEntries([remote], [base], [base]),
      mergeVaultEntries([base], [], [base]), mergeVaultEntries([], [base]), mergeVaultEntries([base], [base])]
    for (const plan of cases) {
      expect(resolveVaultMerge(plan, plan.items.map(item => ({ id: item.id, action: 'useMerged' })))).toEqual({ entries: plan.entries, pending: [] })
    }
  })
  test('never mutates input or aliases local/remote outputs; validates duplicate/malformed IDs', () => {
    const base = [entry({ fields: { nested: { a: 1 } } })], local = copy(base), remote = [entry({ notes: 'remote', fields: { nested: { a: 1 } } })]
    const before = [canonical(base), canonical(local), canonical(remote)]
    const plan = mergeVaultEntries(local, remote, base)
    plan.entries[0]!.fields!.nested = 'modified output'
    expect([canonical(base), canonical(local), canonical(remote)]).toEqual(before)
    for (const bad of [[entry(), entry()], [entry({ password: 1 as any })]]) expect(() => mergeVaultEntries(bad, [])).toThrow('vault sync: invalid entry data')
  })
  test('generated convergence/idempotence/one-sided identity and local conflict preservation', () => {
    for (let i = 0; i < 120; i++) {
      const base = entry({ id: 'generated-' + i, title: '例' + i, fields: { one: i, two: [i, null] } })
      const local = { ...base, username: 'local-' + i, updatedAt: i + 500 }
      const remote = { ...base, notes: 'remote-' + i, updatedAt: i + 800 }
      const merged = mergeVaultEntries([local], [remote], [base])
      expect(merged.entries).toEqual(mergeVaultEntries([remote], [local], [base]).entries)
      expect(merged.entries).toEqual([{ ...base, username: local.username, notes: remote.notes, updatedAt: remote.updatedAt }])
      expect(mergeVaultEntries(merged.entries, merged.entries, [base]).entries).toEqual(merged.entries)
      expect(mergeVaultEntries([base], [remote], [base]).entries).toEqual([remote])
      expect(mergeVaultEntries([local], [base], [base]).entries).toEqual([local])
      const conflict = mergeVaultEntries([{ ...local, password: 'local-' + i }], [{ ...remote, password: 'remote-' + i }], [base])
      expect(conflict.entries).toEqual([{ ...local, password: 'local-' + i }])
      expect(resolveVaultMerge(conflict, []).pending).toEqual([base.id + '::/password'])
    }
  })
})
