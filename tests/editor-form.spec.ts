/**
 * Editor conversion helpers. The OAuth catalog template ships
 * `expiresAt: 'expiry epoch millis'` as a *hint*; a build that copied hints
 * into the form crashed the whole settings slot with
 * `RangeError: Invalid time value`, so these conversions are pinned here.
 */
import { test, expect } from 'vitest'
import { credentialPatch, droppedDraftSecrets, entryToForm, existingExtraFields, isPrivateKeyShape, localDateTimeValue, restrictForm, safeTemplateFields, templateHints, templateKind, validateCredentialForm } from '../src/client/editor-form.ts'
import { ADVANCED_FIELDS, COMMON_FIELDS, credentialSchema, inferSshAuth, templateSshAuth, type CredentialTemplate } from '../src/client/credential-fields.ts'
import { envPairsForEntry } from '../src/env-export.ts'

test('localDateTimeValue never throws on unusable input', () => {
  // the exact strings that used to take the page down
  for (const bad of ['expiry epoch millis', 'expiry (MM/YY)', 'what it is for', 'account username', 'not a date']) {
    expect(() => localDateTimeValue(bad)).not.toThrow()
    expect(localDateTimeValue(bad)).toBe('')
  }
  for (const bad of [undefined, null, '', '   ', Number.NaN, Number.POSITIVE_INFINITY, 0, -1, {}, []]) {
    expect(() => localDateTimeValue(bad)).not.toThrow()
    expect(localDateTimeValue(bad)).toBe('')
  }
})

test('localDateTimeValue renders a valid epoch as local wall-clock time', () => {
  const epoch = Date.UTC(2026, 8, 15, 12, 30) // 2026-09-15T12:30Z
  const value = localDateTimeValue(epoch)
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  // the shown value must be the LOCAL time, so parsing it back gives the epoch
  expect(Date.parse(value)).toBe(epoch)
})

test('localDateTimeValue accepts a parseable date string', () => {
  expect(localDateTimeValue('2026-09-15T12:30:00.000Z')).toBe(localDateTimeValue(Date.parse('2026-09-15T12:30:00.000Z')))
})

test('templateKind maps catalog templates onto store kinds', () => {
  expect(templateKind('oauth')).toBe('oauth')
  expect(templateKind('api-key')).toBe('api-key')
  // catalog-only kinds have no store equivalent
  expect(templateKind('wifi')).toBe('login')
  expect(templateKind('server')).toBe('ssh')
  expect(templateKind('database')).toBe('ssh')
  expect(templateKind('identity')).toBe('login')
  expect(templateKind('bank')).toBe('card')
  expect(templateKind('password')).toBe('login')
  expect(templateKind('ssh-password')).toBe('ssh')
  expect(templateKind('ssh-certificate')).toBe('ssh')
  expect(templateKind('something-new')).toBe('custom')
})

test('templateHints keeps descriptions and drops non-hint entries', () => {
  const hints = templateHints({
    accessToken: 'access token',
    expiresAt: 'expiry epoch millis',
    fields: 'arbitrary key/value pairs', // the key/value map itself, not a hint
    empty: '',
    blank: '   ',
    weird: 42 as unknown as string,
  })
  expect(hints).toEqual({ accessToken: 'access token', expiresAt: 'expiry epoch millis' })
})

