import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloudBackupManager, changeCloudBackupVault, onCloudVaultLifecycle, cloudBackupConfigPath, createCloudBackupManager, readCloudBackupSnapshot } from '../src/cloud-backup.ts'
import { openVault, onVaultPersist } from '../src/store.ts'
import type { CloudBackupSettings, CloudBackupSnapshot, CloudBackupTarget } from '../src/cloud-backup-types.ts'

const target: CloudBackupTarget = { id: 'github', label: 'Private archive', provider: 'github', enabled: true, prefix: 'backups', owner: 'example', repo: 'archive', branch: 'main', tokenEnv: 'BACKUP_TEST_TOKEN' }
const config: CloudBackupSettings = { enabled: true, onChange: true, intervalMinutes: 5, retention: 3, targets: [target] }
const snapshot: CloudBackupSnapshot = { vaultId: 'vault-' + 'a'.repeat(24), filename: 'snapshot-2026-11-14T14-25-38-123Z-00000000-0000-4000-8000-000000000000.json', data: '{}' }
const managers: CloudBackupManager[] = []
function fixture(load: unknown = config, overrides: Partial<ConstructorParameters<typeof CloudBackupManager>[0]> = {}) {
  const upload = vi.fn(async () => ({ objectKey: 'backups/encrypted.json' }))
  const save = vi.fn(async () => {})
  const m = new CloudBackupManager({ load: async () => load, save, snapshot: async () => snapshot, canRun: () => true, upload, ...overrides })
  managers.push(m)
  return { m, upload, save }
}
afterEach(async () => { for (const m of managers.splice(0)) await m.dispose(); vi.useRealTimers() })

test('disabled defaults and reading status never contact a provider', async () => {
  vi.useFakeTimers()
  const { m, upload } = fixture({ enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] })
  expect((await m.status()).config.enabled).toBe(false)
  m.notifyChange()
  await vi.advanceTimersByTimeAsync(86400000)
  expect(upload).not.toHaveBeenCalled()
  await expect(m.run()).rejects.toThrow(/disabled/)
})

test('saving explicit consent arms future triggers without uploading', async () => {
  const { m, upload, save } = fixture({ enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] })
  const result = await m.configure(config)
  expect(save).toHaveBeenCalledWith(config)
  expect(upload).not.toHaveBeenCalled()
  expect(result.nextRunAt).toBeGreaterThan(Date.now())
})

test('change bursts coalesce and interval still runs independently', async () => {
  vi.useFakeTimers()
  const { m, upload } = fixture()
  await m.status()
  m.notifyChange(); m.notifyChange(); m.notifyChange()
  await vi.advanceTimersByTimeAsync(1999)
  expect(upload).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(upload).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(300000)
  expect(upload).toHaveBeenCalledTimes(2)
})

test('interval 0 disables timing, onChange false disables change trigger', async () => {
  vi.useFakeTimers()
  const { m, upload } = fixture({ ...config, intervalMinutes: 0, onChange: false })
  expect((await m.status()).nextRunAt).toBeUndefined()
  m.notifyChange()
  await vi.advanceTimersByTimeAsync(86400000)
  expect(upload).not.toHaveBeenCalled()
  await m.run()
  expect(upload).toHaveBeenCalledTimes(1)
})

test('a failed target is isolated and its raw error never reaches status', async () => {
  const upload = vi.fn(async (t: CloudBackupTarget) => {
    if (t.id === 'github') throw new Error('secret-access-token and signed-url')
    return { objectKey: 'ok', warning: 'Retention needs permission.' }
  })
  const { m } = fixture({ ...config, targets: [target, { ...target, id: 'other' }] }, { upload })
  const result = await m.run()
  expect(result.statuses.map(s => s.state)).toEqual(['error', 'success'])
  expect(result.running).toBe(false)
  expect(JSON.stringify(result)).not.toContain('secret-access-token')
  expect(result.statuses[1]?.warning).toBe('Retention needs permission.')
})

