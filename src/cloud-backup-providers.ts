/** Encrypted backup transport only. No credentials are read until an upload is requested. */
import type {
  CloudBackupSettings, CloudBackupSnapshot, CloudBackupTarget, CloudBackupUploadResult,
  GitHubBackupTarget, ObjectStorageBackupTarget,
} from './cloud-backup-types.ts'

type Crypto = typeof import('node:crypto')
type RecordValue = Record<string, unknown>
type UploadOptions = {
  fetch?: typeof globalThis.fetch
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  now?: () => Date
}

const MAX_SNAPSHOT = 20 * 1024 * 1024
const MAX_RESPONSE = 2 * 1024 * 1024
const MAX_PAGES = 10
const MAX_KEYS = 10_000
const MAX_DELETES = 100
const REQUEST_TIMEOUT = 20_000
const GIT_HISTORY_WARNING = 'GitHub retention removes files from the branch, not from Git history. Historical encrypted backups remain in repository history.'
const PRUNE_WARNING = 'Backup uploaded, but remote retention could not be completed. Older backups may remain.'
const INCOMPLETE_WARNING = 'Backup uploaded, but the remote listing was incomplete or exceeded safety limits. No old backups were deleted.'
const DELETE_LIMIT_WARNING = 'Backup uploaded, but retention reached its deletion safety limit. Older backups may remain.'
const FILENAME = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

/** Only locally authored errors cross the transport boundary; never relay fetch errors/bodies. */
class BackupError extends Error {}
function fail(message: string): never { throw new BackupError(message) }

function record(value: unknown, context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${context}.`)
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(`Invalid ${context}.`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`Invalid ${context}.`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor) || !descriptor.enumerable) fail(`Invalid ${context}.`)
  }
  return value as RecordValue
}
function fields(value: RecordValue, allowed: readonly string[], context: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${context} contains unsupported fields; use environment references, not secrets.`)
}
function string(value: unknown, max: number, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${context}.`)
  return value
}
function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') fail(`Invalid ${context}.`)
  return value
}
function integer(value: unknown, min: number, max: number, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${context}.`)
  return value
}
function envName(value: unknown): string {
  const name = string(value, 128, 'credential environment name')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('Invalid credential environment name.')
  return name
}
function prefix(value: unknown): string {
  const path = string(value, 512, 'backup prefix')
  // No absolute paths, percent escapes, dot segments, control characters, or backslashes.
  if (!path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9 _.!()+@=-]{0,63}$/.test(part) && !part.endsWith('.') && !part.endsWith(' '))) fail('Invalid backup prefix; use a nonempty safe relative path.')
  return path
}
function isLiteral(host: string): boolean { return host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) }
function unsafeHost(input: string): boolean {
  const host = input.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[')) {
    // Only globally routable unicast IPv6; this also denies mapped IPv4, loopback,
    // link-local, unique-local and transition ranges that could wrap private IPs.
    return !/^\[[23][0-9a-f]{3}:/.test(host) || /^\[(?:2001:(?::|(?:db8|0):)|2002:)/.test(host)
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number, number, number]
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
  }
  return !host.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|home|lan)$/.test(host) ||
    /^(?:metadata|instance-data)(?:\.|$)/.test(host) ||
    !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}
