// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { VaultWorkbench } from '../src/client/VaultWorkbench.tsx'
import type { VaultSectionProps } from '../src/client/VaultSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import { workbenchFixture } from './fixtures/workbench-ui.ts'

// Synthetic injected APIs only: mount the real workbench and VaultSection.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const languages = [
  { language: 'English', dictionary: en, bootLoading: 'Checking vault…', waitingUnlock: 'Enter the master password to open your vault.', waitingCreate: 'Create a master password to get started.', entriesLoading: 'Loading vault entries…', entriesFailed: 'Unable to load vault entries. Try refreshing.' },
  { language: 'Chinese', dictionary: zh, bootLoading: '正在检查密码库…', waitingUnlock: '输入主密码以打开密码库。', waitingCreate: '请先设置主密码以创建密码库。', entriesLoading: '正在加载密码条目…', entriesFailed: '无法加载密码条目，请刷新重试。' },
]
function footer() { return document.querySelector('[data-vault-workbench] > footer') as HTMLElement }
function expectStatus(text: string, dot: 'unknown' | 'warn' | 'ok') {
  expect(within(footer()).getByRole('status').textContent).toBe(text)
  expect(footer().querySelector('[data-state]')?.getAttribute('data-state')).toBe(dot)
}
function localizedProps(props: VaultSectionProps, dictionary: typeof en | typeof zh): VaultSectionProps {
  return { ...props, t: key => dictionary[key] }
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks() })

test.each(languages)('$language: setup loading is an explicit pending status', ({ dictionary, bootLoading }) => {
  const { props, api } = workbenchFixture()
  const setup = deferred<Awaited<ReturnType<NonNullable<VaultSectionProps['setupStatus']>>>>()
  api.setupStatus.mockReturnValue(setup.promise)
  render(createElement(VaultWorkbench, localizedProps(props, dictionary)))
  expectStatus(bootLoading, 'unknown')
  expect(api.list).not.toHaveBeenCalled()
})

test.each(languages)('$language: an existing unopened vault waits for its password', async ({ dictionary, waitingUnlock }) => {
  const { props, api } = workbenchFixture({ configured: false, exists: true })
  render(createElement(VaultWorkbench, localizedProps(props, dictionary)))
  await screen.findByLabelText(dictionary.wbMasterPassword)
  expectStatus(waitingUnlock, 'warn')
  expect(screen.queryByLabelText(dictionary.wbConfirmPassword)).toBeNull()
  expect(api.list).not.toHaveBeenCalled()
})

test.each(languages)('$language: a missing vault waits for master password creation', async ({ dictionary, waitingCreate }) => {
  const { props, api } = workbenchFixture({ configured: false, exists: false })
  render(createElement(VaultWorkbench, localizedProps(props, dictionary)))
  await screen.findByLabelText(dictionary.wbConfirmPassword)
  expectStatus(waitingCreate, 'warn')
  expect(api.list).not.toHaveBeenCalled()
})

test.each(languages)('$language: setup failure is localized and retry returns to pending', async ({ dictionary, bootLoading, waitingUnlock }) => {
  const { props, api } = workbenchFixture()
  const first = deferred<Awaited<ReturnType<NonNullable<VaultSectionProps['setupStatus']>>>>()
  const retry = deferred<Awaited<ReturnType<NonNullable<VaultSectionProps['setupStatus']>>>>()
  api.setupStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  render(createElement(VaultWorkbench, localizedProps(props, dictionary)))
  await act(async () => first.reject(new Error('TEST-PRIVATE-SETUP-DETAIL')))
  expectStatus(dictionary.wbLoadFailed, 'warn')
  expect(document.body.innerHTML).not.toContain('TEST-PRIVATE-SETUP-DETAIL')
  fireEvent.click(screen.getByRole('button', { name: dictionary.wbRetry }))
  expectStatus(bootLoading, 'unknown')
  await act(async () => retry.resolve({ configured: false, exists: true }))
  expectStatus(waitingUnlock, 'warn')
  expect(api.list).not.toHaveBeenCalled()
})

test.each(languages)('$language: entry loading, failure and retry have distinct footer states', async ({ dictionary, entriesLoading, entriesFailed }) => {
  const { props, api } = workbenchFixture()
  const first = deferred<Awaited<ReturnType<typeof api.list>>>()
  const retry = deferred<Awaited<ReturnType<typeof api.list>>>()
  api.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  render(createElement(VaultWorkbench, localizedProps(props, dictionary)))
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
  expectStatus(entriesLoading, 'unknown')
  await act(async () => first.reject(new Error('TEST-PRIVATE-LIST-DETAIL')))
  expectStatus(entriesFailed, 'warn')
  expect(footer().innerHTML).not.toContain('TEST-PRIVATE-LIST-DETAIL')
  fireEvent.click(screen.getByRole('tab', { name: dictionary.wbEntries }))
  fireEvent.click(screen.getByRole('button', { name: dictionary.retry }))
  expectStatus(entriesLoading, 'unknown')
  await act(async () => retry.resolve([]))
  expectStatus(dictionary.wbReady, 'ok')
  expect(api.list).toHaveBeenCalledTimes(2)
})

test('password submission reports working, then a safe localized failure', async () => {
  const { props, api } = workbenchFixture({ configured: false, exists: true })
  const opening = deferred<Awaited<ReturnType<NonNullable<VaultSectionProps['openWithPassword']>>>>()
  api.openWithPassword.mockReturnValueOnce(opening.promise)
  render(createElement(VaultWorkbench, props))
  const password = await screen.findByLabelText(en.wbMasterPassword) as HTMLInputElement
  fireEvent.change(password, { target: { value: 'TEST-NOT-A-REAL-PASSWORD' } })
  fireEvent.click(screen.getByRole('button', { name: en.wbOpenVault }))
  expectStatus(en.wbWorking, 'unknown')
  await act(async () => opening.reject(new Error('TEST-PRIVATE-OPEN-DETAIL')))
  expectStatus(en.wbOpenFailedStatus, 'warn')
  expect(password.value).toBe('')
  expect(document.body.innerHTML).not.toContain('TEST-PRIVATE-OPEN-DETAIL')
  expect(api.list).not.toHaveBeenCalled()
})

test('an operation reports working before the locked status takes priority over its message', async () => {
  const { props, api } = workbenchFixture()
  const locking = deferred<Awaited<ReturnType<VaultSectionProps['lock']>>>()
  api.lock.mockReturnValueOnce(locking.promise)
  render(createElement(VaultWorkbench, props))
  await waitFor(() => expectStatus(en.wbReady, 'ok'))
  fireEvent.click(screen.getByRole('button', { name: en.wbCommands }))
  const palette = screen.getByRole('dialog', { name: en.wbCommands })
  fireEvent.click(within(palette).getByRole('option', { name: en.wbLock }))
  expectStatus(en.wbWorking, 'unknown')
  await act(async () => locking.resolve({ locked: true }))
  expectStatus(en.lockedShort, 'warn')
})

test('a locked list result reports locked rather than an entry load error', async () => {
  const { props, api } = workbenchFixture()
  const list = deferred<Awaited<ReturnType<typeof api.list>>>()
  api.list.mockReturnValueOnce(list.promise)
  api.status.mockResolvedValue({ locked: true, entries: 0 })
  render(createElement(VaultWorkbench, props))
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
  await act(async () => list.reject(new Error('vault is locked')))
  expectStatus(en.lockedShort, 'warn')
})
