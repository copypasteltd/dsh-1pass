/**
 * Pure helpers for the entry editor. They live outside the component so the
 * tricky conversions can be unit-tested without a DOM.
 */

import { CREDENTIAL_FIELDS, inferSshAuth, isSecretField, normalizeCredentialKind, type CredentialField, type CredentialSchema, type FormFields } from './credential-fields.ts'
import { otpInputIssue } from '../otp-input.ts'
import type { EditorLocaleKey } from './editor-locales.ts'
import type { VaultFullWire, VaultPatch } from './VaultSection.tsx'

/** Unknown catalog kinds are custom, never an unsupported store kind. */
export function templateKind(rawKind: string): string {
  return normalizeCredentialKind(rawKind)
}

/**
 * Value for `<input type="datetime-local">`, i.e. LOCAL time, or '' when the
 * value cannot be used.
 *
 * It must never throw. `expiresAt` used to be filled straight from a catalog
 * template hint ("expiry epoch millis"), and `new Date(hint).toISOString()`
 * raises `RangeError: Invalid time value` — which took down the whole settings
 * slot until the page was reloaded. Anything unparseable now renders empty.
 */
export function localDateTimeValue(value: unknown): string {
  const ms = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  // datetime-local expects local wall-clock time, so shift by the offset
  // before slicing the ISO string (the old code showed UTC and was off by the
  // timezone).
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/**
 * Which of a template's texts may be used as field hints. The catalog values
 * are descriptions ("PEM private key", "port (e.g. 22)"), never entry values:
 * they are shown as placeholders, and copying them into the form was what
 * corrupted new entries in the first place.
 */
export function templateHints(fields: Record<string, string>): Record<string, string> {
  const hints: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    // `fields` is the arbitrary key/value map itself; a string is not usable.
    if (key === 'fields') continue
    hints[key] = value
  }
  return hints
}

export function emptyCredentialForm(): FormFields { return { title: '', kind: 'login', notes: '' } }
/** Pick every own editor field, including all four card values. Never hydrate from a summary. */
export function entryToForm(entry: VaultFullWire): FormFields {
  const form: FormFields = { title: entry.title, kind: normalizeCredentialKind(entry.kind ?? 'login') }
  for (const key of CREDENTIAL_FIELDS) {
    if (key === 'envKeys' || key === 'kind') continue
    const value = entry[key as keyof VaultFullWire]
    if (value !== undefined) (form as Record<string, unknown>)[key] = value
  }
  form.envKeys = (entry.envKeys ?? (entry.envKey ? [entry.envKey] : [])).join(', ')
  if (form.kind === 'ssh') form.sshAuth = inferSshAuth(entry)
  return form
}
/** Only active fields survive a schema change in the draft. Original hidden values
 * remain in the encrypted entry, not in a hidden draft waiting to reappear. */
export function restrictForm(form: FormFields, schema: CredentialSchema, original?: FormFields): FormFields {
  const next: FormFields = { kind: schema.kind }
  for (const key of schema.fields) {
    if (key === 'kind' || key === 'sshAuth') continue
    const value = form[key] ?? original?.[key]
    if (value !== undefined) (next as Record<string, unknown>)[key] = value
  }
  if (schema.kind === 'ssh') next.sshAuth = schema.sshAuth
  return next
}
export function droppedDraftSecrets(form: FormFields, schema: CredentialSchema, original?: FormFields): CredentialField[] {
  return CREDENTIAL_FIELDS.filter(key => isSecretField(key) && !schema.fields.includes(key) &&
    typeof form[key] === 'string' && (form[key] as string).length > 0 && form[key] !== original?.[key])
}
/** Names are static editor identifiers. No titles, notes, hints or secret values
 * (including custom field values) can reach plaintext template persistence. */
