import { randomUUID } from 'node:crypto'
import type { SyncSecretPort } from './config.ts'

// Public OAuth app identifier, verified verbatim against dsh-config-manager/src/index.ts:208.
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'
const API = 'https://api.github.com'
const DEVICE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 10000
const MAX_FLOWS = 8
const MAX_PAGES = 10
const TOKEN = /^[\x21-\x7e]{1,16384}$/u

type PollResult = {
  status: 'pending' | 'success' | 'denied' | 'expired' | 'error'
  pollDelayMs?: number; errorCode?: string; message?: string; credentialConfigured?: boolean
}
export interface GitHubRepositorySummary {
  fullName: string; htmlUrl: string; cloneUrl: string; defaultBranch: string
  private: boolean; fork: boolean; pushedAt: string; updatedAt: string
}
interface Flow {
  deviceCode: string; expiresAt: number; intervalMs: number; nextPollAt: number
  cancelled: boolean; controller?: AbortController; pending?: Promise<PollResult>
}
export class VaultSyncGitHubError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VaultSyncGitHubError' }
}
function fail(code = 'GITHUB_INVALID_RESPONSE'): never { throw new VaultSyncGitHubError(code) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function field(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) return fail()
  return value
}
function safeUrl(value: unknown, host: string): string {
  const raw = field(value)
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || /[\\\s]/u.test(raw)) return fail()
    return parsed.href
  } catch { return fail() }
}
function summary(value: unknown): GitHubRepositorySummary {
  const raw = object(value), fullName = field(raw.full_name, 256)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) || raw.private !== true) return fail('GITHUB_PRIVATE_REPOSITORY_REQUIRED')
  const htmlUrl = safeUrl(raw.html_url, 'github.com'), cloneUrl = safeUrl(raw.clone_url, 'github.com')
  if (new URL(htmlUrl).pathname !== '/'+fullName || new URL(cloneUrl).pathname !== '/'+fullName+'.git') return fail()
  const defaultBranch = raw.default_branch === undefined || raw.default_branch === '' ? 'main' : field(raw.default_branch, 256)
  const date = (value: unknown): string => value == null || value === '' ? '' : field(value, 64)
  return { fullName, htmlUrl, cloneUrl, defaultBranch, private: true, fork: raw.fork === true, pushedAt: date(raw.pushed_at), updatedAt: date(raw.updated_at) }
}

