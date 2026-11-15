// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudSyncPanel } from '../src/client/CloudSyncPanel.tsx'
import { en } from '../src/client/locales.ts'
import { vaultTranslations } from '../vendor/config-manager/src/client/vault-translations.ts'
import { createGuardedCloudSyncCall } from '../vendor/config-manager/src/client/vault-policy.ts'
import { toastStore } from '../vendor/config-manager/src/client/common/toast-store.ts'
import { SyncApi } from '../vendor/config-manager/src/client/sync/sync-api.ts'
import type { CloudSyncCall, SyncStatusResponse } from '../vendor/config-manager/src/client/sync/sync-api.ts'
const tr = vaultTranslations(() => 'en')
const channels = ['git', 'webdav', 's3', 'gist'] as const
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function status(savedPassword = true): SyncStatusResponse {
  return {
    ok: true, configured: true, hasBaseline: false, credentialConfigured: true, credentialWritable: true,
    repoUrl: 'https://example.invalid/git-vault.git', transport: { type: 'git', ref: 'fixture' }, lastSyncChannel: 'git', sectionCount: 1,
    webdav: { url: 'https://dav.example.invalid/vault', username: 'synthetic', usernameConfigured: true, passwordConfigured: true },
    syncSections: [{ id: 'vault', displayName: 'Password vault', portability: 'portable', defaultIncluded: true }],
    syncSelectionByChannel: Object.fromEntries(channels.map(transport => [transport, { transport, mode: 'advanced', sections: ['vault'], encrypt: true, includeSecrets: false }])) as NonNullable<SyncStatusResponse['syncSelectionByChannel']>,
    syncCredentialsByChannel: Object.fromEntries(channels.map(channel => [channel, { encryptPasswordConfigured: savedPassword, decryptPasswordConfigured: true }])) as NonNullable<SyncStatusResponse['syncCredentialsByChannel']>,
    autosyncByChannel: Object.fromEntries(channels.map(channel => [channel, { enabled: false, interval: '30m', running: false }])) as NonNullable<SyncStatusResponse['autosyncByChannel']>,
  }
}
function payload(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} }
function setup(options: { readonly?: boolean; info?: SyncStatusResponse; statusWait?: ReturnType<typeof deferred<unknown>>; save?: ReturnType<typeof deferred<unknown>>; rejectPreview?: string } = {}) {
  const info = options.info ?? status()
  const call = vi.fn<CloudSyncCall>(async (action, input) => {
    const body = payload(input), channel = String(body.transport ?? 'git')
    switch (action) {
      case 'status': if (options.statusWait) await options.statusWait.promise; return structuredClone(info)
      case 'history': return { entries: [] }
      case 'githubValidate': return { ok: true, configured: true, valid: true }
      case 'snapshotsList': return { snapshots: [] }
      case 'saveUiPrefs': return { ok: true }
      case 'saveConfig': if (options.save) await options.save.promise; return { ok: true, configured: true, transport: channel, credentialConfigured: true }
      case 'saveSelection': return { ...body, encryptPasswordConfigured: true, decryptPasswordConfigured: true }
      case 'pushPreview':
        if (options.rejectPreview) throw new Error(options.rejectPreview)
        return { ok: true, planId: 'plan-' + channel, sections: [{ section: 'vault', count: 1, changed: true }], remoteSnapshotCount: 0, encrypted: true, credentialsIncluded: false }
      case 'push':
        if (body.planId !== 'plan-' + channel) throw new Error('SYNC_PUSH_PREVIEW_REQUIRED')
        return { ok: true, snapshotId: 'synthetic-snapshot', sections: ['vault'], warnings: [] }
      case 'sync': return { ok: false, syncSessionId: '', snapshotId: '', items: [], needsReview: false, compatibility: 'excellent', reason: 'remote-empty' }
      default: throw new Error('Unexpected workflow action: ' + action)
    }
  })
  const rendered = render(createElement(CloudSyncPanel, { t: key => en[key], cloudSyncCall: call, readonly: options.readonly ?? false, locked: false, unavailable: false, vaultName: 'synthetic-workflow' }))
  return { ...rendered, call }
}
async function ready() { await screen.findByText(tr.syncT('history.empty')) }
function channelBody(channel: string) { const node = document.getElementById('sync-channel-' + channel); if (!node) throw new Error('Missing channel body'); return node }
function pushButton(channel: string) { return within(channelBody(channel)).getByRole('button', { name: tr.uiT('sync.pushLabel'), exact: true }) as HTMLButtonElement }
function expandDav() { fireEvent.click(screen.getByRole('button', { name: tr.syncT('channel.expand') })) }
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }))
})
afterEach(() => { cleanup(); toastStore.clear(); vi.useRealTimers() })

