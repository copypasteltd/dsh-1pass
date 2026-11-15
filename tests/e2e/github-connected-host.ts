/** QA-only actual host flow. All I/O is restricted to a new temporary fixture. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultCloudSync } from '../../src/cloud-sync/controller.ts'
import { createVaultSyncTransport } from '../../src/cloud-sync/transports.ts'
import { cleanEnvironment } from '../../src/cloud-sync/transports/process.ts'
import { openVault } from '../../src/store.ts'
const exec = promisify(execFile)
export const syntheticPassword = 'SYNTHETIC-BROWSER-SYNC-PASSWORD'
const syntheticEntryPassword = 'SYNTHETIC-BROWSER-ENTRY-NOT-REAL'
function secrets() {
  const values = new Map<string, string>()
  return { get: async (ref: string) => values.get(ref), has: async (ref: string) => values.has(ref), set: async (ref: string, value: string) => { values.set(ref, value) }, unset: async (ref: string) => { values.delete(ref) } }
}
export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), '1pass-browser-connected-'))
  const controllers: VaultCloudSync[] = []
  const stores: Awaited<ReturnType<typeof openVault>>[] = []
  const commands: Array<{ args: string[]; exitCode: number; stdout: string }> = []
  async function git(args: string[]) {
    const env = cleanEnvironment()
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'; env.GIT_TERMINAL_PROMPT = '0'; env.GIT_ALLOW_PROTOCOL = 'file'
    const result = await exec('git', args, { env, timeout: 15000, windowsHide: true })
    commands.push({ args: args.map(arg => arg.replaceAll(root, '<temporary-fixture>')), exitCode: 0, stdout: result.stdout.trim() })
    return result.stdout.trim()
  }
  const remote = join(root, 'remote.git')
  const dispose = async () => { for (const controller of controllers) await controller.dispose(); for (const store of stores) await store.lock(); await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 75 }) }
  try {
    await git(['init', '--bare', '--initial-branch=trunk', remote])
    async function device(name: string) {
      const store = await openVault({ path: join(root, name + '.json'), masterPassword: 'SYNTHETIC-LOCAL-' + name }); stores.push(store)
      const controller = new VaultCloudSync({ stateDir: join(root, name + '-sync'), vaultName: name, secrets: secrets(), context: async () => ({ store, authorize() {} }), transport: (config, stateDir, signal, getSecret) => createVaultSyncTransport({ config, stateDir, signal, credentials: { getSecret }, allowLocalGitForTests: true, timeoutMs: 15000 }) }); controllers.push(controller)
      return { store, controller }
    }
    const one = await device('one')
    await one.store.add({ title: 'Synthetic browser connected item', password: syntheticEntryPassword })
    return { remote, commands, dispose, call: (action: string, payload?: unknown) => one.controller.call(action, payload),
      async inspect() {
        const refs = await git(['--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])
        if (!refs) return { refs, snapshotCount: 0 }
        assert.equal(refs, 'refs/heads/trunk')
        const tree = await git(['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'trunk'])
        assert.ok(tree.includes('1pass/index.json'))
        const index = await git(['--git-dir=' + remote, 'show', 'trunk:1pass/index.json'])
        const entries = JSON.parse(index) as Array<{ id: string }>
        assert.equal(entries.length, 1)
        const snapshot = await git(['--git-dir=' + remote, 'show', 'trunk:1pass/' + entries[0]!.id + '.json'])
        const envelope = JSON.parse(snapshot)
        assert.equal(envelope.format, '1pass-cloud-snapshot-v1'); assert.equal(envelope.manifest.encrypted, true)
        assert.ok(!snapshot.includes(syntheticEntryPassword)); assert.ok(!snapshot.includes(syntheticPassword))
        const saved = await readFile(join(root, 'one-sync', 'sync-config.json'), 'utf8')
        assert.equal(JSON.parse(saved).channels.git.config.subdir, '')
        assert.ok(!saved.includes(syntheticPassword))
        return { refs, tree, snapshotCount: entries.length, snapshotId: entries[0]!.id, encrypted: true, plaintextAbsent: true, savedBlankSubdir: true }
      },
      async verifySecondDevice() {
        const two = await device('two')
        await two.controller.call('saveConfig', { transport: 'git', repoUrl: remote, subdir: '' })
        await two.controller.call('saveSelection', { transport: 'git', mode: 'advanced', sections: ['vault'], encrypt: true, includeSecrets: false, encryptPassword: syntheticPassword, decryptPassword: syntheticPassword })
        const sync = await two.controller.call('sync', { transport: 'git' }) as { ok: boolean; syncSessionId: string; items: Array<{ itemId: string }> }
        assert.equal(sync.ok, true)
        await two.controller.call('applyItems', { syncSessionId: sync.syncSessionId, adoptions: sync.items.map(item => ({ itemId: item.itemId, adopt: true })) })
        assert.equal(two.store.list()[0]?.password, syntheticEntryPassword)
        return { decrypted: true, itemCount: two.store.list().length, viaActualController: true }
      },
    }
  } catch (error) { await dispose(); throw error }
}
