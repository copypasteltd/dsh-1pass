// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudSyncPanel, type CloudSyncPanelProps } from '../src/client/CloudSyncPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { vaultTranslations } from '../vendor/config-manager/src/client/vault-translations.ts'
import { toastStore } from '../vendor/config-manager/src/client/common/toast-store.ts'
import type { SyncStatusResponse } from '../vendor/config-manager/src/client/sync/sync-api.ts'

const tr = vaultTranslations(() => 'en')
const status: SyncStatusResponse = {
  ok: true, configured: false, credentialConfigured: false, credentialWritable: true, sectionCount: 0,
  syncSections: [{ id: 'vault', displayName: 'Password vault', portability: 'portable', defaultIncluded: true }],
}
function mount(overrides: Partial<CloudSyncPanelProps> = {}) {
  const call = vi.fn(async (action: string): Promise<unknown> => {
    if (action === 'status') return structuredClone(status)
    if (action === 'history') return { ok: true, entries: [] }
    if (action === 'githubValidate') return { ok: true, valid: false }
    if (action === 'githubListRepositories') return { ok: true, repos: [] }
    return { ok: true }
  })
  const props: CloudSyncPanelProps = { t: key => en[key], cloudSyncCall: call, readonly: false, locked: false, unavailable: false, vaultName: 'synthetic-vault', ...overrides }
  return { ...render(createElement(CloudSyncPanel, props)), call, props }
}
async function openDraft() {
  await screen.findByText(tr.syncT('history.empty'))
  fireEvent.click(screen.getAllByRole('button', { name: tr.syncT('channel.open') })[0]!)
  const dialog = await screen.findByRole('dialog')
  const token = within(dialog).getByRole('textbox', { name: tr.syncT('config.repoUrl') }) as HTMLInputElement
  fireEvent.change(token, { target: { value: 'https://example.invalid/synthetic.git' } })
  const secret = within(dialog).getByLabelText(tr.syncT('config.token')) as HTMLInputElement
  fireEvent.change(secret, { target: { value: 'synthetic-draft-only' } })
  return { dialog, secret }
}
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }))
})
afterEach(() => { cleanup(); toastStore.clear(); vi.useRealTimers() })

test('unavailable offers a localized Retry separately from the locked banner and never calls the host', async () => {
  const retry = vi.fn(async () => { throw new Error('synthetic-server-detail-do-not-render') })
  const { call } = mount({ unavailable: true, onRetry: retry })
  expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i)
  expect(screen.queryByText(/unlock the password vault/i)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(retry).toHaveBeenCalledOnce())
  await waitFor(() => expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false))
  expect(document.body.textContent).not.toContain('synthetic-server-detail-do-not-render')
  expect(call).not.toHaveBeenCalled()
})

test('Retry recovery mounts the sync UI and locked still suppresses Retry', async () => {
  const retry = vi.fn(async () => {})
  const { props, rerender, call } = mount({ unavailable: true, onRetry: retry })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(retry).toHaveBeenCalledOnce())
  rerender(createElement(CloudSyncPanel, { ...props, unavailable: false }))
  await screen.findByText(tr.syncT('history.empty'))
  expect(call).toHaveBeenCalled()
  rerender(createElement(CloudSyncPanel, { ...props, locked: true }))
  expect(screen.getByText(/unlock the password vault/i)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

test('availability recovery copy follows the active locale', () => {
  mount({ t: key => zh[key], unavailable: true, onRetry: async () => {} })
  expect(screen.getByRole('alert').textContent).toContain('云同步暂不可用')
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('请先解锁')
})

test('ordinary parent busy preserves the draft and blocks pending autosave and new mutations', async () => {
  const { props, rerender, call } = mount()
  const { dialog, secret } = await openDraft()
  rerender(createElement(CloudSyncPanel, { ...props, busy: true }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(secret.value).toBe('synthetic-draft-only')
  expect(secret.disabled).toBe(true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
  expect(call.mock.calls.some(([action]) => action === 'saveConfig')).toBe(false)
  expect(secret.value).toBe('synthetic-draft-only')
  rerender(createElement(CloudSyncPanel, { ...props, busy: false }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(secret.disabled).toBe(false)
  expect(secret.value).toBe('synthetic-draft-only')
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('synthetic-draft-only')
})

test.each(['locked', 'readonly', 'unavailable', 'vaultName'] as const)('%s remains a true draft-revocation boundary', async field => {
  const { props, rerender } = mount()
  const { secret } = await openDraft()
  rerender(createElement(CloudSyncPanel, { ...props, [field]: field === 'vaultName' ? 'synthetic-other' : true }))
  expect(secret.isConnected).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  rerender(createElement(CloudSyncPanel, { ...props }))
  await screen.findByText(tr.syncT('history.empty'))
  fireEvent.click(screen.getAllByRole('button', { name: tr.syncT('channel.open') })[0]!)
  const dialog = await screen.findByRole('dialog')
  expect((within(dialog).getByLabelText(tr.syncT('config.token')) as HTMLInputElement).value).toBe('')
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('synthetic-draft-only')
})
