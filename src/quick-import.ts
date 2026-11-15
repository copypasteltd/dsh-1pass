/**
 * A pure, fixed-format credential parser shared by the browser preview and Node.
 * No I/O, evaluation, user-supplied regular expressions, or credential logging.
 *
 * Grammar: named {placeholders} separated by nonempty, exact literal delimiters.
 * Backslash quotes ONE following character in both the format and each data field;
 * write two backslashes for one literal backslash. Quotes have no CSV/shell meaning:
 * they are preserved, and a delimiter inside quotes must still be backslash-escaped.
 * Delimiters themselves must be unescaped in data. Backslash cannot be a delimiter.
 * The first unescaped following delimiter ends a field (no backtracking). The last
 * field reserves the preceding delimiter too, so extra columns cannot be swallowed.
 * Brackets protect IPv6 colons in host/ip fields; stored addresses omit brackets.
 *
 * Username and password contents are not trimmed or Unicode-normalized. Address,
 * port and label whitespace is trimmed. Passwords need only be nonempty, not strong.
 * {tag}/{tags} are aliases for comma-separated tags (escape a comma to keep it).
 * {tag/nick_name} is ONE label used as both a single tag and the title, even if it
 * contains commas. An absent/empty nickname falls back to username@host.
 *
 * Empty ports and formats without {port} use defaultPort; SSH otherwise uses 22.
 * No placeholder/port is implicitly optional: in the default format a blank port
 * is written as user@host:|password|label. Use the host-only preset to omit ':'.
 * {host}:{ip} means a host name/address PLUS a literal IP, NEVER an inferred port.
 * IPv6 before a ':' delimiter must be bracketed to avoid host:port ambiguity.
 *
 * Leading BOM is removed once. LF, CRLF and CR separate physical rows; blank and
 * #-comment-only rows are ignored. Escape an initial # in a username to keep it.
 * A final newline does not add a phantom row. Row numbers are 1-based; a global
 * format/options/size/row-count failure is one error row at line 0, with NO entries.
 * All diagnostics are fixed codes; callers must render labels as plain text and
 * mask passwords. This parser does not sanitize HTML, execute input or save defaults.
 */

export interface QuickImportOptions {
  format: string
  kind: 'ssh' | 'login'
  defaultPort?: string
  defaultTags?: string[]
}

export interface QuickImportEntry {
  title: string
  kind: 'ssh' | 'login'
  username: string
  host: string
  port?: string
  ip?: string
  password: string
  tags: string[]
  sshAuth?: 'password'
}

export interface QuickImportRow {
  line: number
  entry?: QuickImportEntry
  error?: string
  warning?: string
}

export interface QuickImportResult {
  rows: QuickImportRow[]
  valid: number
  invalid: number
  ignored: number
}

export const DEFAULT_QUICK_IMPORT_FORMAT = '{user}@{host}:{port}|{pwd}|{tag/nick_name}'

export const SUPPORTED_QUICK_IMPORT_PLACEHOLDERS = Object.freeze([
  '{user}', '{username}', '{host}', '{ip}', '{port}', '{pwd}', '{password}',
  '{tag}', '{tags}', '{nick_name}', '{nickname}', '{title}', '{tag/nick_name}',
] as const)

export const QUICK_IMPORT_PRESETS = Object.freeze([
  Object.freeze({ id: 'host-port', format: DEFAULT_QUICK_IMPORT_FORMAT }),
  Object.freeze({ id: 'host-only', format: '{user}@{host}|{pwd}|{tag/nick_name}' }),
  Object.freeze({ id: 'host-ip', format: '{user}@{host}:{ip}|{pwd}|{tag/nick_name}' }),
  Object.freeze({ id: 'ip-port', format: '{user}@{ip}:{port}|{pwd}|{tag/nick_name}' }),
])

/** String bounds use UTF-16 code units, except maxInputBytes which is UTF-8. */
export const QUICK_IMPORT_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxRows: 500,
  maxFormatLength: 512,
  maxFields: 8,
  maxUsernameLength: 256,
  maxPasswordLength: 65_536,
  maxLabelLength: 256,
  maxTags: 32,
})

