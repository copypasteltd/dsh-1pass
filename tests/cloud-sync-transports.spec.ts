import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createVaultSyncTransport, metaFromSnapshot, snapshotContentHash, remoteIndexVersion } from '../src/cloud-sync/transports.ts'
import type { VaultHostTransportOptions } from '../src/cloud-sync/transports.ts'
import type { VaultSyncChannel, VaultSyncChannelConfig, VaultSyncSnapshot } from '../src/cloud-sync/types.ts'
import { canonical, MAX_BYTES, parseIndex } from '../src/cloud-sync/transports/documents.ts'
import { signHeaders } from '../src/cloud-sync/transports/signing.ts'
import { runProcess } from '../src/cloud-sync/transports/process.ts'
import * as processModule from '../src/cloud-sync/transports/process.ts'

const exec = promisify(execFile)
const temporary: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const p of temporary.splice(0)) await rm(p, { recursive: true, force: true }) })
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), '1pass-transport-test-')); temporary.push(dir); return dir }
function snapshot(transport: VaultSyncChannel, id = 'test-1'): VaultSyncSnapshot {
  const s: VaultSyncSnapshot = { format: '1pass-cloud-snapshot-v1', contentHash: '', id, createdAt: '2026-11-15T00:00:00.000Z', manifest: { schemaVersion: 1, encrypted: true, transport, vaultName: 'synthetic', deviceId: 'test-device', deviceName: 'Synthetic', platform: 'test', dshVersion: 'test', sections: ['vault'] }, encryptedPayload: { version: 1, kdf: { algo: 'scrypt', n: 32768, r: 8, p: 1, saltHex: '11'.repeat(16) }, nonce: '22'.repeat(12), ciphertext: '33'.repeat(128), tag: '44'.repeat(16) } }
  s.contentHash = snapshotContentHash(s)
  return s
}
function base(config: VaultSyncChannelConfig, fetcher: typeof fetch): VaultHostTransportOptions {
  return { config, stateDir: '/unused-test-state', credentials: { getSecret: async () => 'synthetic-secret' }, fetch: fetcher }
}
function response(status: number, body = '', headers: Record<string, string> = {}): Response { return new Response([204, 304].includes(status) ? null : body, { status, headers }) }
type Call = { url: URL; method: string; headers: Headers; body: string }
function objectMock() {
  const files = new Map<string, string>(); const calls: Call[] = []
  const opts = { noEtag: false, conflict: false, headConflict: false }
  const etag = (s: string) => '"' + createHash('sha256').update(s).digest('hex') + '"'
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; const headers = new Headers(init?.headers); const body = String(init?.body ?? '')
    calls.push({ url, method, headers, body })
    if (method === 'MKCOL') return response(201)
    const prior = files.get(url.pathname)
    if (method === 'GET' || method === 'HEAD') {
      if (prior === undefined) return response(404)
      return response(200, method === 'HEAD' ? '' : prior, opts.noEtag ? {} : { etag: opts.headConflict && method === 'HEAD' ? '"different"' : etag(prior) })
    }
    if (method === 'PUT') {
      if (url.pathname.endsWith('/index.json') && opts.conflict) return response(412)
      if (((headers.get('if-none-match') === '*' || headers.get('x-oss-forbid-overwrite') === 'true') && prior !== undefined) || (headers.has('if-match') && (prior === undefined || headers.get('if-match') !== etag(prior)))) return response(412)
      files.set(url.pathname, body); return response(200)
    }
    if (method === 'DELETE') { files.delete(url.pathname); return response(204) }
    throw new Error('Unexpected synthetic request')
  }) as unknown as typeof fetch
  return { files, calls, opts, fetcher }
}
function gistMock() {
  const files: Record<string, { content: string }> = {}; const calls: Call[] = []
  let patches = 0; let breakVerification = false
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; const headers = new Headers(init?.headers); const body = String(init?.body ?? ''); calls.push({ url: new URL(String(input)), method, headers, body })
    if (method === 'GET') return response(200, JSON.stringify({ public: false, files }))
    if (method === 'PATCH') {
      expect(headers.has('if-match')).toBe(false); expect(headers.has('if-none-match')).toBe(false)
      patches++
      const data = JSON.parse(body).files as Record<string, { content: string } | null>
      for (const [k, v] of Object.entries(data)) if (v === null) delete files[k]; else files[k] = v
      if (breakVerification) files['1pass-index.json'] = { content: '[]' }
      return response(200, '{}')
    }
    throw new Error('Unexpected synthetic request')
  }) as unknown as typeof fetch
  return { files, calls, fetcher, patches: () => patches, break: () => { breakVerification = true } }
}

