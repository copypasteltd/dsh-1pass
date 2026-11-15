import { afterEach, expect, test, vi } from 'vitest'
import { DEFAULT_GITHUB_CLIENT_ID, VaultSyncGitHub } from '../src/cloud-sync/github.ts'
import type { SyncSecretPort } from '../src/cloud-sync/config.ts'

const clients: VaultSyncGitHub[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())); vi.useRealTimers() })
const device = { device_code: 'synthetic-host-only-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const repo = (name = 'vault', privateRepo = true) => ({ full_name: 'tester/'+name, html_url: 'https://github.com/tester/'+name, clone_url: 'https://github.com/tester/'+name+'.git', default_branch: 'main', private: privateRepo, fork: false, pushed_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T12:00:00Z', secretExtra: 'discard-provider-extras' })
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(responses: Array<Response | (() => Promise<Response>)> = [], options: { clientId?: string; authorize?: () => void } = {}) {
  const values = new Map<string, string>()
  const secrets: SyncSecretPort = {
    get: vi.fn(async ref => values.get(ref)), has: vi.fn(async ref => values.has(ref)),
    set: vi.fn(async (ref, value) => { values.set(ref, value) }), unset: vi.fn(async ref => { values.delete(ref) }),
  }
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const response = responses.shift()
    if (!response) throw new Error('unexpected-network-call-with-raw-secret')
    return typeof response === 'function' ? response() : response
  })
  let now = 100000
  const client = new VaultSyncGitHub({ secrets, credentialRef: 'synthetic-ref', fetch: fetcher as typeof fetch, now: () => now, ...options })
  clients.push(client)
  return { client, secrets, values, fetcher, advance: (ms = 5000) => { now += ms }, responses }
}

test('device start matches wire, verified public app ID, no auth/code echo, and respects initial polling interval', async () => {
  const { client, secrets, fetcher } = fixture([json(device)])
  const start = await client.start()
  expect(start).toEqual({ flowId: expect.any(String), userCode: device.user_code, verificationUri: device.verification_uri, expiresIn: 900, interval: 5 })
  expect(JSON.stringify(start)).not.toContain(device.device_code)
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://github.com/login/device/code')
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
  expect(new URLSearchParams(init.body as string).get('client_id')).toBe(DEFAULT_GITHUB_CLIENT_ID)
  expect(new URLSearchParams(init.body as string).get('scope')).toBe('repo')
  expect(await client.poll(start.flowId)).toEqual({ status: 'pending', pollDelayMs: 5000 })
  expect(fetcher).toHaveBeenCalledTimes(1); expect(secrets.set).not.toHaveBeenCalled()
})

test('pending and slow_down honor new minimum interval; success stores token only in secret port', async () => {
  const { client, values, fetcher, advance } = fixture([json(device), json({ error: 'authorization_pending', error_description: 'do-not-echo-provider-text' }), json({ error: 'slow_down' }), json({ access_token: 'synthetic-access-token', token_type: 'bearer' })])
  const start = await client.start()
  advance()
  expect(await client.poll(start.flowId)).toEqual({ status: 'pending', pollDelayMs: 5000 })
  advance()
  expect(await client.poll(start.flowId)).toEqual({ status: 'pending', pollDelayMs: 10000 })
  advance()
  expect(await client.poll(start.flowId)).toEqual({ status: 'pending', pollDelayMs: 5000 })
  expect(fetcher).toHaveBeenCalledTimes(3)
  advance()
  const wire = await client.poll(start.flowId)
  expect(wire).toEqual({ status: 'success', credentialConfigured: true })
  expect(values.get('synthetic-ref')).toBe('synthetic-access-token')
  expect(JSON.stringify(wire)).not.toContain('synthetic-access-token')
  expect(await client.poll(start.flowId)).toMatchObject({ status: 'expired' })
})

test.each([
  ['access_denied', 'denied'], ['expired_token', 'expired'], ['arbitrary-provider-error-with-secret', 'error'],
])('only allowlisted device terminal errors are projected: %s', async (error, status) => {
  const { client, secrets, advance } = fixture([json(device), json({ error, error_description: 'synthetic-provider-secret' })])
  const start = await client.start(); advance()
  const result = await client.poll(start.flowId)
  expect(result.status).toBe(status)
  expect(JSON.stringify(result)).not.toContain('synthetic-provider-secret')
  expect(JSON.stringify(result)).not.toContain('arbitrary-provider-error')
  expect(secrets.set).not.toHaveBeenCalled()
})