type Field = 'username' | 'host' | 'ip' | 'port' | 'password' | 'tags' | 'title' | 'tagTitle'
type Token = { literal: string } | { field: Field }
interface Delimiter { text: string; fallback: number[] }
interface CompiledField { name: Field; following?: Delimiter; previous?: Delimiter }
interface CompiledFormat { prefix: string; fields: CompiledField[] }
interface Capture { value: string; raw: string }
type Captures = Partial<Record<Field, Capture>>

function globalError(error: string, ignored = 0): QuickImportResult {
  return { rows: [{ line: 0, error }], valid: 0, invalid: 1, ignored }
}

function fieldName(name: string): Field | undefined {
  switch (name) {
    case 'user': case 'username': return 'username'
    case 'host': return 'host'
    case 'ip': return 'ip'
    case 'port': return 'port'
    case 'pwd': case 'password': return 'password'
    case 'tag': case 'tags': return 'tags'
    case 'nick_name': case 'nickname': case 'title': return 'title'
    case 'tag/nick_name': return 'tagTitle'
    default: return undefined
  }
}

function hasControls(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

/** KMP prefix table: delimiter matching stays linear even for repetitive formats. */
function delimiter(text: string): Delimiter {
  const fallback = new Array<number>(text.length).fill(0)
  for (let i = 1, matched = 0; i < text.length; i++) {
    while (matched > 0 && text[i] !== text[matched]) matched = fallback[matched - 1]!
    if (text[i] === text[matched]) matched++
    fallback[i] = matched
  }
  return { text, fallback }
}

function compileFormat(format: string): CompiledFormat | string {
  if (!format) return 'EMPTY_FORMAT'
  if (format.length > QUICK_IMPORT_LIMITS.maxFormatLength) return 'FORMAT_TOO_LONG'
  if (hasControls(format)) return 'INVALID_FORMAT'
  const tokens: Token[] = []
  let literal = ''
  let fieldCount = 0
  for (let i = 0; i < format.length; i++) {
    const char = format[i]!
    if (char === '\\') {
      if (++i === format.length) return 'FORMAT_INVALID_ESCAPE'
      literal += format[i]!
    } else if (char === '{') {
      if (literal) { tokens.push({ literal }); literal = '' }
      const close = format.indexOf('}', i + 1)
      if (close === -1) return 'INVALID_FORMAT'
      const name = fieldName(format.slice(i + 1, close))
      if (!name) return 'UNSUPPORTED_PLACEHOLDER'
      if (++fieldCount > QUICK_IMPORT_LIMITS.maxFields) return 'FORMAT_TOO_MANY_FIELDS'
      tokens.push({ field: name })
      i = close
    } else if (char === '}') {
      return 'INVALID_FORMAT'
    } else {
      literal += char
    }
  }
  if (literal) tokens.push({ literal })
  const seen = new Set<Field>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if ('literal' in token) {
      if (token.literal.includes('\\')) return 'AMBIGUOUS_FORMAT'
      continue
    }
    if (i > 0 && 'field' in tokens[i - 1]!) return 'AMBIGUOUS_FORMAT'
    const names: Field[] = token.field === 'tagTitle' ? ['tags', 'title'] : [token.field]
    for (const name of names) {
      if (seen.has(name)) return 'DUPLICATE_PLACEHOLDER'
      seen.add(name)
    }
  }
  if (!seen.has('username')) return 'FORMAT_MISSING_USERNAME'
  if (!seen.has('host') && !seen.has('ip')) return 'FORMAT_MISSING_ADDRESS'
  if (!seen.has('password')) return 'FORMAT_MISSING_PASSWORD'
  const first = tokens[0]!
  const prefix = 'literal' in first ? first.literal : ''
  const fields: CompiledField[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!('field' in token)) continue
    const next = tokens[i + 1]
    const previous = tokens[i - 1]
    fields.push({
      name: token.field,
      ...(next && 'literal' in next ? { following: delimiter(next.literal) } : {}),
      ...(previous && 'literal' in previous ? { previous: delimiter(previous.literal) } : {}),
    })
  }
  return { prefix, fields }
}

