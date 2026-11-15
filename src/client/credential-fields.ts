/** The editor's whitelist, shared by rendering, transitions, validation and save. */
export type SshAuth = 'password' | 'certificate'
export type CredentialKind = 'login' | 'ssh' | 'api-key' | 'oauth' | 'secret' | 'card' | 'cookie' | 'custom'
export interface FormFields {
  title?: string | undefined
  kind?: string | undefined
  username?: string | undefined
  email?: string | undefined
  phone?: string | undefined
  password?: string | undefined
  host?: string | undefined
  ip?: string | undefined
  port?: string | undefined
  sshAuth?: SshAuth | undefined
  privateKey?: string | undefined
  certificate?: string | undefined
  keyPassphrase?: string | undefined
  apiKey?: string | undefined
  secret?: string | undefined
  accessToken?: string | undefined
  refreshToken?: string | undefined
  otpSecret?: string | undefined
  cardNumber?: string | undefined
  cardExpiry?: string | undefined
  cardCvv?: string | undefined
  cardHolder?: string | undefined
  url?: string | undefined
  notes?: string | undefined
  icon?: string | undefined
  color?: string | undefined
  expiresAt?: number | undefined
  /** Comma-separated exact environment-variable names. */
  envKeys?: string | undefined
  rotationDays?: number | undefined
  sensitivity?: string | undefined
  favorite?: boolean | undefined
}
export type CredentialField = keyof FormFields
export interface CredentialTemplate { name: string; kind: string; fields: Record<string, string> }
export const COMMON_FIELDS = ['title', 'kind', 'notes', 'otpSecret'] as const satisfies readonly CredentialField[]
export const ADVANCED_FIELDS = ['envKeys', 'rotationDays', 'sensitivity', 'favorite', 'icon', 'color'] as const satisfies readonly CredentialField[]
export const SECRET_FIELDS = ['password', 'privateKey', 'certificate', 'keyPassphrase', 'apiKey', 'secret', 'accessToken', 'refreshToken', 'otpSecret', 'cardNumber', 'cardCvv'] as const satisfies readonly CredentialField[]
export const CREDENTIAL_FIELDS = ['title', 'kind', 'username', 'email', 'phone', 'password', 'host', 'ip', 'port', 'sshAuth', 'privateKey', 'certificate', 'keyPassphrase', 'apiKey', 'secret', 'accessToken', 'refreshToken', 'otpSecret', 'cardNumber', 'cardExpiry', 'cardCvv', 'cardHolder', 'url', 'notes', 'expiresAt', ...ADVANCED_FIELDS] as const satisfies readonly CredentialField[]
const KINDS = new Set<string>(['login', 'ssh', 'api-key', 'oauth', 'secret', 'card', 'cookie', 'custom'])
const KIND_ALIASES: Record<string, CredentialKind> = {
  wifi: 'login', server: 'ssh', database: 'ssh', identity: 'login', bank: 'card',
  password: 'login', 'ssh-password': 'ssh', 'ssh-certificate': 'ssh', totp: 'custom', authenticator: 'custom',
}
export function normalizeCredentialKind(rawKind: string): CredentialKind {
  const kind = rawKind.replace(/^builtin:/, '')
  return KIND_ALIASES[kind] ?? (KINDS.has(kind) ? kind as CredentialKind : 'custom')
}
export function inferSshAuth(entry: Pick<FormFields, 'sshAuth' | 'privateKey'>): SshAuth {
  return entry.sshAuth === 'password' || entry.sshAuth === 'certificate' ? entry.sshAuth : entry.privateKey ? 'certificate' : 'password'
}
/** Old generic builtins must remain password templates despite their old key hint. */
export function templateSshAuth(template: CredentialTemplate): SshAuth {
  if (template.name === 'builtin:ssh-certificate') return 'certificate'
  if (['builtin:ssh', 'builtin:ssh-password', 'builtin:server', 'builtin:database'].includes(template.name)) return 'password'
  const raw = template.kind.replace(/^builtin:/, '')
  if (raw === 'ssh-certificate') return 'certificate'
  if (raw === 'ssh-password') return 'password'
  return Object.hasOwn(template.fields, 'privateKey') ? 'certificate' : 'password'
}
const PRIMARY: Record<CredentialKind, readonly CredentialField[]> = {
  login: ['username', 'email', 'phone', 'password', 'url', 'otpSecret'],
  ssh: ['sshAuth', 'username', 'host', 'ip', 'port'],
  'api-key': ['username', 'apiKey', 'secret', 'url'],
  oauth: ['accessToken', 'refreshToken', 'expiresAt', 'url'],
  secret: ['secret'],
  card: ['cardHolder', 'cardNumber', 'cardExpiry', 'cardCvv'],
  cookie: ['url', 'secret', 'expiresAt'],
  custom: [],
}
export interface CredentialSchema { kind: CredentialKind; sshAuth: SshAuth; fields: readonly CredentialField[]; authenticatorOnly: boolean }
export function credentialSchema(rawKind: string, template: CredentialTemplate | null = null, sshAuth: SshAuth = 'password'): CredentialSchema {
  const kind = normalizeCredentialKind(rawKind)
  const authenticatorOnly = ['totp', 'authenticator'].includes((template?.kind ?? rawKind).replace(/^builtin:/, '')) || template?.name === 'builtin:totp'
  let primary: readonly CredentialField[] = authenticatorOnly ? ['username', 'otpSecret', 'url'] : PRIMARY[kind]
  if (template?.name === 'builtin:password' || template?.kind.replace(/^builtin:/, '') === 'password') primary = ['username', 'password', 'url']
  // A named user template may only narrow its kind's schema, never broaden it.
  // Custom-kind templates can explicitly request any known field.
  if (kind === 'ssh') primary = [...PRIMARY.ssh, ...(sshAuth === 'certificate' ? ['privateKey', 'certificate', 'keyPassphrase'] as const : ['password'] as const)]
  if (template && !template.name.startsWith('builtin:')) {
    const candidates = kind === 'custom' ? CREDENTIAL_FIELDS : primary
    const requiredSsh: readonly CredentialField[] = kind === 'ssh' ? ['sshAuth', 'host', 'username', sshAuth === 'certificate' ? 'privateKey' : 'password'] : []
    primary = candidates.filter(key => requiredSsh.includes(key) || Object.hasOwn(template.fields, key))
  }
  const fields = [...new Set<CredentialField>([...COMMON_FIELDS, ...primary, ...ADVANCED_FIELDS])]
  return { kind, sshAuth, fields, authenticatorOnly }
}
export function isSecretField(key: CredentialField): boolean { return (SECRET_FIELDS as readonly CredentialField[]).includes(key) }
export function inactiveSshFields(mode: SshAuth): CredentialField[] {
  return mode === 'password' ? ['privateKey', 'certificate', 'keyPassphrase'] : ['password']
}
