import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConfigHash, VaultSyncConfigStore } from '../src/cloud-sync/config.ts'
import type { SyncSecretPort } from '../src/cloud-sync/config.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks() })
function memorySecrets() {
  const values = new Map<string, string>()
  const port: SyncSecretPort = {
    get: vi.fn(async ref => values.get(ref)), has: vi.fn(async ref => values.has(ref)),
    set: vi.fn(async (ref, value) => { values.set(ref, value) }), unset: vi.fn(async ref => { values.delete(ref) }),
  }
  return { port, values }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vault-sync-config-')); roots.push(root)
  const { port, values } = memorySecrets()
  const stateDir = join(root, 'state')
  return { root, stateDir, port, values, store: new VaultSyncConfigStore({ stateDir, secrets: port, deviceName: 'Test device' }) }
}
const s3 = { transport: 's3', provider: 's3', endpoint: 'https://s3.example.test', region: 'us-east-1', bucket: 'vault-backups', accessKeyId: 'test-access-id' }

test('missing reads and view do not create directories, mutate secrets, or create identity', async () => {
  const { root, store, port } = await fixture()
  const doc = await store.read()
  expect(doc.deviceId).toBe('')
  expect(doc.channels.git.selection).toEqual({ mode: 'default', sections: ['vault'], encrypt: true, includeSecrets: false })
  expect(doc.channels.git.autosync).toEqual({ enabled: false, interval: '30m', realtime: true, remoteCheckMs: 300000, autoApplyTier: 'medium', conflictPolicy: 'ask', startupMinIntervalMs: 300000 })
  expect(await store.view()).toMatchObject({ ok: true, configured: false, credentialConfigured: false, lastSyncChannel: 'git' })
  expect(await readdir(root)).toEqual([])
  expect(port.set).not.toHaveBeenCalled(); expect(port.unset).not.toHaveBeenCalled()
})

test('ensureIdentity is durable, stable across instances, and serialized before snapshot use', async () => {
  const { stateDir, store, port } = await fixture()
  const other = new VaultSyncConfigStore({ stateDir, secrets: port, deviceName: 'Renamed device' })
  const ids = await Promise.all([store.ensureIdentity(), other.ensureIdentity(), store.ensureIdentity()])
  expect(new Set(ids.map(doc => doc.deviceId)).size).toBe(1)
  expect(ids[0]!.deviceId).toMatch(/^[a-f0-9-]{36}$/)
  expect(JSON.parse(await readFile(store.configPath, 'utf8')).deviceId).toBe(ids[0]!.deviceId)
  expect((await other.read()).deviceName).toBe('Test device')
  if (process.platform !== 'win32') expect((await stat(store.configPath)).mode & 0o777).toBe(0o600)
})

test('git/webdav wire saves whitelist non-secret fields and never echo credentials', async () => {
  const { store, values } = await fixture()
  expect(await store.saveConfig({ repoUrl: 'https://github.com/user/private.git', subdir: 'vault-sync/', token: 'synthetic-git-token', unknownSecret: 'must-not-persist' })).toEqual({ ok: true, configured: true, transport: 'git', credentialConfigured: true })
  const dav = await store.saveConfig({ transport: 'webdav', url: 'https://dav.example.test/vault', username: 'user', password: 'synthetic-webdav-secret' })
  expect(dav).toEqual({ ok: true, configured: true, transport: 'webdav', credentialConfigured: true, webdav: { usernameConfigured: true, passwordConfigured: true } })
  expect((await store.read()).channels.webdav.config).toEqual({ transport: 'webdav', webdavUrl: 'https://dav.example.test/vault', webdavUsername: 'user' })
  expect(await store.getSecret('git', 'auth')).toBe('synthetic-git-token')
  expect(await store.getSecret('webdav', 'auth')).toBe('synthetic-webdav-secret')
  const serialized = await readFile(store.configPath, 'utf8') + JSON.stringify(await store.view()) + JSON.stringify(dav)
  for (const secret of ['synthetic-git-token', 'synthetic-webdav-secret', 'must-not-persist']) expect(serialized).not.toContain(secret)
  expect([...values.keys()]).toEqual(expect.arrayContaining([expect.stringMatching(/^DSH_1PASS_SYNC_[A-F0-9]{16}_GIT_AUTH$/), expect.stringMatching(/_WEBDAV_AUTH$/)]))
})

