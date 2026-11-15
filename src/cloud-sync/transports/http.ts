/** Bounded HTTP and locally-authored errors only. See LICENSE.reference. */
import type { VaultSyncTransportOptions } from '../types.ts'
import { fail, MAX_BYTES, VaultTransportError, text } from './documents.ts'

export interface HostTransportOptions extends VaultSyncTransportOptions {
  /** Test-only: loopback HTTP is permitted only with an injected fetch implementation. */
  allowInsecureHttpForTests?: boolean
  /** Test-only: permit an absolute local bare Git repository. Never persisted in config. */
  allowLocalGitForTests?: boolean
  timeoutMs?: number
}
export function timeoutMs(o: HostTransportOptions): number {
  const n = o.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(n) || n < 1 || n > 120_000) fail('invalid-config', 'Timeout must be 1..120000 ms.')
  return n
}
export function endpoint(input: unknown, o: HostTransportOptions, allowQuery = false): URL {
  const raw = text(input, 4096)
  if (raw.includes('\\') || /%(?:2e|2f|5c|00)/i.test(raw) || /(?:^|\/)\.\.?(?:\/|$)/.test(raw)) fail('invalid-config', 'Unsafe endpoint path.')
  let u: URL
  try { u = new URL(raw) } catch { fail('invalid-config', 'Invalid endpoint URL.') }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && o.allowInsecureHttpForTests === true && o.fetch)) fail('invalid-config', 'HTTPS is required (HTTP is for injected loopback tests only).')
  if (u.username || u.password || u.hash || (!allowQuery && u.search)) fail('invalid-config', 'Endpoints must not contain credentials, query or fragment.')
  return u
}
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, o: HostTransportOptions): Promise<T> {
  if (o.signal?.aborted) fail('aborted', 'Vault transport operation aborted.')
  const controller = new AbortController()
  let timedOut = false
  let rejectAbort!: (e: Error) => void
  const stop = () => { controller.abort(); rejectAbort(new VaultTransportError(timedOut ? 'timeout' : 'aborted', timedOut ? 'Vault transport operation timed out.' : 'Vault transport operation aborted.')) }
  const stopped = new Promise<never>((_, reject) => { rejectAbort = reject })
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs(o))
  o.signal?.addEventListener('abort', stop, { once: true })
  try { return await Promise.race([work(controller.signal), stopped]) }
  catch (e) { if (e instanceof VaultTransportError) throw e; return fail('transport-failed', 'Vault transport operation failed; remote details were suppressed.') }
  finally { clearTimeout(timer); o.signal?.removeEventListener('abort', stop); controller.abort() }
}
export async function secret(o: HostTransportOptions): Promise<string> {
  return bounded(async () => {
    let value: string | undefined
    try { value = await o.credentials.getSecret() } catch { fail('credential-failed', 'Unable to read host transport credential; details suppressed.') }
    if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\r\n\0]/.test(value)) fail('credential-missing', 'Transport credential is missing or invalid.')
    return value
  }, o)
}
async function bodyText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { await response.body?.cancel(); fail('size-limit', 'Remote body exceeds 21 MiB.') }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) fail('aborted', 'Vault transport operation aborted.')
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); fail('size-limit', 'Remote body exceeds 21 MiB.') }
      chunks.push(value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}
export interface Reply { status: number; headers: Headers; body: string }
/** Redirects are manual. Auth is permanently dropped on cross-origin reads; writes may not redirect cross-origin. */
export async function request(o: HostTransportOptions, method: string, input: URL, headers: Record<string, string> = {}, body?: string, follow = true): Promise<Reply> {
  if (body && Buffer.byteLength(body) > MAX_BYTES) fail('size-limit', 'Request exceeds 21 MiB.')
  return bounded(async signal => {
    let url = new URL(input); let sent = { ...headers }
    for (let hop = 0; hop <= 5; hop++) {
      const r = await (o.fetch ?? globalThis.fetch)(url, { method, headers: sent, redirect: 'manual', signal, ...(body === undefined ? {} : { body }) })
      if (r.url && new URL(r.url).origin !== url.origin) { await r.body?.cancel(); fail('unsafe-redirect', 'Fetch implementation followed an unapproved redirect.') }
      if (follow && [301, 302, 303, 307, 308].includes(r.status) && r.headers.has('location')) {
        await r.body?.cancel()
        if (hop === 5) fail('unsafe-redirect', 'Too many transport redirects.')
        const next = endpoint(new URL(r.headers.get('location')!, url).href, o, true)
        if (next.origin !== url.origin) {
          if (!['GET', 'HEAD'].includes(method)) fail('unsafe-redirect', 'Cross-origin write redirect refused.')
          sent = Object.fromEntries(Object.entries(sent).filter(([k]) => !['authorization', 'proxy-authorization', 'cookie', 'host'].includes(k.toLowerCase())))
        }
        if (!['GET', 'HEAD'].includes(method) && ![307, 308].includes(r.status)) fail('unsafe-redirect', 'Write-method changing redirect refused.')
        url = next; continue
      }
      return { status: r.status, headers: r.headers, body: await bodyText(r, signal) }
    }
    fail('unsafe-redirect', 'Too many transport redirects.')
  }, o)
}
export function success(r: Reply, context = 'HTTP request'): void {
  if (r.status === 409 || r.status === 412) fail('index-conflict', 'Remote index changed concurrently; refresh before retrying.')
  if (r.status < 200 || r.status >= 300) fail(r.status === 404 ? 'not-found' : 'http-failed', context + ' failed (HTTP ' + r.status + '); remote details suppressed.')
}