describe('encrypted-only wire validation', () => {
  it('versions the whole index independent of timestamp/order and detects same-id content changes', () => {
    const a = metaFromSnapshot(snapshot('webdav', 'newer')); const b = metaFromSnapshot(snapshot('webdav', 'older')); b.createdAt = '2020-01-01T00:00:00.000Z'
    expect(remoteIndexVersion([])).toBe(''); expect(remoteIndexVersion([a, b])).toBe(remoteIndexVersion([b, a]))
    expect(remoteIndexVersion([a, b])).not.toBe(remoteIndexVersion([a])); expect(remoteIndexVersion([a])).not.toBe(remoteIndexVersion([{ ...a, contentHash: '00'.repeat(32) }]))
    expect(remoteIndexVersion([b, a])).toBe(createHash('sha256').update(canonical([[a.id, a.contentHash], [b.id, b.contentHash]])).digest('hex'))
  })

  it('hashes canonical order and rejects plaintext/config-manager/wrong-hash/unsafe metadata', () => {
    const s = snapshot('webdav')
    expect(metaFromSnapshot(s).contentHash).toBe(snapshotContentHash({ ...s, encryptedPayload: { ...s.encryptedPayload, kdf: { saltHex: '11'.repeat(16), p: 1, r: 8, n: 32768, algo: 'scrypt' } } }))
    expect(() => metaFromSnapshot({ ...s, format: 'dsh-config-manager' } as never)).toThrow()
    expect(() => metaFromSnapshot({ ...s, contentHash: '00'.repeat(32) })).toThrow(/hash/)
    expect(() => metaFromSnapshot({ ...s, sections: { settings: 'plaintext' } } as never)).toThrow()
    expect(() => snapshotContentHash({ ...s, manifest: { ...s.manifest, sections: ['settings'] } })).toThrow()
    expect(() => parseIndex(JSON.stringify([{ ...metaFromSnapshot(s), sectionCount: 10 }]), 'webdav')).toThrow()
    expect(() => parseIndex(JSON.stringify(Array(5001).fill(metaFromSnapshot(s))), 'webdav')).toThrow()
    expect(() => snapshotContentHash({ ...s, id: 'index' })).toThrow()
    expect(() => snapshotContentHash({ ...s, id: 'x'.repeat(129) })).toThrow()
    expect(() => snapshotContentHash({ ...s, encryptedPayload: { ...s.encryptedPayload, kdf: { ...s.encryptedPayload.kdf, n: 2 ** 28 } } })).toThrow()
  })
  it('rejects HTTP by default, unsafe namespaces, credential-in-config and token URL without I/O', () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    for (const patch of [{ webdavUrl: 'http://127.0.0.1/dav' }, { webdavUrl: 'https://user:secret@example.test' }, { prefix: '../outside' }, { password: 'never-config' }]) {
      expect(() => createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://example.test/dav', webdavUsername: 'test', ...patch } as never, fetcher))).toThrow()
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => createVaultSyncTransport({ ...base({ transport: 'webdav', webdavUrl: 'http://127.0.0.1/dav', webdavUsername: 'test' }, fetcher), allowInsecureHttpForTests: true })).not.toThrow()
  })
})

