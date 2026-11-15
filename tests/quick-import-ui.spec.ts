// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { QuickImportPanel, type QuickImportPanelProps } from '../src/client/QuickImportPanel.tsx'
import { QuickImportEn as en, QuickImportZh as zh, type QuickImportLocaleKey } from '../src/client/quick-import-locales.ts'
import { DEFAULT_QUICK_IMPORT_FORMAT, QUICK_IMPORT_PRESETS, SUPPORTED_QUICK_IMPORT_PLACEHOLDERS } from '../src/quick-import.ts'
import type { QuickImportCommitResult, QuickImportOptions, QuickImportPreview } from '../src/quick-import-types.ts'
import type { VaultTranslate } from '../src/client/host-contracts.ts'

// Synthetic values only. All I/O is mocked: no real vault, network, browser or storage.
const SOURCE = 'root@192.0.2.10:22|TEST-NOT-REAL-UI|demo'
const TOKEN = 'synthetic-preview-token-not-a-secret'
const translate = ((key: QuickImportLocaleKey) => en[key]) as VaultTranslate
function previewValue(overrides: Partial<QuickImportPreview> = {}): QuickImportPreview {
  return { token: TOKEN, expiresAt: Date.now() + 300_000, vaultName: 'test', valid: 2, duplicates: 1, invalid: 1, ignored: 0, rows: [
    { line: 1, status: 'ready', title: 'Backend title', username: 'root', host: '192.0.2.10', ip: '192.0.2.10', port: '22', tags: ['demo'], hasPassword: true },
    { line: 2, status: 'duplicate', title: 'Already saved', username: 'root', host: '192.0.2.20', port: '22', hasPassword: true },
    { line: 3, status: 'invalid', error: 'INVALID_PORT' },
    { line: 4, status: 'ready', title: 'Second server', username: 'dev', host: 'example.test', port: '2222', tags: ['dev'], hasPassword: true },
  ], ...overrides }
}
function resultValue(): QuickImportCommitResult { return { added: 2, skipped: 0, lines: [{ line: 1, status: 'added' }, { line: 4, status: 'added' }], note: 'synthetic backend note that must not be rendered' } }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(overrides: Partial<QuickImportPanelProps> = {}) {
  const previewQuickImport = vi.fn(async (_text: string, _options: QuickImportOptions) => previewValue())
  const commitQuickImport = vi.fn(async (_token: string, _lines: number[], _confirm: boolean) => resultValue())
  const discardQuickImport = vi.fn(async (_token: string) => ({ discarded: true }))
  const onImported = vi.fn()
  const onBusyChange = vi.fn()
  const props: QuickImportPanelProps = { t: translate, previewQuickImport, commitQuickImport, discardQuickImport,
    readonly: false, locked: false, unavailable: false, vaultName: 'test', onImported, onBusyChange, ...overrides }
  return { ...render(createElement(QuickImportPanel, props)), props, previewQuickImport: props.previewQuickImport, commitQuickImport: props.commitQuickImport, discardQuickImport: props.discardQuickImport!, onImported: props.onImported!, onBusyChange: props.onBusyChange! }
}
function enter(value = SOURCE): HTMLTextAreaElement {
  const source = screen.getByLabelText(en.quickImportSource) as HTMLTextAreaElement
  fireEvent.change(source, { target: { value } })
  return source
}
async function showPreview(): Promise<void> {
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  await screen.findByRole('table', { name: en.quickImportTable })
}
function review(count = 2): void { fireEvent.click(screen.getByRole('button', { name: en.quickImportReviewAction.replace('{n}', String(count)) })) }
function approve(count = 2): void { fireEvent.click(screen.getByLabelText(en.quickImportReviewed.replace('{n}', String(count)))) }
function commitButton(count = 2): HTMLButtonElement { return screen.getByRole('button', { name: en.quickImportCommit.replace('{n}', String(count)) }) as HTMLButtonElement }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear() })

