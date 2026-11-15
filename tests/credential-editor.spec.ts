// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { VaultSection, type VaultFullWire, type VaultPatch, type VaultSectionProps } from '../src/client/VaultSection.tsx'
import type { CredentialTemplate } from '../src/client/credential-fields.ts'
import { editorEn } from '../src/client/editor-locales.ts'
import { en } from '../src/client/locales.ts'
import { workbenchFixture } from './fixtures/workbench-ui.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks() })
const SYNTHETIC_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nU1lOVEg=\n-----END OPENSSH PRIVATE KEY-----'
const BUILTINS: CredentialTemplate[] = ['login', 'password', 'totp', 'ssh', 'ssh-password', 'ssh-certificate', 'api-key', 'oauth', 'secret', 'card', 'cookie', 'custom', 'wifi', 'server', 'database', 'identity', 'bank'].map(kind => ({ name: 'builtin:' + kind, kind, fields: kind === 'ssh' ? { privateKey: 'old generic hint', host: 'hostname hint' } : {} }))
function mountEditor(entry?: VaultFullWire, templates = BUILTINS) {
  const { props, api } = workbenchFixture()
  const full: VaultFullWire = entry ?? { id: 'entry-fixture', title: 'Example account', kind: 'login', password: 'synthetic-password' }
  const injected = {
    ...api,
    list: vi.fn(async () => [{ id: full.id, title: full.title, kind: full.kind, tags: full.tags }]),
    get: vi.fn(async () => ({ found: true, entry: full })),
    templates: vi.fn(async () => templates),
    saveTemplate: vi.fn(async () => ({ saved: true })),
    strength: vi.fn(async () => ({ score: 1, verdict: 'weak', feedback: 'synthetic', bits: 1 })),
    generatePassword: vi.fn(async () => ({ password: 'synthetic-generated' })),
    update: vi.fn(async (_id: string, patch: VaultPatch) => ({ found: true, entry: { ...full, ...patch } })),
    t: (key: string) => ({ ...en, ...editorEn } as Record<string, string>)[key] ?? key,
  }
  const mounted = { ...props, ...injected, embedded: true, activeTab: 'entries' } as VaultSectionProps
  const result = render(createElement(VaultSection, mounted))
  return { api: injected, full, command: (command: NonNullable<VaultSectionProps['command']>) => result.rerender(createElement(VaultSection, { ...mounted, command })), replaceGet: (get: VaultSectionProps['get']) => result.rerender(createElement(VaultSection, { ...mounted, get })) }
}
async function createEditor() {
  await screen.findAllByText('Example account')
  fireEvent.click(screen.getByRole('button', { name: '+ ' + en.add }))
  return screen.findByRole('region', { name: en.add })
}
async function editEditor(title: string) {
  await screen.findByText(title)
  fireEvent.click(await screen.findByRole('button', { name: '⋯' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: en.edit }))
  return screen.findByRole('region', { name: en.edit })
}
function input(editor: HTMLElement, name: string): HTMLInputElement { return within(editor).getByLabelText(name, { exact: true }) as HTMLInputElement }
function fill(editor: HTMLElement, name: string, value: string) { fireEvent.change(input(editor, name), { target: { value } }) }
async function selectTemplate(editor: HTMLElement, name: string) {
  fireEvent.change(input(editor, en.tplApply), { target: { value: name } })
  await waitFor(() => expect(input(editor, en.tplApply).value).toBe(name))
}
async function confirm() {
  const dialog = await screen.findByRole('dialog', { name: en.wbConfirm })
  fireEvent.click(within(dialog).getByRole('button', { name: en.wbConfirm }))
}

