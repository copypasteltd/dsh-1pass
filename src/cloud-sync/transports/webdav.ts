/** WebDAV channel adapted from dsh-config-manager 0.8.2 (MIT), see LICENSE.reference. */
import { fail, safePrefix, text } from './documents.ts'
import { endpoint, request, secret, success } from './http.ts'
import type { HostTransportOptions, Reply } from './http.ts'
import { ObjectTransport } from './objects.ts'
import type { IndexState } from './objects.ts'

export class WebDAVTransport extends ObjectTransport {
  readonly type = 'webdav' as const
  private readonly base: URL
  private readonly namespace: string
  private readonly username: string
  constructor(private readonly o: HostTransportOptions) {
    super()
    this.base = endpoint(o.config.webdavUrl, o)
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/'
    this.namespace = safePrefix(o.config.prefix ?? '1pass')
    this.username = text(o.config.webdavUsername, 256)
    if (this.username.includes(':')) fail('invalid-config', 'WebDAV username must not contain a colon.')
  }
  protected condition(index: IndexState): Record<string, string> {
    return index.etag ? { 'if-match': index.etag } : index.missing ? { 'if-none-match': '*' } : {}
  }
  protected snapshotCondition(): Record<string, string> { return { 'if-none-match': '*' } }
  protected hint(): string {
    return this.noEtag ? 'WARNING: server supplied no usable strong ETag; existing-index writes are non-atomic and concurrent updates may be lost.' : 'Index writes use ETag If-Match; initial writes use If-None-Match: *. A server that omits ETag weakens concurrency protection.'
  }
  private async auth(): Promise<Record<string, string>> {
    return { authorization: 'Basic ' + Buffer.from(this.username + ':' + await secret(this.o)).toString('base64') }
  }
  protected async send(method: string, key: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    return request(this.o, method, new URL(this.namespace + '/' + key, this.base), { ...await this.auth(), ...headers }, body)
  }
  /** Only MKCOL is a probe side effect; report paths only on actual 201 creation. */
  protected async prepare(): Promise<string[]> {
    const created: string[] = []
    const target = new URL(this.namespace + '/', this.base)
    const parts = target.pathname.split('/').filter(Boolean)
    let path = '/'
    for (const part of parts) {
      path += part + '/'
      const url = new URL(path, target.origin)
      const r = await request(this.o, 'MKCOL', url, await this.auth())
      if (r.status === 201) created.push(url.href)
      else if (![200, 204, 405].includes(r.status)) success(r, 'Create WebDAV collection')
    }
    return created
  }
}