test('mount is inert, defaults use port not IP, and raw source is masked with an explicit toggle', () => {
  const { previewQuickImport, commitQuickImport } = setup()
  expect(previewQuickImport).not.toHaveBeenCalled(); expect(commitQuickImport).not.toHaveBeenCalled()
  expect((screen.getByLabelText(en.quickImportFormat) as HTMLInputElement).value).toBe(DEFAULT_QUICK_IMPORT_FORMAT)
  expect((screen.getByLabelText(en.quickImportDefaultPort) as HTMLInputElement).value).toBe('22')
  expect(screen.getByText('root@192.0.2.10:22|TEST-NOT-REAL|demo')).toBeTruthy()
  const source = enter()
  expect((source.style as CSSStyleDeclaration & { WebkitTextSecurity: string }).WebkitTextSecurity).toBe('disc')
  expect(source.getAttribute('aria-describedby')).toContain('privacy')
  expect(source.autocomplete).toBe('off'); expect(source.spellcheck).not.toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.quickImportShow }))
  expect((source.style as CSSStyleDeclaration & { WebkitTextSecurity: string }).WebkitTextSecurity).toBe('none')
  expect(screen.getByRole('button', { name: en.quickImportHide }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: en.quickImportHide }))
  expect((source.style as CSSStyleDeclaration & { WebkitTextSecurity: string }).WebkitTextSecurity).toBe('disc')
})

test('presets, custom formats, login/SSH options, tags, and complete escaping help use the parser contract', async () => {
  const { previewQuickImport } = setup()
  fireEvent.click(screen.getByText(en.quickImportHelp))
  for (const placeholder of SUPPORTED_QUICK_IMPORT_PLACEHOLDERS) expect(screen.getByText(placeholder, { selector: 'code' })).toBeTruthy()
  expect(en.quickImportEscapeHelp).toContain(String.raw`\|`)
  expect(en.quickImportEscapeHelp).toContain(String.raw`\\`)
  const ip = QUICK_IMPORT_PRESETS.find(item => item.id === 'host-ip')!
  fireEvent.change(screen.getByLabelText(en.quickImportPreset), { target: { value: ip.id } })
  expect((screen.getByLabelText(en.quickImportFormat) as HTMLInputElement).value).toBe(ip.format)
  expect(ip.format).toContain('{ip}'); expect(ip.format).not.toContain('{port}')
  const custom = '{username}@{host}|{password}|{nickname}'
  fireEvent.change(screen.getByLabelText(en.quickImportFormat), { target: { value: custom } })
  expect((screen.getByLabelText(en.quickImportPreset) as HTMLSelectElement).value).toBe('custom')
  fireEvent.change(screen.getByLabelText(en.quickImportKind), { target: { value: 'login' } })
  fireEvent.change(screen.getByLabelText(en.quickImportDefaultPort), { target: { value: '443' } })
  fireEvent.change(screen.getByLabelText(en.quickImportTags), { target: { value: ' extra, demo , ' } })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  await waitFor(() => expect(previewQuickImport).toHaveBeenCalledWith(SOURCE, { format: custom, kind: 'login', defaultPort: '443', defaultTags: ['extra', 'demo'] }))
})

test('preview only trusts backend metadata, hides all password/raw/token/error text, and makes duplicates/invalid unselectable', async () => {
  const response = previewValue()
  Object.assign(response.rows[0]!, { password: 'TEST-SHOULD-NEVER-RENDER', raw: SOURCE, warning: 'TEST-BACKEND-WARNING-DO-NOT-ECHO' })
  Object.assign(response.rows[2]!, { error: 'TEST-BACKEND-RAW-PASSWORD', title: SOURCE })
  const { commitQuickImport } = setup({ previewQuickImport: vi.fn(async () => response) })
  await showPreview()
  expect(screen.queryByLabelText(en.quickImportSource)).toBeNull()
  expect(document.querySelector('textarea')).toBeNull()
  expect(screen.getByText('Backend title')).toBeTruthy()
  for (const secret of [SOURCE, 'TEST-SHOULD-NEVER-RENDER', 'TEST-BACKEND-RAW-PASSWORD', 'TEST-BACKEND-WARNING-DO-NOT-ECHO', TOKEN]) {
    expect(document.body.innerHTML).not.toContain(secret)
  }
  expect(screen.getAllByLabelText(en.quickImportPasswordPresent).length).toBe(3)
  for (const node of screen.getAllByLabelText(en.quickImportPasswordPresent)) expect(node.textContent).toBe('••••••••')
  expect(screen.getByText(en.quickImportErrInvalid)).toBeTruthy()
  expect((screen.getByLabelText(en.quickImportSelectLine.replace('{line}', '2')) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText(en.quickImportSelectLine.replace('{line}', '3')) as HTMLInputElement).disabled).toBe(true)
  expect(commitQuickImport).not.toHaveBeenCalled()
})