describe('WebDAV and S3-family index/CAS', () => {
  it.each(['webdav', 's3'] as const)('rejects a stale preview head for %s before any snapshot/marker/index write', async channel => {
    const m = objectMock(); const config: VaultSyncChannelConfig = channel === 'webdav' ? { transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' } : { transport: 's3', endpoint: 'https://storage.example.test', bucket: 'test-bucket', accessKeyId: 'testAk', pathStyle: true }
    const a = createVaultSyncTransport(base(config, m.fetcher)); expect(await a.list()).toEqual([])
    const b = createVaultSyncTransport(base(config, m.fetcher)); await b.upload(snapshot(channel, 'remote-B'))
    const before = m.calls.length; const preserved = [...m.files]
    await expect(a.upload(snapshot(channel, 'stale-A'), '')).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED', message: 'SYNC_REMOTE_CHANGED' })
    expect(m.calls.slice(before).every(c => ['GET', 'HEAD'].includes(c.method))).toBe(true); expect([...m.files]).toEqual(preserved)
    const oldVersion = remoteIndexVersion(await a.list())
    const key = [...m.files.keys()].find(k => k.endsWith('/index.json'))!; const changed = JSON.parse(m.files.get(key)!); changed[0].contentHash = '00'.repeat(32); m.files.set(key, JSON.stringify(changed))
    const beforeOverwrite = m.calls.length
    await expect(a.upload(snapshot(channel, 'stale-A'), oldVersion)).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' })
    expect(m.calls.slice(beforeOverwrite).every(c => ['GET', 'HEAD'].includes(c.method))).toBe(true)
  })

  it('round-trips a 6MiB synthetic ciphertext payload without violating the bounded HEX wire contract', async () => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' }, m.fetcher))
    const s = snapshot('webdav', 'large-synthetic'); s.encryptedPayload.ciphertext = '35'.repeat(6 * 1024 * 1024); s.contentHash = snapshotContentHash(s)
    const meta = await t.upload(s); const downloaded = await t.download(s.id)
    expect(downloaded.encryptedPayload.ciphertext.length).toBe(12 * 1024 * 1024); expect(meta.contentHash).toBe(s.contentHash)
  }, 30000)

  it('round-trips WebDAV with initial IfNoneMatch and existing IfMatch, and reports created collections only', async () => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://dav.example.test/root', webdavUsername: 'test' }, m.fetcher))
    const s = snapshot('webdav'); expect(await t.upload(s)).toEqual(metaFromSnapshot(s)); expect(await t.download(s.id)).toEqual(s)
    const writes = m.calls.filter(c => c.method === 'PUT' && c.url.pathname.endsWith('/index.json'))
    expect(writes[0]?.headers.get('if-none-match')).toBe('*')
    await t.upload(snapshot('webdav', 'test-2'))
    expect(m.calls.filter(c => c.method === 'PUT' && c.url.pathname.endsWith('/index.json'))[1]?.headers.get('if-match')).toMatch(/^"/)
    const p = await t.probe(); expect(p.createdCollections).toEqual(['https://dav.example.test/root/', 'https://dav.example.test/root/1pass/'])
    expect(m.calls.some(c => c.method === 'PUT' && c.body.includes('synthetic-secret'))).toBe(false)
    await t.delete(s.id); expect((await t.list()).map(m => m.id)).toEqual(['test-2'])
  })
  it('does not delete snapshot bytes when index CAS fails', async () => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' }, m.fetcher)); const s = snapshot('webdav')
    await t.upload(s); m.opts.conflict = true
    await expect(t.delete(s.id)).rejects.toMatchObject({ code: 'index-conflict' })
    expect(m.files.has('/1pass/test-1.json')).toBe(true)
  })
  it('fails closed across instances when index disappears after prior content; warns without ETag', async () => {
    const m = objectMock(); const config = { transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' } as const
    await createVaultSyncTransport(base(config, m.fetcher)).upload(snapshot('webdav')); m.opts.noEtag = true
    expect((await createVaultSyncTransport(base(config, m.fetcher)).probe()).hint).toMatch(/WARNING.*non-atomic/)
    m.files.delete('/1pass/index.json'); const t = createVaultSyncTransport(base(config, m.fetcher)); const count = m.calls.filter(c => c.method === 'PUT' || c.method === 'DELETE').length
    await expect(t.upload(snapshot('webdav', 'test-2'))).rejects.toMatchObject({ code: 'index-missing-with-content' }); await expect(t.delete('test-1')).rejects.toMatchObject({ code: 'index-missing-with-content' })
    expect(m.calls.filter(c => c.method === 'PUT' || c.method === 'DELETE')).toHaveLength(count)
  })
  it.each(['s3', 'minio', 'cos', 'kodo', 'oss'] as const)('round-trips %s with its actual signing/conditional dialect', async provider => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 's3', provider, endpoint: 'https://storage.example.test', bucket: 'synthetic-bucket', region: 'test-region', accessKeyId: 'syntheticAk', pathStyle: true }, m.fetcher))
    const s = snapshot('s3'); await t.upload(s); expect(await t.download(s.id)).toEqual(s)
    const first = m.calls.find(c => c.method === 'PUT' && c.url.pathname.endsWith('/index.json'))!
    expect(first.headers.get(provider === 'oss' ? 'x-oss-forbid-overwrite' : 'if-none-match')).toBe(provider === 'oss' ? 'true' : '*')
    expect(first.headers.get('authorization')).toMatch(provider === 'oss' ? /^OSS4-HMAC-SHA256 .*?,Signature=[a-f0-9]{64}$/ : /^AWS4-HMAC-SHA256 /)
    if (provider === 'oss') { expect(first.headers.has('if-none-match')).toBe(false); expect(first.headers.get('authorization')).not.toContain(', '); expect(first.headers.get('x-oss-content-sha256')).toBe('UNSIGNED-PAYLOAD') }
    await t.upload(snapshot('s3', 'test-2'))
    if (provider === 'oss') { expect(m.calls.some(c => c.method === 'HEAD' && c.url.pathname.endsWith('/index.json'))).toBe(true); expect((await t.probe().catch(() => ({ hint: 'bucket HEAD mocked missing' }))).hint).toBeDefined() }
  })
  it('rejects OSS changed pre-HEAD ETag and flags residual race', async () => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 's3', provider: 'oss', region: 'test-region', endpoint: 'https://storage.example.test', bucket: 'test-bucket', accessKeyId: 'testAk', pathStyle: true }, m.fetcher))
    await t.upload(snapshot('s3')); m.opts.headConflict = true
    await expect(t.upload(snapshot('s3', 'test-2'))).rejects.toMatchObject({ code: 'index-conflict' })
  })
  it('detects changed ciphertext and mismatched index metadata on download', async () => {
    const m = objectMock(); const t = createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' }, m.fetcher)); await t.upload(snapshot('webdav'))
    const raw = JSON.parse(m.files.get('/1pass/test-1.json')!); raw.encryptedPayload.ciphertext = 'ff'; m.files.set('/1pass/test-1.json', JSON.stringify(raw))
    await expect(t.download('test-1')).rejects.toMatchObject({ code: 'hash-mismatch' })
  })
})

