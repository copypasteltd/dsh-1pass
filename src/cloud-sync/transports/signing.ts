/** SigV4/OSS4 adapted from dsh-config-manager 0.8.2; Copyright (c) 2026 xiajiajun516. MIT: LICENSE.reference. */
import { createHash, createHmac } from 'node:crypto'
export function uriEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) }
function uri(path: string): string { return path.split('/').map(p => uriEncode(decodeURIComponent(p))).join('/') || '/' }
function sha(data: string): string { return createHash('sha256').update(data).digest('hex') }
function hmac(key: string | Uint8Array, data: string): Buffer { return createHmac('sha256', key).update(data).digest() }
export interface SignInput {
  method: string; url: URL; headers: Record<string, string>; body?: string
  accessKeyId: string; secret: string; region: string; oss: boolean; bucket: string; key: string; now?: Date
}
export function signHeaders(i: SignInput): Record<string, string> {
  const date = (i.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = date.slice(0, 8)
  const prefix = i.oss ? 'x-oss-' : 'x-amz-'
  const algorithm = i.oss ? 'OSS4-HMAC-SHA256' : 'AWS4-HMAC-SHA256'
  const terminator = i.oss ? 'aliyun_v4_request' : 'aws4_request'
  const payloadHash = i.oss ? 'UNSIGNED-PAYLOAD' : sha(i.body ?? '')
  const headers: Record<string, string> = { host: i.url.host }
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  headers[prefix + 'date'] = date
  headers[prefix + 'content-sha256'] = payloadHash
  const names = Object.keys(headers).filter(k => !i.oss || k === 'content-type' || k === 'content-md5' || k.startsWith('x-oss-')).sort()
  const headerList = i.oss ? '' : names.join(';')
  const pairs: [string, string][] = []
  for (const [k, v] of i.url.searchParams) pairs.push([uriEncode(k), uriEncode(v)])
  pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
  const query = pairs.map(([k, v]) => i.oss && !v ? k : k + '=' + v).join('&')
  // OSS canonical resource ALWAYS includes bucket, including virtual-host requests.
  const path = i.oss ? '/' + uriEncode(i.bucket) + '/' + i.key.split('/').map(uriEncode).join('/') : i.url.pathname
  const canonical = [i.method, uri(path), query, names.map(k => k + ':' + headers[k] + '\n').join(''), headerList, payloadHash].join('\n')
  const service = i.oss ? 'oss' : 's3'
  const scope = [day, i.region, service, terminator].join('/')
  const signingKey = hmac(hmac(hmac(hmac((i.oss ? 'aliyun_v4' : 'AWS4') + i.secret, day), i.region), service), terminator)
  const signature = hmac(signingKey, [algorithm, date, scope, sha(canonical)].join('\n')).toString('hex')
  // OSS omits AdditionalHeaders entirely when there are no optional signed headers.
  headers.authorization = algorithm + ' Credential=' + i.accessKeyId + '/' + scope + (i.oss ? '' : ', SignedHeaders=' + headerList) + (i.oss ? ',Signature=' : ', Signature=') + signature
  signingKey.fill(0)
  return headers
}