test('template dropdown is controlled, focuses each schema, and resets hints/reveal/options after cancel', async () => {
  mountEditor()
  const editor = await createEditor()
  await selectTemplate(editor, 'builtin:ssh')
  expect(input(editor, en.fieldKind).value).toBe('ssh')
  expect(input(editor, editorEn.editorSshAuth).value).toBe('password')
  for (const label of [en.fieldEmail, en.fieldPhone, en.fieldApiKey, en.fieldAccessToken, en.fieldRefreshToken, en.fieldCardNumber, editorEn.editorPrivateKey]) expect(within(editor).queryByLabelText(label, { exact: true })).toBeNull()
  expect(input(editor, en.fieldHost).value).toBe('')
  expect(input(editor, en.fieldHost).getAttribute('aria-describedby')).toContain('hint')
  fill(editor, en.fieldTitle, 'Synthetic title')
  fill(editor, en.fieldNotes, 'Synthetic note')
  fill(editor, en.fieldTags, 'synthetic-tag')
  fill(editor, en.fieldPassword, '1')
  fireEvent.click(within(editor).getByRole('button', { name: en.show + ' ' + en.fieldPassword }))
  expect(input(editor, en.fieldPassword).type).toBe('text')
  await selectTemplate(editor, 'builtin:password')
  expect(input(editor, en.fieldTitle).value).toBe('Synthetic title')
  expect(input(editor, en.fieldNotes).value).toBe('Synthetic note')
  expect(input(editor, en.fieldTags).value).toBe('synthetic-tag')
  expect(input(editor, en.fieldPassword).type).toBe('password')
  expect(within(editor).queryByLabelText(en.fieldEmail, { exact: true })).toBeNull()
  expect(editor.querySelector('details')?.open).toBe(false)
  fireEvent.click(within(editor).getAllByRole('button', { name: en.cancel })[0]!)
  const next = await createEditor()
  expect(input(next, en.tplApply).value).toBe('')
  expect(input(next, en.fieldPassword).value).toBe('')
  expect(within(next).queryByLabelText(en.fieldHost, { exact: true })).toBeNull()
})

test('every runtime builtin and custom template chooses a known store kind with no hint-as-value', async () => {
  const custom: CredentialTemplate = { name: 'custom-fixture', kind: 'unexpected-kind', fields: { username: 'Synthetic username hint', secret: 'Synthetic secret hint', invented: 'ignored' } }
  mountEditor(undefined, [...BUILTINS, custom])
  const editor = await createEditor()
  const mappings: Record<string, string> = { totp: 'custom', password: 'login', 'ssh-password': 'ssh', 'ssh-certificate': 'ssh', wifi: 'login', server: 'ssh', database: 'ssh', identity: 'login', bank: 'card' }
  for (const template of BUILTINS) {
    await selectTemplate(editor, template.name)
    expect(input(editor, en.fieldKind).value).toBe(mappings[template.kind] ?? template.kind)
    expect([...editor.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]),textarea')].every(control => control.value === '')).toBe(true)
  }
  await selectTemplate(editor, custom.name)
  expect(input(editor, en.fieldKind).value).toBe('custom')
  expect(input(editor, en.fieldUsername).value).toBe('')
  expect(input(editor, en.fieldSecret).value).toBe('')
  expect(within(editor).queryByLabelText(en.fieldPassword, { exact: true })).toBeNull()
  expect(within(editor).queryByLabelText(en.fieldApiKey, { exact: true })).toBeNull()
})

test('SSH auth switch warns, supports masked multiline key/certificate, clears inactive secrets in add patch', async () => {
  const { api } = mountEditor()
  const editor = await createEditor()
  await selectTemplate(editor, 'builtin:ssh-password')
  fill(editor, en.fieldTitle, 'Synthetic SSH')
  fill(editor, en.fieldHost, 'server.example')
  fill(editor, en.fieldUsername, 'synthetic-user')
  fill(editor, en.fieldPassword, '1')
  fireEvent.change(input(editor, editorEn.editorSshAuth), { target: { value: 'certificate' } })
  const dialog = await screen.findByRole('dialog', { name: en.wbConfirm })
  expect(dialog.textContent).toContain(editorEn.editorAuthConfirm)
  expect(input(editor, editorEn.editorSshAuth).value).toBe('password')
  fireEvent.click(within(dialog).getByRole('button', { name: en.wbCancel }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.wbConfirm })).toBeNull())
  expect(input(editor, en.fieldPassword).value).toBe('1')
  fireEvent.change(input(editor, editorEn.editorSshAuth), { target: { value: 'certificate' } })
  await confirm()
  await waitFor(() => expect(within(editor).queryByLabelText(en.fieldPassword, { exact: true })).toBeNull())
  const key = input(editor, editorEn.editorPrivateKey)
  expect(key.tagName).toBe('TEXTAREA')
  expect(key.getAttribute('data-secret-masked')).toBe('true')
  fireEvent.change(key, { target: { value: SYNTHETIC_KEY } })
  fill(editor, editorEn.editorCertificate, 'ssh-ed25519-cert-v01@openssh.com U1lOVEhFVElD synthetic')
  fill(editor, editorEn.editorKeyPassphrase, 'synthetic-passphrase')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.add).toHaveBeenCalledOnce())
  expect(api.add.mock.calls[0]![0]).toMatchObject({ kind: 'ssh', sshAuth: 'certificate', password: '', privateKey: SYNTHETIC_KEY, keyPassphrase: 'synthetic-passphrase' })
  const next = await createEditor()
  expect(input(next, en.tplApply).value).toBe('')
})

