import { describe, expect, test } from 'vitest'
import {
  DEFAULT_QUICK_IMPORT_FORMAT,
  QUICK_IMPORT_LIMITS,
  QUICK_IMPORT_PRESETS,
  SUPPORTED_QUICK_IMPORT_PLACEHOLDERS,
  parseQuickImport,
} from '../src/quick-import.ts'
import type { QuickImportOptions, QuickImportResult } from '../src/quick-import.ts'

const hostOnly = '{user}@{host}|{pwd}|{tag/nick_name}'
const minimal = '{user}@{host}|{pwd}'
const hostIp = '{user}@{host}:{ip}|{pwd}|{nickname}'

function parse(text: string, overrides: Partial<QuickImportOptions> = {}): QuickImportResult {
  return parseQuickImport(text, { format: DEFAULT_QUICK_IMPORT_FORMAT, kind: 'ssh', ...overrides })
}

function expectGlobal(result: QuickImportResult, error: string): void {
  expect(result).toMatchObject({ rows: [{ line: 0, error }], valid: 0, invalid: 1 })
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).not.toHaveProperty('entry')
}

// An independent test-only encoder. Escape every reserved ASCII symbol, not the
// parser's delimiter logic; expected values originate before encoding. There are
// no filtered/vacuous cases, clock seeds, production codec helpers or dependencies.
function encodeField(value: string): string {
  return Array.from(value, char => '\\|@:,#{}[]'.includes(char) ? '\\' + char : char).join('')
}

