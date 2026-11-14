// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudBackupPanel } from '../src/client/CloudBackupPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { CloudBackupSettings, CloudBackupView } from '../src/cloud-backup-types.ts'
import type { VaultLocaleKey } from '../src/client/locales.ts'

const config: CloudBackupSettings = { enabled: true, onChange: true, intervalMinutes: 60, retention: 10, targets: [{ id: 'github', label: 'Archive', enabled: true, provider: 'github', owner: 'example', repo: 'archive', branch: 'main', prefix: 'backups', tokenEnv: 'BACKUP_TOKEN' }] }
const initial: CloudBackupView = { config, statuses: [{ id: 'github', provider: 'github', state: 'idle' }], running: false }
function setup(overrides = {}) {
  const cloudBackup = vi.fn(async () => structuredClone(initial))
  const setCloudBackup = vi.fn(async (settings: CloudBackupSettings) => ({ ...structuredClone(initial), config: settings }))
  const runCloudBackup = vi.fn(async () => ({ ...structuredClone(initial), statuses: [{ id: 'github', provider: 'github' as const, state: 'success' as const, lastSuccessAt: Date.now() }] }))
  const props = { t: (key: VaultLocaleKey) => en[key], cloudBackup, setCloudBackup, runCloudBackup, readonly: false, locked: false, unavailable: false, vaultName: 'test', ...overrides }
  const rendered = render(createElement(CloudBackupPanel, props))
  return { ...rendered, props, cloudBackup, setCloudBackup, runCloudBackup }
}
afterEach(() => { cleanup(); vi.useRealTimers() })

test('shows credential variable names, requires save for edits, and never uploads on save', async () => {
  const { setCloudBackup, runCloudBackup } = setup()
  const owner = await screen.findByLabelText(en.cloudOwner) as HTMLInputElement
  expect(owner.value).toBe('example')
  expect((screen.getByLabelText(en.cloudTokenEnv) as HTMLInputElement).value).toBe('BACKUP_TOKEN')
  expect(document.querySelector('input[type=password]')).toBeNull()
  fireEvent.change(owner, { target: { value: 'other-owner' } })
  expect((screen.getByRole('button', { name: en.cloudUpload }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.cloudSave }))
  await waitFor(() => expect(setCloudBackup).toHaveBeenCalledTimes(1))
  expect(setCloudBackup.mock.calls[0]![0].targets[0]).toHaveProperty('owner', 'other-owner')
  expect(runCloudBackup).not.toHaveBeenCalled()
  await screen.findByText(en.cloudSaved)
})

test('validation prevents invalid interval and links inline errors to focused summary', async () => {
  const { setCloudBackup } = setup()
  const interval = await screen.findByLabelText(en.cloudInterval)
  fireEvent.change(interval, { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: en.cloudSave }))
  const summary = await screen.findByRole('alert')
  expect(document.activeElement).toBe(summary)
  expect(interval.getAttribute('aria-invalid')).toBe('true')
  expect(interval.getAttribute('aria-describedby')).toContain('-error')
  expect(setCloudBackup).not.toHaveBeenCalled()
})

test('manual upload uses saved configuration and reports completed status', async () => {
  const { runCloudBackup } = setup()
  await screen.findByLabelText(en.cloudOwner)
  fireEvent.click(screen.getByRole('button', { name: en.cloudUpload }))
  await waitFor(() => expect(runCloudBackup).toHaveBeenCalledTimes(1))
  await screen.findByText(en.cloudUploadFinished)
  expect(screen.getByText(en.cloudStateSuccess)).toBeTruthy()
})

test.each([{ readonly: true }, { locked: true }, { unavailable: true }])('guards all edits and explicit uploads: %j', async guards => {
  const { setCloudBackup, runCloudBackup } = setup(guards)
  await screen.findByLabelText(en.cloudOwner)
  const save = screen.getByRole('button', { name: en.cloudSave }) as HTMLButtonElement
  const upload = screen.getByRole('button', { name: en.cloudUpload }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(upload.disabled).toBe(true)
  fireEvent.click(save); fireEvent.click(upload)
  expect(setCloudBackup).not.toHaveBeenCalled()
  expect(runCloudBackup).not.toHaveBeenCalled()
})

test('polling does not overwrite dirty fields and stops on unmount', async () => {
  vi.useFakeTimers()
  const { cloudBackup, unmount } = setup()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const owner = screen.getByLabelText(en.cloudOwner) as HTMLInputElement
  fireEvent.change(owner, { target: { value: 'unsaved-owner' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(cloudBackup.mock.calls.length).toBeGreaterThan(1)
  expect(owner.value).toBe('unsaved-owner')
  unmount()
  const calls = cloudBackup.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(cloudBackup).toHaveBeenCalledTimes(calls)
})

test('failed status request presents a retry without losing setup controls', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('synthetic network error')).mockResolvedValue(structuredClone(initial))
  setup({ cloudBackup: read })
  const retry = await screen.findByRole('button', { name: en.cloudRetry })
  fireEvent.click(retry)
  await screen.findByLabelText(en.cloudOwner)
  expect(read).toHaveBeenCalledTimes(2)
})

test('all backup labels have matching Chinese translations', () => {
  for (const key of Object.keys(en).filter(key => key.startsWith('cloud')) as VaultLocaleKey[]) {
    expect(typeof zh[key]).toBe('string')
    expect(zh[key].length).toBeGreaterThan(0)
  }
})