function endpoint(value: unknown): string {
  const input = string(value, 2048, 'storage endpoint')
  // Check the original syntax as URL normalizes backslashes, dot paths and empty queries.
  if (!/^https:\/\/[^\s/?#@\\]+\/?$/.test(input)) fail('Storage endpoint must be an HTTPS origin without credentials, query, fragment or path.')
  let url: URL
  try { url = new URL(input) } catch { fail('Invalid storage endpoint.') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || unsafeHost(url.hostname)) fail('Unsafe storage endpoint; use a public HTTPS origin.')
  return url.origin
}
function branchName(value: unknown): string {
  const branch = string(value, 200, 'GitHub branch')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') ||
      !branch.split('/').every(part => /^[A-Za-z0-9]/.test(part) && !part.endsWith('.') && !part.endsWith('.lock'))) fail('Invalid GitHub branch.')
  return branch
}
function target(input: unknown): CloudBackupTarget {
  const value = record(input, 'cloud backup target')
  const base = ['id', 'label', 'enabled', 'prefix', 'provider']
  if (value.provider !== 'github' && value.provider !== 's3' && value.provider !== 'r2' && value.provider !== 'oss') fail('Invalid cloud backup provider.')
  fields(value, [...base, ...(value.provider === 'github' ? ['owner', 'repo', 'branch', 'tokenEnv'] :
    ['endpoint', 'region', 'bucket', 'accessKeyIdEnv', 'secretAccessKeyEnv', 'sessionTokenEnv', 'forcePathStyle'])], 'Cloud backup target')
  const id = string(value.id, 64, 'target id')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail('Invalid target id; use a simple lowercase slug.')
  const common = { id, label: string(value.label, 100, 'target label'), enabled: boolean(value.enabled, 'target enabled'), prefix: prefix(value.prefix) }
  if (value.provider === 'github') {
    const owner = string(value.owner, 39, 'GitHub owner')
    const repo = string(value.repo, 100, 'GitHub repository')
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || repo.endsWith('.')) fail('Invalid GitHub owner or repository slug.')
    return { ...common, provider: 'github', owner, repo, branch: branchName(value.branch), tokenEnv: envName(value.tokenEnv) }
  }
  const region = string(value.region, 63, 'storage region')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) fail('Invalid storage region.')
  const bucket = string(value.bucket, 63, 'storage bucket')
  if (bucket.length < 3 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes('..') || bucket.includes('.-') || bucket.includes('-.') || isLiteral(bucket)) fail('Invalid storage bucket.')
  if (value.provider === 'oss' && bucket.includes('.')) fail('Invalid native OSS bucket.')
  const storageEndpoint = endpoint(value.endpoint)
  const forcePathStyle = boolean(value.forcePathStyle, 'path-style setting')
  if (isLiteral(new URL(storageEndpoint).hostname) && !forcePathStyle) fail('Literal IP endpoints require path-style addressing.')
  return { ...common, provider: value.provider, endpoint: storageEndpoint, region, bucket, forcePathStyle,
    accessKeyIdEnv: envName(value.accessKeyIdEnv), secretAccessKeyEnv: envName(value.secretAccessKeyEnv),
    ...(value.sessionTokenEnv === undefined ? {} : { sessionTokenEnv: envName(value.sessionTokenEnv) }),
  }
}

/** Pure validation, shared by settings consumers. Unknown fields (including raw keys) fail closed. */
export function validateCloudBackupSettings(input: unknown): CloudBackupSettings {
  const value = input === undefined ? {} : record(input, 'cloud backup settings')
  fields(value, ['enabled', 'onChange', 'intervalMinutes', 'retention', 'targets'], 'Cloud backup settings')
  const intervalMinutes = value.intervalMinutes === undefined ? 60 : integer(value.intervalMinutes, 0, 10080, 'backup interval')
  if (intervalMinutes !== 0 && intervalMinutes < 5) fail('Backup interval must be zero or an integer from 5 to 10080 minutes.')
  const rawTargets = value.targets === undefined ? [] : value.targets
  if (!Array.isArray(rawTargets) || rawTargets.length > 8) fail('Cloud backup supports at most 8 targets.')
  const targets = Array.from(rawTargets, target)
  if (new Set(targets.map(item => item.id)).size !== targets.length) fail('Cloud backup target ids must be unique.')
  return { enabled: value.enabled === undefined ? false : boolean(value.enabled, 'backup enabled'),
    onChange: value.onChange === undefined ? true : boolean(value.onChange, 'backup on-change'), intervalMinutes,
    retention: value.retention === undefined ? 10 : integer(value.retention, 1, 100, 'backup retention'), targets }
}