test('device flow expires by local TTL and missing flow is expired without network', async () => {
  const { client, fetcher, advance } = fixture([json(device)])
  const start = await client.start(); advance(900000)
  expect(await client.poll(start.flowId)).toEqual({ status: 'expired', errorCode: 'expired_token' })
  expect(await client.poll('unknown')).toEqual({ status: 'expired', errorCode: 'expired_token' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('cancelled pending polls cannot save a token even if upstream ignores abort and replies late', async () => {
  const late = deferred<Response>()
  const { client, secrets, advance } = fixture([json(device), () => late.promise])
  const start = await client.start(); advance()
  const poll = client.poll(start.flowId)
  await client.cancel(start.flowId)
  late.resolve(json({ access_token: 'late-token-must-not-save' }))
  expect(await poll).toMatchObject({ status: 'expired' })
  expect(secrets.set).not.toHaveBeenCalled()
})

test('poll concurrency coalesces one exchange and disposal prevents later polling', async () => {
  const late = deferred<Response>()
  const { client, fetcher, advance } = fixture([json(device), () => late.promise])
  const start = await client.start(); advance()
  const one = client.poll(start.flowId), two = client.poll(start.flowId)
  expect(fetcher).toHaveBeenCalledTimes(2)
  late.resolve(json({ access_token: 'synthetic-value' }))
  expect(await one).toMatchObject({ status: 'success' }); expect(await two).toMatchObject({ status: 'success' })
  await client.dispose()
  await expect(client.start()).rejects.toThrow('GITHUB_DISPOSED')
  await expect(client.poll(start.flowId)).rejects.toThrow('GITHUB_DISPOSED')
})

test('cancellation during an in-flight credential write waits for and restores prior token', async () => {
  const write = deferred<void>()
  const { client, values, secrets, advance } = fixture([json(device), json({ access_token: 'new-synthetic-value' })])
  values.set('synthetic-ref', 'old-synthetic-value')
  secrets.set = vi.fn(async (ref, value) => { if (value === 'new-synthetic-value') await write.promise; values.set(ref, value) })
  const start = await client.start(); advance()
  const poll = client.poll(start.flowId)
  await vi.waitFor(() => expect(secrets.set).toHaveBeenCalled())
  let cancelled = false
  const cancel = client.cancel(start.flowId).then(() => { cancelled = true })
  expect(cancelled).toBe(false)
  write.resolve()
  await cancel
  expect(await poll).toMatchObject({ status: 'expired' })
  expect(values.get('synthetic-ref')).toBe('old-synthetic-value')
})

test('credential set that applies then rejects is rolled back without exposing raw errors', async () => {
  const { client, values, secrets, advance } = fixture([json(device), json({ access_token: 'synthetic-new-token' })])
  values.set('synthetic-ref', 'synthetic-old-token')
  secrets.set = vi.fn(async (ref, value) => {
    values.set(ref, value)
    if (value === 'synthetic-new-token') throw new Error('raw-auth-error')
  })
  const start = await client.start(); advance()
  await expect(client.poll(start.flowId)).rejects.toThrow('GITHUB_CREDENTIAL_WRITE_FAILED')
  expect(values.get('synthetic-ref')).toBe('synthetic-old-token')
})

test('simultaneous device flows cannot clobber a successful token through another flow cancellation rollback', async () => {
  const gate = deferred<void>()
  const { client, secrets, values, advance } = fixture([json(device), json(device), json({ access_token: 'cancelled-token' }), json({ access_token: 'successful-token' })])
  secrets.set = vi.fn(async (ref, value) => { if (value === 'cancelled-token') await gate.promise; values.set(ref, value) })
  const first = await client.start(), second = await client.start(); advance()
  const firstPoll = client.poll(first.flowId), secondPoll = client.poll(second.flowId)
  await vi.waitFor(() => expect(secrets.set).toHaveBeenCalledWith('synthetic-ref', 'cancelled-token'))
  const cancellation = client.cancel(first.flowId)
  gate.resolve()
  await cancellation
  expect(await firstPoll).toMatchObject({ status: 'expired' })
  expect(await secondPoll).toMatchObject({ status: 'success' })
  expect(values.get('synthetic-ref')).toBe('successful-token')
})

test('HTTP body readers are canceled when the deadline is reached', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
  const { client } = fixture([response])
  const rejected = expect(client.start()).rejects.toThrow('GITHUB_REQUEST_TIMEOUT')
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
  expect(cancel).toHaveBeenCalled()
})

test('revoke invalidates a late pending poll and permits a new explicit device login', async () => {
  const late = deferred<Response>()
  const { client, secrets, advance, responses } = fixture([json(device), () => late.promise])
  const start = await client.start(); advance()
  const pending = client.poll(start.flowId)
  client.revoke()
  late.resolve(json({ access_token: 'late-revoked-token' }))
  expect(await pending).toMatchObject({ status: 'expired' })
  expect(secrets.set).not.toHaveBeenCalled()
  responses.push(json(device))
  expect((await client.start()).flowId).not.toBe(start.flowId)
})

test('GitHub authorization is rechecked before token writes and failures never expose raw details', async () => {
  let allowed = true
  const { client, secrets, values, advance } = fixture([json(device), json({ access_token: 'denied-token' })], { authorize: () => { if (!allowed) throw new Error('sensitive-locked-reason') } })
  const start = await client.start(); advance()
  allowed = false
  await expect(client.poll(start.flowId)).rejects.toThrow('GITHUB_NOT_AUTHORIZED')
  expect(secrets.set).not.toHaveBeenCalled(); expect(values.size).toBe(0)
})

test('revocation while credential write is pending restores prior token even without cancel await', async () => {
  const gate = deferred<void>()
  const { client, values, secrets, advance } = fixture([json(device), json({ access_token: 'revoked-token' })])
  values.set('synthetic-ref', 'prior-token')
  secrets.set = vi.fn(async (ref, value) => { if (value === 'revoked-token') await gate.promise; values.set(ref, value) })
  const start = await client.start(); advance()
  const poll = client.poll(start.flowId)
  await vi.waitFor(() => expect(secrets.set).toHaveBeenCalled())
  client.revoke(); gate.resolve()
  expect(await poll).toMatchObject({ status: 'expired' })
  expect(values.get('synthetic-ref')).toBe('prior-token')
})

test('missing client ID is unavailable without invented app and starts are bounded', async () => {
  const missing = fixture([], { clientId: '' })
  await expect(missing.client.start()).rejects.toThrow('GITHUB_DEVICE_FLOW_UNAVAILABLE')
  expect(missing.fetcher).not.toHaveBeenCalled()
  const bounded = fixture(Array.from({ length: 8 }, () => json(device)))
  await Promise.all(Array.from({ length: 8 }, () => bounded.client.start()))
  await expect(bounded.client.start()).rejects.toThrow('GITHUB_TOO_MANY_FLOWS')
})

test.each([
  { ...device, verification_uri: 'https://evil.test/login/device' },
  { ...device, verification_uri: 'https://github.com/login/device?token=secret' },
  { ...device, verification_uri: 'https://user:pass@github.com/login/device' },
  { ...device, expires_in: 999999999 }, { ...device, interval: -1 },
])('malformed device responses fail closed and never save secrets: %j', async raw => {
  const { client, secrets } = fixture([json(raw)])
  await expect(client.start()).rejects.toThrow('GITHUB_INVALID_RESPONSE')
  expect(secrets.set).not.toHaveBeenCalled()
})

test('validate returns only configured/valid/login and differentiates invalid auth from upstream failure', async () => {
  const { client, values, fetcher } = fixture([json({ message: 'provider-secret' }, 401), json({ login: 'tester', secret: 'must-discard' }), json({ message: 'private-error' }, 403)])
  expect(await client.validate()).toEqual({ ok: true, configured: false, valid: false })
  expect(fetcher).not.toHaveBeenCalled()
  values.set('synthetic-ref', 'synthetic-token')
  expect(await client.validate()).toEqual({ ok: true, configured: true, valid: false })
  expect(await client.validate()).toEqual({ ok: true, configured: true, valid: true, login: 'tester' })
  await expect(client.validate()).rejects.toThrow('GITHUB_VALIDATE_FAILED')
  const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token')
})

test('list requires auth, paginates fixed trusted URLs and projects private repositories only', async () => {
  const first = Array.from({ length: 100 }, (_, i) => repo('repo-'+i, i !== 99))
  const { client, values, fetcher } = fixture([json(first), json([repo('last'), repo('public', false)])])
  await expect(client.listRepositories()).rejects.toThrow('GITHUB_AUTH_REQUIRED')
  values.set('synthetic-ref', 'synthetic-token')
  const result = await client.listRepositories()
  expect(result.ok).toBe(true); expect(result.repos).toHaveLength(100)
  expect(result.repos.every(item => item.private)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('secretExtra')
  expect(JSON.stringify(result)).not.toContain('synthetic-token')
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([expect.stringMatching(/^https:\/\/api.github.com\/user\/repos\?.*page=1$/), expect.stringMatching(/page=2$/)])
})

test('repository listing limit fails explicitly rather than silently reporting truncation', async () => {
  const { client, values, fetcher } = fixture(Array.from({ length: 10 }, () => json(Array.from({ length: 100 }, (_, i) => repo('repo-'+i)))))
  values.set('synthetic-ref', 'synthetic-token')
  await expect(client.listRepositories()).rejects.toThrow('GITHUB_REPOSITORIES_LIMIT_EXCEEDED')
  expect(fetcher).toHaveBeenCalledTimes(10)
})

test('create always sends private:true, ignores provider extra fields, and validates full input before I/O', async () => {
  const { client, values, fetcher } = fixture([json(repo(), 201)])
  values.set('synthetic-ref', 'synthetic-token')
  for (const [name, description] of [['../escape', ''], ['--flag', ''], ['okay', 'bad\ntext']]) await expect(client.createRepository(name!, description)).rejects.toThrow(/GITHUB_REPOSITORY_(NAME|DESCRIPTION)_INVALID/)
  expect(fetcher).not.toHaveBeenCalled()
  const result = await client.createRepository('vault', ' private vault ')
  expect(result).toMatchObject({ ok: true, repo: { fullName: 'tester/vault', private: true } })
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.github.com/user/repos')
  expect(JSON.parse(init.body as string)).toEqual({ name: 'vault', description: 'private vault', private: true })
  expect(JSON.stringify(result)).not.toContain('discard-provider-extras')
})

test('public or credential-bearing create response is refused, and raw upstream errors never leak', async () => {
  const { client, values } = fixture([json(repo('public', false), 201), json({ ...repo(), clone_url: 'https://user:secret@github.com/tester/vault.git' }, 201), json({ message: 'provider-raw-secret' }, 422)])
  values.set('synthetic-ref', 'synthetic-token')
  await expect(client.createRepository('public')).rejects.toThrow('GITHUB_PRIVATE_REPOSITORY_REQUIRED')
  await expect(client.createRepository('vault')).rejects.toThrow('GITHUB_INVALID_RESPONSE')
  await expect(client.createRepository('vault')).rejects.toThrow('GITHUB_REPOSITORY_CREATE_REJECTED')
})

test('HTTP errors, invalid JSON and thrown fetch exceptions expose only fixed codes', async () => {
  const { client } = fixture([() => Promise.reject(new Error('raw-authorization-secret')), new Response('{broken'), json({ error_description: 'raw-provider-secret' }, 400)])
  await expect(client.start()).rejects.toThrow('GITHUB_REQUEST_FAILED')
  await expect(client.start()).rejects.toThrow('GITHUB_REQUEST_FAILED')
  await expect(client.start()).rejects.toThrow('GITHUB_DEVICE_FLOW_UNAVAILABLE')
})

test('HTTP is bounded to 10 seconds even if fetch ignores AbortSignal', async () => {
  vi.useFakeTimers()
  const { client } = fixture([() => new Promise<Response>(() => {})])
  const pending = client.start()
  const rejection = expect(pending).rejects.toThrow('GITHUB_REQUEST_TIMEOUT')
  await vi.advanceTimersByTimeAsync(10000)
  await rejection
})

test('HTTP response is bounded to 2 MiB both with declared length and streaming chunks', async () => {
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1)
  const { client } = fixture([new Response('{}', { headers: { 'content-length': '2097153' } }), new Response(huge)])
  await expect(client.start()).rejects.toThrow('GITHUB_RESPONSE_TOO_LARGE')
  await expect(client.start()).rejects.toThrow('GITHUB_RESPONSE_TOO_LARGE')
})
