import { expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as VaultPlugin from '../src/index.ts'

async function fixture(run: (gateway: VaultPlugin.VaultGateway, ctx: Context, path: string) => Promise<void>, mode = 'auto') {
  const dir = await mkdtemp(join(tmpdir(), 'onepass-setup-'))
  const path = join(dir, 'vault.json')
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    await ctx.plugin(VaultPlugin, { path, masterPasswordEnv: 'DSH_ONEPASS_UNSET_TEST_VARIABLE', accessMode: mode, tools: 'full' })
    await run(ctx.get('vault') as VaultPlugin.VaultGateway, ctx, path)
  } finally {
    ctx.registry.delete(VaultPlugin); ctx.registry.delete(ToolRuntime); ctx.registry.delete(SystemPrompt)
    VaultPlugin.resetVaultSwitch()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

test('first-use Settings opening accepts a weak password and shares it with model tools', async () => {
  await fixture(async (g, ctx, path) => {
    expect(await g.setupStatus()).toEqual({ configured: false, exists: false })
    expect(existsSync(path)).toBe(false)
    await expect(g.list()).rejects.toThrow(/Settings/)
    expect(await g.openWithPassword('1')).toEqual({ locked: false, entries: 0 })
    expect(await g.setupStatus()).toEqual({ configured: true, exists: true })
    const added = await g.add({ title: 'Synthetic', password: 'a' })
    const result = await ctx.tools.execute({ name: 'vault_get', arguments: { id: added.id }, callId: 'bootstrap-share' as ToolCallId, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect((result.value as { entry: { password: string } }).entry.password).toBe('a')
    expect(await readFile(path, 'utf8')).not.toContain('Synthetic')
    await g.lock(); expect((await g.openWithPassword('1')).locked).toBe(false)
    await expect(g.openWithPassword('2')).rejects.toThrow(/does not match/)
    expect((await g.get(added.id)).entry?.password).toBe('a')
    expect(ctx.tools.schemas().some(tool => tool.name === 'openWithPassword' || tool.name === 'vault_open_with_password')).toBe(false)
  })
})

test('empty first-use password is rejected and readonly cannot create a new vault', async () => {
  await fixture(async (g, _ctx, path) => {
    await expect(g.openWithPassword('')).rejects.toThrow(/nonempty/)
    await expect(g.openWithPassword('1')).rejects.toThrow(/readonly/)
    expect(existsSync(path)).toBe(false)
  }, 'readonly')
})

test('a pre-existing encrypted vault rejects wrong first-use passwords without changing bytes', async () => {
  const { openVault } = await import('../src/store.ts')
  await fixture(async (g, _ctx, path) => {
    const existing = await openVault({ path, masterPassword: 'synthetic-existing-key' })
    await existing.add({ title: 'Existing synthetic entry', password: 'synthetic-stored-value' })
    await existing.lock()
    const before = await readFile(path, 'utf8')
    expect(await g.setupStatus()).toEqual({ configured: false, exists: true })
    for (const password of ['wrong-one', 'wrong-two']) await expect(g.openWithPassword(password)).rejects.toThrow(/incorrect/)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await g.setupStatus()).configured).toBe(false)
    expect((await g.openWithPassword('synthetic-existing-key')).entries).toBe(1)
  })
})

test('readonly may open an existing encrypted vault without rewriting its document', async () => {
  const { openVault } = await import('../src/store.ts')
  await fixture(async (g, _ctx, path) => {
    const existing = await openVault({ path, masterPassword: 'existing-readonly-key' })
    await existing.add({ title: 'Readonly synthetic', password: 'synthetic-stored' })
    await existing.lock()
    const before = await readFile(path, 'utf8')
    expect((await g.openWithPassword('existing-readonly-key')).entries).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    await expect(g.add({ title: 'Forbidden' })).rejects.toThrow(/readonly/)
  }, 'readonly')
})

test('concurrent distinct first-use passwords have one winner and never replace the vault', async () => {
  await fixture(async g => {
    const results = await Promise.allSettled([g.openWithPassword('one'), g.openWithPassword('two')])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((await g.openWithPassword('one')).locked).toBe(false)
  })
})


test('unopened GUI cannot rename or delete an encrypted named vault', async () => {
  await fixture(async (g, _ctx, path) => {
    const named = join(dirname(path), 'work.json')
    await writeFile(named, 'synthetic-encrypted-file-sentinel')
    await expect(g.vaultRename('work', 'renamed')).rejects.toThrow(/Settings/)
    await expect(g.vaultDelete('work', true)).rejects.toThrow(/Settings/)
    expect(await readFile(named, 'utf8')).toBe('synthetic-encrypted-file-sentinel')
    expect(existsSync(join(dirname(path), 'renamed.json'))).toBe(false)
  })
})


test('unopened model file operations cannot bypass first-use authentication', async () => {
  await fixture(async (_g, ctx, path) => {
    const named = join(dirname(path), 'work.json')
    await writeFile(named, 'synthetic-file-sentinel')
    for (const [name, args] of [['vault_vault_rename', { from: 'work', to: 'renamed' }], ['vault_vault_delete', { name: 'work', confirm: true }]] as const) {
      const result = await ctx.tools.execute({ name, arguments: args, callId: name as ToolCallId, signal: new AbortController().signal })
      expect(result.isError).toBe(true)
    }
    expect(await readFile(named, 'utf8')).toBe('synthetic-file-sentinel')
  })
})

test('unloading during the first open revokes the pending password and locks its store', async () => {
  const { VaultStore } = await import('../src/store.ts')
  const original = VaultStore.prototype.load
  let release: (() => void) | undefined
  let captured: InstanceType<typeof VaultStore> | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(VaultStore.prototype, 'load').mockImplementation(async function (this: InstanceType<typeof VaultStore>) {
    captured = this
    await gate
    return original.call(this)
  })
  try {
    await fixture(async (g, ctx) => {
      const opening = g.openWithPassword('pending-first-open')
      const rejected = expect(opening).rejects.toThrow(/unavailable/)
      await vi.waitFor(() => expect(captured).toBeDefined())
      ctx.registry.delete(VaultPlugin)
      await vi.waitFor(async () => { await expect(g.setupStatus()).rejects.toThrow(/unavailable/) })
      release!()
      await rejected
      expect(captured?.isLocked).toBe(true)
    })
  } finally { release?.(); spy.mockRestore() }
})