test('manual concurrent runs share one upload; a new write schedules a follow-up', async () => {
  vi.useFakeTimers()
  let finish: (() => void) | undefined
  const upload = vi.fn(() => new Promise<{ objectKey: string }>(resolve => { finish = () => resolve({ objectKey: 'ok' }) }))
  const { m } = fixture(config, { upload })
  await m.status()
  const a = m.run(); const b = m.run()
  await vi.advanceTimersByTimeAsync(0)
  expect(upload).toHaveBeenCalledTimes(1)
  m.notifyChange()
  finish!()
  await Promise.all([a, b])
  await vi.advanceTimersByTimeAsync(2000)
  expect(upload).toHaveBeenCalledTimes(2)
  finish!()
  await vi.advanceTimersByTimeAsync(0)
})

test('readonly blocks manual and scheduled requests', async () => {
  vi.useFakeTimers()
  const { m, upload } = fixture(config, { canRun: async () => false })
  await expect(m.run()).rejects.toThrow(/readonly/)
  await vi.advanceTimersByTimeAsync(300000)
  expect(upload).not.toHaveBeenCalled()
  expect((await m.status()).warning).toMatch(/readonly/)
})

test('malformed persisted settings fail closed and can be repaired explicitly', async () => {
  const { m, upload } = fixture({ enabled: true, targets: [{ token: 'not-allowed' }] })
  expect((await m.status()).config.enabled).toBe(false)
  expect((await m.status()).warning).toBeTruthy()
  expect(upload).not.toHaveBeenCalled()
  expect((await m.configure(config)).warning).toBeUndefined()
})

test('configuration changes abort and quiesce the old attempt before saving', async () => {
  const upload = vi.fn(async (_t, _s, _r, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled-secret')), { once: true })
  }))
  const { m, save } = fixture(config, { upload })
  const run = m.run()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  const result = await m.configure({ ...config, enabled: false })
  await run
  expect(save).toHaveBeenCalledTimes(1)
  expect(result.config.enabled).toBe(false)
  expect(result.statuses[0]?.state).toBe('idle')
})

test('disposal stops timers and rejects subsequent work', async () => {
  vi.useFakeTimers()
  const { m, upload } = fixture()
  await m.status()
  m.notifyChange()
  await m.dispose()
  await vi.advanceTimersByTimeAsync(86400000)
  expect(upload).not.toHaveBeenCalled()
  await expect(m.run()).rejects.toThrow(/stopped/)
})