function ownedFilename(name: string): boolean {
  const match = FILENAME.exec(name)
  if (!match) return false
  const iso = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  const parsed = new Date(iso)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso
}
function encryptedBlob(input: unknown, entry: boolean): string | undefined {
  const value = record(input, 'encrypted envelope')
  fields(value, entry ? ['id', 'ivHex', 'tagHex', 'dataHex'] : ['ivHex', 'tagHex', 'dataHex'], 'Encrypted envelope')
  if (typeof value.ivHex !== 'string' || !/^[0-9a-f]{24}$/i.test(value.ivHex) ||
      typeof value.tagHex !== 'string' || !/^[0-9a-f]{32}$/i.test(value.tagHex) ||
      typeof value.dataHex !== 'string' || value.dataHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value.dataHex)) fail('Invalid encrypted envelope; plaintext backups are not allowed.')
  if (entry) {
    const id = string(value.id, 128, 'encrypted entry id')
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('Invalid encrypted entry id.')
    return id
  }
}
/** JSON.parse discards duplicate keys; they could otherwise conceal plaintext in the original bytes. */
function rejectDuplicateJsonKeys(input: string): void {
  const stack: Array<Set<string> | null> = []
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '{') stack.push(new Set())
    else if (char === '[') stack.push(null)
    else if (char === '}' || char === ']') stack.pop()
    else if (char === '"') {
      const start = i
      while (++i < input.length) {
        if (input[i] === '\\') i++
        else if (input[i] === '"') break
      }
      let next = i + 1
      while (/^[ \t\r\n]$/.test(input[next] ?? '')) next++
      if (input[next] === ':') {
        const key = JSON.parse(input.slice(start, i + 1)) as string
        const keys = stack.at(-1)
        if (!keys || keys.has(key)) fail('Duplicate encrypted snapshot JSON fields are not allowed.')
        keys.add(key)
      }
    }
  }
}
function snapshotData(input: CloudBackupSnapshot): string {
  const value = record(input, 'encrypted snapshot')
  fields(value, ['vaultId', 'filename', 'data'], 'Encrypted snapshot')
  if (typeof value.vaultId !== 'string' || !/^vault-[a-f0-9]{24}$/.test(value.vaultId) ||
      typeof value.filename !== 'string' || !ownedFilename(value.filename)) fail('Invalid encrypted snapshot namespace or filename.')
  if (typeof value.data !== 'string' || value.data.length > MAX_SNAPSHOT || Buffer.byteLength(value.data, 'utf8') > MAX_SNAPSHOT) fail('Encrypted snapshot exceeds the 20 MiB safety limit or is invalid.')
  let parsed: unknown
  try { parsed = JSON.parse(value.data) } catch { fail('Invalid encrypted snapshot JSON.') }
  rejectDuplicateJsonKeys(value.data)
  const document = record(parsed, 'encrypted vault document')
  fields(document, ['version', 'kdf', 'verify', 'entries'], 'Encrypted vault document')
  if (document.version !== 1) fail('Only version 1 encrypted vault snapshots are supported.')
  const kdf = record(document.kdf, 'encrypted vault KDF')
  fields(kdf, ['algo', 'n', 'r', 'p', 'saltHex'], 'Encrypted vault KDF')
  if (kdf.algo !== 'scrypt' || typeof kdf.saltHex !== 'string' || !/^[0-9a-f]{32}$/i.test(kdf.saltHex)) fail('Invalid encrypted vault KDF.')
  const n = integer(kdf.n, 2, 2 ** 30, 'encrypted vault KDF cost')
  if (!Number.isInteger(Math.log2(n))) fail('Invalid encrypted vault KDF cost.')
  integer(kdf.r, 1, 1_000_000, 'encrypted vault KDF block size')
  integer(kdf.p, 1, 1_000_000, 'encrypted vault KDF parallelism')
  encryptedBlob(document.verify, false)
  if (!Array.isArray(document.entries)) fail('Invalid encrypted vault entries.')
  const ids = Array.from(document.entries, entry => encryptedBlob(entry, true))
  if (new Set(ids).size !== ids.length) fail('Duplicate encrypted vault entry ids.')
  return value.data
}

function credential(env: Record<string, string | undefined>, name: string): string {
  // An injected environment is authoritative and never falls through to the real process.
  const value = Object.hasOwn(env, name) ? env[name] : undefined
  if (!value || typeof value !== 'string') fail('A required cloud backup credential environment variable is not set.')
  if (value.length > 16384 || /[^\x21-\x7e]/.test(value)) fail('Invalid cloud backup credential format.')
  return value
}
function encode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) }
function encodePath(value: string): string { return value.split('/').map(encode).join('/') }
function queryString(query: Record<string, string>): string {
  return Object.entries(query).map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&')
}

