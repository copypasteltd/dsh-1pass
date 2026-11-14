import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const source = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
const contracts = readFileSync(fileURLToPath(new URL('../src/client/host-contracts.ts', import.meta.url)), 'utf8')
test('password workbench uses the reference declaration-aware Settings section lifecycle', () => {
  expect(source).toContain("ctx.slots.inject('settings.section'")
  expect(source).toContain("name: 'settings.section'")
  expect(source).toContain("id: 'onepass'")
  expect(source).toContain('locale: NS')
  expect(source).toContain('}, VaultWorkbench)')
  expect(contracts).toContain("locale: 'settings.vault'")
  const locales = readFileSync(fileURLToPath(new URL('../src/client/locales.ts', import.meta.url)), 'utf8')
  expect(locales).toContain("nav: '密码管理(1pass)'")
})
test('first-use password is a GUI RPC only and wrapped under the exact parameter key', () => {
  expect(source).toContain("invoke<{ configured: boolean; exists: boolean }>('setupStatus')")
  expect(source).toContain("('openWithPassword', { password })")
})
