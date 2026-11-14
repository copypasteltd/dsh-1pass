// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { VaultWorkbench } from '../src/client/VaultWorkbench.tsx'
import { en } from '../src/client/locales.ts'
import { workbenchFixture } from './fixtures/workbench-ui.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks() })

test('four reference-style main tabs, command actions and full-width tasks preserve the business engine', async () => {
  const { props, api } = workbenchFixture()
  render(createElement(VaultWorkbench, props))
  await screen.findByText('Example account')
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map(tab => tab.textContent)).toEqual([en.wbHome, en.wbEntries, en.wbBackup, en.wbSettings])
  const calls = api.list.mock.calls.length
  fireEvent.click(screen.getByRole('tab', { name: en.wbEntries }))
  expect(screen.getByText('Example account')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.wbAbout }))
  expect(screen.getByText(en.wbAboutText)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.wbBack.replace('{page}', en.wbEntries) }))
  expect(screen.getByText('Example account')).toBeTruthy()
  expect(api.list.mock.calls.length).toBe(calls)
})

test('command palette has keyboard search and closes without persisting query', async () => {
  const { props } = workbenchFixture()
  render(createElement(VaultWorkbench, props))
  await screen.findByText('Example account')
  fireEvent.click(screen.getByRole('button', { name: en.wbCommands }))
  const palette = await screen.findByRole('dialog', { name: en.wbCommands })
  const query = within(palette).getByRole('combobox')
  fireEvent.change(query, { target: { value: 'synthetic-private-command-query' } })
  expect(sessionStorage.getItem('dsh-onepass-workbench-navigation')).not.toContain('synthetic-private-command-query')
  fireEvent.keyDown(query, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.wbCommands })).toBeNull())
})

test('first-use form allows weak passwords, requires confirmation, and clears password DOM after opening', async () => {
  const { props, api } = workbenchFixture({ configured: false, exists: false })
  render(createElement(VaultWorkbench, props))
  const password = await screen.findByLabelText(en.wbMasterPassword) as HTMLInputElement
  const confirmation = screen.getByLabelText(en.wbConfirmPassword) as HTMLInputElement
  expect(password.type).toBe('password')
  expect(confirmation.type).toBe('password')
  fireEvent.change(password, { target: { value: '1' } })
  fireEvent.change(confirmation, { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: en.wbCreateVault }))
  await screen.findByText(en.wbMismatch)
  expect(api.openWithPassword).not.toHaveBeenCalled()
  fireEvent.change(confirmation, { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: en.wbCreateVault }))
  await waitFor(() => expect(api.openWithPassword).toHaveBeenCalledWith('1'))
  await screen.findByText('Example account')
  expect(screen.queryByLabelText(en.wbMasterPassword)).toBeNull()
  expect(JSON.stringify(Object.values(sessionStorage))).not.toContain('password')
})

test('existing vault opening never asks for creation confirmation', async () => {
  const { props } = workbenchFixture({ configured: false, exists: true })
  render(createElement(VaultWorkbench, props))
  await screen.findByLabelText(en.wbMasterPassword)
  expect(screen.queryByLabelText(en.wbConfirmPassword)).toBeNull()
  expect(screen.getByRole('button', { name: en.wbOpenVault })).toBeTruthy()
})

test('a password-opening failure clears input and never mounts credential reads', async () => {
  const { props, api } = workbenchFixture({ configured: false, exists: true })
  api.openWithPassword.mockRejectedValueOnce(new Error('synthetic-password-must-not-echo'))
  render(createElement(VaultWorkbench, props))
  const input = await screen.findByLabelText(en.wbMasterPassword) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'synthetic-password-must-not-echo' } })
  fireEvent.click(screen.getByRole('button', { name: en.wbOpenVault }))
  await screen.findByText(en.wbSetupFailed)
  expect(input.value).toBe('')
  expect(document.body.textContent).not.toContain('synthetic-password-must-not-echo')
  expect(api.list).not.toHaveBeenCalled()
})