test('visible inline errors and focused summary reject port zero and bad host while weak SSH passwords save', async () => {
  const { api } = mountEditor()
  const editor = await createEditor()
  await selectTemplate(editor, 'builtin:ssh-password')
  fill(editor, en.fieldTitle, 'Synthetic weak SSH')
  fill(editor, en.fieldHost, 'https://bad.example/path')
  fill(editor, en.fieldPort, '0')
  fill(editor, en.fieldPassword, '1')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  const summary = await within(editor).findByRole('alert')
  await waitFor(() => expect(document.activeElement).toBe(summary))
  expect(input(editor, en.fieldHost).getAttribute('aria-invalid')).toBe('true')
  expect(input(editor, en.fieldPort).getAttribute('aria-describedby')).toContain('error')
  expect(api.add).not.toHaveBeenCalled()
  fill(editor, en.fieldHost, '192.0.2.11')
  fill(editor, en.fieldPort, '22')
  fill(editor, en.fieldUsername, 'synthetic-user')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.add).toHaveBeenCalledOnce())
  expect(api.add.mock.calls[0]![0]).toMatchObject({ password: '1', port: '22' })
})

test('card editor uses own full values and preserves unrelated legacy/nested fields without serializing them', async () => {
  const entry: VaultFullWire = { id: 'synthetic-card', title: 'Synthetic card', kind: 'card', cardNumber: '4111111111111111', cardCvv: '123', cardHolder: 'Synthetic holder', cardExpiry: '12/29', apiKey: 'synthetic-extra-api', notes: 'synthetic-notes', fields: { nested: { retain: true } } }
  const { api } = mountEditor(entry)
  const editor = await editEditor(entry.title)
  for (const [label, value] of [[en.fieldCardNumber, entry.cardNumber], [en.fieldCardCvv, entry.cardCvv], [en.fieldCardHolder, entry.cardHolder], [en.fieldCardExpiry, entry.cardExpiry]]) expect(input(editor, label!).value).toBe(value)
  expect(input(editor, en.fieldCardCvv).type).toBe('password')
  expect(within(editor).getByText(editorEn.editorExtrasHint)).toBeTruthy()
  expect(within(editor).queryByLabelText(en.fieldApiKey, { exact: true })).toBeNull()
  fill(editor, en.fieldTitle, 'Renamed synthetic card')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
  const patch = api.update.mock.calls[0]![1]
  expect({ ...entry, ...patch }).toMatchObject({ ...entry, title: 'Renamed synthetic card' })
  expect(patch).not.toHaveProperty('fields')
  expect(patch).not.toHaveProperty('apiKey')
})

test('legacy dual SSH secrets infer certificate, preserve password until confirmed mode change, then clear key patch', async () => {
  const entry: VaultFullWire = { id: 'synthetic-dual', title: 'Synthetic dual SSH', kind: 'ssh', host: 'server.example', username: 'synthetic-user', password: 'synthetic-legacy-password', privateKey: SYNTHETIC_KEY, certificate: 'ssh-ed25519-cert-v01@openssh.com U1lOVEhFVElD synthetic', keyPassphrase: 'synthetic-passphrase' }
  const { api } = mountEditor(entry)
  let editor = await editEditor(entry.title)
  expect(input(editor, editorEn.editorSshAuth).value).toBe('certificate')
  expect(within(editor).queryByLabelText(en.fieldPassword, { exact: true })).toBeNull()
  fill(editor, en.fieldTitle, 'Rename only')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
  expect(api.update.mock.calls[0]![1]).not.toHaveProperty('password')
  editor = await editEditor(entry.title)
  fireEvent.change(input(editor, editorEn.editorSshAuth), { target: { value: 'password' } })
  await confirm()
  await waitFor(() => expect(input(editor, editorEn.editorSshAuth).value).toBe('password'))
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2))
  expect(api.update.mock.calls[1]![1]).toMatchObject({ sshAuth: 'password', privateKey: '', certificate: '', keyPassphrase: '' })
})