test('env names are positional and tolerate the legacy single-name field', () => {
  // no configuration → every name derives from the title
  expect(envPairsForEntry({ id: '1', title: 'DASHSCOPE', apiKey: 'k' }).map(p => p.key)).toEqual(['DASHSCOPE_API_KEY'])
  // one name → names the primary secret
  expect(envPairsForEntry({ id: '1', title: 'x', envKeys: ['MY_KEY'], apiKey: 'k' }).map(p => p.key)).toEqual(['MY_KEY'])
  // several → positional, with derived names for anything beyond the list
  const pairs = envPairsForEntry({
    id: '1', title: 'x', envKeys: ['GOOGLE_ACCESS', 'GOOGLE_REFRESH'],
    accessToken: 'at', refreshToken: 'rt', fields: { scope: 'openid' },
  })
  expect(pairs.map(p => p.key)).toEqual(['GOOGLE_ACCESS', 'GOOGLE_REFRESH', 'GOOGLE_ACCESS_SCOPE'])
  expect(pairs.map(p => p.field)).toEqual(['accessToken', 'refreshToken', 'fields.scope'])
  // the legacy field still works and is read as a one-element list
  expect(envPairsForEntry({ id: '1', title: 'x', envKey: 'LEGACY', apiKey: 'k' }).map(p => p.key)).toEqual(['LEGACY'])
  // an explicit name beats the prefix; derived names take it
  expect(envPairsForEntry({ id: '1', title: 'x', envKeys: ['MINE'], apiKey: 'k' }, 'APP_').map(p => p.key)).toEqual(['MINE'])
  expect(envPairsForEntry({ id: '1', title: 'x', apiKey: 'k' }, 'APP_').map(p => p.key)).toEqual(['APP_X_API_KEY'])
})

const SYNTHETIC_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nU1lOVEg=\n-----END OPENSSH PRIVATE KEY-----'
const tpl = (name: string, kind = name.replace('builtin:', ''), fields: Record<string, string> = {}): CredentialTemplate => ({ name, kind, fields })