test('inactive WebDAV push previews and confirms only WebDAV with the exact preview plan', async () => {
  const { call } = setup(); await ready(); expandDav()
  fireEvent.click(pushButton('webdav'))
  const dialog = await screen.findByRole('dialog', { name: tr.syncT('syncflow.pushPreviewTitle') })
  expect(call.mock.calls.find(([action]) => action === 'pushPreview')?.[1]).toMatchObject({ transport: 'webdav', url: 'https://dav.example.invalid/vault' })
  fireEvent.click(within(dialog).getByRole('button', { name: tr.syncT('syncflow.pushConfirm'), exact: true }))
  await waitFor(() => expect(call.mock.calls.find(([action]) => action === 'push')?.[1]).toMatchObject({ transport: 'webdav', planId: 'plan-webdav' }))
})

test('inactive-channel first sync fallback uses that channel rather than the rendered active one', async () => {
  const { call } = setup(); await ready(); expandDav()
  fireEvent.click(within(channelBody('webdav')).getByRole('button', { name: tr.syncT('syncflow.button') }))
  await waitFor(() => expect(call.mock.calls.find(([action]) => action === 'sync')?.[1]).toMatchObject({ transport: 'webdav', url: 'https://dav.example.invalid/vault' }))
})

test('pending debounced configuration is saved and awaited before preview, with saving feedback', async () => {
  const save = deferred<unknown>(); const { call } = setup({ save }); await ready()
  fireEvent.click(screen.getAllByRole('button', { name: tr.syncT('channel.open'), exact: true })[0]!)
  const configDialog = await screen.findByRole('dialog')
  fireEvent.change(within(configDialog).getByRole('textbox', { name: tr.syncT('config.repoUrl'), exact: true }), { target: { value: 'https://example.invalid/new-vault.git' } })
  fireEvent.click(within(configDialog).getByRole('button', { name: tr.syncT('common.close'), exact: true }))
  const action = pushButton('git')
  fireEvent.click(action)
  await waitFor(() => expect(call.mock.calls.some(([action]) => action === 'saveConfig')).toBe(true))
  expect(call.mock.calls.some(([action]) => action === 'pushPreview')).toBe(false)
  expect(action.disabled).toBe(true)
  expect(channelBody('git').textContent).toMatch(/sav.*config|config.*sav/i)
  await act(async () => { save.resolve({}); await save.promise })
  await screen.findByRole('dialog', { name: tr.syncT('syncflow.pushPreviewTitle') })
  expect(call.mock.calls.find(([action]) => action === 'pushPreview')?.[1]).toMatchObject({ transport: 'git', repoUrl: 'https://example.invalid/new-vault.git' })
  const actions = call.mock.calls.map(([action]) => action)
  expect(actions.indexOf('saveConfig')).toBeLessThan(actions.indexOf('pushPreview'))
  expect(call.mock.calls.find(([action]) => action === 'saveConfig')?.[1]).toMatchObject({ subdir: '' })
})

test('read-only configured channels disable both actions including ghost push', async () => {
  const { call } = setup({ readonly: true }); await ready()
  expect(pushButton('git').disabled).toBe(true)
  expect(within(channelBody('git')).getByRole('button', { name: tr.syncT('syncflow.button') }).hasAttribute('disabled')).toBe(true)
  expect(channelBody('git').textContent).toMatch(/read.only/i)
  fireEvent.click(pushButton('git'))
  expect(call.mock.calls.some(([action]) => action === 'pushPreview' || action === 'push')).toBe(false)
})

