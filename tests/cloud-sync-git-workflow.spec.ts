import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultSyncConfigStore, type SyncSecretPort } from '../src/cloud-sync/config.ts'
import { createVaultSyncTransport, metaFromSnapshot, remoteIndexVersion, snapshotContentHash } from '../src/cloud-sync/transports.ts'
import { cleanEnvironment } from '../src/cloud-sync/transports/process.ts'
import type { VaultSyncSnapshot } from '../src/cloud-sync/types.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
async function git(args: string[]): Promise<string> {
  const env = cleanEnvironment()
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ALLOW_PROTOCOL = 'file'
  return (await exec('git', args, { env, timeout: 15000, windowsHide: true })).stdout.trim()
}
async function fixture(branch = 'main', populated = false) {
  const root = await mkdtemp(join(tmpdir(), '1pass-git-workflow-')); roots.push(root)
  const remote = join(root, 'remote.git')
  await git(['init', '--bare', '--initial-branch=' + branch, remote])
  if (populated) {
    const seed = join(root, 'seed')
    await git(['clone', '--', remote, seed])
    await mkdir(join(seed, 'dsh-config-manager'))
    await writeFile(join(seed, 'dsh-config-manager', 'original.json'), '{"synthetic":true}')
    await git(['-C', seed, 'add', '--', 'dsh-config-manager'])
    await git(['-C', seed, '-c', 'user.name=Synthetic', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'synthetic unrelated configuration'])
    await git(['-C', seed, 'push', 'origin', 'HEAD:refs/heads/' + branch])
  }
  return { root, remote }
}
async function device(root: string, remote: string, name: string, fields: Record<string, string> = {}) {
  const secrets: SyncSecretPort = { get: vi.fn(async () => undefined), has: vi.fn(async () => false), set: vi.fn(async () => {}), unset: vi.fn(async () => {}) }
  const store = new VaultSyncConfigStore({ stateDir: join(root, name, 'config'), secrets, deviceName: name })
  // Match the UI's fresh payload: no branch, no subdir and no credential for a bare fixture.
  await store.saveConfig({ transport: 'git', repoUrl: remote, ...fields, encrypt: true, includeSecrets: false })
  const config = (await store.read()).channels.git.config!
  const stateDir = join(root, name, 'transport')
  const transport = createVaultSyncTransport({ config, stateDir, credentials: { getSecret: () => store.getSecret('git', 'auth') }, allowLocalGitForTests: true })
  return { store, config, stateDir, transport, secrets }
}
function snapshot(id: string): VaultSyncSnapshot {
  const result: VaultSyncSnapshot = { format: '1pass-cloud-snapshot-v1', contentHash: '', id, createdAt: '2026-11-15T00:00:00.000Z', manifest: { schemaVersion: 1, encrypted: true, transport: 'git', vaultName: 'synthetic', deviceId: 'synthetic-device', deviceName: 'Synthetic', platform: 'test', dshVersion: 'test', sections: ['vault'] }, encryptedPayload: { version: 1, kdf: { algo: 'scrypt', n: 32768, r: 8, p: 1, saltHex: '11'.repeat(16) }, nonce: '22'.repeat(12), ciphertext: '33'.repeat(128), tag: '44'.repeat(16) } }
  result.contentHash = snapshotContentHash(result)
  return result
}

