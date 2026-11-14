import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as VaultPlugin from '../src/index.ts'
import type { CloudBackupSettings } from '../src/cloud-backup-types.ts'
import { cloudBackupConfigPath } from '../src/cloud-backup.ts'

const config: CloudBackupSettings = { enabled: true, onChange: true, intervalMinutes: 0, retention: 2, targets: [
  { id: 'github', label: 'Offline test', enabled: true, provider: 'github', owner: 'example', repo: 'archive', branch: 'main', prefix: 'vault-archives', tokenEnv: 'VAULT_CLOUD_TEST_TOKEN' },
] }
const realFetch = globalThis.fetch
const previousToken = process.env.VAULT_CLOUD_TEST_TOKEN
let calls = 0
afterEach(() => { globalThis.fetch = realFetch; if (previousToken === undefined) delete process.env.VAULT_CLOUD_TEST_TOKEN; else process.env.VAULT_CLOUD_TEST_TOKEN = previousToken })

async function withVault(run: (g: VaultPlugin.VaultGateway, ctx: Context, path: string) => Promise<void>) {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'cloud-backup-integration-'))
  const path = join(dir, 'vault.json')
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VaultPlugin, { masterPassword: 'cloud-integration-synthetic', path, accessMode: 'auto', tools: 'full' })
    await run(ctx.get('vault') as VaultPlugin.VaultGateway, ctx, path)
  } finally {
    VaultPlugin.resetVaultSwitch()
    ctx.registry.delete(VaultPlugin)
    ctx.registry.delete(ToolRuntime)
    ctx.registry.delete(SystemPrompt)
    await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
  }
}

function stubPrivateGitHub() {
  const uploads: string[] = []
  const requests: string[] = []
  process.env.VAULT_CLOUD_TEST_TOKEN = 'synthetic-cloud-auth-value'
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (!url.startsWith('https://api.github.com/')) throw new Error('Tests must never contact a cloud service')
    if (init?.method === 'PUT') {
      uploads.push(Buffer.from(JSON.parse(String(init.body)).content, 'base64').toString('utf8'))
      return new Response(JSON.stringify({ content: { sha: '0000000000000000000000000000000000000000' } }), { status: 201 })
    }
    if (url.includes('/branches/')) return Response.json({ name: 'main', commit: { sha: '0000000000000000000000000000000000000000' } })
    if (url.includes('/contents/')) return Response.json([])
    return Response.json({ private: true, default_branch: 'main' })
  }) as typeof fetch
  return { uploads, requests }
}

test('explicit GUI upload sends exactly ciphertext and never credential configuration', async () => {
  const { uploads } = stubPrivateGitHub()
  await withVault(async (g, _ctx, path) => {
    await g.add({ title: 'Synthetic entry', password: 'synthetic-password-for-encryption-test' })
    expect((await g.cloudBackup()).config.enabled).toBe(false)
    await g.setCloudBackup(config)
    expect(uploads).toHaveLength(0)
    const saved = await readFile(cloudBackupConfigPath(path), 'utf8')
    expect(saved).toContain('VAULT_CLOUD_TEST_TOKEN')
    expect(saved).not.toContain('synthetic-cloud-auth-value')
    const result = await g.runCloudBackup()
    expect(result.statuses[0]?.state).toBe('success')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toBe(await readFile(path, 'utf8'))
    expect(uploads[0]).not.toContain('synthetic-password-for-encryption-test')
    expect(uploads[0]).not.toContain('VAULT_CLOUD_TEST_TOKEN')
    expect(JSON.stringify(result)).not.toContain('synthetic-cloud-auth-value')
  })
})

test('model tool persistence automatically backs up without a GUI CRUD call', async () => {
  const { uploads } = stubPrivateGitHub()
  await withVault(async (g, ctx) => {
    await g.setCloudBackup(config)
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ('cloud-model-' + (++calls)) as ToolCallId, name: 'vault_add', arguments: { title: 'Via model', apiKey: 'synthetic-tool-secret' } })
    expect(result.isError).toBe(false)
    await vi.waitFor(() => expect(uploads.length).toBeGreaterThan(0), { timeout: 6000, interval: 100 })
    expect(uploads[0]).not.toContain('synthetic-tool-secret')
    await g.setCloudBackup({ ...config, enabled: false })
  })
})

test('readonly and lock gates protect configuration and explicit uploads', async () => {
  const { uploads } = stubPrivateGitHub()
  await withVault(async g => {
    await g.setCloudBackup(config)
    await g.setAccessMode('readonly')
    await expect(g.setCloudBackup(config)).rejects.toThrow(/readonly/)
    await expect(g.runCloudBackup()).rejects.toThrow(/readonly/)
    await g.setAccessMode('auto')
    await g.lock()
    await expect(g.setCloudBackup(config)).rejects.toThrow(/locked/)
    await expect(g.runCloudBackup()).rejects.toThrow(/locked/)
    expect(uploads).toHaveLength(0)
  })
})

test('invalid raw secret settings are rejected without persisting or network requests', async () => {
  const { requests } = stubPrivateGitHub()
  await withVault(async g => {
    const before = requests.length
    await expect(g.setCloudBackup({ ...config, targets: [{ ...config.targets[0]!, token: 'secret-not-an-env-name' }] } as CloudBackupSettings)).rejects.toThrow()
    expect(requests).toHaveLength(before)
    expect((await g.cloudBackup()).config.enabled).toBe(false)
  })
})

test('an RPC already waiting on store IO cannot recreate a manager after unload', async () => {
  const { requests } = stubPrivateGitHub()
  await withVault(async (g, ctx) => {
    await g.setCloudBackup(config)
    let release: (() => void) | undefined
    const store = await (g as unknown as { guardedStore: () => Promise<unknown> }).guardedStore()
    const gate = new Promise<unknown>(resolve => { release = () => resolve(store) })
    const waiting = vi.spyOn(g as unknown as { guardedStore: () => Promise<unknown> }, 'guardedStore').mockReturnValue(gate)
    const request = g.runCloudBackup()
    ctx.registry.delete(VaultPlugin)
    release!()
    await expect(request).rejects.toThrow(/unavailable|stopped/)
    expect(requests).toHaveLength(0)
    waiting.mockRestore()
  })
})

test('GUI vault rename preserves cloud settings and delete/recreate requires new opt-in', async () => {
  const { requests } = stubPrivateGitHub()
  const dir = await mkdtemp(join(tmpdir(), 'cloud-named-integration-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VaultPlugin.VaultGateway, { masterPassword: 'synthetic-named-cloud', name: 'work', accessMode: 'auto' })
    const g = ctx.get('vault') as VaultPlugin.VaultGateway
    await g.setCloudBackup({ ...config, onChange: false, intervalMinutes: 0 })
    await g.vaultRename('work', 'personal')
    expect((await g.cloudBackup()).config.enabled).toBe(true)
    expect((await g.cloudBackup()).config.targets).toEqual(config.targets)
    await g.vaultDelete('personal', true)
    await g.switchVault('personal')
    expect((await g.cloudBackup()).config.enabled).toBe(false)
    expect((await g.cloudBackup()).config.targets).toEqual([])
    expect(requests).toHaveLength(0)
  } finally {
    ctx.registry.delete(VaultPlugin.VaultGateway)
    ctx.registry.delete(ToolRuntime)
    ctx.registry.delete(SystemPrompt)
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    VaultPlugin.resetVaultSwitch()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