test.each([
  { repoUrl: '--upload-pack=malicious', token: 'never-store' },
  { repoUrl: 'https://user:password@github.com/a/b', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b?access_token=private', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b\nflag', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', subdir: '../outside', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', subdir: 'vault.with.dots', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', subdir: 'CON', token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', subdir: '%2e%2e/outside', token: 'never-store' },
  { transport: 'webdav', url: 'https://u:p@dav.example.test', password: 'never-store' },
  { ...s3, prefix: 'ok/../bad', secret: 'never-store' },
  { ...s3, dialectId: 'bad', secret: 'never-store' },
  { transport: 'gist', gistId: '../bad', secret: 'never-store' },
  { repoUrl: 'https://github.com/a/b', encrypt: false, token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', includeSecrets: true, token: 'never-store' },
  { repoUrl: 'https://github.com/a/b', token: 12 },
  { repoUrl: 'https://github.com/a/b', clearEncryptPassword: true, encryptPassword: 'never-store' },
])('invalid full config body is rejected before any secret mutation: %j', async payload => {
  const { store, port, root } = await fixture()
  await expect(store.saveConfig(payload)).rejects.toThrow('SYNC_CONFIG_INVALID')
  expect(port.set).not.toHaveBeenCalled(); expect(port.unset).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

test('git allows explicit local absolute and ssh repositories without executing anything', async () => {
  const { store, root } = await fixture()
  await store.saveConfig({ repoUrl: join(root, 'absolute repository') })
  expect((await store.read()).channels.git.config?.repoUrl).toBe(join(root, 'absolute repository'))
  await store.saveConfig({ repoUrl: 'git@github.com:owner/private.git' })
  expect((await store.read()).channels.git.config?.repoUrl).toBe('git@github.com:owner/private.git')
})

test('selection only allows vault, defaults nonempty, and password slots are write-only with explicit clears', async () => {
  const { store } = await fixture()
  const wire = await store.saveSelection({ transport: 'gist', mode: 'advanced', sections: [], encryptPassword: 'synthetic-encryption-pass', decryptPassword: 'synthetic-decryption-pass', ignoredPassword: 'discard-this' })
  expect(wire).toEqual({ transport: 'gist', mode: 'advanced', sections: [], encrypt: true, includeSecrets: false, encryptPasswordConfigured: true, decryptPasswordConfigured: true })
  expect(await store.getSecret('gist', 'encrypt')).toBe('synthetic-encryption-pass')
  expect(await store.getSecret('gist', 'decrypt')).toBe('synthetic-decryption-pass')
  await store.saveSelection({ transport: 'gist', clearEncryptPassword: true, clearDecryptPassword: true })
  expect(await store.getSecret('gist', 'encrypt')).toBeUndefined()
  expect(await store.getSecret('gist', 'decrypt')).toBeUndefined()
  for (const body of [{ sections: ['settings'] }, { encrypt: false }, { includeSecrets: true }, { mode: 'arbitrary' }]) await expect(store.saveSelection(body)).rejects.toThrow('SYNC_CONFIG_INVALID')
  expect(await readFile(store.configPath, 'utf8')).not.toContain('synthetic-')
})

test('autosync validates configuration, defaults ask, clamps remote intervals and persists selected channel', async () => {
  const { store } = await fixture()
  await expect(store.updateAutosync({ transport: 'webdav', enabled: true })).rejects.toThrow('SYNC_CHANNEL_UNCONFIGURED')
  await store.saveConfig({ transport: 'webdav', url: 'https://dav.example.test', username: 'u' })
  expect(await store.updateAutosync({ transport: 'webdav', enabled: true, remoteCheckMs: 1 })).toMatchObject({ enabled: true, interval: '30m', remoteCheckMs: 15000, conflictPolicy: 'ask' })
  expect(await store.updateAutosync({ transport: 'webdav', remoteCheckMs: 99999999 })).toMatchObject({ remoteCheckMs: 3600000 })
  await expect(store.updateAutosync({ transport: 'webdav', interval: 'invalid' })).rejects.toThrow()
  await expect(store.updateAutosync({ transport: 'webdav', remoteCheckMs: NaN })).rejects.toThrow()
  await store.setUiChannel('gist')
  expect((await store.read()).active).toBe('gist')
})

test('cloud providers backfill independently and active S3 auth resolves to the selected provider slot', async () => {
  const { store, values } = await fixture()
  await store.saveConfig({ ...s3, secret: 'synthetic-s3-value' })
  const first = (await store.read()).channels.s3.config!
  await store.saveConfig({ ...s3, provider: 'oss', endpoint: 'https://oss.example.test', secret: 'synthetic-oss-value' })
  expect(await store.getSecret('s3', 'auth')).toBe('synthetic-oss-value')
  expect(values.get(store.secretRef('s3', 'auth', 's3'))).toBe('synthetic-s3-value')
  expect(await store.readConfigProvider('s3')).toMatchObject({ ok: true, provider: 's3', config: { provider: 's3', endpoint: first.endpoint, secretStored: true } })
  await store.saveConfig({ transport: 'gist', gistId: 'abc123', secret: 'synthetic-gist-value' })
  expect(await store.readConfigProvider('gist')).toMatchObject({ config: { provider: 'gist', gistId: 'abc123', secretStored: true } })
  expect((await store.view()).cloudSavedProviders).toEqual(['s3', 'oss', 'gist'])
})

test('clear removes only local channel bindings, all its slots and autosync, and switches to another configured channel', async () => {
  const { store, values } = await fixture()
  await store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'git-value' })
  await store.saveConfig({ ...s3, secret: 's3-value' })
  await store.saveConfig({ ...s3, provider: 'oss', secret: 'oss-value' })
  await store.saveSelection({ transport: 's3', encryptPassword: 'e', decryptPassword: 'd' })
  await store.updateAutosync({ transport: 's3', enabled: true })
  expect(await store.clearChannel('s3')).toEqual({ ok: true, cleared: 's3', removed: true, configured: true, transport: 'git' })
  const doc = await store.read()
  expect(doc.channels.s3.config).toBeUndefined(); expect(doc.channels.s3.autosync.enabled).toBe(false)
  expect([...values.keys()]).toEqual([store.secretRef('git', 'auth')])
  expect(await store.saveConfig({ transport: 's3', clear: true })).toMatchObject({ removed: false, configured: true })
})

test('secret write failure restores slots in memory and leaves prior config bytes unchanged, without raw errors', async () => {
  const { store, port, values } = await fixture()
  await store.saveConfig({ repoUrl: 'https://github.com/u/original', token: 'original-auth' })
  const bytes = await readFile(store.configPath, 'utf8')
  const originalSet = port.set
  port.set = vi.fn(async (ref, value) => {
    if (value === 'synthetic-rejected-auth') throw new Error('raw-secret-in-error')
    return originalSet(ref, value)
  })
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/new', encryptPassword: 'synthetic-new-password', token: 'synthetic-rejected-auth' })).rejects.toThrow('SYNC_SECRET_WRITE_FAILED')
  expect(await readFile(store.configPath, 'utf8')).toBe(bytes)
  expect(values.get(store.secretRef('git', 'auth'))).toBe('original-auth')
  expect(values.has(store.secretRef('git', 'encrypt'))).toBe(false)
})

test('disk write failure rolls secrets back and reports only sanitized error codes', async () => {
  const { store, port, values } = await fixture()
  await store.ensureIdentity()
  const originalSet = port.set
  port.set = vi.fn(async (ref, value) => {
    await originalSet(ref, value)
    // Simulate a disk race after validation but before the atomic rename.
    await rm(store.configPath, { force: true })
    await mkdir(store.configPath)
  })
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'synthetic-value' })).rejects.toThrow('SYNC_CONFIG_WRITE_FAILED')
  expect(values.size).toBe(0)
  expect(port.unset).toHaveBeenCalledWith(store.secretRef('git', 'auth'))
})