/** Find an unescaped delimiter, protecting bracketed address literals only. */
function findDelimiter(line: string, start: number, pattern: Delimiter, address: boolean): number {
  let first = start
  if (address) while (line[first] === ' ' || line[first] === '\t') first++
  const bracketStart = address && line[first] === '[' ? first : -1
  let inBrackets = false
  let matched = 0
  for (let i = start; i < line.length; i++) {
    const char = line[i]!
    if (char === '\\') { i++; matched = 0; continue }
    if (i === bracketStart) inBrackets = true
    if (inBrackets) {
      if (char === ']') inBrackets = false
      matched = 0
      continue
    }
    while (matched > 0 && char !== pattern.text[matched]) matched = pattern.fallback[matched - 1]!
    if (char === pattern.text[matched]) matched++
    if (matched === pattern.text.length) return i - matched + 1
  }
  return -1
}

function decode(raw: string): string | undefined {
  let value = ''
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') continue
    if (i + 1 === raw.length) return undefined
    value += raw.slice(start, i) + raw[i + 1]!
    i++
    start = i + 1
  }
  return value + raw.slice(start)
}

function captureLine(line: string, format: CompiledFormat): Captures | string {
  if (!line.startsWith(format.prefix)) return 'FORMAT_MISMATCH'
  const captures: Captures = {}
  let position = format.prefix.length
  for (const field of format.fields) {
    const address = field.name === 'host' || field.name === 'ip'
    let end = line.length
    if (field.following) {
      end = findDelimiter(line, position, field.following, address)
      if (end === -1) return 'FORMAT_MISMATCH'
    } else if (field.previous && findDelimiter(line, position, field.previous, address) !== -1) {
      return 'FORMAT_MISMATCH'
    }
    const raw = line.slice(position, end)
    const value = decode(raw)
    if (value === undefined) return 'INVALID_ESCAPE'
    captures[field.name] = { raw, value }
    position = end + (field.following?.text.length ?? 0)
  }
  return position === line.length ? captures : 'FORMAT_MISMATCH'
}

function digits(value: string): boolean {
  if (!value.length) return false
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 48 || value.charCodeAt(i) > 57) return false
  return true
}

function validIpv4(ip: string): boolean {
  const parts = ip.split('.')
  return parts.length === 4 && parts.every(part => part.length <= 3 && digits(part)
    && (part.length === 1 || part[0] !== '0') && Number(part) <= 255)
}

function validIpv6(ip: string): boolean {
  if (!ip.includes(':') || ip.length > 45) return false
  const compressed = ip.indexOf('::')
  if (compressed !== -1 && compressed !== ip.lastIndexOf('::')) return false
  const left = compressed === -1 ? ip : ip.slice(0, compressed)
  const right = compressed === -1 ? '' : ip.slice(compressed + 2)
  const parts = [...(left ? left.split(':') : []), ...(right ? right.split(':') : [])]
  let units = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if (part.includes('.')) {
      if (index !== parts.length - 1 || !ip.endsWith(part) || !validIpv4(part)) return false
      units += 2
    } else {
      if (!part.length || part.length > 4) return false
      for (let i = 0; i < part.length; i++) {
        const code = part.charCodeAt(i)
        if (!(code >= 48 && code <= 57) && !(code >= 65 && code <= 70) && !(code >= 97 && code <= 102)) return false
      }
      units++
    }
  }
  return compressed === -1 ? units === 8 : units < 8
}

function ipAddress(value: string): string | undefined {
  const ip = value.trim()
  if (ip.startsWith('[') || ip.endsWith(']')) {
    if (!(ip.startsWith('[') && ip.endsWith(']'))) return undefined
    const inner = ip.slice(1, -1)
    return validIpv6(inner) ? inner : undefined
  }
  return validIpv4(ip) || validIpv6(ip) ? ip : undefined
}