test('selection and reviewed checkbox gate the only commit; success clears raw source/token and calls parent once', async () => {
  const { commitQuickImport, onImported, previewQuickImport } = setup()
  await showPreview()
  fireEvent.click(screen.getByLabelText(en.quickImportSelectLine.replace('{line}', '4')))
  review(1)
  expect(commitButton(1).disabled).toBe(true)
  fireEvent.click(commitButton(1)); expect(commitQuickImport).not.toHaveBeenCalled()
  approve(1); fireEvent.click(commitButton(1))
  await screen.findByRole('heading', { name: en.quickImportResultTitle })
  expect(commitQuickImport).toHaveBeenCalledExactlyOnceWith(TOKEN, [1], true)
  expect(onImported).toHaveBeenCalledTimes(1)
  expect(previewQuickImport).toHaveBeenCalledTimes(1)
  expect(document.body.innerHTML).not.toContain(SOURCE)
  expect(document.body.innerHTML).not.toContain(TOKEN)
  expect(document.body.innerHTML).not.toContain(resultValue().note)
  fireEvent.click(screen.getByRole('button', { name: en.quickImportAgain }))
  expect((screen.getByLabelText(en.quickImportSource) as HTMLTextAreaElement).value).toBe('')
})

test('select-all supports none/some/all, and changing selection resets review approval', async () => {
  setup(); await showPreview()
  const all = screen.getByLabelText(en.quickImportSelectAll, { exact: false }) as HTMLInputElement
  expect(all.checked).toBe(true)
  fireEvent.click(all)
  expect(screen.getByText(en.quickImportNoSelection)).toBeTruthy()
  expect((screen.getByRole('button', { name: en.quickImportReviewAction.replace('{n}', '0') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(en.quickImportSelectLine.replace('{line}', '1')))
  expect(all.indeterminate).toBe(true)
  review(1); approve(1)
  fireEvent.click(screen.getByRole('button', { name: en.quickImportBackToPreview }))
  fireEvent.click(screen.getByLabelText(en.quickImportSelectAll, { exact: false })); review(2)
  expect((screen.getByLabelText(en.quickImportReviewed.replace('{n}', '2')) as HTMLInputElement).checked).toBe(false)
})

test('discard-and-edit invalidates token immediately, retains only the draft in memory and requires fresh preview', async () => {
  const { discardQuickImport, commitQuickImport, previewQuickImport } = setup()
  await showPreview()
  fireEvent.click(screen.getByRole('button', { name: en.quickImportEdit }))
  expect(discardQuickImport).toHaveBeenCalledWith(TOKEN)
  expect(screen.queryByRole('table')).toBeNull()
  expect((screen.getByLabelText(en.quickImportSource) as HTMLTextAreaElement).value).toBe(SOURCE)
  fireEvent.change(screen.getByLabelText(en.quickImportFormat), { target: { value: '{user}@{host}|{pwd}' } })
  expect(previewQuickImport).toHaveBeenCalledTimes(1); expect(commitQuickImport).not.toHaveBeenCalled()
})

test.each(['source', 'format', 'kind', 'port', 'tags', 'preset'] as const)('editing %s while preview is pending discards late response and never overwrites edits', async field => {
  const late = deferred<QuickImportPreview>()
  const previewQuickImport = vi.fn(() => late.promise)
  const { discardQuickImport, commitQuickImport } = setup({ previewQuickImport })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  const edits = {
    source: [en.quickImportSource, SOURCE + '-edited'], format: [en.quickImportFormat, '{user}@{host}|{pwd}'],
    kind: [en.quickImportKind, 'login'], port: [en.quickImportDefaultPort, '2222'], tags: [en.quickImportTags, 'edited'], preset: [en.quickImportPreset, 'host-ip'],
  }
  const [label, value] = edits[field]
  fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  await act(async () => { late.resolve(previewValue()); await late.promise })
  expect(screen.queryByRole('table')).toBeNull()
  expect(discardQuickImport).toHaveBeenCalledWith(TOKEN)
  expect((screen.getByLabelText(label!) as HTMLInputElement).value).toBe(value)
  expect(commitQuickImport).not.toHaveBeenCalled()
})

test('out-of-order previews cannot replace current rows or clear current busy state', async () => {
  const first = deferred<QuickImportPreview>(), second = deferred<QuickImportPreview>()
  const previewQuickImport = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const { onBusyChange } = setup({ previewQuickImport })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  enter(SOURCE + '-new'); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  await act(async () => { first.resolve(previewValue({ token: 'old-token' })); await first.promise })
  expect(screen.queryByRole('table')).toBeNull()
  expect((screen.getByRole('button', { name: en.quickImportPreviewing }) as HTMLButtonElement).disabled).toBe(true)
  expect(onBusyChange.mock.lastCall).toEqual([true])
  await act(async () => { second.resolve(previewValue({ token: 'new-token' })); await second.promise })
  await screen.findByRole('table')
  expect(onBusyChange.mock.lastCall).toEqual([false])
})

test('unmount discards an active token and a late preview, and never imports/calls onImported after unmount', async () => {
  const late = deferred<QuickImportPreview>()
  const { unmount, discardQuickImport, onImported } = setup({ previewQuickImport: vi.fn(() => late.promise) })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction })); unmount()
  await act(async () => { late.resolve(previewValue()); await late.promise })
  expect(discardQuickImport).toHaveBeenCalledWith(TOKEN); expect(onImported).not.toHaveBeenCalled()
  const active = setup(); await showPreview(); active.unmount()
  expect(active.discardQuickImport).toHaveBeenCalledWith(TOKEN)
})