test('malformed and oversized persisted documents fail closed and are not overwritten', async () => {
  const { store, stateDir, port } = await fixture()
  await mkdir(stateDir)
  for (const bad of ['{broken', JSON.stringify({ version: 1 }), 'x'.repeat(128 * 1024 + 1)]) {
    await writeFile(store.configPath, bad)
    await expect(store.read()).rejects.toThrow(/SYNC_CONFIG_(INVALID|READ_FAILED)/)
    await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'never-store' })).rejects.toThrow()
    expect(await readFile(store.configPath, 'utf8')).toBe(bad)
  }
  expect(port.set).not.toHaveBeenCalled(); expect(port.unset).not.toHaveBeenCalled()
})

test('persisted unknown secret keys are discarded and concurrent saves preserve other channels', async () => {
  const { store, stateDir, port } = await fixture()
  const doc = await store.ensureIdentity()
  await writeFile(store.configPath, JSON.stringify({ ...doc, token: 'discard-me', channels: { ...doc.channels, git: { ...doc.channels.git, password: 'also-discard' } } }))
  expect(JSON.stringify(await store.read())).not.toContain('discard')
  const other = new VaultSyncConfigStore({ stateDir, secrets: port })
  await Promise.all([store.saveConfig({ repoUrl: 'https://github.com/u/r' }), other.saveConfig({ transport: 'webdav', url: 'https://dav.example.test' })])
  const result = await store.read()
  expect(result.channels.git.config).toBeDefined(); expect(result.channels.webdav.config).toBeDefined()
  expect(await readFile(store.configPath, 'utf8')).not.toContain('discard')
})