test('every builtin maps to a known kind and a meaningful field set', () => {
  const cases: Array<[string, string, string[]]> = [
    ['login', 'login', ['username', 'email', 'phone', 'password', 'url', 'otpSecret']],
    ['password', 'login', ['username', 'password', 'url']],
    ['totp', 'custom', ['username', 'otpSecret', 'url']],
    ['ssh-password', 'ssh', ['sshAuth', 'username', 'host', 'ip', 'port', 'password']],
    ['ssh-certificate', 'ssh', ['sshAuth', 'username', 'host', 'ip', 'port', 'privateKey', 'certificate', 'keyPassphrase']],
    ['api-key', 'api-key', ['username', 'apiKey', 'secret', 'url']], ['oauth', 'oauth', ['accessToken', 'refreshToken', 'expiresAt', 'url']],
    ['secret', 'secret', ['secret']], ['card', 'card', ['cardHolder', 'cardNumber', 'cardExpiry', 'cardCvv']],
    ['cookie', 'cookie', ['url', 'secret', 'expiresAt']], ['custom', 'custom', []],
    ['wifi', 'login', ['username', 'email', 'phone', 'password', 'url', 'otpSecret']],
    ['server', 'ssh', ['sshAuth', 'username', 'host', 'ip', 'port', 'password']],
    ['database', 'ssh', ['sshAuth', 'username', 'host', 'ip', 'port', 'password']],
    ['identity', 'login', ['username', 'email', 'phone', 'password', 'url', 'otpSecret']],
    ['bank', 'card', ['cardHolder', 'cardNumber', 'cardExpiry', 'cardCvv']],
  ]
  for (const [name, kind, primary] of cases) {
    const template = tpl('builtin:' + name)
    const schema = credentialSchema(templateKind(template.kind), template, templateSshAuth(template))
    expect(schema.kind).toBe(kind)
    expect(new Set(schema.fields)).toEqual(new Set([...COMMON_FIELDS, ...ADVANCED_FIELDS, ...primary]))
  }
})
test('generic SSH catalog remains password, exact and user private-key templates infer certificate', () => {
  expect(templateSshAuth(tpl('builtin:ssh', 'ssh', { privateKey: 'old generic hint' }))).toBe('password')
  expect(templateSshAuth(tpl('builtin:ssh-password', 'ssh', { privateKey: 'ignored' }))).toBe('password')
  expect(templateSshAuth(tpl('builtin:ssh-certificate', 'ssh'))).toBe('certificate')
  expect(templateSshAuth(tpl('named-user-template', 'ssh', { privateKey: 'privateKey' }))).toBe('certificate')
  expect(inferSshAuth({ privateKey: SYNTHETIC_KEY })).toBe('certificate')
  expect(inferSshAuth({ sshAuth: 'password', privateKey: SYNTHETIC_KEY })).toBe('password')
})
test('named templates can only request the intersection of known fields and their kind', () => {
  const schema = credentialSchema('login', tpl('small-login', 'login', { username: 'name', password: 'password', apiKey: 'unrelated', invented: 'unknown' }))
  expect(new Set(schema.fields)).toEqual(new Set([...COMMON_FIELDS, ...ADVANCED_FIELDS, 'username', 'password']))
  const custom = credentialSchema('unknown-kind', tpl('custom-shape', 'unknown-kind', { secret: 'secret', username: 'username', invented: 'unknown' }))
  expect(custom.kind).toBe('custom')
  expect(new Set(custom.fields)).toEqual(new Set([...COMMON_FIELDS, ...ADVANCED_FIELDS, 'secret', 'username']))
})
test('schema transitions preserve metadata but drop stale hidden drafts after consent', () => {
  const draft = { title: 'Synthetic title', kind: 'login', password: 'synthetic-password', notes: 'synthetic-notes', apiKey: 'stale-hidden' }
  const next = credentialSchema('oauth')
  expect(droppedDraftSecrets(draft, next)).toEqual(['password', 'apiKey'])
  const restricted = restrictForm(draft, next)
  expect(restricted.title).toBe(draft.title)
  expect(restricted.notes).toBe(draft.notes)
  expect(restricted.password).toBeUndefined()
  expect(restricted.apiKey).toBeUndefined()
  const patch = credentialPatch({ ...restricted, password: 'stale-external-value' }, { schema: next, tags: [] })
  expect(patch).not.toHaveProperty('password')
})
test('card edit hydrates its own values; unchanged cards and typed extra data survive patching', () => {
  const entry = { id: 'synthetic-card', title: 'Synthetic card', kind: 'card', cardNumber: '4111111111111111', cardCvv: '123', cardExpiry: '12/29', cardHolder: 'Synthetic holder', apiKey: 'synthetic-legacy-api', fields: { nested: { unchanged: true }, number: 42 } }
  const schema = credentialSchema('card')
  const form = entryToForm(entry)
  expect(form).toMatchObject({ cardNumber: entry.cardNumber, cardCvv: entry.cardCvv, cardExpiry: entry.cardExpiry, cardHolder: entry.cardHolder })
  expect(existingExtraFields(entry, schema)).toEqual(['apiKey'])
  const patch = credentialPatch({ ...form, title: 'Renamed' }, { schema, tags: [], original: entry })
  expect({ ...entry, ...patch }).toMatchObject({ ...entry, title: 'Renamed' })
  expect(patch).not.toHaveProperty('apiKey')
  expect(patch).not.toHaveProperty('fields')
  expect(credentialPatch({ ...form, cardCvv: '' }, { schema, tags: [], original: entry })).toHaveProperty('cardCvv', '')
})
test('legacy password plus private key is preserved until explicit auth removal patch', () => {
  const entry = { id: 'synthetic-ssh', kind: 'ssh', title: 'Synthetic SSH', password: 'synthetic-legacy-password', privateKey: SYNTHETIC_KEY, keyPassphrase: 'synthetic-passphrase' }
  const form = entryToForm(entry)
  const schema = credentialSchema('ssh', null, inferSshAuth(entry))
  expect(form.sshAuth).toBe('certificate')
  const patch = credentialPatch(restrictForm(form, schema), { schema, tags: [], original: entry })
  expect({ ...entry, ...patch }).toHaveProperty('password', entry.password)
  expect(patch).not.toHaveProperty('password')
  const passwordSchema = credentialSchema('ssh', null, 'password')
  const switched = credentialPatch({ title: entry.title, kind: 'ssh', password: '1' }, { schema: passwordSchema, tags: [], original: entry, cleared: ['privateKey', 'certificate', 'keyPassphrase'] })
  expect(switched).toMatchObject({ sshAuth: 'password', privateKey: '', certificate: '', keyPassphrase: '', password: '1' })
})
test('SSH validation requires new host username and credential, accepts weak passwords and preserves untouched incomplete legacy', () => {
  const schema = credentialSchema('ssh')
  expect(validateCredentialForm({ title: 'SSH' }, schema)).toMatchObject({ host: 'editorErrHost', username: 'editorErrUsername', password: 'editorErrPassword' })
  const form = { title: 'SSH', host: 'server.example', username: 'root', password: '1' }
  expect(validateCredentialForm(form, schema)).toEqual({})
  for (const port of ['0', '65536', '-1', '22.5', 'nope']) expect(validateCredentialForm({ ...form, port }, schema).port).toBe('editorErrPort')
  for (const host of ['https://example.com', 'bad host', 'example.com/path', '-invalid.example']) expect(validateCredentialForm({ ...form, host }, schema).host).toBe('editorErrHost')
  const entry = { id: 'legacy', title: 'Legacy', kind: 'ssh', port: '0', privateKey: 'old non-key text' }
  const old = entryToForm(entry)
  expect(validateCredentialForm({ ...old, title: 'Renamed legacy' }, credentialSchema('ssh', null, inferSshAuth(old)), entry)).toEqual({})
})
test('private-key and certificate validation checks text shape only with synthetic fixtures', () => {
  expect(isPrivateKeyShape(SYNTHETIC_KEY)).toBe(true)
  expect(isPrivateKeyShape(SYNTHETIC_KEY.replace('END OPENSSH', 'END RSA'))).toBe(false)
  expect(isPrivateKeyShape('ssh-ed25519 synthetic-public-key')).toBe(false)
  const schema = credentialSchema('ssh', null, 'certificate')
  const form = { title: 'SSH', kind: 'ssh', host: '192.0.2.1', username: 'root', privateKey: SYNTHETIC_KEY, certificate: 'ssh-ed25519-cert-v01@openssh.com U1lOVEhFVElD synthetic' }
  expect(validateCredentialForm(form, schema)).toEqual({})
  expect(validateCredentialForm({ ...form, privateKey: 'not a private key' }, schema).privateKey).toBe('editorErrPrivateKeyShape')
  expect(validateCredentialForm({ ...form, certificate: 'not a certificate' }, schema).certificate).toBe('editorErrCertificate')
})
test('template serialization is fixed names only and cannot persist notes, card or cookie values', () => {
  for (const kind of ['login', 'ssh', 'card', 'cookie', 'secret', 'oauth', 'api-key', 'custom']) {
    const fields = safeTemplateFields(credentialSchema(kind))
    expect(fields).not.toHaveProperty('notes')
    expect(fields).not.toHaveProperty('title')
    for (const [key, value] of Object.entries(fields)) expect(value).toBe(key)
  }
})

test('custom SSH template only adds named optional fields to required connection/auth fields', () => {
  const template = tpl('minimal-ssh', 'ssh', { privateKey: 'privateKey', apiKey: 'unrelated', port: 'port' })
  const schema = credentialSchema('ssh', template, 'certificate')
  expect(new Set(schema.fields)).toEqual(new Set([...COMMON_FIELDS, ...ADVANCED_FIELDS, 'sshAuth', 'username', 'host', 'privateKey', 'port']))
  expect(schema.fields).not.toContain('ip')
  expect(schema.fields).not.toContain('apiKey')
})
test('structured legacy cookies stay out of the patch and are disclosed as preserved extras', () => {
  const entry = { id: 'synthetic-cookie', title: 'Synthetic cookies', kind: 'cookie', cookies: [{ name: 'synthetic', value: 'synthetic-cookie-value', domain: '.example.com' }] }
  const schema = credentialSchema('cookie')
  expect(existingExtraFields(entry, schema)).toContain('cookies')
  expect(credentialPatch(entryToForm(entry), { schema, original: entry, tags: [] })).not.toHaveProperty('cookies')
})