function hostAddress(value: string): string | undefined {
  const host = value.trim()
  if (!host || host.length > 253) return undefined
  if (host.includes(':') || host.includes('[') || host.includes(']')) return ipAddress(host)
  if (validIpv4(host)) return host
  // Numeric dotted strings must not fall back to DNS after failing IPv4 checks.
  if (host.includes('.') && host.split('.').every(part => !part || digits(part))) return undefined
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.')
  for (const label of labels) {
    if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return undefined
    for (let i = 0; i < label.length; i++) {
      const code = label.charCodeAt(i)
      if (!(code >= 48 && code <= 57) && !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) && code !== 45) return undefined
    }
  }
  return host
}

function portNumber(value: string): string | undefined {
  const port = value.trim()
  if (port.length > 5 || !digits(port)) return undefined
  const number = Number(port)
  return number >= 1 && number <= 65535 ? String(number) : undefined
}

function labelValue(value: string): string | undefined {
  if (value.length > QUICK_IMPORT_LIMITS.maxLabelLength || hasControls(value)) return undefined
  return value.trim()
}

function tagsFromCapture(capture: Capture): string[] | undefined {
  // Split encoded input, not the decoded value: an escaped comma belongs to a tag.
  const tags: string[] = []
  let start = 0
  for (let i = 0; i <= capture.raw.length; i++) {
    if (capture.raw[i] === '\\') { i++; continue }
    if (i !== capture.raw.length && capture.raw[i] !== ',') continue
    const decoded = decode(capture.raw.slice(start, i))
    const label = decoded === undefined ? undefined : labelValue(decoded)
    if (label === undefined) return undefined
    if (label) tags.push(label)
    if (tags.length > QUICK_IMPORT_LIMITS.maxTags) return undefined
    start = i + 1
  }
  return tags
}

function buildEntry(captures: Captures, options: QuickImportOptions, defaultTags: string[]): Omit<QuickImportRow, 'line'> {
  const username = captures.username!.value
  if (!username.trim()) return { error: 'EMPTY_USERNAME' }
  if (username.length > QUICK_IMPORT_LIMITS.maxUsernameLength || hasControls(username)) return { error: 'INVALID_USERNAME' }
  let ip: string | undefined
  if (captures.ip) {
    ip = ipAddress(captures.ip.value)
    if (!ip) return { error: 'INVALID_IP' }
  }
  const host = captures.host ? hostAddress(captures.host.value) : ip
  if (!host) return { error: 'INVALID_HOST' }
  const password = captures.password!.value
  if (!password.length) return { error: 'EMPTY_PASSWORD' }
  if (password.length > QUICK_IMPORT_LIMITS.maxPasswordLength) return { error: 'PASSWORD_TOO_LONG' }
  const suppliedPort = captures.port?.value.trim() ?? ''
  const fallbackPort = options.defaultPort ?? (options.kind === 'ssh' ? '22' : undefined)
  const port = suppliedPort ? portNumber(suppliedPort) : fallbackPort === undefined ? undefined : portNumber(fallbackPort)
  if ((suppliedPort || fallbackPort !== undefined) && !port) return { error: 'INVALID_PORT' }
  let warning = !suppliedPort && port ? 'DEFAULT_PORT_USED' : undefined
  const tags = [...defaultTags]
  if (captures.tags) {
    const parsed = tagsFromCapture(captures.tags)
    if (!parsed) return { error: 'INVALID_TAGS' }
    tags.push(...parsed)
  }
  const titleCapture = captures.tagTitle ?? captures.title
  let title = username + '@' + host
  if (titleCapture) {
    const label = labelValue(titleCapture.value)
    if (label === undefined) return { error: 'INVALID_LABEL' }
    if (label) {
      title = label
      if (captures.tagTitle) tags.push(label)
    } else if (!warning) {
      warning = 'EMPTY_LABEL'
    }
  }
  const uniqueTags = [...new Set(tags)]
  if (uniqueTags.length > QUICK_IMPORT_LIMITS.maxTags) return { error: 'INVALID_TAGS' }
  const entry: QuickImportEntry = {
    title, kind: options.kind, username, host, password, tags: uniqueTags,
    ...(port === undefined ? {} : { port }),
    ...(ip === undefined ? {} : { ip }),
    ...(options.kind === 'ssh' ? { sshAuth: 'password' as const } : {}),
  }
  return { entry, ...(warning ? { warning } : {}) }
}