test('config save validates selection fields in the full body before any credential write', async () => {
  const { store, port } = await fixture()
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'never-store', sections: ['settings'] })).rejects.toThrow('SYNC_CONFIG_INVALID')
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'never-store', mode: 'invalid' })).rejects.toThrow('SYNC_CONFIG_INVALID')
  expect(port.set).not.toHaveBeenCalled(); expect(port.unset).not.toHaveBeenCalled()
})

test('provider-only switches restore that provider form and never copy a different provider target', async () => {
  const { store, port } = await fixture()
  await store.saveConfig({ ...s3, secret: 's3-auth' })
  await store.saveConfig({ ...s3, provider: 'oss', bucket: 'oss-vault', secret: 'oss-auth' })
  await store.saveConfig({ transport: 's3', provider: 's3' })
  expect((await store.read()).channels.s3.config).toMatchObject({ provider: 's3', bucket: 'vault-backups' })
  expect(await store.getSecret('s3', 'auth')).toBe('s3-auth')
  const count = vi.mocked(port.set).mock.calls.length
  await expect(store.saveConfig({ transport: 's3', provider: 'cos', secret: 'never-store' })).rejects.toThrow('SYNC_CONFIG_INVALID')
  expect(port.set).toHaveBeenCalledTimes(count)
})

test('missing persisted active channel is malformed, not silently defaulted', async () => {
  const { store } = await fixture()
  const doc = await store.ensureIdentity()
  const { active: _active, ...malformed } = doc
  await writeFile(store.configPath, JSON.stringify(malformed))
  await expect(store.read()).rejects.toThrow('SYNC_CONFIG_INVALID')
})

test('authorization denies all mutations before secret writes, while read remains write-free', async () => {
  const { stateDir, port, root } = await fixture()
  const store = new VaultSyncConfigStore({ stateDir, secrets: port, authorize: () => { throw new Error('sensitive-denial-detail') } })
  await expect(store.ensureIdentity()).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'never-store' })).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  await expect(store.saveSelection({ encryptPassword: 'never-store' })).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  await expect(store.updateAutosync({ enabled: false })).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  await expect(store.clearChannel('git')).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  await expect(store.setUiChannel('gist')).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  expect((await store.read()).deviceId).toBe('')
  expect(await readdir(root)).toEqual([])
  expect(port.set).not.toHaveBeenCalled(); expect(port.unset).not.toHaveBeenCalled()
})

