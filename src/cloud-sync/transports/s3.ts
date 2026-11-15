/** S3-family channel adapted from dsh-config-manager 0.8.2 (MIT), see LICENSE.reference. */
import { fail, safePrefix, text } from './documents.ts'
import { endpoint, request, secret, success } from './http.ts'
import type { HostTransportOptions, Reply } from './http.ts'
import { ObjectTransport } from './objects.ts'
import type { IndexState } from './objects.ts'
import { signHeaders, uriEncode } from './signing.ts'

const VARIANTS = {
  s3: { region: 'us-east-1', pathStyle: false, host: (r: string) => 'https://s3.' + r + '.amazonaws.com' },
  oss: { region: '', pathStyle: false, host: (r: string) => 'https://oss-' + r + '.aliyuncs.com' },
  cos: { region: '', pathStyle: false, host: (r: string) => 'https://cos.' + r + '.myqcloud.com' },
  minio: { region: 'us-east-1', pathStyle: true, host: (_r: string) => '' },
  kodo: { region: '', pathStyle: false, host: (r: string) => 'https://s3-' + r + '.qiniucs.com' },
}
export class S3Transport extends ObjectTransport {
  readonly type = 's3' as const
  private readonly base: URL
  private readonly prefix: string
  private readonly region: string
  private readonly bucket: string
  private readonly accessKeyId: string
  private readonly pathStyle: boolean
  private readonly oss: boolean
  private readonly forbidOverwrite: boolean
  constructor(private readonly o: HostTransportOptions) {
    super()
    const provider = o.config.provider ?? 's3'
    if (!Object.hasOwn(VARIANTS, provider)) fail('invalid-config', 'Unsupported S3-family provider.')
    const variant = VARIANTS[provider]
    this.region = text(o.config.region ?? variant.region, 64)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(this.region)) fail('invalid-config', 'Invalid object-storage region.')
    this.bucket = text(o.config.bucket, 63)
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket) || this.bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(this.bucket)) fail('invalid-config', 'Invalid object-storage bucket.')
    this.accessKeyId = text(o.config.accessKeyId, 256)
    if (!/^[A-Za-z0-9_-]+$/.test(this.accessKeyId)) fail('invalid-config', 'Invalid object-storage access key id.')
    const dialect = o.config.dialectId ?? (provider === 'oss' ? 'oss4' : 'aws4')
    if (!['aws4', 'oss4'].includes(dialect)) fail('invalid-config', 'Unsupported object-storage signing dialect.')
    this.oss = dialect === 'oss4'
    this.forbidOverwrite = provider === 'oss'
    this.pathStyle = o.config.pathStyle ?? variant.pathStyle
    if (typeof this.pathStyle !== 'boolean') fail('invalid-config', 'Invalid object-storage addressing style.')
    this.base = endpoint(o.config.endpoint ?? variant.host(this.region), o)
    if (this.base.pathname !== '/') fail('invalid-config', 'Object-storage endpoint must be an origin without a path.')
    if (!this.pathStyle && (this.base.hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(this.base.hostname))) fail('invalid-config', 'Literal IP object-storage endpoints require pathStyle.')
    this.prefix = safePrefix(o.config.prefix ?? '1pass')
  }
  private url(key: string): URL {
    const url = new URL(this.base)
    if (this.pathStyle) url.pathname = '/' + uriEncode(this.bucket) + '/' + key.split('/').map(uriEncode).join('/')
    else { url.hostname = this.bucket + '.' + url.hostname; url.pathname = '/' + key.split('/').map(uriEncode).join('/') }
    return url
  }
  protected async send(method: string, file: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    const key = file ? this.prefix + '/' + file : ''
    const url = this.url(key)
    const signed = signHeaders({ method, url, headers, ...(body === undefined ? {} : { body }), accessKeyId: this.accessKeyId, secret: await secret(this.o), region: this.region, oss: this.oss, bucket: this.bucket, key })
    // Redirecting a signed request changes host/canonical resource; do not follow it.
    return request(this.o, method, url, signed, body, false)
  }
  protected condition(index: IndexState): Record<string, string> {
    if (this.forbidOverwrite) return index.missing ? { 'x-oss-forbid-overwrite': 'true' } : {}
    return index.etag ? { 'if-match': index.etag } : index.missing ? { 'if-none-match': '*' } : {}
  }
  protected snapshotCondition(): Record<string, string> { return this.forbidOverwrite ? { 'x-oss-forbid-overwrite': 'true' } : { 'if-none-match': '*' } }
  protected async beforeIndexWrite(index: IndexState): Promise<void> {
    if (!this.forbidOverwrite || index.missing || !index.etag) return
    const r = await this.send('HEAD', 'index.json')
    if (r.status === 404) fail('index-conflict', 'Remote OSS index disappeared before write.')
    success(r, 'Recheck OSS index')
    if (r.headers.get('etag') !== index.etag) fail('index-conflict', 'Remote OSS index changed before write.')
  }
  protected hint(): string {
    if (this.forbidOverwrite) return 'WARNING: OSS has no atomic existing-object CAS. Initial index uses x-oss-forbid-overwrite; existing index uses pre-write HEAD ETag recheck, with a residual HEAD-to-PUT race.' + (this.noEtag ? ' Server supplied no usable ETag; even the recheck is unavailable.' : '')
    return this.noEtag ? 'WARNING: no usable ETag returned; existing-index writes are non-atomic and concurrent updates may be lost.' : 'Index writes use If-Match, or If-None-Match: * for initialization. Verify the gateway implements these conditions.'
  }
  override async probe(): Promise<{ message: string; hint: string; snapshotCount: number; createdCollections: string[] }> {
    success(await this.send('HEAD', ''), 'Read object-storage bucket')
    return super.probe()
  }
}