class Requests {
  constructor(private readonly fetcher: typeof globalThis.fetch, private readonly signal?: AbortSignal) {}
  async send(url: string, init: RequestInit, mode: 'json' | 'xml' | 'none' = 'none', allow404 = false): Promise<unknown> {
    if (this.signal?.aborted) fail('Cloud backup request cancelled.')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT)
    const cancel = () => controller.abort()
    this.signal?.addEventListener('abort', cancel, { once: true })
    let response: Response | undefined
    let cancelReader: (() => void) | undefined
    let abortListener: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new BackupError(timedOut ? 'Cloud backup request timed out.' : 'Cloud backup request cancelled.'))
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      const operation = (async () => {
        response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal, credentials: 'omit' })
        if (response.redirected || (response.status >= 300 && response.status < 400)) fail('Cloud backup redirects are not allowed.')
        if (allow404 && response.status === 404) return null
        if (!response.ok) fail(`Cloud backup request failed (HTTP ${integer(response.status, 100, 599, 'response status')}).`)
        if (mode === 'none') return undefined
        const length = response.headers.get('content-length')
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) fail('Cloud backup response exceeded safety limits.')
        const reader = response.body?.getReader()
        if (!reader) fail('Invalid cloud backup service response.')
        cancelReader = () => { void reader.cancel().catch(() => {}) }
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESPONSE) fail('Cloud backup response exceeded safety limits.')
            chunks.push(value)
          }
        } finally {
          cancelReader()
          reader.releaseLock()
          cancelReader = undefined
        }
        const body = Buffer.concat(chunks).toString('utf8')
        if (mode === 'xml') return body
        try { return JSON.parse(body) as unknown } catch { fail('Invalid cloud backup service response.') }
      })()
      return await Promise.race([operation, aborted])
    } catch (error) {
      if (error instanceof BackupError) throw error
      if (controller.signal.aborted) fail(timedOut ? 'Cloud backup request timed out.' : 'Cloud backup request cancelled.')
      fail('Cloud backup network request failed.')
    } finally {
      clearTimeout(timer)
      this.signal?.removeEventListener('abort', cancel)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      cancelReader?.()
      void response?.body?.cancel().catch(() => {})
    }
  }
}

function expiredKeys(keys: Iterable<string>, uploaded: string, retention: number): string[] {
  // Always keep this upload, even if a remote filename has a clock skew into the future.
  return [...new Set(keys)].filter(key => key !== uploaded).sort().reverse().slice(retention - 1)
}
async function prune(keys: string[], remove: (key: string) => Promise<void>): Promise<string | undefined> {
  try {
    for (const key of keys.slice(0, MAX_DELETES)) await remove(key)
    if (keys.length > MAX_DELETES) return DELETE_LIMIT_WARNING
  } catch { return PRUNE_WARNING }
}
async function githubUpload(target: GitHubBackupTarget, snapshot: CloudBackupSnapshot, data: string, retention: number, token: string, request: Requests): Promise<CloudBackupUploadResult> {
  const namespace = `${target.prefix}/${snapshot.vaultId}/`
  const objectKey = namespace + snapshot.filename
  const root = `https://api.github.com/repos/${encode(target.owner)}/${encode(target.repo)}`
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }
  const body = JSON.stringify({ message: 'Encrypted vault backup', content: Buffer.from(data, 'utf8').toString('base64'), branch: target.branch })
  if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT) fail('GitHub backup request exceeds the 20 MiB payload safety limit.')
  const branch = record(await request.send(`${root}/branches/${encode(target.branch)}`, { headers }, 'json'), 'GitHub branch response')
  const commit = record(branch.commit, 'GitHub branch commit')
  if (branch.name !== target.branch || typeof commit.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit.sha)) fail('The selected GitHub branch must be initialized.')
  // This must be the last network operation before the write, never a cached check.
  const repo = record(await request.send(root, { headers }, 'json'), 'GitHub repository response')
  if (repo.private !== true) fail('Cloud backup requires a private GitHub repository.')
  await request.send(`${root}/contents/${encodePath(objectKey)}`, { method: 'PUT', headers, body })
  let warning: string | undefined
  try {
    const listing = await request.send(`${root}/contents/${encodePath(namespace.slice(0, -1))}?ref=${encode(target.branch)}`, { headers }, 'json')
    // GitHub Contents listings have a documented 1000-entry cap, with no paging.
    if (!Array.isArray(listing) || listing.length >= 1000) warning = INCOMPLETE_WARNING
    else {
      const candidates = new Map<string, string>()
      for (const item of listing) {
        const row = record(item, 'GitHub directory response')
        if (row.type === 'file' && typeof row.name === 'string' && ownedFilename(row.name) && row.path === namespace + row.name &&
            typeof row.sha === 'string' && /^[0-9a-f]{40,64}$/i.test(row.sha)) candidates.set(row.path, row.sha)
      }
      warning = await prune(expiredKeys(candidates.keys(), objectKey, retention), async key => {
        await request.send(`${root}/contents/${encodePath(key)}`, { method: 'DELETE', headers, body: JSON.stringify({ message: 'Prune encrypted vault backup', sha: candidates.get(key), branch: target.branch }) })
      })
    }
  } catch { warning = PRUNE_WARNING }
  return { objectKey, warning: warning ? `${GIT_HISTORY_WARNING} ${warning}` : GIT_HISTORY_WARNING }
}