test('fresh encrypted configuration explains push prerequisite and lets a matching password unlock it', async () => {
  const { call } = setup({ info: status(false) }); await ready()
  expect(pushButton('git').disabled).toBe(true)
  expect(channelBody('git').textContent).toMatch(/encryption password/i)
  const body = within(channelBody('git'))
  const password = body.getByLabelText(tr.syncT('mode.password'), { exact: true })
  const confirm = body.getByLabelText(tr.syncT('mode.passwordConfirm'), { exact: true })
  fireEvent.change(password, { target: { value: 'synthetic-workflow-password' } })
  fireEvent.change(confirm, { target: { value: 'synthetic-workflow-password' } })
  fireEvent.blur(confirm)
  await waitFor(() => expect(call.mock.calls.find(([action]) => action === 'saveSelection')?.[1]).toMatchObject({ transport: 'git', encrypt: true, sections: ['vault'] }))
  expect(pushButton('git').disabled).toBe(false)
})

test('allowlisted host errors become actionable localized text without exposing RPC details', async () => {
  setup({ rejectPreview: 'vault.cloudSyncCall failed: INTERNAL: SYNC_ENCRYPT_PASSWORD_REQUIRED: synthetic-hidden-secret' }); await ready()
  fireEvent.click(pushButton('git'))
  await waitFor(() => expect(document.body.textContent).toMatch(/set.*encryption password|enter.*encryption password/i))
  expect(document.body.textContent).not.toContain('synthetic-hidden-secret')
  expect(document.body.textContent).not.toContain('SYNC_ENCRYPT_PASSWORD_REQUIRED')
})

test('late initial status cannot erase a new target or matching encryption-password draft', async () => {
  const statusWait = deferred<unknown>()
  const info = { ...status(false), configured: false, repoUrl: '', webdav: undefined }
  setup({ info, statusWait }); await ready()
  fireEvent.click(screen.getAllByRole('button', { name: tr.syncT('channel.open'), exact: true })[0]!)
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox', { name: tr.syncT('config.repoUrl'), exact: true }), { target: { value: 'https://example.invalid/new-vault.git' } })
  fireEvent.click(within(dialog).getByRole('button', { name: tr.syncT('common.close'), exact: true }))
  const body = within(channelBody('git'))
  fireEvent.change(body.getByLabelText(tr.syncT('mode.password'), { exact: true }), { target: { value: 'synthetic-draft-password' } })
  fireEvent.change(body.getByLabelText(tr.syncT('mode.passwordConfirm'), { exact: true }), { target: { value: 'synthetic-draft-password' } })
  await act(async () => { statusWait.resolve({}); await statusWait.promise })
  await waitFor(() => expect(pushButton('git').disabled).toBe(false))
  expect((body.getByLabelText(tr.syncT('mode.password'), { exact: true }) as HTMLInputElement).value).toBe('synthetic-draft-password')
})

test('facade can confirm the exact first preview even after another same-channel preview', async () => {
  let count = 0
  const host = vi.fn<CloudSyncCall>(async action => action === 'pushPreview' ? { ok: true, planId: 'preview-' + ++count } : { ok: true })
  const api = new SyncApi(tr.uiT, host)
  const first = await api.pushPreview({ transport: 'git' })
  const second = await api.pushPreview({ transport: 'git' })
  await api.push({ transport: 'git' }, first.planId)
  await api.push({ transport: 'git' }, second.planId)
  expect(host.mock.calls.filter(([action]) => action === 'push').map(([, body]) => payload(body).planId)).toEqual(['preview-1', 'preview-2'])
})

test('guard passes only safe known error codes and masks every unknown error', async () => {
  const access = () => ({ readonly: false, locked: false, unavailable: false })
  const known = createGuardedCloudSyncCall(async () => { throw new Error('vault.cloudSyncCall failed: INTERNAL: SYNC_PUSH_PREVIEW_REQUIRED: synthetic-hidden-secret') }, access, () => true, () => {})
  await expect(known.call('push', {})).rejects.toMatchObject({ message: 'SYNC_PUSH_PREVIEW_REQUIRED' })
  const unknown = createGuardedCloudSyncCall(async () => { throw new Error('synthetic-hidden-secret') }, access, () => true, () => {})
  await expect(unknown.call('push', {})).rejects.not.toThrow('synthetic-hidden-secret')
})
