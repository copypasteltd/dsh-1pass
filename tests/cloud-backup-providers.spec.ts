import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { uploadCloudBackup, validateCloudBackupSettings } from '../src/cloud-backup-providers.ts'
import type { CloudBackupSnapshot, GitHubBackupTarget, ObjectStorageBackupTarget } from '../src/cloud-backup-types.ts'

// All credentials are synthetic fixtures. The suite never uses the real network or real environment.
const env = { TEST_BACKUP_ACCESS: 'fixture-access', TEST_BACKUP_SECRET: 'fixture-secret', TEST_BACKUP_TOKEN: 'fixture-token+/=', TEST_GITHUB_TOKEN: 'fixture-github-token' }
const now = () => new Date('2026-11-14T14:25:38.123Z')
const vaultId = 'vault-0123456789abcdef01234567'
const blob = { ivHex: '11'.repeat(12), tagHex: '22'.repeat(16), dataHex: 'aabbcc' }
const document = { version: 1, kdf: { algo: 'scrypt', n: 32768, r: 8, p: 1, saltHex: '33'.repeat(16) }, verify: blob, entries: [{ id: 'entry-1', ...blob }] }
const filename = (day: string, uuid = '00000000-0000-4000-8000-000000000001') => `snapshot-2026-11-${day}T14-25-38-123Z-${uuid}.json`
const snapshot = (overrides: Partial<CloudBackupSnapshot> = {}): CloudBackupSnapshot => ({ vaultId, filename: filename('14'), data: JSON.stringify(document, null, 2) + '\n', ...overrides })
const storage = (overrides: Partial<ObjectStorageBackupTarget> = {}): ObjectStorageBackupTarget => ({
  provider: 's3', id: 'test-s3', label: 'Fixture bucket', enabled: true, prefix: 'dsh-vault',
  endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'backups',
  accessKeyIdEnv: 'TEST_BACKUP_ACCESS', secretAccessKeyEnv: 'TEST_BACKUP_SECRET', forcePathStyle: true, ...overrides,
})
const github = (overrides: Partial<GitHubBackupTarget> = {}): GitHubBackupTarget => ({
  provider: 'github', id: 'test-github', label: 'Fixture private repository', enabled: true, prefix: 'dsh-vault',
  owner: 'fixture-owner', repo: 'private-backups', branch: 'backup/main', tokenEnv: 'TEST_GITHUB_TOKEN', ...overrides,
})
interface Call { url: URL; method: string; headers: Headers; init: RequestInit }
function stub(handler: (call: Call, count: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), method: init.method ?? 'GET', headers: new Headers(init.headers), init }
    calls.push(call)
    return handler(call, calls.length)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const xmlEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function listing(keys: string[] = [], next?: string, encoded = true): Response {
  const encode = (value: string) => encoded ? encodeURIComponent(value) : xmlEscape(value)
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${encoded ? '<EncodingType>url</EncodingType>' : ''}<IsTruncated>${next === undefined ? 'false' : 'true'}</IsTruncated>${keys.map(key => `<Contents><Key>${encode(key)}</Key></Contents>`).join('')}${next === undefined ? '' : `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>`}</ListBucketResult>`)
}
function githubHandler(call: Call): Response {
  if (call.url.pathname.includes('/branches/')) return json({ name: 'backup/main', commit: { sha: 'a'.repeat(40) } })
  if (call.url.pathname.endsWith('/private-backups')) return json({ private: true })
  if (call.method === 'PUT') return json({}, 201)
  return json([])
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live fetch is forbidden') })) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('strict shared settings validation', () => {
  test('safe defaults, root defaults and fully populated target copies', () => {
    expect(validateCloudBackupSettings(undefined)).toEqual({ enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] })
    const item = storage({ endpoint: 'https://s3.example.com/' })
    const result = validateCloudBackupSettings({ targets: [item], intervalMinutes: 0 })
    expect(result.targets[0]).toEqual({ ...item, endpoint: 'https://s3.example.com' })
    expect(result.targets[0]).not.toBe(item)
    expect(result.intervalMinutes).toBe(0)
    expect(validateCloudBackupSettings({ intervalMinutes: 10080, retention: 100 }).retention).toBe(100)
  })
  test.each([null, [], true, { enabled: 'false' }, { onChange: 1 }, { intervalMinutes: 1 }, { intervalMinutes: 4 },
    { intervalMinutes: 5.5 }, { intervalMinutes: 10081 }, { retention: 0 }, { retention: 101 }, { retention: 1.5 },
    { targets: {} }, { targets: new Array(1) }, { token: 'raw-fixture-secret' }, { targets: Array.from({ length: 9 }, (_, i) => storage({ id: `id-${i}` })) },
    { targets: [storage(), storage()] },
  ])('rejects invalid root settings %#', input => { expect(() => validateCloudBackupSettings(input)).toThrow() })
  test.each([
    { id: 'Not-a-slug' }, { id: '../bad' }, { id: 'bad--slug' }, { prefix: '' }, { prefix: '/absolute' },
    { prefix: '../escape' }, { prefix: 'a/../b' }, { prefix: 'a//b' }, { prefix: 'a\\b' }, { prefix: 'a/%2e%2e' },
    { label: '' }, { accessKeyIdEnv: 'BAD-ENV' }, { secretAccessKeyEnv: '1BAD' }, { sessionTokenEnv: '' },
    { secretAccessKey: 'raw-fixture-secret' }, { accessKeyId: 'raw-fixture-access' }, { forcePathStyle: 'yes' },
    { bucket: '../bucket' }, { bucket: '192.168.1.1' }, { region: 'bad/region' },
  ])('validates configured targets even when everything is disabled %#', patch => {
    expect(() => validateCloudBackupSettings({ enabled: false, targets: [{ ...storage(), enabled: false, ...patch }] })).toThrow()
  })
  test.each(['http://s3.example.com', 'https://user:password@s3.example.com', 'https://@s3.example.com',
    'https://s3.example.com?token=fixture', 'https://s3.example.com?', 'https://s3.example.com#',
    'https://s3.example.com/path', 'https://s3.example.com/a/..', 'https://s3.example.com\\other',
    'https://localhost', 'https://localhost.example.local', 'https://foo.localhost', 'https://metadata.google.internal',
    'https://instance-data.ec2.internal', 'https://169.254.169.254', 'https://100.100.100.200',
    'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1', 'https://0.0.0.0',
    'https://10.0.0.1', 'https://192.168.0.1', 'https://172.16.0.1', 'https://224.0.0.1',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fe80::1]', 'https://[fc00::1]', 'https://[2002:7f00:1::1]',
  ])('denies unsafe endpoint %s', endpoint => { expect(() => validateCloudBackupSettings({ targets: [storage({ endpoint })] })).toThrow() })
  test.each([{ owner: 'a/b' }, { repo: '../repo' }, { branch: 'a..b' }, { branch: 'a/.hidden' }, { branch: 'a.lock' },
    { branch: 'a/' }, { branch: 'a//b' }, { branch: 'a@{b' }, { endpoint: 'https://github.example.com' }, { token: 'fixture' },
  ])('rejects unsafe GitHub fields %#', patch => { expect(() => validateCloudBackupSettings({ targets: [{ ...github(), ...patch }] })).toThrow() })
  test('rejects accessors, prototypes, symbols and nonenumerable hidden secrets', () => {
    const get = vi.fn(() => 'fixture')
    expect(() => validateCloudBackupSettings({ get enabled() { return get() } })).toThrow()
    expect(get).not.toHaveBeenCalled()
    expect(() => validateCloudBackupSettings(Object.create({ enabled: true }))).toThrow()
    expect(() => validateCloudBackupSettings({ [Symbol('secret')]: 'fixture' })).toThrow()
    expect(() => validateCloudBackupSettings(Object.defineProperty({}, 'secret', { value: 'fixture' }))).toThrow()
  })
})

describe('encrypted snapshot preflight', () => {
  test.each([
    { data: '{"password":"plaintext"}' }, { data: 'not JSON' }, { data: JSON.stringify({ ...document, version: 2 }) },
    { data: JSON.stringify({ ...document, password: 'plaintext' }) }, { data: JSON.stringify({ ...document, entries: [{ id: 'x', password: 'plaintext' }] }) },
    { data: JSON.stringify({ ...document, verify: { ...blob, plaintext: 'secret' } }) },
    { data: JSON.stringify({ ...document, kdf: { ...document.kdf, saltHex: 'aa' } }) },
    { data: JSON.stringify({ ...document, kdf: { ...document.kdf, n: 7 } }) },
    { data: JSON.stringify({ ...document, entries: [{ id: 'x', ...blob }, { id: 'x', ...blob }] }) },
    { data: JSON.stringify({ ...document, verify: { ...blob, ivHex: 'aa' } }) },
    { data: JSON.stringify({ ...document, verify: { ...blob, tagHex: 'aa' } }) },
    { data: JSON.stringify({ ...document, verify: { ...blob, dataHex: 'abc' } }) },
    { data: JSON.stringify(document).replace('{"version":1', '{"version":"plaintext","version":1') },
    { vaultId: '../escape' }, { vaultId: 'vault-not-a-hash' }, { filename: '../escape.json' },
    { filename: filename('99') }, { filename: filename('14').replace('.json', '.txt') },
  ])('rejects malformed/plaintext snapshot before any network call %#', async patch => {
    const remote = stub(() => { throw new Error('Unexpected request') })
    await expect(uploadCloudBackup(storage(), snapshot(patch), 10, { env, fetch: remote.fetch })).rejects.toThrow()
    expect(remote.calls).toHaveLength(0)
  })
  test('duplicate escaped keys cannot conceal plaintext', async () => {
    const remote = stub(() => new Response())
    const data = JSON.stringify(document).replace('"dataHex":"aabbcc"', '"dataHex":"plaintext","data\\u0048ex":"aabbcc"')
    await expect(uploadCloudBackup(storage(), snapshot({ data }), 10, { env, fetch: remote.fetch })).rejects.toThrow(/Duplicate/)
    expect(remote.calls).toHaveLength(0)
  })
  test('oversize raw snapshots never send requests', async () => {
    const remote = stub(() => new Response())
    await expect(uploadCloudBackup(storage(), snapshot({ data: ' '.repeat(20 * 1024 * 1024 + 1) }), 10, { env, fetch: remote.fetch })).rejects.toThrow(/20 MiB/)
    expect(remote.calls).toHaveLength(0)
  })
  test('GitHub bounds actual base64 JSON request as well as raw bytes', async () => {
    const remote = stub(githubHandler)
    const data = JSON.stringify({ ...document, entries: [{ id: 'large', ...blob, dataHex: 'aa'.repeat(8 * 1024 * 1024) }] })
    expect(Buffer.byteLength(data)).toBeLessThan(20 * 1024 * 1024)
    await expect(uploadCloudBackup(github(), snapshot({ data }), 10, { env, fetch: remote.fetch })).rejects.toThrow(/20 MiB payload/)
    expect(remote.calls).toHaveLength(0)
  })
  test('disabled target and invalid retention cannot upload', async () => {
    const remote = stub(() => new Response())
    await expect(uploadCloudBackup(storage({ enabled: false }), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/disabled/)
    await expect(uploadCloudBackup(storage(), snapshot(), 0, { env, fetch: remote.fetch })).rejects.toThrow(/retention/)
    expect(remote.calls).toHaveLength(0)
  })
})

// Independent signature oracle uses WebCrypto, fixed canonical requests, not transport helpers.
const utf8 = (value: string) => new TextEncoder().encode(value)
const hex = (value: ArrayBuffer) => Buffer.from(value).toString('hex')
const sha = async (value: string) => hex(await webcrypto.subtle.digest('SHA-256', utf8(value)))
async function mac(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const imported = await webcrypto.subtle.importKey('raw', typeof key === 'string' ? utf8(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return webcrypto.subtle.sign('HMAC', imported, utf8(data))
}
async function signature(canonical: string, algorithm: 'AWS4-HMAC-SHA256' | 'OSS4-HMAC-SHA256', secret: string, time: string, region: string, service = 's3'): Promise<string> {
  const oss = algorithm.startsWith('OSS')
  const ending = oss ? 'aliyun_v4_request' : 'aws4_request'
  const date = time.slice(0, 8)
  let key = await mac((oss ? 'aliyun_v4' : 'AWS4') + secret, date)
  for (const part of [region, service, ending]) key = await mac(key, part)
  return hex(await mac(key, `${algorithm}\n${time}\n${date}/${region}/${service}/${ending}\n${await sha(canonical)}`))
}
const enc = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

describe('independently verified native signatures', () => {
  test('reference oracle agrees with the published AWS IAM SigV4 vector', async () => {
    const canonical = `GET\n/\nAction=ListUsers&Version=2010-05-08\ncontent-type:application/x-www-form-urlencoded; charset=utf-8\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n${await sha('')}`
    expect(await signature(canonical, 'AWS4-HMAC-SHA256', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830T123600Z', 'us-east-1', 'iam')).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
  })
  test('reference oracle agrees with official OSS canonical hash and final-MAC subvectors', async () => {
    // https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4
    const canonical = 'PUT\n/examplebucket/exampleobject\n\ncontent-disposition:attachment\ncontent-length:3\ncontent-md5:ICy5YqxZB1uWSwcVLSNLcA==\ncontent-type:text/plain\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20250411T064124Z\n\ncontent-disposition;content-length\nUNSIGNED-PAYLOAD'
    expect(await sha(canonical)).toBe('c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca')
    // The page substitutes a placeholder secret that does not derive its published key.
    // Verify the unambiguous published canonical hash and final MAC using that key.
    const publishedKey = Uint8Array.from(Buffer.from('3543b7686e65eda71e5e5ca19d548d78423c37e8ddba4dc9d83f90228b457c76', 'hex')).buffer
    expect(hex(await mac(publishedKey, `OSS4-HMAC-SHA256\n20250411T064124Z\n20250411/cn-hangzhou/oss/aliyun_v4_request\n${await sha(canonical)}`))).toBe('053edbf550ebd239b32a9cdfd93b0b2b3f2d223083aa61f75e9ac16856d61f23')
  })
  test.each([true, false])('S3 encoded-path PUT and security token independently match, pathStyle=%s', async forcePathStyle => {
    const target = storage({ prefix: 'dsh vault/a!()+@=', sessionTokenEnv: 'TEST_BACKUP_TOKEN', forcePathStyle })
    const remote = stub(call => call.method === 'GET' ? listing() : new Response('', { status: 200 }))
    const snap = snapshot()
    const result = await uploadCloudBackup(target, snap, 10, { env, fetch: remote.fetch, now })
    const call = remote.calls[0]!
    const path = `/${forcePathStyle ? 'backups/' : ''}${target.prefix}/${vaultId}/${snap.filename}`.split('/').map(enc).join('/')
    const host = forcePathStyle ? 's3.example.com' : 'backups.s3.example.com'
    expect(call.url.pathname).toBe(path)
    expect(call.url.host).toBe(host)
    expect(call.init.body).toBe(snap.data)
    expect(result.objectKey).toBe(`${target.prefix}/${vaultId}/${snap.filename}`)
    const hash = await sha(snap.data)
    const canonical = `PUT\n${path}\n\ncontent-type:application/json\nhost:${host}\nif-none-match:*\nx-amz-content-sha256:${hash}\nx-amz-date:20261114T142538Z\nx-amz-security-token:${env.TEST_BACKUP_TOKEN}\n\ncontent-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token\n${hash}`
    const expected = await signature(canonical, 'AWS4-HMAC-SHA256', env.TEST_BACKUP_SECRET, '20261114T142538Z', 'us-east-1')
    expect(expected).toBe(forcePathStyle ? 'f0bbad8e9eb03b511c066d3e4005f8783770f3e4fad3004a375cedf55eff83b9' : '42a0ed7dff95d61e2da9c4e09345bfc52fc9ffbe3aca042856b41eabee1261eb')
    expect(call.headers.get('authorization')).toBe(`AWS4-HMAC-SHA256 Credential=${env.TEST_BACKUP_ACCESS}/20261114/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${expected}`)
    expect(call.url.search).toBe('')
    expect(call.init.redirect).toBe('error')
    expect(call.init.credentials).toBe('omit')
  })
  test('R2 always signs with auto region', async () => {
    const remote = stub(call => call.method === 'GET' ? listing() : new Response())
    await uploadCloudBackup(storage({ provider: 'r2', region: 'ignored-setting' }), snapshot(), 10, { env, fetch: remote.fetch, now })
    expect(remote.calls[0]!.headers.get('authorization')).toContain('/20261114/auto/s3/aws4_request')
  })
  test.each([true, false])('OSS uses native V4 bucket canonical URI and signs token/MD5, pathStyle=%s', async forcePathStyle => {
    const target = storage({ provider: 'oss', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', prefix: 'dsh vault/a!()+@=', sessionTokenEnv: 'TEST_BACKUP_TOKEN', forcePathStyle })
    const remote = stub(call => call.method === 'GET' ? listing() : new Response())
    const snap = snapshot()
    await uploadCloudBackup(target, snap, 10, { env, fetch: remote.fetch, now })
    const call = remote.calls[0]!
    const md5 = call.headers.get('content-md5')
    expect(md5).toBe('q6bamzwpYaax4y/Qv1JSCg==')
    // The fixed payload digest and independent WebCrypto oracle bind the exact bytes.
    const path = `/backups/${target.prefix}/${vaultId}/${snap.filename}`.split('/').map(enc).join('/')
    const canonical = `PUT\n${path}\n\ncontent-md5:${md5}\ncontent-type:application/json\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20261114T142538Z\nx-oss-forbid-overwrite:true\nx-oss-security-token:${env.TEST_BACKUP_TOKEN}\n\n\nUNSIGNED-PAYLOAD`
    const expected = await signature(canonical, 'OSS4-HMAC-SHA256', env.TEST_BACKUP_SECRET, '20261114T142538Z', 'cn-hangzhou', 'oss')
    expect(expected).toBe('56b52b5829324d78d4693b8ef60d68a04e05cb300ab79c957a72b9d39b679b3e')
    expect(call.headers.get('authorization')).toBe(`OSS4-HMAC-SHA256 Credential=${env.TEST_BACKUP_ACCESS}/20261114/cn-hangzhou/oss/aliyun_v4_request, Signature=${expected}`)
    expect(call.headers.get('x-amz-date')).toBeNull()
    expect(call.headers.get('x-oss-content-sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(call.init.body).toBe(snap.data)
    expect(call.url.pathname).toBe(forcePathStyle ? path : path.replace('/backups/', '/'))
  })
})

describe('GitHub fail-closed upload and retention', () => {
  test.each([false, undefined, 'true'])('denies repository unless private is exactly true: %s', async privateValue => {
    const remote = stub(call => call.url.pathname.endsWith('/private-backups') ? json({ private: privateValue, message: 'fixture-github-token' }) : githubHandler(call))
    await expect(uploadCloudBackup(github(), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/private GitHub/)
    expect(remote.calls.every(call => call.method === 'GET')).toBe(true)
  })
  test('requires initialized selected branch', async () => {
    const remote = stub(call => call.url.pathname.includes('/branches/') ? json({ name: 'backup/main', commit: {} }) : githubHandler(call))
    await expect(uploadCloudBackup(github(), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/initialized/)
    expect(remote.calls).toHaveLength(1)
  })
  test('checks private immediately before every PUT and preserves original encrypted bytes', async () => {
    let isPrivate = true
    const remote = stub(call => call.url.pathname.endsWith('/private-backups') ? json({ private: isPrivate }) : githubHandler(call))
    const snap = snapshot()
    const result = await uploadCloudBackup(github(), snap, 10, { env, fetch: remote.fetch })
    expect(result.warning).toMatch(/Git history/)
    const put = remote.calls.findIndex(call => call.method === 'PUT')
    expect(remote.calls[put - 1]!.url.pathname).toBe('/repos/fixture-owner/private-backups')
    const payload = JSON.parse(remote.calls[put]!.init.body as string)
    expect(payload.branch).toBe('backup/main')
    expect(payload.sha).toBeUndefined()
    expect(Buffer.from(payload.content, 'base64').toString('utf8')).toBe(snap.data)
    expect(remote.calls.every(call => call.url.origin === 'https://api.github.com')).toBe(true)
    expect(remote.calls[0]!.url.pathname).toContain('/branches/backup%2Fmain')
    isPrivate = false
    await expect(uploadCloudBackup(github(), snapshot({ filename: filename('15') }), 10, { env, fetch: remote.fetch })).rejects.toThrow(/private/)
    expect(remote.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  })
  test('prunes only strict filenames at exact branch directory with their own SHA', async () => {
    const ns = `dsh-vault/${vaultId}/`
    const rows = [
      { name: filename('10'), path: ns + filename('10'), type: 'file', sha: 'b'.repeat(40) },
      { name: filename('12'), path: ns + filename('12'), type: 'file', sha: 'c'.repeat(40) },
      { name: filename('14'), path: ns + filename('14'), type: 'file', sha: 'd'.repeat(40) },
      { name: filename('09'), path: `other-vault/${filename('09')}`, type: 'file', sha: 'e'.repeat(40) },
      { name: 'notes.json', path: ns + 'notes.json', type: 'file', sha: 'e'.repeat(40) },
      { name: filename('08'), path: ns + filename('08'), type: 'dir', sha: 'e'.repeat(40) },
    ]
    const remote = stub(call => call.method === 'GET' && call.url.pathname.includes('/contents/') ? json(rows) : githubHandler(call))
    await uploadCloudBackup(github(), snapshot(), 2, { env, fetch: remote.fetch })
    const deletes = remote.calls.filter(call => call.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(decodeURIComponent(deletes[0]!.url.pathname)).toBe('/repos/fixture-owner/private-backups/contents/' + ns + filename('10'))
    expect(JSON.parse(deletes[0]!.init.body as string)).toMatchObject({ sha: 'b'.repeat(40), branch: 'backup/main' })
    expect(remote.calls.find(call => call.method === 'GET' && call.url.pathname.includes('/contents/'))!.url.searchParams.get('ref')).toBe('backup/main')
  })
  test('truncated Contents listing skips all deletion and warns', async () => {
    const remote = stub(call => call.method === 'GET' && call.url.pathname.includes('/contents/') ? json(Array.from({ length: 1000 }, () => ({ name: 'ignored' }))) : githubHandler(call))
    const result = await uploadCloudBackup(github(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.warning).toMatch(/incomplete/)
    expect(remote.calls.some(call => call.method === 'DELETE')).toBe(false)
  })
  test('prune failure does not negate upload and never reflects response text', async () => {
    const remote = stub(call => call.method === 'GET' && call.url.pathname.includes('/contents/') ? new Response('fixture-github-token signed-url', { status: 403 }) : githubHandler(call))
    const result = await uploadCloudBackup(github(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.objectKey).toContain(snapshot().filename)
    expect(result.warning).toMatch(/retention could not be completed/)
    expect(result.warning).not.toContain('fixture-github-token')
  })
})

describe('object pagination, signing and retention isolation', () => {
  test('paginates before deleting and signs encoded continuation token with namespace isolation', async () => {
    const target = storage({ prefix: 'dsh vault/a!()', sessionTokenEnv: 'TEST_BACKUP_TOKEN' })
    const ns = `${target.prefix}/${vaultId}/`
    const token = 'page+/= &雪'
    const unrelated = [ 'other/' + filename('01'), ns + '../' + filename('01'), ns + 'child/' + filename('01'), ns + filename('01') + '.bak', ns + filename('99'), ns + 'snapshot-2026-11-01T14-25-38-123Z-' + '-'.repeat(36) + '.json', ns.replace(vaultId, 'vault-ffffffffffffffffffffffff') + filename('01') ]
    let page = 0
    const remote = stub(call => {
      if (call.method === 'PUT') return new Response()
      if (call.method === 'DELETE') { expect(page).toBe(2); return new Response(null, { status: 204 }) }
      page++
      expect(call.url.searchParams.get('prefix')).toBe(ns)
      expect(call.url.searchParams.get('list-type')).toBe('2')
      if (page === 1) return listing([ns + filename('10'), ...unrelated], token)
      expect(call.url.searchParams.get('continuation-token')).toBe(token)
      return listing([ns + filename('12'), ns + filename('14'), ns + filename('10')])
    })
    const result = await uploadCloudBackup(target, snapshot(), 2, { env, fetch: remote.fetch, now })
    expect(result.warning).toBeUndefined()
    const deletes = remote.calls.filter(call => call.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(decodeURIComponent(deletes[0]!.url.pathname)).toBe('/backups/' + ns + filename('10'))
    const second = remote.calls.filter(call => call.method === 'GET')[1]!
    const query = `continuation-token=${enc(token)}&encoding-type=url&list-type=2&max-keys=1000&prefix=${enc(ns)}`
    expect(second.url.search).toBe('?' + query)
    const empty = await sha('')
    const canonical = `GET\n/backups/\n${query}\nhost:s3.example.com\nx-amz-content-sha256:${empty}\nx-amz-date:20261114T142538Z\nx-amz-security-token:${env.TEST_BACKUP_TOKEN}\n\nhost;x-amz-content-sha256;x-amz-date;x-amz-security-token\n${empty}`
    const expected = await signature(canonical, 'AWS4-HMAC-SHA256', env.TEST_BACKUP_SECRET, '20261114T142538Z', 'us-east-1')
    expect(second.headers.get('authorization')).toContain(`Signature=${expected}`)
  })
  test('native OSS paginates and deletes using OSS signing and exact owned keys', async () => {
    const ns = `dsh-vault/${vaultId}/`
    let page = 0
    const remote = stub(call => {
      expect(call.headers.get('authorization')).toContain('OSS4-HMAC-SHA256')
      expect(call.headers.get('x-amz-date')).toBeNull()
      if (call.method === 'GET') {
        page++
        return page === 1 ? listing([ns + filename('01')], 'oss+/=token') : listing([ns + filename('14')])
      }
      return new Response()
    })
    const result = await uploadCloudBackup(storage({ provider: 'oss', region: 'cn-hangzhou', forcePathStyle: false }), snapshot(), 1, { env, fetch: remote.fetch, now })
    expect(result.warning).toBeUndefined()
    expect(remote.calls.filter(call => call.method === 'GET')).toHaveLength(2)
    const deletion = remote.calls.find(call => call.method === 'DELETE')!
    expect(decodeURIComponent(deletion.url.pathname)).toBe('/' + ns + filename('01'))
    expect(deletion.headers.get('authorization')).toContain('/20261114/cn-hangzhou/oss/aliyun_v4_request')
  })
  test('XML without EncodingType handles entity-escaped keys without decoding percent escapes', async () => {
    const ns = `dsh-vault/${vaultId}/`
    const remote = stub(call => call.method === 'GET' ? listing([ns + filename('01'), ns + '%2e%2e/' + filename('01')], undefined, false) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.warning).toBeUndefined()
    expect(remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  })
  test.each(['repeat', 'limit'])('incomplete pagination %s skips all deletion and warns', async mode => {
    let page = 0
    const remote = stub(call => call.method === 'GET' ? listing([`dsh-vault/${vaultId}/${filename('01')}`], mode === 'repeat' ? 'repeat' : `page-${++page}`) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch, now })
    expect(result.warning).toMatch(/incomplete/)
    expect(remote.calls.filter(call => call.method === 'GET')).toHaveLength(mode === 'repeat' ? 2 : 10)
    expect(remote.calls.some(call => call.method === 'DELETE')).toBe(false)
  })
  test.each([
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>x</Key></Contents>',
    '<!DOCTYPE x [<!ENTITY steal SYSTEM "file:///fixture">]><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
    '<ListBucketResult><Contents><Key>x</Key></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Prefix>other/</Prefix></ListBucketResult>',
  ])('malformed XML cannot trigger deletion %#', async body => {
    const remote = stub(call => call.method === 'GET' ? new Response(body) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.warning).toBeTruthy()
    expect(remote.calls.some(call => call.method === 'DELETE')).toBe(false)
  })
  test('remote body bytes are bounded without trusting Content-Length', async () => {
    const remote = stub(call => call.method === 'GET' ? new Response('x'.repeat(2 * 1024 * 1024 + 1)) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.warning).toMatch(/retention/)
    expect(remote.calls.some(call => call.method === 'DELETE')).toBe(false)
  })
  test('delete failure preserves upload success and never emits remote body', async () => {
    const remote = stub(call => call.method === 'GET' ? listing([`dsh-vault/${vaultId}/${filename('01')}`]) : call.method === 'DELETE' ? new Response('fixture-secret', { status: 403 }) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(result.warning).toMatch(/retention/)
    expect(result.warning).not.toContain('fixture-secret')
    expect(result.objectKey).toContain(snapshot().filename)
  })
  test('caps destructive work and warns rather than deleting unbounded keys', async () => {
    const keys = Array.from({ length: 103 }, (_, i) => `dsh-vault/${vaultId}/${filename('01', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)}`)
    const remote = stub(call => call.method === 'GET' ? listing(keys) : new Response())
    const result = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch })
    expect(remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(100)
    expect(result.warning).toMatch(/deletion safety limit/)
  })
})

describe('credential resolution and safe error boundary', () => {
  test('missing credentials or an authoritative empty env cause zero requests', async () => {
    const remote = stub(() => new Response())
    await expect(uploadCloudBackup(storage(), snapshot(), 10, { env: {}, fetch: remote.fetch })).rejects.toThrow(/environment variable is not set/)
    await expect(uploadCloudBackup(github(), snapshot(), 10, { env: {}, fetch: remote.fetch })).rejects.toThrow(/environment variable is not set/)
    await expect(uploadCloudBackup(storage({ sessionTokenEnv: 'ABSENT_TOKEN' }), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/environment variable is not set/)
    expect(remote.calls).toHaveLength(0)
  })
  test('credentials are resolved at each invocation, never cached at import', async () => {
    const mutableEnv = { ...env }
    const remote = stub(call => call.method === 'GET' ? listing() : new Response())
    await uploadCloudBackup(storage(), snapshot(), 10, { env: mutableEnv, fetch: remote.fetch, now })
    mutableEnv.TEST_BACKUP_ACCESS = 'fixture-access-rotated'
    await uploadCloudBackup(storage(), snapshot({ filename: filename('15') }), 10, { env: mutableEnv, fetch: remote.fetch, now })
    expect(remote.calls.filter(call => call.method === 'PUT').map(call => call.headers.get('authorization'))).toEqual([expect.stringContaining('Credential=fixture-access/'), expect.stringContaining('Credential=fixture-access-rotated/')])
  })
  test.each(['network', 'response'])('sensitive %s errors never escape or log', async type => {
    const secret = Object.values(env).join(' ')
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
    const remote = stub(() => { if (type === 'network') throw new Error(secret + ' https://signed.example/?Signature=fixture'); return new Response(secret, { status: 403 }) })
    const error = await uploadCloudBackup(storage(), snapshot(), 1, { env, fetch: remote.fetch }).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('Expected upload to fail')
    for (const value of Object.values(env)) expect(String(error)).not.toContain(value)
    expect(String(error)).not.toContain('signed.example')
    expect(error.cause).toBeUndefined()
    logs.forEach(log => expect(log).not.toHaveBeenCalled())
  })
  test.each(['github', 's3', 'oss', 'r2'] as const)('redirect denied without following for %s', async provider => {
    const remote = stub(() => new Response('fixture-secret', { status: 307, headers: { location: 'https://169.254.169.254/' } }))
    await expect(uploadCloudBackup(provider === 'github' ? github() : storage({ provider }), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/redirect/)
    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0]!.init.redirect).toBe('error')
  })
  test('already redirected custom fetch response is also rejected', async () => {
    const response = new Response()
    Object.defineProperty(response, 'redirected', { value: true })
    const remote = stub(() => response)
    await expect(uploadCloudBackup(storage(), snapshot(), 10, { env, fetch: remote.fetch })).rejects.toThrow(/redirect/)
  })
  test('external abort cancels in-flight fetch without exposing its reason', async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const remote = stub(call => { started(); return new Promise((_resolve, reject) => call.init.signal!.addEventListener('abort', () => reject(new Error('fixture-secret abort reason')))) })
    const result = uploadCloudBackup(storage(), snapshot(), 10, { env, fetch: remote.fetch, signal: controller.signal })
    await ready
    controller.abort('fixture-secret')
    await expect(result).rejects.toThrow('Cloud backup request cancelled.')
    expect(remote.calls[0]!.init.signal!.aborted).toBe(true)
  })
  test('each request times out at 20 seconds even if fetch ignores abort', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const remote = stub(() => { started(); return new Promise<Response>(() => {}) })
    const result = uploadCloudBackup(storage(), snapshot(), 10, { env, fetch: remote.fetch })
    const assertion = expect(result).rejects.toThrow('Cloud backup request timed out.')
    await ready
    await vi.advanceTimersByTimeAsync(20_001)
    await assertion
    expect(remote.calls[0]!.init.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  test('response body timeout cancels a reader even when the transport ignores abort', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const cancel = vi.fn()
    const remote = stub(call => call.method === 'GET' ? new Response(new ReadableStream({ start() { started() }, cancel })) : new Response())
    const result = uploadCloudBackup(storage(), snapshot(), 10, { env, fetch: remote.fetch })
    await ready
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await result).warning).toMatch(/retention/)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  test('snapshot metadata cannot change while the asynchronous request is in flight', async () => {
    const snap = snapshot()
    const original = { ...snap }
    const remote = stub(call => {
      snap.vaultId = '../attacker'
      snap.filename = '../plaintext.json'
      return githubHandler(call)
    })
    const result = await uploadCloudBackup(github(), snap, 10, { env, fetch: remote.fetch })
    expect(result.objectKey).toBe(`dsh-vault/${original.vaultId}/${original.filename}`)
    expect(remote.calls.find(call => call.method === 'PUT')!.url.pathname).toContain(original.filename)
  })
  test('injected environment never falls through to ambient credentials', async () => {
    vi.stubEnv('TEST_BACKUP_ACCESS', 'fixture-ambient-access')
    vi.stubEnv('TEST_BACKUP_SECRET', 'fixture-ambient-secret')
    const remote = stub(() => new Response())
    await expect(uploadCloudBackup(storage(), snapshot(), 10, { env: {}, fetch: remote.fetch })).rejects.toThrow(/not set/)
    expect(remote.calls).toHaveLength(0)
  })
  test('already aborted input starts no requests', async () => {
    const remote = stub(() => new Response())
    const controller = new AbortController()
    controller.abort('fixture-secret')
    await expect(uploadCloudBackup(storage(), snapshot(), 10, { env, fetch: remote.fetch, signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(remote.calls).toHaveLength(0)
  })
})