interface XmlNode { name: string; text: string; children: XmlNode[] }
function xmlText(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) fail('Invalid cloud backup listing.')
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
    const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    if (known[entity] !== undefined) return known[entity]!
    const hex = entity.startsWith('&#x')
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    if (!Number.isSafeInteger(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('Invalid cloud backup listing.')
    return String.fromCodePoint(code)
  })
}
/** Small non-expanding XML reader: no DTD, entities, comments, CDATA or external access. */
function xmlRoot(input: string): XmlNode {
  const xml = input.replace(/^\s*<\?xml\s[^?]*\?>/, '')
  if (/<[!?]/.test(xml)) fail('Invalid cloud backup listing.')
  const root: XmlNode = { name: '', text: '', children: [] }
  const stack = [root]
  const tokens = /<[^>]*>|[^<]+/g
  let end = 0
  let count = 0
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== end) fail('Invalid cloud backup listing.')
    const token = match[0]
    end += token.length
    if (token.startsWith('</')) {
      const name = /^<\/([A-Za-z][A-Za-z0-9_.-]*)\s*>$/.exec(token)?.[1]
      if (stack.length < 2 || stack.at(-1)!.name !== name) fail('Invalid cloud backup listing.')
      stack.pop()
    } else if (token.startsWith('<')) {
      const tag = /^<([A-Za-z][A-Za-z0-9_.-]*)(?:\s+xmlns(?::[A-Za-z][A-Za-z0-9_.-]*)?=(?:"[^"<>&]*"|'[^'<>&]*'))*\s*(\/?)>$/.exec(token)
      if (!tag || ++count > 20000 || stack.length > 10) fail('Invalid cloud backup listing.')
      const node: XmlNode = { name: tag[1]!, text: '', children: [] }
      stack.at(-1)!.children.push(node)
      if (!tag[2]) stack.push(node)
    } else stack.at(-1)!.text += xmlText(token)
  }
  if (end !== xml.length || stack.length !== 1 || root.text.trim() || root.children.length !== 1 || root.children[0]!.name !== 'ListBucketResult') fail('Invalid cloud backup listing.')
  return root.children[0]!
}
function xmlField(node: XmlNode, name: string, required = false): string | undefined {
  const fields = node.children.filter(child => child.name === name)
  if (fields.length > 1 || (required && fields.length !== 1) || fields[0]?.children.length) fail('Invalid cloud backup listing.')
  return fields[0]?.text
}
function listPage(xml: string, namespace: string): { keys: string[]; next?: string } {
  const root = xmlRoot(xml)
  const encoding = xmlField(root, 'EncodingType')
  if (encoding !== undefined && encoding !== 'url') fail('Invalid cloud backup listing encoding.')
  const decode = (value: string): string => {
    try { return encoding === 'url' ? decodeURIComponent(value) : value } catch { fail('Invalid cloud backup listing encoding.') }
  }
  const reportedPrefix = xmlField(root, 'Prefix')
  if (reportedPrefix !== undefined && decode(reportedPrefix) !== namespace) fail('Invalid cloud backup listing prefix.')
  const contents = root.children.filter(child => child.name === 'Contents')
  if (contents.length > 1000) fail('Cloud backup listing exceeded safety limits.')
  const keys = contents.map(row => decode(xmlField(row, 'Key', true)!)).filter(key => key.startsWith(namespace) && ownedFilename(key.slice(namespace.length)))
  const truncated = xmlField(root, 'IsTruncated', true)
  if (truncated !== 'true' && truncated !== 'false') fail('Invalid cloud backup listing completeness.')
  if (truncated === 'false') return { keys }
  const next = xmlField(root, 'NextContinuationToken', true)!
  if (!next || next.length > 4096 || /[\x00-\x1f\x7f]/.test(next)) fail('Invalid cloud backup continuation token.')
  return { keys, next }
}