describe('saved Git configuration through actual isolated Git workflow', () => {
  it('uses the safe namespace for omitted and persisted-empty UI subdir across two devices', async () => {
    const { root, remote } = await fixture()
    const one = await device(root, remote, 'one')
    const two = await device(root, remote, 'two', { subdir: '' })
    expect(one.config.subdir).toBe(''); expect(two.config.subdir).toBe('')
    expect(await one.transport.list()).toEqual([])
    const first = snapshot('first-device')
    await one.transport.upload(first, '')
    expect(await two.transport.list()).toEqual([metaFromSnapshot(first)])
    expect(await two.transport.download(first.id)).toEqual(first)
    const second = snapshot('second-device')
    await two.transport.upload(second, remoteIndexVersion(await two.transport.list()))
    expect((await one.transport.list()).map(meta => meta.id)).toEqual(['first-device', 'second-device'])
    expect(await one.transport.download(second.id)).toEqual(second)
    const paths = (await git(['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main'])).split('\n')
    expect(paths).toEqual(['1pass/content-present.json', '1pass/first-device.json', '1pass/index.json', '1pass/second-device.json'])
    expect(JSON.parse(await readFile(join(one.stateDir, 'worktree-owner.json'), 'utf8')).subdir).toBe('1pass')
    expect(one.secrets.get).not.toHaveBeenCalled(); expect(two.secrets.get).not.toHaveBeenCalled()
  }, 60000)

  it.each(['master', 'trunk'])('uses a populated remote default %s without inventing a main branch', async branch => {
    const { root, remote } = await fixture(branch, true)
    // Nonempty prefix isolates branch autodetection from the separate blank-prefix regression.
    const one = await device(root, remote, 'one', { subdir: '1pass' })
    const two = await device(root, remote, 'two', { subdir: '1pass' })
    const before = await git(['--git-dir=' + remote, 'rev-parse', branch])
    const first = snapshot('default-branch')
    await one.transport.upload(first, '')
    expect(await git(['-C', join(one.stateDir, 'worktree'), 'symbolic-ref', '--short', 'HEAD'])).toBe(branch)
    expect(await git(['--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/' + branch)
    await git(['--git-dir=' + remote, 'merge-base', '--is-ancestor', before, branch])
    expect(await git(['--git-dir=' + remote, 'show', branch + ':dsh-config-manager/original.json'])).toBe('{"synthetic":true}')
    expect(await two.transport.download(first.id)).toEqual(first)
    const second = snapshot('default-branch-second')
    await two.transport.upload(second, remoteIndexVersion(await two.transport.list()))
    expect(await one.transport.download(second.id)).toEqual(second)
  }, 60000)

  it.each(['main', 'master'])('preserves an empty remote initial %s HEAD and first publication', async branch => {
    const { root, remote } = await fixture(branch)
    const one = await device(root, remote, 'one', { subdir: '1pass' })
    expect(await one.transport.list()).toEqual([])
    expect(await git(['-C', join(one.stateDir, 'worktree'), 'symbolic-ref', '--short', 'HEAD'])).toBe(branch)
    await one.transport.upload(snapshot('empty-default'), '')
    expect(await git(['--git-dir=' + remote, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/' + branch)
    expect(await git(['--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/' + branch)
  }, 60000)

  it('refuses a populated remote with an unavailable default HEAD rather than silently creating main', async () => {
    const { root, remote } = await fixture('trunk', true)
    const before = await git(['--git-dir=' + remote, 'rev-parse', 'trunk'])
    await git(['--git-dir=' + remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing-default'])
    const one = await device(root, remote, 'one', { subdir: '1pass' })
    await expect(one.transport.upload(snapshot('must-not-fork'), '')).rejects.toMatchObject({ code: 'workdir-branch' })
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'trunk'])).toBe(before)
    expect(await git(['--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/trunk')
  }, 60000)

  it('retains an explicit namespace and explicit absent branch as an isolated opt-in, not the default', async () => {
    const { root, remote } = await fixture('trunk', true)
    const before = await git(['--git-dir=' + remote, 'rev-parse', 'trunk'])
    const one = await device(root, remote, 'one', { subdir: 'private/vault', branch: 'vault-isolated' })
    await one.transport.upload(snapshot('explicit-target'), '')
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'trunk'])).toBe(before)
    expect(await git(['-C', join(one.stateDir, 'worktree'), 'symbolic-ref', '--short', 'HEAD'])).toBe('vault-isolated')
    const paths = await git(['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'vault-isolated'])
    expect(paths).toContain('private/vault/index.json'); expect(paths).not.toContain('dsh-config-manager'); expect(paths).not.toContain('1pass/')
  }, 60000)

  it('does not report or download a rejected first push as remote, and retries the exact commit without force', async () => {
    const { root, remote } = await fixture()
    const hook = join(remote, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\nif test ! -f "$GIT_DIR/allow-synthetic-push"; then exit 1; fi\n', { mode: 0o700 })
    const one = await device(root, remote, 'one', { subdir: '1pass' })
    const pending = snapshot('pending-publication')
    await expect(one.transport.upload(pending, '')).rejects.toMatchObject({ code: 'index-conflict' })
    expect(await git(['--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('')
    const localCommit = await git(['-C', join(one.stateDir, 'worktree'), 'rev-parse', 'HEAD'])
    expect(await one.transport.list()).toEqual([])
    await expect(one.transport.download(pending.id)).rejects.toMatchObject({ code: 'not-found' })
    await writeFile(join(remote, 'allow-synthetic-push'), 'synthetic permission restored')
    const restarted = await device(root, remote, 'one', { subdir: '1pass' })
    await restarted.transport.upload(pending, '')
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'main'])).toBe(localCommit)
    expect(await one.transport.list()).toEqual([metaFromSnapshot(pending)])
    expect(await one.transport.download(pending.id)).toEqual(pending)
    await one.transport.upload(pending, remoteIndexVersion(await one.transport.list()))
    await restarted.transport.upload(pending, '') // Retry a lost success acknowledgement with the original preview.
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'main'])).toBe(localCommit)
    const two = await device(root, remote, 'two', { subdir: '1pass' })
    await two.transport.upload(snapshot('later-writer'), remoteIndexVersion(await two.transport.list()))
    const winner = await git(['--git-dir=' + remote, 'rev-parse', 'main'])
    await expect(restarted.transport.upload(pending, '')).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' })
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'main'])).toBe(winner)
    expect(await readdir(one.stateDir)).not.toContain('.worktree-lock')
  }, 60000)

  it('keeps a rejected local commit inspectable when another device wins; no unrelated or force merge', async () => {
    const { root, remote } = await fixture()
    const hook = join(remote, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\nif test ! -f "$GIT_DIR/allow-synthetic-push"; then exit 1; fi\n', { mode: 0o700 })
    const one = await device(root, remote, 'one', { subdir: '1pass' })
    await expect(one.transport.upload(snapshot('local-rejected'), '')).rejects.toMatchObject({ code: 'index-conflict' })
    const localCommit = await git(['-C', join(one.stateDir, 'worktree'), 'rev-parse', 'HEAD'])
    await writeFile(join(remote, 'allow-synthetic-push'), 'synthetic permission restored')
    const two = await device(root, remote, 'two', { subdir: '1pass' })
    await two.transport.upload(snapshot('remote-winner'), '')
    const winner = await git(['--git-dir=' + remote, 'rev-parse', 'main'])
    await expect(one.transport.upload(snapshot('must-not-force'), '')).rejects.toMatchObject({ code: 'index-conflict' })
    expect(await git(['--git-dir=' + remote, 'rev-parse', 'main'])).toBe(winner)
    expect(await git(['-C', join(one.stateDir, 'worktree'), 'rev-parse', 'HEAD'])).toBe(localCommit)
    expect((await one.transport.workdirFacts!()).ahead).toBe(1)
    expect((await two.transport.list()).map(meta => meta.id)).toEqual(['remote-winner'])
  }, 60000)
})