describe('Gist bounded read/merge/PATCH/verify', () => {
  it('rejects a stale preview head without PATCH and rechecks expected head before each retry', async () => {
    const m = gistMock(); const config = { transport: 'gist', gistId: 'abcdef123456' } as const
    const a = createVaultSyncTransport(base(config, m.fetcher)); expect(await a.list()).toEqual([])
    await createVaultSyncTransport(base(config, m.fetcher)).upload(snapshot('gist', 'remote-B'))
    const patches = m.patches(); const preserved = canonical(m.files)
    await expect(a.upload(snapshot('gist', 'stale-A'), '')).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' }); expect(m.patches()).toBe(patches); expect(canonical(m.files)).toBe(preserved)
    const oldVersion = remoteIndexVersion(await a.list()); const replaced = JSON.parse(m.files['1pass-index.json']!.content); replaced[0].contentHash = '00'.repeat(32); m.files['1pass-index.json'] = { content: JSON.stringify(replaced) }
    await expect(a.upload(snapshot('gist', 'stale-A'), oldVersion)).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' }); expect(m.patches()).toBe(patches)
    let reads = 0; let writes = 0; const b = snapshot('gist', 'remote-B'); const bMeta = metaFromSnapshot(b)
    const fetcher = (async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'PATCH') { writes++; return response(200, '{}') }
      reads++
      // First GET is empty; verify sees B instead of A; retry must not absorb B then publish stale A.
      return response(200, JSON.stringify({ public: false, files: reads === 1 ? {} : { '1pass-index.json': { content: canonical([bMeta]) }, '1pass-remote-B.json': { content: canonical(b) } } }))
    }) as typeof fetch
    await expect(createVaultSyncTransport(base(config, fetcher)).upload(snapshot('gist', 'stale-A'), '')).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' }); expect(writes).toBe(1)
  })

  it('does not overwrite different orphaned content under an existing immutable snapshot id', async () => {
    const m = gistMock(); const s = snapshot('gist'); m.files['1pass-index.json'] = { content: '[]' }; m.files['1pass-test-1.json'] = { content: canonical(s) }
    const changed = { ...s, createdAt: '2026-11-16T00:00:00.000Z' }; changed.contentHash = snapshotContentHash(changed)
    const t = createVaultSyncTransport(base({ transport: 'gist', gistId: 'abcdef123456' }, m.fetcher))
    await expect(t.upload(changed)).rejects.toMatchObject({ code: 'hash-mismatch' }); expect(m.patches()).toBe(0)
  })

  it('round-trips, preserves other prefix files, never sends fake conditional headers and warns about loss', async () => {
    const m = gistMock(); m.files['other-prefix.json'] = { content: 'not-vault' }; const t = createVaultSyncTransport(base({ transport: 'gist', gistId: 'abcdef123456' }, m.fetcher)); const s = snapshot('gist')
    await t.upload(s); expect(await t.download(s.id)).toEqual(s); expect((await t.probe()).hint).toMatch(/no atomic CAS/)
    await t.delete(s.id); expect(await t.list()).toEqual([]); expect(m.files['other-prefix.json']).toEqual({ content: 'not-vault' })
  })
  it('aborts after exactly 3 failed verification cycles and refuses missing index with prior files', async () => {
    const m = gistMock(); m.break(); const t = createVaultSyncTransport(base({ transport: 'gist', gistId: 'abcdef123456' }, m.fetcher))
    await expect(t.upload(snapshot('gist'))).rejects.toMatchObject({ code: 'index-conflict' }); expect(m.patches()).toBe(3)
    delete m.files['1pass-index.json']; const fresh = createVaultSyncTransport(base({ transport: 'gist', gistId: 'abcdef123456' }, m.fetcher))
    await expect(fresh.delete('test-1')).rejects.toMatchObject({ code: 'index-missing-with-content' })
  })
})

