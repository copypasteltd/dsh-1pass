import { createHash, randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { VaultSyncChannel, VaultSyncChannelConfig } from './types.ts'

export interface SyncSecretPort {
  get(ref: string): Promise<string | undefined>
  has(ref: string): Promise<boolean>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}
export interface SyncChannelState {
  config?: VaultSyncChannelConfig
  selection: { mode: 'default' | 'advanced'; sections: string[]; encrypt: true; includeSecrets: false }
  autosync: {
    enabled: boolean; interval: '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h'
    realtime: boolean; remoteCheckMs: number; autoApplyTier: 'low' | 'medium'
    conflictPolicy: 'ask' | 'local'; startupMinIntervalMs: number
  }
}
type S3Provider = NonNullable<VaultSyncChannelConfig['provider']>
type SecretKind = 'auth' | 'encrypt' | 'decrypt'
export interface SyncConfigDocument {
  version: 1
  deviceId: string
  deviceName: string
  active: VaultSyncChannel
  channels: Record<VaultSyncChannel, SyncChannelState>
  /** Independent, non-secret S3 form backfills. The active config remains channels.s3.config. */
  configProviders?: Partial<Record<S3Provider, VaultSyncChannelConfig>>
}

const CHANNELS: VaultSyncChannel[] = ['git', 'webdav', 's3', 'gist']
const PROVIDERS: S3Provider[] = ['s3', 'oss', 'cos', 'minio', 'kodo']
const INTERVALS = ['5m', '15m', '30m', '60m', '6h', '12h', '24h'] as const
const MAX_BYTES = 128 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL = /[\x00-\x1f\x7f]/u
const queues = new Map<string, Promise<void>>()

export class VaultSyncConfigError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VaultSyncConfigError' }
}
function invalid(): never { throw new VaultSyncConfigError('SYNC_CONFIG_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return invalid()
  return value as Record<string, unknown>
}
function channel(value: unknown = 'git'): VaultSyncChannel {
  if (!CHANNELS.includes(value as VaultSyncChannel)) return invalid()
  return value as VaultSyncChannel
}
function provider(value: unknown = 's3'): S3Provider {
  if (!PROVIDERS.includes(value as S3Provider)) return invalid()
  return value as S3Provider
}
function text(value: unknown, fallback = '', max = 4096): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) return invalid()
  return value.trim()
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') return invalid()
  return value
}
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid()
  return Math.min(max, Math.max(min, Math.round(value)))
}
function checkBody(value: unknown): Record<string, unknown> {
  const body = record(value)
  try { if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) return invalid() } catch { return invalid() }
  // Check all recognized security fields before any credential mutation, including fields for other channels.
  if (!bool(body.encrypt, true) || bool(body.includeSecrets, false)) return invalid()
  for (const key of ['token', 'password', 'secret', 'encryptPassword', 'decryptPassword']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || (body[key] as string).length > 16384)) return invalid()
  }
  for (const key of ['clear', 'clearEncryptPassword', 'clearDecryptPassword']) bool(body[key], false)
  // Selection fields may share a config-save body; reject invalid values before saving any credential.
  selection(body)
  if ((body.clearEncryptPassword === true && body.encryptPassword) || (body.clearDecryptPassword === true && body.decryptPassword)) return invalid()
  return body
}
function url(value: unknown): string {
  const input = text(value)
  if (!input || /[\\\s]/u.test(input)) return invalid()
  try {
    const parsed = new URL(input)
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return invalid()
    if (CONTROL.test(decodeURIComponent(input))) return invalid()
    return parsed.href
  } catch { return invalid() }
}
function relative(value: unknown, fallback = ''): string {
  const input = text(value, fallback, 1024)
  if (!input) return ''
  // No encoded traversal, Windows separators, options, absolute paths or empty interior segments.
  if (/[\\%:?#]/u.test(input) || input.startsWith('/') || input.startsWith('-')) return invalid()
  const segments = input.replace(/\/+$/u, '').split('/')
  if (segments.some(part => !part || part === '.' || part === '..')) return invalid()
  return segments.join('/')
}
function repository(value: unknown): string {
  const input = text(value)
  if (!input || input.startsWith('-') || /[?#]/u.test(input)) return invalid()
  if (/^https:\/\//u.test(input)) {
    const parsed = url(input)
    if (new URL(parsed).protocol !== 'https:') return invalid()
    return parsed
  }
  if (/^git@[a-z0-9.-]+:[A-Za-z0-9_./~-]+$/iu.test(input)) {
    const path = input.slice(input.indexOf(':') + 1)
    if (path.startsWith('-') || path.split('/').some(part => part === '..')) return invalid()
    return input
  }
  if (input.startsWith('ssh://')) {
    try {
      const parsed = new URL(input)
      if (parsed.protocol !== 'ssh:' || !/^[A-Za-z0-9_-]+$/u.test(parsed.username) || parsed.password || !/^[A-Za-z0-9.-]+$/u.test(parsed.hostname) || (parsed.port && (!/^\d{1,5}$/u.test(parsed.port) || Number(parsed.port)>65535 || Number(parsed.port)===0)) || !/^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(parsed.pathname) || input.includes('..') || parsed.hash || parsed.search) return invalid()
      return input
    } catch { return invalid() }
  }
  // Local absolute repositories are legitimate input, never executable names or flags.
  if ((isAbsolute(input) || win32.isAbsolute(input)) && !input.includes('://')) return input
  return invalid()
}
function branch(value: unknown): string {
  const input = text(value, '', 256)
  if (input && (!/^[A-Za-z0-9_./-]+$/u.test(input) || input.startsWith('-') || input.startsWith('/') || input.endsWith('/') || input.includes('..') || input.includes('//') || input.endsWith('.lock'))) return invalid()
  return input
}
function selection(raw: unknown): SyncChannelState['selection'] {
  const body = record(raw)
  if (!bool(body.encrypt, true) || bool(body.includeSecrets, false)) return invalid()
  const mode = body.mode ?? 'default'
  if (mode !== 'default' && mode !== 'advanced') return invalid()
  if (body.sections !== undefined && (!Array.isArray(body.sections) || body.sections.some(item => item !== 'vault'))) return invalid()
  return { mode, sections: body.sections === undefined ? ['vault'] : [...new Set(body.sections as string[])], encrypt: true, includeSecrets: false }
}
function autosync(raw: unknown, configured: boolean): SyncChannelState['autosync'] {
  const body = record(raw)
  const interval = body.interval ?? '30m'
  if (!INTERVALS.includes(interval as typeof INTERVALS[number])) return invalid()
  const autoApplyTier = body.autoApplyTier ?? 'medium'
  const conflictPolicy = body.conflictPolicy ?? 'ask'
  if ((autoApplyTier !== 'low' && autoApplyTier !== 'medium') || (conflictPolicy !== 'ask' && conflictPolicy !== 'local')) return invalid()
  const enabled = bool(body.enabled, false)
  if (enabled && !configured) throw new VaultSyncConfigError('SYNC_CHANNEL_UNCONFIGURED')
  return {
    enabled, interval: interval as SyncChannelState['autosync']['interval'], realtime: bool(body.realtime, true),
    remoteCheckMs: bounded(body.remoteCheckMs, 300000, 15000, 3600000), autoApplyTier, conflictPolicy,
    startupMinIntervalMs: bounded(body.startupMinIntervalMs, 300000, 0, 86400000),
  }
}
function config(transport: VaultSyncChannel, raw: unknown): VaultSyncChannelConfig {
  const body = record(raw)
  if (body.transport !== undefined && body.transport !== transport) return invalid()
  switch (transport) {
    case 'git': {
      const subdir = relative(body.subdir)
      if (subdir && (subdir.length > 512 || !subdir.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(part)))) return invalid()
      const value: VaultSyncChannelConfig = { transport, repoUrl: repository(body.repoUrl), subdir }
      const ref = branch(body.branch)
      if (ref) value.branch = ref
      return value
    }
    case 'webdav':
      return { transport, webdavUrl: url(body.url ?? body.webdavUrl), webdavUsername: text(body.username ?? body.webdavUsername, '', 1024) }
    case 's3': {
      const p = provider(body.provider)
      const region = text(body.region, '', 256), bucket = text(body.bucket, '', 256), accessKeyId = text(body.accessKeyId, '', 1024)
      if (!region || !bucket || !accessKeyId || !/^[A-Za-z0-9._-]+$/u.test(bucket) || !/^[A-Za-z0-9_-]+$/u.test(region)) return invalid()
      const value: VaultSyncChannelConfig = {
        transport, provider: p, endpoint: url(body.endpoint), region, bucket, prefix: relative(body.prefix), accessKeyId,
        pathStyle: bool(body.pathStyle, p === 'minio'),
      }
      if (body.dialectId !== undefined) {
        if (body.dialectId !== 'aws4' && body.dialectId !== 'oss4') return invalid()
        value.dialectId = body.dialectId
      }
      return value
    }
    case 'gist': {
      const gistId = text(body.gistId, '', 128), filePrefix = relative(body.filePrefix, 'dsh-sync')
      if (!/^[a-z0-9_-]+$/iu.test(gistId) || !filePrefix || filePrefix.includes('/')) return invalid()
      return { transport, gistId, apiBaseUrl: url(body.apiBaseUrl ?? 'https://api.github.com'), filePrefix }
    }
  }
}
function fresh(deviceName: string): SyncConfigDocument {
  const state = (): SyncChannelState => ({ selection: selection({}), autosync: autosync({}, false) })
  return { version: 1, deviceId: '', deviceName, active: 'git', channels: { git: state(), webdav: state(), s3: state(), gist: state() } }
}
function parseDocument(raw: unknown): SyncConfigDocument {
  const root = record(raw), states = record(root.channels)
  if (root.version !== 1 || typeof root.deviceId !== 'string' || !UUID.test(root.deviceId) || !text(root.deviceName, '', 256)) return invalid()
  const doc = fresh(text(root.deviceName, '', 256))
  doc.deviceId = root.deviceId
  if (root.active === undefined) return invalid()
  doc.active = channel(root.active)
  for (const type of CHANNELS) {
    const state = record(states[type])
    const cfg = state.config === undefined ? undefined : config(type, state.config)
    doc.channels[type] = { ...(cfg ? { config: cfg } : {}), selection: selection(state.selection), autosync: autosync(state.autosync, !!cfg) }
  }
  if (root.configProviders !== undefined) {
    const providers = record(root.configProviders)
    doc.configProviders = {}
    for (const p of PROVIDERS) {
      if (providers[p] === undefined) continue
      const cfg = config('s3', providers[p])
      if (cfg.provider !== p) return invalid()
      doc.configProviders[p] = cfg
    }
  }
  return doc
}
/** Stable target identity; excludes auth and object-key insertion order. */
export function syncConfigHash(value: VaultSyncChannelConfig): string {
  const safe = config(channel(value.transport), value)
  const sorted = Object.fromEntries(Object.entries(safe).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

type SecretChange = { ref: string; value: string | undefined }
export class VaultSyncConfigStore {
  readonly stateDir: string
  readonly configPath: string
  private readonly secrets: SyncSecretPort
  private readonly deviceName: string
  private readonly slotPrefix: string
  private readonly queueKey: string
  private readonly authorize: (() => void) | undefined
  private generation = 0
  constructor(options: { stateDir: string; secrets: SyncSecretPort; deviceName?: string; authorize?: () => void }) {
    if (!options.stateDir || CONTROL.test(options.stateDir)) invalid()
    this.stateDir = resolve(options.stateDir)
    this.configPath = join(this.stateDir, 'sync-config.json')
    this.secrets = options.secrets
    this.authorize = options.authorize
    this.deviceName = text(options.deviceName ?? hostname(), '', 256) || 'Device'
    const identity = process.platform === 'win32' ? this.stateDir.toLowerCase() : this.stateDir
    this.queueKey = process.platform === 'win32' ? this.configPath.toLowerCase() : this.configPath
    this.slotPrefix = 'DSH_1PASS_SYNC_' + createHash('sha256').update(identity).digest('hex').slice(0, 16).toUpperCase()
  }
  /** S3 auth is provider-scoped. With no provider specified the base S3 provider is selected. */
  secretRef(transport: VaultSyncChannel, kind: SecretKind, s3Provider?: S3Provider): string {
    const type = channel(transport)
    if (!['auth', 'encrypt', 'decrypt'].includes(kind)) return invalid()
    const suffix = type === 's3' && kind === 'auth' ? '_'+provider(s3Provider).toUpperCase() : ''
    return this.slotPrefix + '_' + type.toUpperCase() + suffix + '_' + kind.toUpperCase()
  }
  async getSecret(transport: VaultSyncChannel, kind: SecretKind): Promise<string | undefined> {
    const type = channel(transport)
    const doc = await this.read()
    try { return await this.secrets.get(this.secretRef(type, kind, doc.channels[type].config?.provider)) }
    catch { throw new VaultSyncConfigError('SYNC_SECRET_READ_FAILED') }
  }
  /** Revoke queued and in-flight mutations, including lock-then-unlock races. Reads stay available. */
  revoke(): void { this.generation++ }
  private checkAuthorization(generation: number): void {
    if (generation !== this.generation) throw new VaultSyncConfigError('SYNC_CONFIG_REVOKED')
    try { this.authorize?.() } catch { throw new VaultSyncConfigError('SYNC_CONFIG_NOT_AUTHORIZED') }
  }
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    const tail = current.then(() => {}, () => {})
    queues.set(this.queueKey, tail)
    try { return await current } finally { if (queues.get(this.queueKey) === tail) queues.delete(this.queueKey) }
  }
  private async rawConfig(): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(this.configPath, 'r')
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) return invalid()
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_BYTES) return invalid()
      return bytes.subarray(0, length).toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof VaultSyncConfigError) throw error
      throw new VaultSyncConfigError('SYNC_CONFIG_READ_FAILED')
    } finally { await handle?.close() }
  }
  private async load(): Promise<SyncConfigDocument> {
    const raw = await this.rawConfig()
    if (raw === undefined) return fresh(this.deviceName)
    try { return parseDocument(JSON.parse(raw) as unknown) }
    catch (error) { if (error instanceof VaultSyncConfigError) throw error; throw new VaultSyncConfigError('SYNC_CONFIG_READ_FAILED') }
  }
  async read(): Promise<SyncConfigDocument> {
    await queues.get(this.queueKey)
    return this.load()
  }
  /** No read-time identity writes. A first snapshot must call this before constructing its manifest. */
  async ensureIdentity(): Promise<SyncConfigDocument> {
    const generation = this.generation
    return this.serialized(async () => {
      const doc = await this.load()
      this.checkAuthorization(generation)
      if (!doc.deviceId) await this.commit(doc, [], generation)
      return doc
    })
  }
  private passwordChanges(type: VaultSyncChannel, body: Record<string, unknown>): SecretChange[] {
    const changes: SecretChange[] = []
    for (const kind of ['encrypt', 'decrypt'] as const) {
      const cap = kind === 'encrypt' ? 'Encrypt' : 'Decrypt'
      if (body['clear'+cap+'Password'] === true) changes.push({ ref: this.secretRef(type, kind), value: undefined })
      else if (body[kind+'Password']) changes.push({ ref: this.secretRef(type, kind), value: body[kind+'Password'] as string })
    }
    return changes
  }
  private async commit(doc: SyncConfigDocument, changes: SecretChange[], generation: number): Promise<void> {
    this.checkAuthorization(generation)
    const previous = await this.rawConfig()
    this.checkAuthorization(generation)
    if (!doc.deviceId) doc.deviceId = randomUUID()
    const serialized = JSON.stringify(doc, null, 2) + '\n'
    if (Buffer.byteLength(serialized) > MAX_BYTES) return invalid()
    const backups: SecretChange[] = [], attempted: SecretChange[] = []
    try {
      // Capture every old value before the first write; backups stay exclusively in memory.
      for (const change of changes) backups.push({ ref: change.ref, value: await this.secrets.get(change.ref) })
    } catch { throw new VaultSyncConfigError('SYNC_SECRET_READ_FAILED') }
    let stage: 'secret' | 'config' = 'secret', configWritten = false
    try {
      this.checkAuthorization(generation)
      for (const change of changes) {
        this.checkAuthorization(generation)
        attempted.push(change)
        if (change.value === undefined) await this.secrets.unset(change.ref)
        else await this.secrets.set(change.ref, change.value)
        this.checkAuthorization(generation)
      }
      stage = 'config'
      this.checkAuthorization(generation)
      await writeFileAtomic(this.configPath, serialized, { mode: 0o600, dirMode: 0o700 })
      configWritten = true
      this.checkAuthorization(generation)
    } catch (error) {
      let rollbackFailed = false
      if (configWritten) {
        try {
          if (previous === undefined) await unlink(this.configPath)
          else await writeFileAtomic(this.configPath, previous, { mode: 0o600, dirMode: 0o700 })
        } catch { rollbackFailed = true }
      }
      for (const change of attempted.reverse()) {
        const old = backups.find(item => item.ref === change.ref)!
        try {
          if (old.value === undefined) await this.secrets.unset(old.ref)
          else await this.secrets.set(old.ref, old.value)
        } catch { rollbackFailed = true }
      }
      if (rollbackFailed) throw new VaultSyncConfigError('SYNC_SECRET_ROLLBACK_FAILED')
      if (error instanceof VaultSyncConfigError && ['SYNC_CONFIG_REVOKED', 'SYNC_CONFIG_NOT_AUTHORIZED'].includes(error.code)) throw error
      throw new VaultSyncConfigError(stage === 'secret' ? 'SYNC_SECRET_WRITE_FAILED' : 'SYNC_CONFIG_WRITE_FAILED')
    }
  }
  private async has(type: VaultSyncChannel, kind: SecretKind, s3Provider?: S3Provider): Promise<boolean> {
    try { return await this.secrets.has(this.secretRef(type, kind, s3Provider)) }
    catch { throw new VaultSyncConfigError('SYNC_SECRET_READ_FAILED') }
  }
  private async selectionWire(doc: SyncConfigDocument, type: VaultSyncChannel): Promise<Record<string, unknown>> {
    return { transport: type, ...doc.channels[type].selection,
      encryptPasswordConfigured: await this.has(type, 'encrypt'), decryptPasswordConfigured: await this.has(type, 'decrypt') }
  }
  private async cloudView(cfg: VaultSyncChannelConfig): Promise<Record<string, unknown>> {
    const stored = await this.has(cfg.transport, 'auth', cfg.provider)
    if (cfg.transport === 'gist') return { provider: 'gist', gistId: cfg.gistId, apiBaseUrl: cfg.apiBaseUrl, filePrefix: cfg.filePrefix, secretStored: stored }
    return { provider: cfg.provider, endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, prefix: cfg.prefix,
      accessKeyId: cfg.accessKeyId, pathStyle: cfg.pathStyle, ...(cfg.dialectId ? { dialectId: cfg.dialectId } : {}), secretStored: stored }
  }
  async saveConfig(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = checkBody(payload), type = channel(body.transport)
    if (body.clear === true) return this.clearChannel(type)
    const generation = this.generation
    return this.serialized(async () => {
      const doc = await this.load()
      // The entire merged configuration is normalized/validated before any secret is written.
      const selectedProvider = type === 's3' ? provider(body.provider ?? doc.channels.s3.config?.provider) : undefined
      const previous = selectedProvider ? doc.configProviders?.[selectedProvider] ?? (doc.channels.s3.config?.provider === selectedProvider ? doc.channels.s3.config : undefined) : doc.channels[type].config
      const cfg = config(type, { ...previous, ...body, transport: type })
      doc.channels[type].config = cfg
      doc.active = type
      if (type === 's3') (doc.configProviders ??= {})[cfg.provider!] = cfg
      const changes = this.passwordChanges(type, body)
      const auth = body[type === 'git' ? 'token' : type === 'webdav' ? 'password' : 'secret']
      if (auth) changes.push({ ref: this.secretRef(type, 'auth', cfg.provider), value: auth as string })
      await this.commit(doc, changes, generation)
      const result: Record<string, unknown> = { ok: true, configured: true, transport: type, credentialConfigured: await this.has('git', 'auth') }
      if (type === 'webdav') result.webdav = { usernameConfigured: !!cfg.webdavUsername, passwordConfigured: await this.has(type, 'auth') }
      if (type === 's3' || type === 'gist') result[type] = await this.cloudView(cfg)
      return result
    })
  }
  async saveSelection(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = checkBody(payload), type = channel(body.transport), next = selection(body)
    const generation = this.generation
    return this.serialized(async () => {
      const doc = await this.load()
      doc.channels[type].selection = next
      await this.commit(doc, this.passwordChanges(type, body), generation)
      return this.selectionWire(doc, type)
    })
  }
  async updateAutosync(payload: Record<string, unknown>): Promise<SyncChannelState['autosync']> {
    const body = checkBody(payload), type = channel(body.transport)
    const generation = this.generation
    return this.serialized(async () => {
      const doc = await this.load(), state = doc.channels[type]
      const next = autosync({ ...state.autosync, ...body }, !!state.config)
      state.autosync = next
      await this.commit(doc, [], generation)
      return { ...next }
    })
  }
  async clearChannel(transport: VaultSyncChannel): Promise<Record<string, unknown>> {
    const type = channel(transport), generation = this.generation
    return this.serialized(async () => {
      const doc = await this.load(), removed = !!doc.channels[type].config
      delete doc.channels[type].config
      doc.channels[type].autosync.enabled = false
      const changes: SecretChange[] = ['auth', 'encrypt', 'decrypt'].map(kind => ({ ref: this.secretRef(type, kind as SecretKind), value: undefined }))
      if (type === 's3') {
        delete doc.configProviders
        for (const p of PROVIDERS) changes.push({ ref: this.secretRef('s3', 'auth', p), value: undefined })
      }
      if (doc.active === type) doc.active = CHANNELS.find(item => !!doc.channels[item].config) ?? 'git'
      await this.commit(doc, [...new Map(changes.map(item => [item.ref, item])).values()], generation)
      return { ok: true, cleared: type, removed, configured: CHANNELS.some(item => !!doc.channels[item].config), transport: doc.active }
    })
  }
  async setUiChannel(transport: VaultSyncChannel): Promise<void> {
    const type = channel(transport), generation = this.generation
    await this.serialized(async () => { const doc = await this.load(); doc.active = type; await this.commit(doc, [], generation) })
  }
  async readConfigProvider(value: string): Promise<Record<string, unknown>> {
    const doc = await this.read()
    const cfg = value === 'gist' ? doc.channels.gist.config : doc.configProviders?.[provider(value)]
    return { ok: true, provider: value, ...(cfg ? { config: await this.cloudView(cfg) } : {}) }
  }
  async view(): Promise<Record<string, unknown>> {
    const doc = await this.read(), cfg = doc.channels[doc.active].config
    const selections: Record<string, unknown> = {}, credentials: Record<string, unknown> = {}, autosyncs: Record<string, unknown> = {}
    for (const type of CHANNELS) {
      const wire = await this.selectionWire(doc, type)
      selections[type] = wire
      credentials[type] = { encryptPasswordConfigured: wire.encryptPasswordConfigured, decryptPasswordConfigured: wire.decryptPasswordConfigured }
      autosyncs[type] = { ...doc.channels[type].autosync }
    }
    const git = doc.channels.git.config, dav = doc.channels.webdav.config
    return {
      ok: true, configured: CHANNELS.some(type => !!doc.channels[type].config), credentialConfigured: await this.has('git', 'auth'), credentialWritable: true,
      ...(git ? { repoUrl: git.repoUrl, subdir: git.subdir, ...(git.branch ? { branch: git.branch } : {}) } : {}),
      ...(dav ? { webdav: { url: dav.webdavUrl, username: dav.webdavUsername, usernameConfigured: !!dav.webdavUsername, passwordConfigured: await this.has('webdav', 'auth') } } : {}),
      ...(doc.channels.s3.config ? { s3: await this.cloudView(doc.channels.s3.config) } : {}),
      ...(doc.channels.gist.config ? { gist: await this.cloudView(doc.channels.gist.config) } : {}),
      cloudSavedProviders: [...Object.keys(doc.configProviders ?? {}), ...(doc.channels.gist.config ? ['gist'] : [])],
      ...(cfg ? { transport: { type: doc.active, ref: cfg.repoUrl ?? cfg.webdavUrl ?? cfg.bucket ?? cfg.gistId ?? '' } } : {}),
      lastSyncChannel: doc.active, sectionCount: 0,
      syncSections: [{ id: 'vault', displayName: 'Vault', portability: 'portable', defaultIncluded: true }],
      syncSelection: selections[doc.active], syncSelectionByChannel: selections, syncCredentialsByChannel: credentials,
      autosync: autosyncs[doc.active], autosyncByChannel: autosyncs,
    }
  }
}