test('new template transitions require consent before discarding edited secrets and cannot save hidden stale values', async () => {
  const { api } = mountEditor()
  const editor = await createEditor()
  fill(editor, en.fieldTitle, 'Synthetic transitions')
  fill(editor, en.fieldNotes, 'Synthetic note retained')
  fill(editor, en.fieldPassword, 'synthetic-draft-password')
  fireEvent.change(input(editor, en.tplApply), { target: { value: 'builtin:oauth' } })
  let dialog = await screen.findByRole('dialog', { name: en.wbConfirm })
  fireEvent.click(within(dialog).getByRole('button', { name: en.wbCancel }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.wbConfirm })).toBeNull())
  expect(input(editor, en.fieldPassword).value).toBe('synthetic-draft-password')
  expect(input(editor, en.tplApply).value).toBe('')
  fireEvent.change(input(editor, en.tplApply), { target: { value: 'builtin:oauth' } })
  await confirm()
  await waitFor(() => expect(input(editor, en.tplApply).value).toBe('builtin:oauth'))
  expect(input(editor, en.fieldTitle).value).toBe('Synthetic transitions')
  expect(input(editor, en.fieldNotes).value).toBe('Synthetic note retained')
  expect(within(editor).queryByLabelText(en.fieldPassword, { exact: true })).toBeNull()
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.add).toHaveBeenCalledOnce())
  expect(api.add.mock.calls[0]![0]).not.toHaveProperty('password')
})

test('save-as-template never persists card secrets, cookies, notes, custom field values or arbitrary hints', async () => {
  const entry: VaultFullWire = { id: 'synthetic-template', title: 'Synthetic template card', kind: 'card', cardNumber: '4111111111111111', cardCvv: '123', cardHolder: 'synthetic-holder-confidential', notes: 'synthetic-notes-confidential', secret: 'synthetic-cookie-confidential', fields: { synthetic: 'synthetic-field-confidential' } }
  const { api } = mountEditor(entry)
  const editor = await editEditor(entry.title)
  fireEvent.click(within(editor).getByRole('button', { name: en.tplSave }))
  const prompt = await screen.findByRole('dialog', { name: en.wbPrompt })
  fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: 'Synthetic shape' } })
  fireEvent.click(within(prompt).getByRole('button', { name: en.wbConfirm }))
  await waitFor(() => expect(api.saveTemplate).toHaveBeenCalledOnce())
  const fields = api.saveTemplate.mock.calls[0]![2]
  expect(fields).not.toHaveProperty('notes')
  expect(fields).not.toHaveProperty('title')
  for (const [key, value] of Object.entries(fields)) expect(value).toBe(key)
  for (const secret of [entry.cardNumber, entry.cardCvv, entry.cardHolder, entry.notes, entry.secret, 'synthetic-field-confidential']) expect(JSON.stringify(fields)).not.toContain(secret!)
})

test('SSH auth switch-back never resurrects a cleared legacy private key, even when the original had both secrets', async () => {
  const entry: VaultFullWire = { id: 'synthetic-back', title: 'Synthetic switch back', kind: 'ssh', username: 'synthetic-user', host: 'server.example', password: 'synthetic-original-password', privateKey: SYNTHETIC_KEY }
  mountEditor(entry)
  const editor = await editEditor(entry.title)
  fireEvent.change(input(editor, editorEn.editorSshAuth), { target: { value: 'password' } })
  await confirm()
  await waitFor(() => expect(input(editor, editorEn.editorSshAuth).value).toBe('password'))
  fireEvent.change(input(editor, editorEn.editorSshAuth), { target: { value: 'certificate' } })
  await confirm()
  await waitFor(() => expect(input(editor, editorEn.editorSshAuth).value).toBe('certificate'))
  expect(input(editor, editorEn.editorPrivateKey).value).toBe('')
})