test('snapshot preserves encrypted bytes and persisted config contains no credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-backup-manager-'))
  const path = join(dir, 'default.json')
  const observed: string[] = []
  const off = onVaultPersist(p => observed.push(p))
  try {
    const store = await openVault({ path, masterPassword: 'synthetic-test-passphrase' })
    await store.add({ title: 'Synthetic', password: 'synthetic-entry-value' })
    const captured = await readCloudBackupSnapshot(path)
    expect(captured.data).toBe(await readFile(path, 'utf8'))
    expect(captured.data).not.toContain('synthetic-entry-value')
    expect(captured.vaultId).toMatch(/^vault-[a-f0-9]{24}$/)
    expect(captured.filename).toMatch(/^snapshot-/)
    expect(observed.length).toBeGreaterThanOrEqual(2)
    const m = createCloudBackupManager(path, () => true); managers.push(m)
    await m.configure({ ...config, enabled: false })
    const saved = JSON.parse(await readFile(cloudBackupConfigPath(path), 'utf8'))
    expect(saved.targets[0].tokenEnv).toBe('BACKUP_TEST_TOKEN')
    expect(saved).not.toHaveProperty('token')
    const reloaded = createCloudBackupManager(path, () => true); managers.push(reloaded)
    expect((await reloaded.status()).config).toEqual(saved)
    await store.lock()
    await writeFile(path, JSON.stringify({ password: 'plaintext-must-not-upload' }))
    await expect(readCloudBackupSnapshot(path)).rejects.toThrow(/valid encrypted/)
  } finally {
    off()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('vault rename migrates opt-in and deletion revokes it; failed mutation rolls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-backup-lifecycle-'))
  const source = join(dir, 'work.json')
  const target = join(dir, 'renamed.json')
  const phases: string[] = []
  const off = onCloudVaultLifecycle(async phase => { phases.push(phase) })
  try {
    const m = createCloudBackupManager(source, () => true); managers.push(m)
    await m.configure({ ...config, enabled: false })
    const before = await readFile(cloudBackupConfigPath(source), 'utf8')
    await changeCloudBackupVault(source, target, async () => {})
    expect(await readFile(cloudBackupConfigPath(target), 'utf8')).toBe(before)
    await expect(readFile(cloudBackupConfigPath(source))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(phases).toEqual(['pause', 'resume'])
    await expect(changeCloudBackupVault(target, source, async () => { throw new Error('synthetic file failure') })).rejects.toThrow(/synthetic/)
    expect(await readFile(cloudBackupConfigPath(target), 'utf8')).toBe(before)
    await expect(readFile(cloudBackupConfigPath(source))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(changeCloudBackupVault(target, undefined, async () => { throw new Error('synthetic delete failure') })).rejects.toThrow(/synthetic/)
    expect(await readFile(cloudBackupConfigPath(target), 'utf8')).toBe(before)
    await changeCloudBackupVault(target, undefined, async () => {})
    await expect(readFile(cloudBackupConfigPath(target))).rejects.toMatchObject({ code: 'ENOENT' })
    const fresh = createCloudBackupManager(target, () => true); managers.push(fresh)
    expect((await fresh.status()).config.enabled).toBe(false)
    expect((await fresh.status()).config.targets).toEqual([])
  } finally { off(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})


test('writes during settings save cannot resurrect disabled automatic triggers', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  const save = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const { m, upload } = fixture({ ...config, intervalMinutes: 0 }, { save })
  await m.status()
  const update = m.configure({ ...config, onChange: false, intervalMinutes: 0 })
  await vi.advanceTimersByTimeAsync(0)
  m.notifyChange()
  await vi.advanceTimersByTimeAsync(0)
  release!()
  await update
  await vi.advanceTimersByTimeAsync(10000)
  expect(upload).not.toHaveBeenCalled()
  expect((await m.status()).nextRunAt).toBeUndefined()
})

test('writes during an enabled settings save are coalesced against the committed destination', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  const save = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const { m, upload } = fixture({ ...config, intervalMinutes: 0 }, { save })
  await m.status()
  const update = m.configure({ ...config, intervalMinutes: 0, targets: [{ ...target, repo: 'new-archive' }] })
  await vi.advanceTimersByTimeAsync(0)
  m.notifyChange(); m.notifyChange()
  await vi.advanceTimersByTimeAsync(0)
  release!()
  await update
  await vi.advanceTimersByTimeAsync(2000)
  expect(upload).toHaveBeenCalledTimes(1)
  expect(upload.mock.calls[0]![0]).toHaveProperty('repo', 'new-archive')
})


test.each([false, true])('a queued write survives a settings save (save fails: %s)', async fails => {
  vi.useFakeTimers()
  const save = vi.fn(async () => { if (fails) throw new Error('synthetic save error') })
  const { m, upload } = fixture({ ...config, intervalMinutes: 0 }, { save })
  await m.status()
  m.notifyChange()
  await vi.advanceTimersByTimeAsync(1000)
  const pending = m.configure({ ...config, intervalMinutes: 0, retention: 5 })
  if (fails) await expect(pending).rejects.toThrow(/could not be saved/)
  else await pending
  await vi.advanceTimersByTimeAsync(2000)
  expect(upload).toHaveBeenCalledTimes(1)
})