test('epoch revoke rolls back in-flight secrets and invalidates queued saves even if permission returns', async () => {
  const { store, port, values } = await fixture()
  await store.saveConfig({ repoUrl: 'https://github.com/u/original', token: 'old-auth' })
  const original = await readFile(store.configPath, 'utf8')
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const originalSet = port.set
  port.set = vi.fn(async (ref, value) => { if (value === 'late-auth') await gate; await originalSet(ref, value) })
  const save = expect(store.saveConfig({ repoUrl: 'https://github.com/u/new', token: 'late-auth' })).rejects.toThrow('SYNC_CONFIG_REVOKED')
  await vi.waitFor(() => expect(port.set).toHaveBeenCalledWith(store.secretRef('git', 'auth'), 'late-auth'))
  const queued = expect(store.saveSelection({ mode: 'advanced' })).rejects.toThrow('SYNC_CONFIG_REVOKED')
  store.revoke(); release()
  await Promise.all([save, queued])
  expect(values.get(store.secretRef('git', 'auth'))).toBe('old-auth')
  expect(await readFile(store.configPath, 'utf8')).toBe(original)
  await store.saveSelection({ mode: 'advanced' })
  expect((await store.read()).channels.git.selection.mode).toBe('advanced')
})

test('authorization changing during secret write rolls that credential back before persisting configuration', async () => {
  const { stateDir, port, values } = await fixture()
  let allowed = true
  const store = new VaultSyncConfigStore({ stateDir, secrets: port, authorize: () => { if (!allowed) throw new Error('locked') } })
  await store.ensureIdentity()
  const original = await readFile(store.configPath, 'utf8')
  const originalSet = port.set
  port.set = vi.fn(async (ref, value) => { await originalSet(ref, value); allowed = false })
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', token: 'synthetic-value' })).rejects.toThrow('SYNC_CONFIG_NOT_AUTHORIZED')
  expect(values.size).toBe(0)
  expect(await readFile(store.configPath, 'utf8')).toBe(original)
})

test('request bounds, slot namespace and target hashes are deterministic and independent per vault', async () => {
  const { store, root, port } = await fixture()
  const other = new VaultSyncConfigStore({ stateDir: join(root, 'another'), secrets: port })
  expect(store.secretRef('git', 'auth')).not.toBe(other.secretRef('git', 'auth'))
  await expect(store.saveConfig({ repoUrl: 'https://github.com/u/r', ignoredSecret: 'x'.repeat(128 * 1024), token: 'never-store' })).rejects.toThrow('SYNC_CONFIG_INVALID')
  expect(port.set).not.toHaveBeenCalled()
  expect(syncConfigHash({ transport: 'git', repoUrl: 'https://github.com/u/r', subdir: 'snapshots' })).toBe(syncConfigHash({ subdir: 'snapshots', repoUrl: 'https://github.com/u/r', transport: 'git' }))
  expect(syncConfigHash({ transport: 'git', repoUrl: 'https://github.com/u/r' })).not.toBe(syncConfigHash({ transport: 'git', repoUrl: 'https://github.com/u/other' }))
})

test('Git SSH URL accepted by transport can be saved and explicit empty namespace resets the previous namespace',async()=>{
 const {store}=await fixture()
 await store.saveConfig({transport:'git',repoUrl:'ssh://git@github.com/owner/private.git',subdir:''})
 expect((await store.read()).channels.git.config?.repoUrl).toBe('ssh://git@github.com/owner/private.git')
 await store.saveConfig({transport:'git',repoUrl:'https://github.com/owner/private.git',subdir:'custom-vault'})
 await store.saveConfig({transport:'git',repoUrl:'https://github.com/owner/private.git',subdir:''})
 expect((await store.read()).channels.git.config?.subdir).toBe('')
 for(const repoUrl of ['ssh://git:password@github.com/a/b','ssh://git@github.com/a/../b','ssh://git@github.com/a/b?token=synthetic'])await expect(store.saveConfig({transport:'git',repoUrl})).rejects.toThrow('SYNC_CONFIG_INVALID')
})