export function safeTemplateFields(schema: CredentialSchema): Record<string, string> {
  return Object.fromEntries(schema.fields.filter(key => !['title', 'kind', 'notes'].includes(key)).map(key => [key, key]))
}
export function existingExtraFields(entry: VaultFullWire | undefined, schema: CredentialSchema, cleared: readonly CredentialField[] = []): string[] {
  if (!entry) return []
  const known = CREDENTIAL_FIELDS.filter(key => !schema.fields.includes(key) && !cleared.includes(key) &&
    entry[key as keyof VaultFullWire] !== undefined && entry[key as keyof VaultFullWire] !== '')
  // Older wire entries can carry structured cookies or other opaque fields.
  // The update omits them, and the hint discloses their preservation by name only.
  const reserved = new Set(['id', 'kind', 'createdAt', 'updatedAt', 'deletedAt', 'tags', 'fields', 'envKey', ...CREDENTIAL_FIELDS])
  return [...known, ...Object.keys(entry).filter(key => !reserved.has(key) && (entry as unknown as Record<string, unknown>)[key] !== undefined)]
}
export interface EditorPatchOptions {
  schema: CredentialSchema
  tags: string[]
  original?: VaultFullWire | undefined
  /** Auth-mode changes explicitly consent to removing these stored fields. */
  cleared?: readonly CredentialField[] | undefined
  fields?: Record<string, unknown> | undefined
}
export function credentialPatch(form: FormFields, options: EditorPatchOptions): VaultPatch {
  const patch: VaultPatch = { title: (form.title ?? '').trim(), kind: options.schema.kind, tags: options.tags }
  const originalForm = options.original ? entryToForm(options.original) : undefined
  for (const key of options.schema.fields) {
    if (key === 'title' || key === 'kind') continue
    const value = form[key]
    // Unchanged values are omitted: preserves exact epoch precision, own values,
    // absent metadata, and incomplete legacy entries without destructive defaults.
    if (options.original && value === originalForm?.[key]) continue
    if (value === undefined) {
      if (options.original && originalForm?.[key] !== undefined) {
        if (key === 'expiresAt' || key === 'rotationDays') (patch as Record<string, unknown>)[key] = 0
      }
      continue
    }
    if (key === 'envKeys') patch.envKeys = String(value).split(',').map(x => x.trim()).filter(Boolean)
    else (patch as Record<string, unknown>)[key] = value
  }
  if (options.schema.kind === 'ssh' && (!options.original || options.original.sshAuth !== options.schema.sshAuth)) patch.sshAuth = options.schema.sshAuth
  for (const key of options.cleared ?? []) {
    if (!options.schema.fields.includes(key) || !form[key]) (patch as Record<string, unknown>)[key] = ''
  }
  if (options.fields !== undefined) patch.fields = options.fields
  return patch
}
export type EditorErrors = Partial<Record<CredentialField, EditorLocaleKey>>
/** Basic text shape checks only; never parse/decrypt a private key in the GUI. */
export function isPrivateKeyShape(raw: string): boolean {
  const match = /^-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----\r?\n([\s\S]+)\r?\n-----END \1-----$/.exec(raw.trim())
  if (!match) return false
  const body = match[2]!.replace(/^(?:Proc-Type|DEK-Info):[^\n]*$/gm, '').replace(/\s/g, '')
  return body.length >= 4 && /^[A-Za-z0-9+/=]+$/.test(body)
}
function isIpShape(raw: string): boolean {
  if (raw.includes(':')) {
    try { return new URL('http://[' + raw + ']').hostname.length > 0 } catch { return false }
  }
  const parts = raw.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function isHostShape(raw: string): boolean {
  if (isIpShape(raw)) return true
  if (/^[0-9.]+$/.test(raw)) return false
  const host = raw.endsWith('.') ? raw.slice(0, -1) : raw
  return host.length > 0 && host.length <= 253 && host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}
export function validateCredentialForm(form: FormFields, schema: CredentialSchema, original?: VaultFullWire, authChanged = false): EditorErrors {
  const errors: EditorErrors = {}
  const old = original ? entryToForm(original) : undefined
  const changed = (key: CredentialField): boolean => !old || form[key] !== old[key]
  const active = (key: CredentialField): boolean => schema.fields.includes(key)
  const text = (key: CredentialField): string => typeof form[key] === 'string' ? (form[key] as string).trim() : ''
  if (!text('title')) errors.title = 'editorErrTitle'
  if (active('otpSecret') && (changed('otpSecret') || schema.authenticatorOnly)) {
    const issue = otpInputIssue(form.otpSecret ?? '')
    if (schema.authenticatorOnly && !text('otpSecret')) errors.otpSecret = 'editorErrTotpRequired'
    else if (issue) errors.otpSecret = issue === 'migration' ? 'editorErrTotpMigration' : issue === 'algorithm' ? 'editorErrTotpAlgorithm' : 'editorErrTotp'
  }
  if (active('port') && changed('port') && text('port') && (!/^\d{1,5}$/.test(text('port')) || Number(text('port')) < 1 || Number(text('port')) > 65535)) errors.port = 'editorErrPort'
  if (active('ip') && changed('ip') && text('ip') && !isIpShape(text('ip'))) errors.ip = 'editorErrIp'
  if (active('privateKey') && changed('privateKey') && text('privateKey') && !isPrivateKeyShape(text('privateKey'))) errors.privateKey = 'editorErrPrivateKeyShape'
  if (active('certificate') && changed('certificate') && text('certificate') && !/^[A-Za-z0-9-]+-cert-v01@openssh[.]com [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/.test(text('certificate'))) errors.certificate = 'editorErrCertificate'
  if (active('envKeys') && changed('envKeys') && text('envKeys') && text('envKeys').split(',').some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim()))) errors.envKeys = 'editorErrEnvKeys'
  if (active('rotationDays') && changed('rotationDays') && form.rotationDays !== undefined && (!Number.isInteger(form.rotationDays) || form.rotationDays < 0 || form.rotationDays > 3650)) errors.rotationDays = 'editorErrRotation'
  if (schema.kind === 'ssh') {
    const enforce = !original || original.kind !== 'ssh' || authChanged
    if ((enforce || changed('host')) && !isHostShape(text('host'))) errors.host = 'editorErrHost'
    if ((enforce || changed('username')) && !text('username')) errors.username = 'editorErrUsername'
    const key = schema.sshAuth === 'password' ? 'password' : 'privateKey'
    if ((enforce || changed(key)) && (key === 'password' ? (form.password ?? '').length === 0 : !text(key))) errors[key] = key === 'password' ? 'editorErrPassword' : 'editorErrPrivateKeyRequired'
  }
  return errors
}