test('ambiguous commit retries exactly the same token/selection, locks selection, never auto-previews, and is safe against double click', async () => {
  const retry = deferred<QuickImportCommitResult>()
  const commitQuickImport = vi.fn().mockRejectedValueOnce(new Error('TEST-NOT-REAL-RAW-ERROR')).mockImplementationOnce(() => retry.promise)
  const { previewQuickImport, onImported } = setup({ commitQuickImport })
  await showPreview(); review(); approve(); fireEvent.click(commitButton())
  await screen.findByText(en.quickImportAmbiguous)
  expect(document.body.innerHTML).not.toContain('TEST-NOT-REAL-RAW-ERROR')
  expect(screen.queryByRole('button', { name: en.quickImportBackToPreview })).toBeNull()
  expect((screen.getByLabelText(en.quickImportReviewed.replace('{n}', '2')) as HTMLInputElement).disabled).toBe(true)
  const button = screen.getByRole('button', { name: en.quickImportRetryCommit })
  fireEvent.click(button); fireEvent.click(button)
  expect(commitQuickImport).toHaveBeenCalledTimes(2)
  expect(commitQuickImport.mock.calls).toEqual([[TOKEN, [1, 4], true], [TOKEN, [1, 4], true]])
  expect(previewQuickImport).toHaveBeenCalledTimes(1)
  await act(async () => { retry.resolve(resultValue()); await retry.promise })
  expect(onImported).toHaveBeenCalledTimes(1)
})

test('readonly can preview but cannot commit, and policy changes guard an already-reviewed action', async () => {
  const { props, rerender, commitQuickImport } = setup({ readonly: true })
  await showPreview()
  expect((screen.getByRole('button', { name: en.quickImportReviewAction.replace('{n}', '2') }) as HTMLButtonElement).disabled).toBe(true)
  rerender(createElement(QuickImportPanel, { ...props, readonly: false })); review(); approve()
  rerender(createElement(QuickImportPanel, { ...props, readonly: true }))
  expect(commitButton().disabled).toBe(true); fireEvent.click(commitButton())
  expect(commitQuickImport).not.toHaveBeenCalled()
})

test.each([{ locked: true }, { unavailable: true }])('locked/unavailable blocks preview entirely: %j', guards => {
  const { previewQuickImport, commitQuickImport } = setup(guards); enter()
  const button = screen.getByRole('button', { name: en.quickImportPreviewAction }) as HTMLButtonElement
  expect(button.disabled).toBe(true); fireEvent.click(button)
  expect(previewQuickImport).not.toHaveBeenCalled(); expect(commitQuickImport).not.toHaveBeenCalled()
})