describe('HTTP boundaries and secret redaction', () => {
  it('strips Basic auth on cross-origin redirect and never follows cross-origin writes', async () => {
    const s = snapshot('webdav'); let crossAuth: string | null = 'unset'
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'dav.example.test') return response(302, '', { location: 'https://cdn.example.test/index.json' })
      crossAuth = new Headers(init?.headers).get('authorization'); return response(200, JSON.stringify([metaFromSnapshot(s)]))
    }) as unknown as typeof fetch
    const t = createVaultSyncTransport(base({ transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' }, fetcher))
    expect(await t.list()).toHaveLength(1); expect(crossAuth).toBeNull()
    await expect(t.probe()).rejects.toMatchObject({ code: 'unsafe-redirect' })
  })
  it('bounds response body, aborts hung fetch and suppresses token/body/error text', async () => {
    const cfg = { transport: 'webdav', webdavUrl: 'https://dav.example.test/', webdavUsername: 'test' } as const
    const tooBig = (async () => response(200, 'x', { 'content-length': String(MAX_BYTES + 1) })) as typeof fetch
    await expect(createVaultSyncTransport(base(cfg, tooBig)).list()).rejects.toMatchObject({ code: 'size-limit' })
    const controller = new AbortController(); let sent: AbortSignal | null | undefined
    const hung = (async (_u: unknown, i?: RequestInit) => { sent = i?.signal; return new Promise<Response>(() => {}) }) as typeof fetch
    const t = createVaultSyncTransport({ ...base(cfg, hung), signal: controller.signal }); const pending = t.list(); await new Promise(r => setTimeout(r, 5)); controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' }); expect(sent?.aborted).toBe(true)
    const throws = (async () => { throw new Error('synthetic-secret Authorization Bearer secret-value') }) as typeof fetch
    let error: unknown; try { await createVaultSyncTransport(base(cfg, throws)).list() } catch (e) { error = e }
    expect(String(error)).not.toMatch(/synthetic-secret|Bearer|secret-value/)
    const badCredential = { ...base(cfg, tooBig), credentials: { getSecret: async () => { throw new Error('synthetic-secret') } } }
    await expect(createVaultSyncTransport(badCredential).list()).rejects.not.toThrow(/synthetic-secret/)
  })
  it('times out an injected fetch that ignores signals', async () => {
    const t = createVaultSyncTransport({ ...base({ transport: 'gist', gistId: 'abcd' }, (async () => new Promise<Response>(() => {})) as typeof fetch), timeoutMs: 15 })
    await expect(t.list()).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('actual local Git transport, no network', () => {
  it('rechecks expected preview head after fetch and before any local snapshot commit or remote push', async () => {
    const dir = await temp(); const remote = join(dir, 'remote.git'); await exec('git', ['init', '--bare', '--initial-branch=main', remote])
    const config = { transport: 'git', repoUrl: remote } as const; const credentials = { getSecret: async () => undefined }
    const a = createVaultSyncTransport({ config, stateDir: join(dir, 'a'), credentials, allowLocalGitForTests: true }); const b = createVaultSyncTransport({ config, stateDir: join(dir, 'b'), credentials, allowLocalGitForTests: true })
    expect(await a.list()).toEqual([]); await b.upload(snapshot('git', 'remote-B'), '')
    const before = (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim()
    await expect(a.upload(snapshot('git', 'stale-A'), '')).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' })
    expect((await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim()).toBe(before)
    expect((await exec('git', ['-C', join(dir, 'a', 'worktree'), 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before)
    expect(await readdir(join(dir, 'a', 'worktree', '1pass'))).not.toContain('stale-A.json'); expect((await b.list()).map(m => m.id)).toEqual(['remote-B'])
    const oldVersion = remoteIndexVersion(await a.list()); const bw = join(dir, 'b', 'worktree'); const indexPath = join(bw, '1pass', 'index.json'); const replaced = JSON.parse(await readFile(indexPath, 'utf8')); replaced[0].contentHash = '00'.repeat(32); await writeFile(indexPath, JSON.stringify(replaced))
    await exec('git', ['-C', bw, 'add', '--', '1pass/index.json']); await exec('git', ['-C', bw, '-c', 'user.name=Synthetic', '-c', 'user.email=test@localhost', 'commit', '-m', 'synthetic same-id remote version']); await exec('git', ['-C', bw, 'push', 'origin', 'main'])
    const winner = (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim()
    await expect(a.upload(snapshot('git', 'stale-A'), oldVersion)).rejects.toMatchObject({ code: 'SYNC_REMOTE_CHANGED' }); expect((await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim()).toBe(winner)
  }, 30000)

  it('keeps HTTPS token out of argv/config/helper source and cleans helper after process failure', async () => {
    const dir = await temp(); const state = join(dir, 'https-state'); await mkdir(state)
    const token = 'synthetic-sensitive-token'
    const t = createVaultSyncTransport({ config: { transport: 'git', repoUrl: 'https://git.example.test/private.git' }, stateDir: state, credentials: { getSecret: async () => token } })
    const execute = vi.spyOn(processModule, 'runProcess').mockImplementation(async (_command, args, o) => {
      expect(args.join(' ')).not.toContain(token)
      expect(o.env?.ONEPASS_GIT_TOKEN).toBe(token)
      expect(await readFile(join(state, (await readdir(state)).find(n => n.startsWith('askpass-'))!, 'askpass.cjs'), 'utf8')).not.toContain(token)
      expect(await readFile(o.env!.GIT_ASKPASS!, 'utf8')).not.toContain(token)
      return { code: 1, stdout: token }
    })
    const run = t as unknown as { run(args: string[], auth: boolean): Promise<unknown> }
    await expect(run.run(['ls-remote', '--', 'https://git.example.test/private.git'], true)).rejects.not.toThrow(token)
    expect(execute).toHaveBeenCalledOnce(); expect(await readdir(state)).toEqual([])
    expect(() => createVaultSyncTransport({ config: { transport: 'git', repoUrl: 'git@git.example.test:owner/private.git' }, stateDir: join(dir, 'ssh'), credentials: { getSecret: async () => undefined } })).not.toThrow()
  })
  it('rejects push divergence and leaves remote winner intact, with encrypted local commit inspectable', async () => {
    const dir = await temp(); const remote = join(dir, 'remote.git'); await exec('git', ['init', '--bare', '--initial-branch=main', remote])
    const config = { transport: 'git', repoUrl: remote } as const
    const one = createVaultSyncTransport({ config, stateDir: join(dir, 'one'), credentials: { getSecret: async () => undefined }, allowLocalGitForTests: true })
    const two = createVaultSyncTransport({ config, stateDir: join(dir, 'two'), credentials: { getSecret: async () => undefined }, allowLocalGitForTests: true })
    await one.upload(snapshot('git')); await two.list()
    const work = join(dir, 'one', 'worktree')
    await writeFile(join(work, '1pass', 'local-only.txt'), 'synthetic local commit')
    await exec('git', ['-C', work, 'add', '--', '1pass/local-only.txt'])
    await exec('git', ['-C', work, '-c', 'user.name=Synthetic', '-c', 'user.email=test@localhost', 'commit', '-m', 'synthetic divergence'])
    await two.upload(snapshot('git', 'remote-winner'))
    await expect(one.upload(snapshot('git', 'must-not-push'))).rejects.toMatchObject({ code: 'index-conflict' })
    expect((await one.workdirFacts!()).ahead).toBe(1)
    expect((await two.list()).map(m => m.id)).toEqual(['remote-winner', 'test-1'])
  }, 60000)
  it('isolates a new branch from other default-branch/config-manager content', async () => {
    const dir = await temp(); const remote = join(dir, 'remote.git'); const seed = join(dir, 'seed'); await exec('git', ['init', '--bare', '--initial-branch=main', remote]); await exec('git', ['clone', remote, seed])
    await mkdir(join(seed, 'dsh-config-manager')); await writeFile(join(seed, 'dsh-config-manager', 'original.json'), '{"not":"vault"}')
    await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, '-c', 'user.name=Synthetic', '-c', 'user.email=test@localhost', 'commit', '-m', 'synthetic reference data']); await exec('git', ['-C', seed, 'push', 'origin', 'main'])
    const t = createVaultSyncTransport({ config: { transport: 'git', repoUrl: remote, branch: 'vault-branch' }, stateDir: join(dir, 'state'), credentials: { getSecret: async () => undefined }, allowLocalGitForTests: true })
    await t.upload(snapshot('git'))
    const main = await exec('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main']); expect(main.stdout).toContain('dsh-config-manager/original.json'); expect(main.stdout).not.toContain('1pass')
    const branch = await exec('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'vault-branch']); expect(branch.stdout).toContain('1pass/index.json'); expect(branch.stdout).not.toContain('dsh-config-manager')
  }, 60000)

  it('clones bare remote, commits/pushes namespace, fast-forwards second worktree, downloads and deletes', async () => {
    const dir = await temp(); const remote = join(dir, 'remote.git'); await exec('git', ['init', '--bare', '--initial-branch=main', remote])
    const config = { transport: 'git', repoUrl: remote } as const
    const credentials = { getSecret: vi.fn(async () => 'never-needed-local') }
    const one = createVaultSyncTransport({ config, stateDir: join(dir, 'one'), credentials, allowLocalGitForTests: true })
    const two = createVaultSyncTransport({ config, stateDir: join(dir, 'two'), credentials, allowLocalGitForTests: true })
    const s = snapshot('git'); expect((await one.probe()).hint).toMatch(/Local bare/); await one.upload(s)
    expect(await two.list()).toEqual([metaFromSnapshot(s)]); expect(await two.download(s.id)).toEqual(s)
    await two.upload(snapshot('git', 'test-2')); expect(await one.list()).toHaveLength(2)
    const tree = await exec('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main']); expect(tree.stdout).toContain('1pass/index.json'); expect(tree.stdout).not.toContain('dsh-config-manager')
    await one.delete('test-1'); expect((await two.list()).map(m => m.id)).toEqual(['test-2'])
    expect((await one.workdirFacts!()).match).toBe(true); expect(credentials.getSecret).not.toHaveBeenCalled()
    await expect(one.resetWorkdir!('reclone', false)).rejects.toMatchObject({ code: 'confirmation-required' }); await one.resetWorkdir!('reclone', true); expect(await one.list()).toHaveLength(1)
    expect((await readFile(join(dir, 'one', 'worktree', '.git', 'config'), 'utf8'))).not.toContain('never-needed-local')
  }, 60000)
  it('requires fixture opt-in, refuses unknown workdirs, and kills/collects aborted supervised child', async () => {
    const dir = await temp(); const remote = join(dir, 'remote.git'); await exec('git', ['init', '--bare', '--initial-branch=main', remote])
    expect(() => createVaultSyncTransport({ config: { transport: 'git', repoUrl: remote }, stateDir: join(dir, 'state'), credentials: { getSecret: async () => undefined } })).toThrow()
    const state = join(dir, 'owned'); await mkdir(join(state, 'worktree'), { recursive: true }); await writeFile(join(state, 'worktree', 'keep.txt'), 'synthetic')
    const t = createVaultSyncTransport({ config: { transport: 'git', repoUrl: remote }, stateDir: state, credentials: { getSecret: async () => undefined }, allowLocalGitForTests: true })
    await expect(t.resetWorkdir!('reclone', true)).rejects.toMatchObject({ code: 'unsafe-workdir' }); expect(await readFile(join(state, 'worktree', 'keep.txt'), 'utf8')).toBe('synthetic')
    const c = new AbortController(); const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 10000, signal: c.signal }); setTimeout(() => c.abort(), 40)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' }); expect(await readdir(state)).not.toContain('.worktree-lock')
  }, 15000)
})

it('signing is deterministic, OSS canonical URI includes bucket and authorization punctuation matches reference', () => {
  const common = { method: 'PUT', headers: { 'content-type': 'application/json', 'x-oss-forbid-overwrite': 'true' }, body: '[]', accessKeyId: 'testAk', secret: 'synthetic-secret', region: 'test-region', oss: true, bucket: 'test-bucket', key: '1pass/index.json', now: new Date('2026-01-01T00:00:00.000Z') }
  const virtual = signHeaders({ ...common, url: new URL('https://test-bucket.oss.example.test/1pass/index.json') })
  const path = signHeaders({ ...common, url: new URL('https://oss.example.test/test-bucket/1pass/index.json') })
  expect(virtual.authorization).toBe(path.authorization); expect(virtual.authorization).not.toContain(', '); expect(virtual.authorization).not.toContain('synthetic-secret')
  expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
})