test('incomplete legacy SSH may save unchanged while new private-key mistakes show near the key', async () => {
  const entry: VaultFullWire = { id: 'synthetic-incomplete', title: 'Synthetic incomplete', kind: 'ssh', port: '0', privateKey: 'synthetic-legacy-opaque' }
  const { api } = mountEditor(entry)
  const editor = await editEditor(entry.title)
  fill(editor, en.fieldNotes, 'Synthetic note only')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
  expect(api.update.mock.calls[0]![1]).toMatchObject({ notes: 'Synthetic note only' })
  expect(api.update.mock.calls[0]![1]).not.toHaveProperty('privateKey')
})

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('generated password response after schema switch is revoked, not silently carried into hidden fields', async () => {
  const { api } = mountEditor()
  const pending = deferred<{ password: string }>()
  api.generatePassword.mockImplementationOnce(() => pending.promise)
  const editor = await createEditor()
  fill(editor, en.fieldTitle, 'Synthetic generation race')
  fireEvent.click(within(editor).getByRole('button', { name: en.genPw }))
  await selectTemplate(editor, 'builtin:oauth')
  await act(async () => { pending.resolve({ password: 'synthetic-late-generated-secret' }); await pending.promise })
  expect(within(editor).queryByLabelText(en.fieldPassword, { exact: true })).toBeNull()
  await selectTemplate(editor, 'builtin:login')
  expect(input(editor, en.fieldPassword).value).toBe('')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.add).toHaveBeenCalledOnce())
  expect(JSON.stringify(api.add.mock.calls[0]![0])).not.toContain('synthetic-late-generated-secret')
})

test('observed lock clears the open secret draft and invalidates pending generation', async () => {
  const { api, command } = mountEditor()
  const pending = deferred<{ password: string }>()
  api.generatePassword.mockImplementationOnce(() => pending.promise)
  const editor = await createEditor()
  fill(editor, en.fieldPassword, 'synthetic-draft-to-clear')
  fireEvent.click(within(editor).getByRole('button', { name: en.genPw }))
  api.status.mockResolvedValue({ locked: true, entries: 1 })
  command({ id: 41, kind: 'refresh' })
  await screen.findByText(en.lockedBanner)
  await waitFor(() => expect(screen.queryByRole('region', { name: en.add })).toBeNull())
  await act(async () => { pending.resolve({ password: 'synthetic-generated-after-lock' }); await pending.promise })
  expect(document.body.innerHTML).not.toContain('synthetic-draft-to-clear')
  expect(document.body.innerHTML).not.toContain('synthetic-generated-after-lock')
})

test('late full-entry get after lock cannot reopen editor or repopulate any secret', async () => {
  const { api, command } = mountEditor()
  const pending = deferred<{ found: boolean; entry: VaultFullWire }>()
  api.get.mockImplementationOnce(() => pending.promise)
  await screen.findByText('Example account')
  fireEvent.click(await screen.findByRole('button', { name: '⋯' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: en.edit }))
  await waitFor(() => expect(api.get).toHaveBeenCalledOnce())
  api.status.mockResolvedValue({ locked: true, entries: 1 })
  command({ id: 42, kind: 'refresh' })
  await screen.findByText(en.lockedBanner)
  await act(async () => { pending.resolve({ found: true, entry: { id: 'late', title: 'Synthetic late entry', password: 'synthetic-get-after-lock' } }); await pending.promise })
  expect(screen.queryByRole('region', { name: en.edit })).toBeNull()
  expect(document.body.innerHTML).not.toContain('synthetic-get-after-lock')
})