test('vault change or lock during a request rejects late response and clears previous scope input', async () => {
  const late = deferred<QuickImportPreview>()
  const { props, rerender, discardQuickImport } = setup({ previewQuickImport: vi.fn(() => late.promise) })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  rerender(createElement(QuickImportPanel, { ...props, vaultName: 'other', locked: true }))
  await act(async () => { late.resolve(previewValue()); await late.promise })
  expect(screen.queryByRole('table')).toBeNull()
  expect((screen.getByLabelText(en.quickImportSource) as HTMLTextAreaElement).value).toBe('')
  expect(discardQuickImport).toHaveBeenCalledWith(TOKEN)
})

test('client blocks more than 500 credential rows and more than 1 MiB UTF-8 without calling backend', () => {
  const { previewQuickImport } = setup()
  enter(Array(501).fill(SOURCE).join('\n'))
  expect(screen.getByText(en.quickImportErrRows)).toBeTruthy()
  expect((screen.getByRole('button', { name: en.quickImportPreviewAction }) as HTMLButtonElement).disabled).toBe(true)
  enter('界'.repeat(350_000))
  expect(screen.getByText(en.quickImportErrBytes)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  expect(previewQuickImport).not.toHaveBeenCalled()
})

test('exactly 500 rows remain previewable; blank/comment rows are not counted, and backend global errors stay visible', async () => {
  const previewQuickImport = vi.fn(async () => previewValue({ valid: 0, invalid: 1, duplicates: 0, rows: [{ line: 0, status: 'invalid', error: 'INVALID_DEFAULT_TAGS' }] }))
  setup({ previewQuickImport })
  enter('# synthetic comment\r\n\r\n' + Array(500).fill(SOURCE).join('\r\n') + '\r\n')
  const button = screen.getByRole('button', { name: en.quickImportPreviewAction }) as HTMLButtonElement
  expect(button.disabled).toBe(false); fireEvent.click(button)
  await screen.findByText(en.quickImportErrInvalid)
  expect(previewQuickImport).toHaveBeenCalledTimes(1)
  expect(screen.getByText('0', { selector: 'td span' })).toBeTruthy()
})

test('expired or wrong-vault preview is rejected, and expiry disables commit without polling/repreview', async () => {
  const bad = setup({ previewQuickImport: vi.fn(async () => previewValue({ vaultName: 'other' })) })
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  await screen.findByText(en.quickImportErrScope)
  expect(screen.queryByRole('table')).toBeNull(); bad.unmount()
  const soon = setup({ previewQuickImport: vi.fn(async () => previewValue({ expiresAt: Date.now() + 1000 })) })
  await showPreview(); review(); approve()
  await waitFor(() => expect(commitButton().disabled).toBe(true), { timeout: 2000 })
  expect(soon.previewQuickImport).toHaveBeenCalledTimes(1)
  expect(soon.commitQuickImport).not.toHaveBeenCalled()
})

test('clear button erases input and stale previews; failed preview never renders backend error text', async () => {
  const { previewQuickImport, commitQuickImport } = setup({ previewQuickImport: vi.fn().mockRejectedValue(new Error('TEST-RAW-PASSWORD-ERROR')) })
  const source = enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportClear }))
  expect(source.value).toBe('')
  enter(); fireEvent.click(screen.getByRole('button', { name: en.quickImportPreviewAction }))
  await screen.findByText(en.quickImportErrPreview)
  expect(document.body.innerHTML).not.toContain('TEST-RAW-PASSWORD-ERROR')
  expect(previewQuickImport).toHaveBeenCalledTimes(1); expect(commitQuickImport).not.toHaveBeenCalled()
})