class ObjectRequests {
  constructor(private readonly target: ObjectStorageBackupTarget, private readonly access: string, private readonly secret: string,
    private readonly token: string | undefined, private readonly request: Requests, private readonly crypto: Crypto, private readonly now: () => Date) {}
  async send(method: string, key: string, query: Record<string, string> = {}, body?: string, mode: 'xml' | 'none' = 'none'): Promise<unknown> {
    const target = this.target
    const url = new URL(target.endpoint)
    if (!target.forcePathStyle) url.hostname = `${target.bucket}.${url.hostname}`
    const rawPath = `/${target.forcePathStyle ? `${target.bucket}/` : ''}${key}`
    url.pathname = encodePath(rawPath)
    const queryValue = queryString(query)
    url.search = queryValue ? `?${queryValue}` : ''
    const time = this.now()
    if (!(time instanceof Date) || !Number.isFinite(time.getTime())) fail('Invalid cloud backup signing time.')
    const timestamp = time.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const date = timestamp.slice(0, 8)
    const hash = (value: string) => this.crypto.createHash('sha256').update(value, 'utf8').digest('hex')
    const hmac = (key: string | Uint8Array, value: string) => this.crypto.createHmac('sha256', key).update(value, 'utf8').digest()
    const headers: Record<string, string> = { host: url.host }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let scope: string
    let canonical: string
    let signingKey: Uint8Array
    let algorithm: string
    let additional: string
    if (target.provider === 'oss') {
      // Native OSS V4, NOT AWS SigV4. Official spec (verified 2026-11-14):
      // https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4
      // OSS mandates UNSIGNED-PAYLOAD; signed Content-MD5 also binds uploaded bytes.
      algorithm = 'OSS4-HMAC-SHA256'
      scope = `${date}/${target.region}/oss/aliyun_v4_request`
      headers['x-oss-date'] = timestamp
      headers['x-oss-content-sha256'] = 'UNSIGNED-PAYLOAD'
      if (this.token) headers['x-oss-security-token'] = this.token
      if (body !== undefined) {
        headers['content-md5'] = this.crypto.createHash('md5').update(body, 'utf8').digest('base64')
        headers['x-oss-forbid-overwrite'] = 'true'
      }
      const signed = Object.keys(headers).filter(name => name === 'content-type' || name === 'content-md5' || name.startsWith('x-oss-')).sort()
      const canonicalHeaders = signed.map(name => `${name}:${headers[name]!.trim()}\n`).join('')
      // OSS resource URI ALWAYS includes bucket, regardless of addressing style.
      canonical = `${method}\n${encodePath(`/${target.bucket}/${key}`)}\n${queryValue}\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`
      signingKey = hmac(hmac(hmac(hmac(`aliyun_v4${this.secret}`, date), target.region), 'oss'), 'aliyun_v4_request')
      additional = ''
    } else {
      algorithm = 'AWS4-HMAC-SHA256'
      const region = target.provider === 'r2' ? 'auto' : target.region
      scope = `${date}/${region}/s3/aws4_request`
      headers['x-amz-date'] = timestamp
      headers['x-amz-content-sha256'] = hash(body ?? '')
      if (this.token) headers['x-amz-security-token'] = this.token
      if (body !== undefined) headers['if-none-match'] = '*'
      const signed = Object.keys(headers).sort()
      const canonicalHeaders = signed.map(name => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join('')
      additional = signed.join(';')
      canonical = `${method}\n${url.pathname}\n${queryValue}\n${canonicalHeaders}\n${additional}\n${headers['x-amz-content-sha256']}`
      signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secret}`, date), region), 's3'), 'aws4_request')
    }
    const signature = hmac(signingKey, `${algorithm}\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex')
    headers.authorization = `${algorithm} Credential=${this.access}/${scope}, ${target.provider === 'oss' ? '' : `SignedHeaders=${additional}, `}Signature=${signature}`
    return this.request.send(url.toString(), { method, headers, ...(body === undefined ? {} : { body }) }, mode, method === 'DELETE')
  }
}
async function objectUpload(target: ObjectStorageBackupTarget, snapshot: CloudBackupSnapshot, data: string, retention: number, access: string, secret: string, token: string | undefined, request: Requests, crypto: Crypto, now: () => Date): Promise<CloudBackupUploadResult> {
  const namespace = `${target.prefix}/${snapshot.vaultId}/`
  const objectKey = namespace + snapshot.filename
  const remote = new ObjectRequests(target, access, secret, token, request, crypto, now)
  await remote.send('PUT', objectKey, {}, data)
  try {
    const keys = new Set<string>()
    const seenTokens = new Set<string>()
    let next: string | undefined
    let complete = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await remote.send('GET', '', { 'list-type': '2', 'encoding-type': 'url', 'max-keys': '1000', prefix: namespace, ...(next ? { 'continuation-token': next } : {}) }, undefined, 'xml')
      const listing = listPage(body as string, namespace)
      for (const key of listing.keys) keys.add(key)
      if (keys.size > MAX_KEYS) break
      next = listing.next
      if (next === undefined) { complete = true; break }
      if (seenTokens.has(next)) break
      seenTokens.add(next)
    }
    if (!complete) return { objectKey, warning: INCOMPLETE_WARNING }
    const warning = await prune(expiredKeys(keys, objectKey, retention), async key => { await remote.send('DELETE', key) })
    return { objectKey, ...(warning ? { warning } : {}) }
  } catch { return { objectKey, warning: PRUNE_WARNING } }
}