/** GitHub-specific I/O only. Never returns a device code, access token, raw provider body or auth header. */
export class VaultSyncGitHub {
  private readonly secrets: SyncSecretPort
  private readonly credentialRef: string
  private readonly fetcher: typeof fetch
  private readonly clientId: string
  private readonly now: () => number
  private readonly authorize: (() => void) | undefined
  private readonly flows = new Map<string, Flow>()
  private readonly requests = new Set<AbortController>()
  private credentialQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private disposed = false
  constructor(options: { secrets: SyncSecretPort; credentialRef: string; fetch?: typeof fetch; clientId?: string; now?: () => number; authorize?: () => void }) {
    this.secrets = options.secrets
    this.credentialRef = options.credentialRef
    this.fetcher = options.fetch ?? globalThis.fetch
    this.clientId = options.clientId ?? DEFAULT_GITHUB_CLIENT_ID
    this.now = options.now ?? Date.now
    this.authorize = options.authorize
  }
  private checkAuthorization(): void {
    try { this.authorize?.() } catch { fail('GITHUB_NOT_AUTHORIZED') }
  }
  private alive(): void { if (this.disposed) fail('GITHUB_DISPOSED') }
  private async request(url: string, init: RequestInit, controller = new AbortController()): Promise<{ status: number; data: unknown }> {
    this.alive()
    this.requests.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const work = (async () => {
      const response = await this.fetcher(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' })
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('GITHUB_REQUEST_CANCELLED') }
      const declared = response.headers.get('content-length')
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BYTES)) { void response.body?.cancel().catch(() => {}); fail('GITHUB_RESPONSE_TOO_LARGE') }
      if (!response.ok) {
        // OAuth errors can be 400 with an allowlisted error code; API errors never expose their body.
        if (url !== TOKEN_URL && url !== DEVICE_URL) { void response.body?.cancel().catch(() => {}); return { status: response.status, data: {} } }
      }
      if (!response.body) return { status: response.status, data: {} }
      const reader = response.body.getReader(), parts: Uint8Array[] = []
      let length = 0
      const abortRead = () => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener('abort', abortRead, { once: true })
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > MAX_BYTES) fail('GITHUB_RESPONSE_TOO_LARGE')
          parts.push(chunk.value)
        }
      } finally { controller.signal.removeEventListener('abort', abortRead); void reader.cancel().catch(() => {}) }
      const bytes = Buffer.concat(parts)
      return { status: response.status, data: JSON.parse(bytes.toString('utf8')) as unknown }
    })()
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new VaultSyncGitHubError('GITHUB_REQUEST_CANCELLED'))
      if (controller.signal.aborted) abort()
      else controller.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { reject(new VaultSyncGitHubError('GITHUB_REQUEST_TIMEOUT')); controller.abort() }, TIMEOUT_MS)
    })
    try { return await Promise.race([work, interrupted]) }
    catch (error) {
      if (error instanceof VaultSyncGitHubError) throw error
      throw new VaultSyncGitHubError('GITHUB_REQUEST_FAILED')
    } finally {
      clearTimeout(timer)
      if (abort) controller.signal.removeEventListener('abort', abort)
      this.requests.delete(controller)
    }
  }
  private form(values: Record<string, string>): RequestInit {
    return { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() }
  }
  private prune(): void {
    for (const [id, flow] of this.flows) if (flow.expiresAt <= this.now()) { flow.cancelled = true; flow.controller?.abort(); this.flows.delete(id) }
  }
  async start(): Promise<{ flowId: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }> {
    this.alive()
    const generation = this.generation
    this.checkAuthorization()
    if (!this.clientId || !/^[A-Za-z0-9_.-]{1,256}$/u.test(this.clientId)) fail('GITHUB_DEVICE_FLOW_UNAVAILABLE')
    this.prune()
    if (this.flows.size + this.requests.size >= MAX_FLOWS) fail('GITHUB_TOO_MANY_FLOWS')
    const result = await this.request(DEVICE_URL, this.form({ client_id: this.clientId, scope: 'repo' }))
    this.alive()
    if (generation !== this.generation) fail('GITHUB_REVOKED')
    this.checkAuthorization()
    if (result.status !== 200) fail('GITHUB_DEVICE_FLOW_UNAVAILABLE')
    const raw = object(result.data), deviceCode = field(raw.device_code, 4096), userCode = field(raw.user_code, 64)
    const verificationUri = safeUrl(raw.verification_uri, 'github.com')
    if (new URL(verificationUri).pathname !== '/login/device' || !/^[A-Za-z0-9-]+$/u.test(userCode)) fail()
    if (typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 3600) fail()
    if (raw.interval !== undefined && (typeof raw.interval !== 'number' || !Number.isFinite(raw.interval) || raw.interval <= 0 || raw.interval > 300)) fail()
    const interval = Math.max(1, Math.ceil((raw.interval as number | undefined) ?? 5)), expiresIn = Math.floor(raw.expires_in)
    this.prune()
    if (this.flows.size >= MAX_FLOWS) fail('GITHUB_TOO_MANY_FLOWS')
    const flowId = randomUUID()
    this.flows.set(flowId, { deviceCode, expiresAt: this.now() + expiresIn * 1000, intervalMs: interval * 1000, nextPollAt: this.now() + interval * 1000, cancelled: false })
    return { flowId, userCode, verificationUri, expiresIn, interval }
  }
  async poll(flowId: string): Promise<PollResult> {
    this.alive()
    const flow = this.flows.get(flowId)
    if (!flow || flow.cancelled) return { status: 'expired', errorCode: 'expired_token' }
    if (flow.expiresAt <= this.now()) { await this.cancel(flowId); return { status: 'expired', errorCode: 'expired_token' } }
    if (flow.pending) return flow.pending
    if (this.now() < flow.nextPollAt) return { status: 'pending', pollDelayMs: Math.ceil(flow.nextPollAt - this.now()) }
    const pending = this.exchange(flowId, flow)
    flow.pending = pending
    try { return await pending } finally { delete flow.pending }
  }
  private current(id: string, flow: Flow): boolean { return !this.disposed && !flow.cancelled && this.flows.get(id) === flow && flow.expiresAt > this.now() }
  private async exchange(id: string, flow: Flow): Promise<PollResult> {
    flow.nextPollAt = this.now() + flow.intervalMs
    const controller = new AbortController()
    flow.controller = controller
    try {
      const response = await this.request(TOKEN_URL, this.form({ client_id: this.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), controller)
      if (!this.current(id, flow)) return { status: 'expired', errorCode: 'expired_token' }
      const raw = object(response.data)
      if (raw.error === 'authorization_pending' || raw.error === 'slow_down') {
        if (raw.error === 'slow_down') flow.intervalMs = Math.min(300000, flow.intervalMs + 5000)
        flow.nextPollAt = this.now() + flow.intervalMs
        return { status: 'pending', pollDelayMs: flow.intervalMs }
      }
      if (raw.error === 'access_denied') { this.flows.delete(id); return { status: 'denied', errorCode: 'access_denied' } }
      if (raw.error === 'expired_token') { this.flows.delete(id); return { status: 'expired', errorCode: 'expired_token' } }
      if (response.status !== 200 || raw.error !== undefined || typeof raw.access_token !== 'string' || !TOKEN.test(raw.access_token)) {
        this.flows.delete(id)
        return { status: 'error', errorCode: 'GITHUB_DEVICE_FLOW_FAILED', message: 'GitHub sign-in did not complete.' }
      }
      // Save only after the final cancellation/TTL check. No device code or token leaves this method.
      if (!await this.saveToken(id, flow, raw.access_token)) return { status: 'expired', errorCode: 'expired_token' }
      this.flows.delete(id)
      return { status: 'success', credentialConfigured: true }
    } catch (error) {
      if (error instanceof VaultSyncGitHubError && error.code === 'GITHUB_CREDENTIAL_ROLLBACK_FAILED') throw error
      if (!this.current(id, flow)) return { status: 'expired', errorCode: 'expired_token' }
      throw error
    } finally { delete flow.controller }
  }
  private async saveToken(id: string, flow: Flow, token: string): Promise<boolean> {
    const work = this.credentialQueue.then(async () => {
      if (!this.current(id, flow)) return false
      this.checkAuthorization()
      let old: string | undefined
      try { old = await this.secrets.get(this.credentialRef) } catch { fail('GITHUB_CREDENTIAL_READ_FAILED') }
      if (!this.current(id, flow)) return false
      const rollback = async () => {
        try { if (old === undefined) await this.secrets.unset(this.credentialRef); else await this.secrets.set(this.credentialRef, old) }
        catch { fail('GITHUB_CREDENTIAL_ROLLBACK_FAILED') }
      }
      this.checkAuthorization()
      try { await this.secrets.set(this.credentialRef, token) }
      catch { await rollback(); fail('GITHUB_CREDENTIAL_WRITE_FAILED') }
      try { this.checkAuthorization() } catch (error) { await rollback(); throw error }
      if (!this.current(id, flow)) { await rollback(); return false }
      return true
    })
    this.credentialQueue = work.then(() => {}, () => {})
    return work
  }
  async cancel(flowId: string): Promise<{ ok: true }> {
    const flow = this.flows.get(flowId)
    if (flow) {
      flow.cancelled = true
      this.flows.delete(flowId)
      flow.controller?.abort()
      // If a secret write already began, wait until its compensating rollback has finished.
      await flow.pending?.catch((error: unknown) => {
        if (error instanceof VaultSyncGitHubError && error.code === 'GITHUB_CREDENTIAL_ROLLBACK_FAILED') throw error
      })
    }
    return { ok: true }
  }
  private async token(): Promise<string | undefined> {
    this.alive()
    try {
      const token = await this.secrets.get(this.credentialRef)
      if (token !== undefined && !TOKEN.test(token)) fail('GITHUB_CREDENTIAL_INVALID')
      return token
    } catch (error) { if (error instanceof VaultSyncGitHubError) throw error; fail('GITHUB_CREDENTIAL_READ_FAILED') }
  }
  private api(token: string, extra: RequestInit = {}): RequestInit {
    return { ...extra, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer '+token, 'X-GitHub-Api-Version': '2022-11-28', ...extra.headers } }
  }
  async validate(): Promise<{ ok: boolean; configured: boolean; valid: boolean; login?: string }> {
    const token = await this.token()
    if (!token) return { ok: true, configured: false, valid: false }
    const response = await this.request(API+'/user', this.api(token))
    if (response.status === 401) return { ok: true, configured: true, valid: false }
    if (response.status !== 200) fail('GITHUB_VALIDATE_FAILED')
    const login = field(object(response.data).login, 128)
    if (!/^[A-Za-z0-9-]+$/u.test(login)) fail()
    return { ok: true, configured: true, valid: true, login }
  }
  async listRepositories(): Promise<{ ok: boolean; repos: GitHubRepositorySummary[] }> {
    const token = await this.token()
    if (!token) fail('GITHUB_AUTH_REQUIRED')
    const repos: GitHubRepositorySummary[] = [], seen = new Set<string>()
    // Fixed same-origin pages only. Ignore untrusted Link URLs so auth cannot be redirected elsewhere.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.request(API+'/user/repos?visibility=private&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page='+page, this.api(token))
      if (response.status === 401) fail('GITHUB_AUTH_REQUIRED')
      if (response.status !== 200) fail('GITHUB_REPOSITORIES_FAILED')
      if (!Array.isArray(response.data) || response.data.length > 100) fail()
      for (const raw of response.data) {
        if (object(raw).private !== true) continue
        const repo = summary(raw)
        if (!seen.has(repo.fullName)) { repos.push(repo); seen.add(repo.fullName) }
      }
      if (response.data.length < 100) return { ok: true, repos }
    }
    // Never present a truncated list as complete; the user can narrow their account permissions.
    fail('GITHUB_REPOSITORIES_LIMIT_EXCEEDED')
  }
  async createRepository(name: string, description?: string): Promise<{ ok: boolean; repo: GitHubRepositorySummary }> {
    this.alive()
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(name) || name === '.' || name === '..' || name.startsWith('-')) fail('GITHUB_REPOSITORY_NAME_INVALID')
    if (description !== undefined && (typeof description !== 'string' || description.length > 1000 || /[\x00-\x1f\x7f]/u.test(description))) fail('GITHUB_REPOSITORY_DESCRIPTION_INVALID')
    const token = await this.token()
    if (!token) fail('GITHUB_AUTH_REQUIRED')
    this.checkAuthorization()
    const response = await this.request(API+'/user/repos', this.api(token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true, ...(description?.trim() ? { description: description.trim() } : {}) }),
    }))
    if (response.status === 401) fail('GITHUB_AUTH_REQUIRED')
    if (response.status !== 201) fail(response.status === 422 ? 'GITHUB_REPOSITORY_CREATE_REJECTED' : 'GITHUB_REPOSITORY_CREATE_FAILED')
    return { ok: true, repo: summary(response.data) }
  }
  /** Revoke lock/switch/readonly-era capabilities without preventing a later explicit login. */
  revoke(): void {
    this.generation++
    for (const flow of this.flows.values()) { flow.cancelled = true; flow.controller?.abort() }
    for (const request of this.requests) request.abort()
    this.flows.clear()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.revoke()
    await this.credentialQueue
  }
}