test('input, options and tokens never enter browser storage, URL, clipboard, fetch or logs', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const log = vi.spyOn(console, 'log'), info = vi.spyOn(console, 'info'), error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn')
  const initialUrl = window.location.href
  setup(); await showPreview(); review(); approve(); fireEvent.click(commitButton())
  await screen.findByRole('heading', { name: en.quickImportResultTitle })
  expect(storage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  expect(window.location.href).toBe(initialUrl)
  for (const spy of [log, info, error, warn]) expect(JSON.stringify(spy.mock.calls)).not.toContain('TEST-NOT-REAL-UI')
  const source = readFileSync(new NodeURL('../src/client/QuickImportPanel.tsx', import.meta.url), 'utf8')
  expect(source).not.toMatch(/localStorage|sessionStorage|console\.|location\.|navigator\.clipboard|fetch\(/)
  vi.unstubAllGlobals()
})

test('unmounted commit cannot call parent or render a late result; busy signal is released', async () => {
  const late = deferred<QuickImportCommitResult>()
  const { unmount, onImported, onBusyChange } = setup({ commitQuickImport: vi.fn(() => late.promise) })
  await showPreview(); review(); approve(); fireEvent.click(commitButton())
  expect(onBusyChange.mock.lastCall).toEqual([true])
  unmount(); expect(onBusyChange.mock.lastCall).toEqual([false])
  await act(async () => { late.resolve(resultValue()); await late.promise })
  expect(onImported).not.toHaveBeenCalled()
  expect(screen.queryByRole('heading', { name: en.quickImportResultTitle })).toBeNull()
})

test('completed result survives the parent refresh busy transition without restoring raw input', async () => {
  const { props, rerender, onImported } = setup()
  await showPreview(); review(); approve(); fireEvent.click(commitButton())
  await screen.findByRole('heading', { name: en.quickImportResultTitle })
  rerender(createElement(QuickImportPanel, { ...props, unavailable: true }))
  expect(screen.getByRole('heading', { name: en.quickImportResultTitle })).toBeTruthy()
  rerender(createElement(QuickImportPanel, { ...props, unavailable: false }))
  expect(screen.getByRole('heading', { name: en.quickImportResultTitle })).toBeTruthy()
  expect(screen.queryByLabelText(en.quickImportSource)).toBeNull()
  expect(onImported).toHaveBeenCalledTimes(1)
})

test('an ambiguous commit keeps its same-token retry available after the preview expiry', async () => {
  const clock = vi.spyOn(Date, 'now')
  const now = Date.now()
  const response = previewValue({ expiresAt: now + 300_000 })
  const commitQuickImport = vi.fn().mockRejectedValueOnce(new Error('synthetic result unknown')).mockResolvedValueOnce(resultValue())
  const { previewQuickImport } = setup({ previewQuickImport: vi.fn(async () => response), commitQuickImport })
  await showPreview(); review(); approve(); fireEvent.click(commitButton())
  await screen.findByText(en.quickImportAmbiguous)
  clock.mockReturnValue(now + 600_000)
  const retry = screen.getByRole('button', { name: en.quickImportRetryCommit }) as HTMLButtonElement
  expect(retry.disabled).toBe(false); fireEvent.click(retry)
  await screen.findByRole('heading', { name: en.quickImportResultTitle })
  expect(commitQuickImport.mock.calls).toEqual([[TOKEN, [1, 4], true], [TOKEN, [1, 4], true]])
  expect(previewQuickImport).toHaveBeenCalledTimes(1)
})

test('markup-looking metadata is escaped, local diagnostic dictionary cannot expose prototype values, and all copy is bilingual', async () => {
  const response = previewValue()
  response.rows[0]!.title = '<img src=x onerror=alert(1)>'
  response.rows[2]!.error = '__proto__'
  setup({ previewQuickImport: vi.fn(async () => response) }); await showPreview()
  expect(document.querySelector('img')).toBeNull()
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  expect(within(screen.getByRole('table')).getByText(en.quickImportErrInvalid)).toBeTruthy()
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  for (const key of Object.keys(en) as QuickImportLocaleKey[]) { expect(en[key]).toBeTruthy(); expect(zh[key]).toBeTruthy() }
  expect(zh.quickImportEscapeHelp).toContain(String.raw`\|`)
  const css = readFileSync(new NodeURL('../src/client/QuickImportPanel.module.css', import.meta.url), 'utf8')
  expect(css).toContain('--v-text'); expect(css).toContain('font-size: 12.5px')
  expect(css).toContain('min-height: 28px'); expect(css).toContain('overflow: auto')
  expect(css).toContain('prefers-reduced-motion'); expect(css).toContain('@media (max-width: 600px)')
})
