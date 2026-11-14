/** Weak passwords are permitted; scores are advisory, not save-time policy. */
import { expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openVault } from '../src/store.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

test.each(['a', '1', '1234', '密码'])('a weak master password can create and reopen a vault: %s', async masterPassword => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-weak-policy-'))
  const path = join(dir, 'vault.json')
  try {
    const store = await openVault({ path, masterPassword })
    const entry = await store.add({ title: 'Synthetic weak password', password: '1' })
    await store.update(entry.id, { password: '2' })
    await store.lock()
    await store.unlock()
    expect(store.get(entry.id)?.password).toBe('2')
    await store.lock()
    const reopened = await openVault({ path, masterPassword })
    expect(reopened.get(entry.id)?.password).toBe('2')
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('Synthetic weak password')
    await reopened.lock()
    await expect(openVault({ path, masterPassword: 'different-synthetic-password' })).rejects.toThrow(/incorrect/)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('local setup checks only nonempty input and matching confirmation, not strength', () => {
  const source = readFileSync(join(root, 'scripts/setup-local-master-password.ps1'), 'utf8')
  expect(source).toContain('if ($first.Text.Length -eq 0)')
  expect(source).toContain('if ($first.Text -cne $second.Text)')
  expect(source).not.toMatch(/\$first\.Text\.Length\s+-(?:lt|le|gt|ge)\s+\d+/)
  expect(source).not.toMatch(/至少\s*\d+\s*个字符|长度不足/)
  expect(source).toContain('$first.UseSystemPasswordChar = $true')
  expect(source).toContain('$second.UseSystemPasswordChar = $true')
})