/** Count UTF-8 without Buffer/TextEncoder, including surrogate-pair handling. */
function inputTooLarge(text: string): boolean {
  if (text.length > QUICK_IMPORT_LIMITS.maxInputBytes) return true
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i++
    } else bytes += 3
    if (bytes > QUICK_IMPORT_LIMITS.maxInputBytes) return true
  }
  return false
}

export function parseQuickImport(text: string, options: QuickImportOptions): QuickImportResult {
  // Also defend the untyped HTTP boundary: every ordinary malformed argument is a
  // generic failure, not an exception which might be logged alongside credentials.
  if (typeof text !== 'string') return globalError('INVALID_INPUT')
  if (inputTooLarge(text)) return globalError('INPUT_TOO_LARGE')
  if (!options || typeof options !== 'object' || Array.isArray(options)) return globalError('INVALID_OPTIONS')
  // Accept only a plain/null-prototype record with the exact own data properties
  // in this API. Do not invoke accessors or read inherited defaults at the boundary.
  let descriptors: Record<string, PropertyDescriptor>
  try {
    const prototype: unknown = Object.getPrototypeOf(options)
    if (prototype !== null && prototype !== Object.prototype) return globalError('INVALID_OPTIONS')
    const keys = Reflect.ownKeys(options)
    if (keys.some(key => typeof key !== 'string' || !['format', 'kind', 'defaultPort', 'defaultTags'].includes(key))) return globalError('INVALID_OPTIONS')
    descriptors = Object.getOwnPropertyDescriptors(options)
    if (keys.some(key => !Object.hasOwn(descriptors[String(key)]!, 'value'))) return globalError('INVALID_OPTIONS')
  } catch {
    return globalError('INVALID_OPTIONS')
  }
  if (!Object.hasOwn(descriptors, 'format') || !Object.hasOwn(descriptors, 'kind') || typeof descriptors.format!.value !== 'string') return globalError('INVALID_OPTIONS')
  options = {
    format: descriptors.format!.value as string,
    kind: descriptors.kind!.value as QuickImportOptions['kind'],
    ...(Object.hasOwn(descriptors, 'defaultPort') ? { defaultPort: descriptors.defaultPort!.value as string } : {}),
    ...(Object.hasOwn(descriptors, 'defaultTags') ? { defaultTags: descriptors.defaultTags!.value as string[] } : {}),
  }
  if (options.kind !== 'ssh' && options.kind !== 'login') return globalError('INVALID_KIND')
  if (options.defaultPort !== undefined && (typeof options.defaultPort !== 'string' || !portNumber(options.defaultPort))) return globalError('INVALID_DEFAULT_PORT')
  const defaultTags: string[] = []
  if (options.defaultTags !== undefined) {
    if (!Array.isArray(options.defaultTags) || options.defaultTags.length > QUICK_IMPORT_LIMITS.maxTags) return globalError('INVALID_DEFAULT_TAGS')
    for (const value of options.defaultTags) {
      const label = typeof value === 'string' ? labelValue(value) : undefined
      if (label === undefined) return globalError('INVALID_DEFAULT_TAGS')
      if (label) defaultTags.push(label)
    }
  }
  const format = compileFormat(options.format)
  if (typeof format === 'string') return globalError(format)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const candidates: { line: number; text: string }[] = []
  let ignored = 0
  let count = 0
  for (let start = 0, line = 1; start < text.length; line++) {
    let end = start
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
    const raw = text.slice(start, end)
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) ignored++
    else if (++count <= QUICK_IMPORT_LIMITS.maxRows) candidates.push({ line, text: raw })
    start = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1)
  }
  if (count > QUICK_IMPORT_LIMITS.maxRows) return globalError('ROW_LIMIT_EXCEEDED', ignored)
  const rows: QuickImportRow[] = candidates.map(candidate => {
    const captures = captureLine(candidate.text, format)
    return {
      line: candidate.line,
      ...(typeof captures === 'string' ? { error: captures } : buildEntry(captures, options, defaultTags)),
    }
  })
  const valid = rows.reduce((total, row) => total + (row.entry ? 1 : 0), 0)
  return { rows, valid, invalid: rows.length - valid, ignored }
}