/** Upload exact encrypted bytes. The caller decides scheduling and user opt-in. */
export async function uploadCloudBackup(targetInput: CloudBackupTarget, snapshot: CloudBackupSnapshot, retention: number, options: UploadOptions = {}): Promise<CloudBackupUploadResult> {
  try {
    const checkedTarget = target(targetInput)
    if (!checkedTarget.enabled) fail('Cloud backup target is disabled.')
    integer(retention, 1, 100, 'backup retention')
    const data = snapshotData(snapshot)
    const checkedSnapshot = { vaultId: snapshot.vaultId, filename: snapshot.filename, data }
    const env = options.env ?? process.env
    const fetcher = options.fetch ?? globalThis.fetch
    if (typeof fetcher !== 'function') fail('Cloud backup fetch transport is unavailable.')
    const request = new Requests(fetcher, options.signal)
    if (checkedTarget.provider === 'github') {
      const token = credential(env, checkedTarget.tokenEnv)
      return await githubUpload(checkedTarget, checkedSnapshot, data, retention, token, request)
    }
    const access = credential(env, checkedTarget.accessKeyIdEnv)
    const secret = credential(env, checkedTarget.secretAccessKeyEnv)
    const token = checkedTarget.sessionTokenEnv === undefined ? undefined : credential(env, checkedTarget.sessionTokenEnv)
    const crypto = await import('node:crypto')
    return await objectUpload(checkedTarget, checkedSnapshot, data, retention, access, secret, token, request, crypto, options.now ?? (() => new Date()))
  } catch (error) {
    if (error instanceof BackupError) throw error
    // Deliberately omit original errors/cause, response text, signed URLs and credentials.
    throw new BackupError('Cloud backup failed.')
  }
}