test('full-entry get from a replaced injected vault scope is ignored', async () => {
  const { api, replaceGet } = mountEditor()
  const pending = deferred<{ found: boolean; entry: VaultFullWire }>()
  api.get.mockImplementationOnce(() => pending.promise)
  await screen.findByText('Example account')
  fireEvent.click(await screen.findByRole('button', { name: '⋯' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: en.edit }))
  await waitFor(() => expect(api.get).toHaveBeenCalledOnce())
  replaceGet(vi.fn(async () => ({ found: false })))
  await act(async () => { pending.resolve({ found: true, entry: { id: 'old-scope', title: 'Synthetic old scope', password: 'synthetic-old-scope-secret' } }); await pending.promise })
  expect(screen.queryByRole('region', { name: en.edit })).toBeNull()
  expect(document.body.innerHTML).not.toContain('synthetic-old-scope-secret')
})

test('adding a custom row preserves unchanged nested and numeric original field values as their original types', async () => {
  const entry: VaultFullWire = { id: 'synthetic-typed', title: 'Synthetic typed fields', kind: 'custom', fields: { nested: { retain: true }, count: 42, text: 'synthetic-text' } }
  const { api } = mountEditor(entry)
  const editor = await editEditor(entry.title)
  fireEvent.click(within(editor).getByText(editorEn.editorAdvanced))
  fireEvent.click(within(editor).getByRole('button', { name: en.addField }))
  fill(editor, editorEn.editorFieldName + ' 4', 'new')
  fill(editor, editorEn.editorFieldValue + ' 4', 'synthetic-added')
  fireEvent.click(within(editor).getByRole('button', { name: en.save }))
  await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
  expect(api.update.mock.calls[0]![1].fields).toEqual({ nested: { retain: true }, count: 42, text: 'synthetic-text', new: 'synthetic-added' })
})

test('TOTP authenticator button creates a masked code-only entry without login password', async () => {
  const { api }=mountEditor()
  const editor=await createEditor()
  fireEvent.click(within(editor).getByRole('button',{name:editorEn.editorTemplateTotp}))
  await waitFor(()=>expect(input(editor,en.fieldKind).value).toBe('custom'))
  expect(within(editor).queryByLabelText(en.fieldPassword,{exact:true})).toBeNull()
  fill(editor,en.fieldTitle,'Synthetic authenticator')
  const uri='otpauth://totp/Synthetic:account?secret='+('JBSW'+'Y3DP'+'EHPK'+'3PXP')+'&issuer=Synthetic&digits=6&period=30'
  fill(editor,en.fieldOtpSecret,uri)
  expect(input(editor,en.fieldOtpSecret).type).toBe('password')
  fireEvent.click(within(editor).getByRole('button',{name:en.save}))
  await waitFor(()=>expect(api.add).toHaveBeenCalledOnce())
  expect(api.add.mock.calls[0]![0]).toMatchObject({kind:'custom',title:'Synthetic authenticator',otpSecret:uri})
  expect(api.add.mock.calls[0]![0]).not.toHaveProperty('password')
})
test('authenticator template rejects empty, temporary-code and Google migration inputs with specific safe errors', async () => {
  const { api }=mountEditor()
  const editor=await createEditor()
  await selectTemplate(editor,'builtin:totp')
  fill(editor,en.fieldTitle,'Synthetic invalid authenticator')
  for (const [value,message] of [['',editorEn.editorErrTotpRequired],['123456',editorEn.editorErrTotp],['otpauth-migration://offline?data=synthetic-export',editorEn.editorErrTotpMigration]]) {
    fill(editor,en.fieldOtpSecret,value!)
    fireEvent.click(within(editor).getByRole('button',{name:en.save}))
    expect(await within(editor).findByText(message!,{exact:true})).toBeTruthy()
    expect(api.add).not.toHaveBeenCalled()
  }
})
test('SSH can keep an optional TOTP when switching password and certificate authentication', async () => {
  mountEditor()
  const editor=await createEditor()
  await selectTemplate(editor,'builtin:ssh-password')
  const key='JBSW'+'Y3DP'+'EHPK'+'3PXP'
  const group=within(editor).getByRole('region',{name:editorEn.editorTwoFactor})
  expect(group).toBeTruthy()
  fill(editor,en.fieldOtpSecret,key)
  await selectTemplate(editor,'builtin:ssh-certificate')
  expect(input(editor,en.fieldOtpSecret).value).toBe(key)
  expect(within(editor).queryByLabelText(en.fieldPassword,{exact:true})).toBeNull()
})