function randomFromSeed(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

describe('quick import fixed-format examples', () => {
  test('exports an immutable port default, literal IP preset and supported aliases', () => {
    expect(DEFAULT_QUICK_IMPORT_FORMAT).toBe('{user}@{host}:{port}|{pwd}|{tag/nick_name}')
    expect(QUICK_IMPORT_PRESETS.map(preset => preset.id)).toEqual(['host-port', 'host-only', 'host-ip', 'ip-port'])
    expect(SUPPORTED_QUICK_IMPORT_PLACEHOLDERS).toContain('{tag/nick_name}')
    expect(SUPPORTED_QUICK_IMPORT_PLACEHOLDERS).toContain('{password}')
    expect(Object.isFrozen(QUICK_IMPORT_PRESETS)).toBe(true)
    expect(Object.isFrozen(SUPPORTED_QUICK_IMPORT_PLACEHOLDERS)).toBe(true)
  })

  test('port example maps combined nickname to title AND one tag', () => {
    const result = parse('demo-user@server.example:2222|synthetic-demo|生产机 / 名称')
    expect(result).toEqual({
      rows: [{ line: 1, entry: {
        title: '生产机 / 名称', kind: 'ssh', username: 'demo-user', host: 'server.example',
        port: '2222', password: 'synthetic-demo', tags: ['生产机 / 名称'], sshAuth: 'password',
      } }], valid: 1, invalid: 0, ignored: 0,
    })
  })

  test('explicit {host}:{ip} never infers an IP as port, or vice versa', () => {
    const result = parse('demo@server.example:192.0.2.9|sample-only|DNS + IP', { format: hostIp })
    expect(result.rows[0]?.entry).toMatchObject({ host: 'server.example', ip: '192.0.2.9', port: '22', title: 'DNS + IP', tags: [] })
    expect(result.rows[0]?.warning).toBe('DEFAULT_PORT_USED')
    expect(parse('demo@server.example:2222|sample-only|label', { format: hostIp }).rows[0]?.error).toBe('INVALID_IP')
    expect(parse('demo@server.example:192.0.2.9|sample-only|label').rows[0]?.error).toBe('INVALID_PORT')
  })

  test('IP-only address supplies both host and ip without pretending it is DNS', () => {
    const result = parse('demo@192.0.2.42:2200|sample-only|edge', { format: '{user}@{ip}:{port}|{pwd}|{tag}' })
    expect(result.rows[0]?.entry).toMatchObject({ host: '192.0.2.42', ip: '192.0.2.42', port: '2200', tags: ['edge'], title: 'demo@192.0.2.42' })
  })

  test('host-only and blank-port presets support SSH defaults and explicit defaults', () => {
    expect(parse('demo@server.example|sample-only|label', { format: hostOnly }).rows[0]).toMatchObject({ warning: 'DEFAULT_PORT_USED', entry: { port: '22' } })
    expect(parse('demo@server.example:|sample-only|label', { defaultPort: '2200' }).rows[0]).toMatchObject({ warning: 'DEFAULT_PORT_USED', entry: { port: '2200' } })
    expect(parse('demo@server.example|sample-only|label', { format: hostOnly, defaultPort: '2222' }).rows[0]?.entry?.port).toBe('2222')
    expect(parse('demo@server.example|sample-only|label').rows[0]?.error).toBe('FORMAT_MISMATCH')
  })

  test('login host-only has no SSH-only fields or implicit port', () => {
    const row = parse('demo@server.example|sample-only|label', { format: hostOnly, kind: 'login' }).rows[0]
    expect(row?.entry).toMatchObject({ kind: 'login', host: 'server.example' })
    expect(row?.entry).not.toHaveProperty('port')
    expect(row?.entry).not.toHaveProperty('sshAuth')
    expect(row).not.toHaveProperty('warning')
  })

  test.each(['nick_name', 'nickname', 'title'])('supports separate {%s} without inventing a tag', alias => {
    const result = parse('demo@server.example|sample-only|nick|a,b', { format: '{username}@{host}|{password}|{' + alias + '}|{tags}', kind: 'login' })
    expect(result.rows[0]?.entry).toMatchObject({ title: 'nick', tags: ['a', 'b'], username: 'demo', password: 'sample-only' })
  })

  test.each(['user', 'username'])('supports {%s} username alias and password alias', alias => {
    expect(parse('demo@server.example|sample-only', { format: '{' + alias + '}@{host}|{password}', kind: 'login' }).rows[0]?.entry?.username).toBe('demo')
  })

  test('merges, trims and deduplicates tags without mutating defaults', () => {
    const defaults = [' shared ', '全局', 'shared']
    const snapshot = defaults.slice()
    const result = parse('demo@server.example|sample-only| a,b,shared,,a ', { format: '{user}@{host}|{pwd}|{tags}', defaultTags: defaults })
    expect(result.rows[0]?.entry?.tags).toEqual(['shared', '全局', 'a', 'b'])
    expect(defaults).toEqual(snapshot)
    expect(parse('demo@server.example:22|sample-only| a,b ').rows[0]?.entry).toMatchObject({ title: 'a,b', tags: ['a,b'] })
  })

  test('blank optional labels fall back to username@host, with generic warning', () => {
    const result = parse('demo@server.example:22|sample-only|   ')
    expect(result.rows[0]).toMatchObject({ warning: 'EMPTY_LABEL', entry: { title: 'demo@server.example', tags: [] } })
    expect(result.rows[0]?.entry).not.toHaveProperty('ip')
  })
})

describe('quick import literal delimiters, escapes and whitespace', () => {
  test('preserves password leading/trailing spaces, tabs and Unicode byte-for-byte after decoding', () => {
    const password = '  合成パス🔐 e\u0301 \t  '
    const result = parse('demo@server.example:22|' + password + '|label')
    expect(result.rows[0]?.entry?.password).toBe(password)
    expect(parse('demo@server.example| ', { format: minimal, kind: 'login' }).rows[0]?.entry?.password).toBe(' ')
  })

  test('preserves username spaces/Unicode while trimming address, port and labels', () => {
    const row = parse('  演示 用户  @ server.example : 22 |  sample-only  | 标签 ').rows[0]
    expect(row?.entry).toMatchObject({ username: '  演示 用户  ', host: 'server.example', port: '22', title: '标签', password: '  sample-only  ' })
  })

  test('backslash quotes separators and itself in any field, including final field', () => {
    const username = 'demo@pipe|colon:back\\slash'
    const password = ' \||@::,#{}[] "quoted" \\ end '
    const title = 'nick|line,one\\tail'
    const result = parse(encodeField(username) + '@server.example:22|' + encodeField(password) + '|' + encodeField(title))
    expect(result.rows[0]?.entry).toMatchObject({ username, password, title, tags: [title] })
    expect(parse('demo@server.example|escaped\\,comma,second', { format: '{user}@{host}|{tags}|{pwd}' }).valid).toBe(0)
    const tags = parse('demo@server.example|sample-only|escaped\\,comma,second', { format: '{user}@{host}|{pwd}|{tags}' })
    expect(tags.rows[0]?.entry?.tags).toEqual(['escaped,comma', 'second'])
  })

  test('quotes are literal, not CSV/shell quoting, and do not protect separators', () => {
    expect(parse('demo@server.example:22|"sample-only"|label').rows[0]?.entry?.password).toBe('"sample-only"')
    expect(parse('demo@server.example:22|"part|part"|label').rows[0]?.error).toBe('FORMAT_MISMATCH')
    expect(parse('demo@server.example:22|"part\\|part"|label').rows[0]?.entry?.password).toBe('"part|part"')
  })

  test('matches multi-character regex-looking delimiters literally', () => {
    const format = '{user}.*{host}[+]{pwd}||{nickname}'
    const password = 'prefix[+]inside.*end'
    const result = parse('demo.*server.example[+]' + password + '||label', { format, kind: 'login' })
    expect(result.rows[0]?.entry).toMatchObject({ username: 'demo', host: 'server.example', password, title: 'label' })
    expect(parse('demoXXserver.example[+]sample-only||label', { format }).rows[0]?.error).toBe('FORMAT_MISMATCH')
  })

  test('format escapes braces and other literal characters without evaluating them', () => {
    const format = '\\{record\\}({user})@{host}|{pwd};end'
    const result = parse('{record}(demo)@server.example|sample-only;end', { format })
    expect(result.rows[0]?.entry?.password).toBe('sample-only')
    expect(parse('{record}(demo)@server.example|sample-only;end-extra', { format }).rows[0]?.error).toBe('FORMAT_MISMATCH')
  })

  test('does not swallow extra final columns and rejects trailing escape', () => {
    expect(parse('demo@server.example:22|sample-only|label|unexpected').rows[0]?.error).toBe('FORMAT_MISMATCH')
    expect(parse('demo@server.example|sample-only\\', { format: minimal }).rows[0]?.error).toBe('INVALID_ESCAPE')
    expect(parse('demo@server.example|sample-only|extra', { format: minimal }).rows[0]?.error).toBe('FORMAT_MISMATCH')
  })

  test('BOM/CRLF/LF/CR, blanks, comments and original physical row numbers', () => {
    const result = parse('\ufeff# synthetic fixture only\r\n  \r\ndemo@server.example:22|sample-only|first\rsecond@host.example:23|sample-only|next\n\n bad row\n')
    expect(result).toMatchObject({ valid: 2, invalid: 1, ignored: 3 })
    expect(result.rows.map(row => row.line)).toEqual([3, 4, 6])
    expect(result.rows[2]).toEqual({ line: 6, error: 'FORMAT_MISMATCH' })
    expect(parse('\\#demo@server.example|sample-only', { format: minimal }).rows[0]?.entry?.username).toBe('#demo')
    expect(parse('')).toEqual({ rows: [], valid: 0, invalid: 0, ignored: 0 })
    expect(parse('\ufeff\r\n# comment\n   ')).toEqual({ rows: [], valid: 0, invalid: 0, ignored: 3 })
  })
})

describe('quick import browser-safe address and value validation', () => {
  test.each(['[2001:db8::1]', '[::1]', '[::ffff:192.0.2.8]'])('supports IPv6 %s in host:port', host => {
    const row = parse('demo@' + host + ':2200|sample-only|label').rows[0]
    expect(row?.entry?.host).toBe(host.slice(1, -1))
    expect(row?.entry?.port).toBe('2200')
  })

  test('supports bracketed host and IP mapping, and bare IPv6 without a colon boundary', () => {
    expect(parse('demo@[2001:db8::1]:[2001:db8::2]|sample-only|label', { format: hostIp }).rows[0]?.entry).toMatchObject({ host: '2001:db8::1', ip: '2001:db8::2' })
    expect(parse('demo@2001:db8::8|sample-only|label', { format: hostOnly }).rows[0]?.entry?.host).toBe('2001:db8::8')
    expect(parse('demo@::|sample-only|label', { format: '{user}@{ip}|{pwd}|{title}' }).rows[0]?.entry?.ip).toBe('::')
  })

  test.each(['2001:db8::1:22', '::1:22', '[2001:db8::1:22', '[::1]:22:80'])('rejects ambiguous/unbalanced host-port input %s', address => {
    expect(parse('demo@' + address + '|sample-only|label').invalid).toBe(1)
    expect(parse('demo@' + address + '|sample-only|label').rows[0]).not.toHaveProperty('entry')
  })

  test.each(['192.0.2.1', '0.0.0.0', '255.255.255.255', '::', '::1', '2001:db8:0:0:0:0:2:1', '::ffff:192.0.2.128', '2001:db8::192.0.2.1'])('accepts literal IP %s without DNS/Node', ip => {
    expect(parse('demo@' + ip + '|sample-only', { format: '{user}@{ip}|{pwd}', kind: 'login' }).rows[0]?.entry?.ip).toBe(ip)
  })

  test.each(['256.1.2.3', '192.0.2', '192.00.2.1', '1.2.3.4.5', '0x7f.0.0.1', '1234', 'server.example', '2001:::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8', '::gggg', '::1%lo', '::ffff:999.0.0.1', '192.0.2.1::', '[192.0.2.1]', '::[1]'])('rejects malformed IP %s', ip => {
    expect(parse('demo@' + ip + '|sample-only', { format: '{user}@{ip}|{pwd}' }).rows[0]?.error).toBe('INVALID_IP')
  })

  test.each(['https://server.example', 'server.example/path', 'server.example?x=y', 'server.example#fragment', 'host;echo-bad', '$(bad)', '-bad.example', 'bad-.example', 'a..example', 'a_b', 'bad host', '256.0.2.1', '192.000.2.1', 'bad\u0000host', 'a'.repeat(64) + '.example', '💻.example'])('rejects non-host URL/shell/malformed values %s', host => {
    expect(parse('demo@' + host + '|sample-only', { format: minimal }).rows[0]?.error).toBe('INVALID_HOST')
  })

  test.each(['localhost', 'example.test', 'HOST.example.', 'xn--bcher-kva.example', '192.0.2.1'])('accepts strict DNS/IPv4 host %s', host => {
    expect(parse('demo@' + host + '|sample-only', { format: minimal }).rows[0]?.entry?.host).toBe(host)
  })

  test.each(['0', '65536', '-1', '+22', '22.0', '2e2', '22x', '0x16', '２２', '000022'])('rejects noninteger/out-of-range port %s', port => {
    expect(parse('demo@server.example:' + port + '|sample-only|label').rows[0]?.error).toBe('INVALID_PORT')
  })

  test.each([['1', '1'], ['65535', '65535'], ['00022', '22']])('accepts and normalizes port %s', (port, expected) => {
    expect(parse('demo@server.example:' + port + '|sample-only|label').rows[0]?.entry?.port).toBe(expected)
  })

  test('requires nonempty password, not password strength', () => {
    expect(parse('demo@server.example:22||label').rows[0]?.error).toBe('EMPTY_PASSWORD')
    expect(parse('demo@server.example:22|x|label').valid).toBe(1)
    expect(parse('demo@server.example:22|   |label').rows[0]?.entry?.password).toBe('   ')
  })

  test('bounds username, password, labels and tags; controls cannot enter metadata', () => {
    expect(parse('@server.example:22|sample-only|label').rows[0]?.error).toBe('EMPTY_USERNAME')
    for (const username of ['x\u0000y', 'x\ty', 'x\u0085y', 'x\u2028y', 'x'.repeat(257)]) {
      expect(parse(username + '@server.example:22|sample-only|label').rows[0]?.error).toBe('INVALID_USERNAME')
    }
    expect(parse('demo@server.example:22|' + 'x'.repeat(QUICK_IMPORT_LIMITS.maxPasswordLength + 1) + '|label').rows[0]?.error).toBe('PASSWORD_TOO_LONG')
    expect(parse('demo@server.example:22|sample-only|' + '名'.repeat(257)).rows[0]?.error).toBe('INVALID_LABEL')
    expect(parse('demo@server.example:22|sample-only|bad\u0000label').rows[0]?.error).toBe('INVALID_LABEL')
    expect(parse('demo@server.example|sample-only|' + Array.from({ length: 33 }, (_, i) => 't' + i).join(','), { format: '{user}@{host}|{pwd}|{tags}' }).rows[0]?.error).toBe('INVALID_TAGS')
  })
})

describe('quick import format validation and bounded rejection', () => {
  test.each([
    ['', 'EMPTY_FORMAT'],
    ['{host}|{pwd}', 'FORMAT_MISSING_USERNAME'],
    ['{user}|{pwd}', 'FORMAT_MISSING_ADDRESS'],
    ['{user}@{host}', 'FORMAT_MISSING_PASSWORD'],
    ['{user}{host}|{pwd}', 'AMBIGUOUS_FORMAT'],
    ['{user}@{host}|{pwd}|{username}', 'DUPLICATE_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{password}', 'DUPLICATE_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{tags}|{tag}', 'DUPLICATE_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{tag/nick_name}|{title}', 'DUPLICATE_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{tag/nick_name}|{tag}', 'DUPLICATE_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{unknown}', 'UNSUPPORTED_PLACEHOLDER'],
    ['{user}@{host}|{pwd}|{__proto__}', 'UNSUPPORTED_PLACEHOLDER'],
    ['{user}@{host}|{pwd', 'INVALID_FORMAT'],
    ['{user}@{host}|{pwd}}', 'INVALID_FORMAT'],
    ['{user}@{host}|{pwd}\\', 'FORMAT_INVALID_ESCAPE'],
    ['{user}@{host}\n{pwd}', 'INVALID_FORMAT'],
    ['{user}@{host}\\\\{pwd}', 'AMBIGUOUS_FORMAT'],
  ])('rejects malformed literal DSL %s with a generic code', (format, code) => {
    expectGlobal(parse('synthetic-only', { format }), code)
  })

  test('format and field limits reject before any row is parsed', () => {
    expectGlobal(parse('synthetic-only', { format: 'x'.repeat(513) }), 'FORMAT_TOO_LONG')
    expectGlobal(parse('synthetic-only', { format: '('.repeat(200_000) }), 'FORMAT_TOO_LONG')
    expectGlobal(parse('synthetic-only', { format: Array.from({ length: 9 }, () => '{user}').join('|') }), 'FORMAT_TOO_MANY_FIELDS')
    const eight = '{user}@{host}:{ip}:{port}|{pwd}|{tags}|{title}|{tags}'
    expectGlobal(parse('synthetic-only', { format: eight }), 'DUPLICATE_PLACEHOLDER')
  })

  test('rejects invalid untyped options with generic codes, no exceptions', () => {
    expectGlobal(parseQuickImport(null as unknown as string, { kind: 'ssh', format: minimal }), 'INVALID_INPUT')
    expectGlobal(parseQuickImport('synthetic-only', null as unknown as QuickImportOptions), 'INVALID_OPTIONS')
    expectGlobal(parse('synthetic-only', { kind: 'api-key' as 'ssh' }), 'INVALID_KIND')
    for (const defaultPort of ['0', '65536', '', '-22']) expectGlobal(parse('synthetic-only', { defaultPort }), 'INVALID_DEFAULT_PORT')
    expectGlobal(parse('synthetic-only', { defaultTags: ['bad\u0000tag'] }), 'INVALID_DEFAULT_TAGS')
    expectGlobal(parse('synthetic-only', { defaultTags: [23 as unknown as string] }), 'INVALID_DEFAULT_TAGS')
    expectGlobal(parse('synthetic-only', { defaultTags: Array(33).fill('tag') }), 'INVALID_DEFAULT_TAGS')
  })

  test('accepts only exact own option data fields, never inherited fields, accessors or arrays', () => {
    const valid = { kind: 'ssh', format: minimal }
    for (const key of ['overwrite', 'path', 'rawsecret', '__proto__', 'constructor']) {
      const options = Object.assign(Object.create(null), valid)
      options[key] = 'synthetic-only-raw'
      const result = parseQuickImport('demo@server.example|sample-only', options as QuickImportOptions)
      expectGlobal(result, 'INVALID_OPTIONS')
      expect(JSON.stringify(result)).not.toContain('synthetic-only-raw')
      expect(JSON.stringify(result)).not.toContain(key)
    }
    for (const options of [[], Object.assign([], valid), Object.create(valid), { format: minimal }, { kind: 'ssh' }]) {
      expectGlobal(parseQuickImport('demo@server.example|sample-only', options as QuickImportOptions), 'INVALID_OPTIONS')
    }
    let accessorCalls = 0
    const accessor = { kind: 'ssh', get format() { accessorCalls++; throw new Error('synthetic-only-raw') } }
    expectGlobal(parseQuickImport('synthetic-only', accessor as QuickImportOptions), 'INVALID_OPTIONS')
    expect(accessorCalls).toBe(0)
    const withSymbol = { ...valid, [Symbol('synthetic-only-raw')]: true }
    expectGlobal(parseQuickImport('synthetic-only', withSymbol as QuickImportOptions), 'INVALID_OPTIONS')
    const nullPrototype = Object.assign(Object.create(null), valid) as QuickImportOptions
    expect(parseQuickImport('demo@server.example|sample-only', nullPrototype).valid).toBe(1)
  })

  test('row cap is all-or-nothing, excludes ignored comments/blanks, and retains no raw lines', () => {
    const row = 'demo@server.example:22|synthetic-only|label'
    const allowed = parse(Array(500).fill(row).join('\n') + '\n# ignored\n\n')
    expect(allowed).toMatchObject({ valid: 500, invalid: 0, ignored: 2 })
    const rejected = parse(Array(501).fill(row).join('\n'))
    expectGlobal(rejected, 'ROW_LIMIT_EXCEEDED')
    expect(JSON.stringify(rejected)).not.toContain('synthetic-only')
  })

  test('1MiB cap counts UTF-8 (including surrogate pairs) and is inclusive', () => {
    const max = QUICK_IMPORT_LIMITS.maxInputBytes
    expect(parse('#' + 'a'.repeat(max - 1))).toEqual({ rows: [], valid: 0, invalid: 0, ignored: 1 })
    expectGlobal(parse('#' + 'a'.repeat(max)), 'INPUT_TOO_LARGE')
    expect(parse('#' + '😀'.repeat((max - 4) / 4) + 'abc').ignored).toBe(1)
    expectGlobal(parse('#' + '😀'.repeat(max / 4)), 'INPUT_TOO_LARGE')
    expect(parse('#' + '名'.repeat(Math.floor(max / 3))).ignored).toBe(1)
    expectGlobal(parse('#' + '名'.repeat(Math.floor(max / 3) + 1)), 'INPUT_TOO_LARGE')
  })

  test('large repetitive delimiters are literal and scanned without regex backtracking', () => {
    const separator = 'a'.repeat(200) + 'b'
    const format = '{user}@{host}|' + '{pwd}' + separator + '{title}'
    const password = 'a'.repeat(60_000)
    const result = parse('demo@server.example|' + password + separator + 'label', { format, kind: 'login' })
    expect(result.rows[0]?.entry?.password).toBe(password)
    expect(parse('demo@server.example|' + password, { format }).rows[0]?.error).toBe('FORMAT_MISMATCH')
  })

  test('input injection is inert data; failures never echo passwords, raw lines or format values', () => {
    const payload = '";globalThis.quickImportProbe=1;//$(echo synthetic-only)<script>demo</script>'
    const before = (globalThis as Record<string, unknown>).quickImportProbe
    const result = parse('demo@server.example:22|' + payload + '|<b>label</b>')
    expect(result.rows[0]?.entry).toMatchObject({ password: payload, title: '<b>label</b>' })
    expect((globalThis as Record<string, unknown>).quickImportProbe).toBe(before)
    const failures = [
      parse('demo@server.example:0|' + payload + '|label'),
      parse('demo@server.example:22|' + payload + '|label|extra'),
      parse(payload, { format: '{' + payload + '}' }),
    ]
    for (const failed of failures) {
      expect(failed.rows[0]).not.toHaveProperty('entry')
      expect(failed.rows[0]?.error).toMatch(/^[A-Z][A-Z_]+$/)
      expect(JSON.stringify(failed)).not.toContain('quickImportProbe')
      expect(JSON.stringify(failed)).not.toContain(payload)
      expect(failed.rows[0]).not.toHaveProperty('text')
    }
  })
})

describe('quick import deterministic generated invariants', () => {
  test('seeded independent encoding roundtrips exact usernames/passwords/hosts over Unicode and delimiters', () => {
    const next = randomFromSeed(0x51a7b00b)
    const alphabet = ['a', 'Z', '0', ' ', '中', 'é', 'e\u0301', '😀', 'パ', '|', '@', ':', '\\', '"', "'", '#', ',', '{', '}', '[', ']']
    const word = (length: number) => Array.from({ length }, () => alphabet[next() % alphabet.length]!).join('')
    const variants = [
      { format: '{user}@{host}:{port}|{pwd}|{nickname}', port: true, userSep: '@', hostSep: ':', passSep: '|' },
      { format: '{username}::{host}||{password}##{title}', port: false, userSep: '::', hostSep: '||', passSep: '##' },
      { format: '{user}@{host}|{pwd}|{tag/nick_name}', port: false, userSep: '@', hostSep: '|', passSep: '|' },
    ]
    for (let index = 0; index < 360; index++) {
      const variant = variants[index % variants.length]!
      const username = 'u' + word(next() % 16) + 'x'
      const host = 'node-' + next().toString(36) + '.example.test'
      const password = ' ' + word(1 + next() % 50) + ' '
      const title = 'label' + index
      const port = String(1 + next() % 65535)
      const encoded = encodeField(username) + variant.userSep + host + variant.hostSep
        + (variant.port ? port + '|' : '') + encodeField(password) + variant.passSep + title
      const result = parse(encoded, { format: variant.format, kind: 'login' })
      expect(result.valid, 'seed=0x51a7b00b case=' + index).toBe(1)
      expect(result.rows[0]?.entry).toMatchObject({ username, host, password, title })
      expect(result.rows[0]?.entry?.port).toBe(variant.port ? port : undefined)
    }
  })

  test('seeded malformed inputs preserve accounting and never attach entries to errors', () => {
    const next = randomFromSeed(0x2e9a06d1)
    const resultRows: string[] = []
    const expectedLines: number[] = []
    for (let index = 0; index < 200; index++) {
      if (index % 11 === 0) { resultRows.push('# comment'); continue }
      const port = String(65536 + next() % 100_000)
      resultRows.push('demo@node-' + index + '.example:' + port + '|synthetic-only|label')
      expectedLines.push(index + 1)
    }
    const result = parse(resultRows.join('\r\n'))
    expect(result.valid).toBe(0)
    expect(result.invalid).toBe(expectedLines.length)
    expect(result.ignored + result.invalid).toBe(200)
    expect(result.rows.map(row => row.line)).toEqual(expectedLines)
    for (const row of result.rows) {
      expect(row.error).toBe('INVALID_PORT')
      expect(row).not.toHaveProperty('entry')
      expect(Object.keys(row).sort()).toEqual(['error', 'line'])
    }
  })
})
