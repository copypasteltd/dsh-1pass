/**
 * The encrypted vault store: a single JSON document on disk holding the KDF
 * parameters and one authenticated-encryption envelope per entry. The whole
 * document is atomically replaced on every mutation (`writeFileAtomic` from
 * `@deepseek-ai/dsh-atomic-write`) and cross-process writers serialize through
 * its companion file lock.
 *
 * All secrets live inside AES-256-GCM envelopes keyed by scrypt(master
 * password). The on-disk document never contains plaintext secrets; the key
 * is never persisted and must be re-derived from the master password on every
 * load.
 *
 * KDF parameters are fixed for the life of a vault (chosen when the document
 * is first created), so loading and persisting always derive the same key.
 *
 * @module dsh-vault/store
 */

import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dshHomePath } from './home-paths.ts'
import {
  decrypt,
  deriveKey,
  encrypt,
  newKdfParams,
  safeEqual,
  VAULT_FORMAT_VERSION,
  type EncryptedBlob,
  type KdfParams,
} from './crypto.ts'

/** Successful encrypted document writes, observed by opt-in backup automation. */
const persistObservers = new Set<(path: string) => void>()
const lockObservers = new Set<(path: string) => void>()
export function onVaultLock(observer: (path: string) => void): () => void {
  lockObservers.add(observer)
  return () => { lockObservers.delete(observer) }
}
export function onVaultPersist(observer: (path: string) => void): () => void {
  persistObservers.add(observer)
  return () => { persistObservers.delete(observer) }
}

/** Signal a successful encrypted replacement, including backup restoration. */
export function notifyVaultPersist(path: string): void {
  for (const observer of persistObservers) {
    try { observer(resolve(path)) } catch { /* independent automation */ }
  }
}

/** JSON-safe value usable inside an entry's arbitrary `fields` map. */
export type FieldValue = string | number | boolean | null | FieldValue[] | { [key: string]: FieldValue }

/** One browser cookie collected from a login session (Playwright shape). */
export interface CookieData {
  /** Cookie name. */
  name: string
  /** Cookie value. */
  value: string
  /** Cookie domain (e.g. `.example.com`). */
  domain: string
  /** Cookie path (default `/`). */
  path: string
  /** Expiry epoch SECONDS; `-1` means a session cookie. */
  expires: number
  /** HttpOnly flag. */
  httpOnly: boolean
  /** Secure flag. */
  secure: boolean
  /** SameSite policy, when the browser reported one. */
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** One file attached to an entry (1Password/KeePass-style). Data is stored
 * base64 inside the encrypted entry, so attachments are encrypted at rest. */
export interface AttachmentData {
  /** Base64-encoded file content. */
  data: string
  /** File name (from the path). */
  name: string
  /** File size in bytes. */
  size: number
  /** MIME type when known (e.g. application/x-pem-file). */
  mime?: string
}

/** Entry categories: general login vs. developer credentials. */
export type VaultEntryKind =
  /** Web/account login (username, email, phone, password). */
  | 'login'
  /** SSH connection (host, port, username, password or privateKey). */
  | 'ssh'
  /** API key (apiKey / secret). */
  | 'api-key'
  /** Generic secret / credential (secret, notes). */
  | 'secret'
  /** OAuth token pair (accessToken, refreshToken, expiresAt). */
  | 'oauth'
  /** Browser session cookies collected after a login (cookies + url). */
  | 'cookie'
  /** Bank/credit card (cardNumber, cardExpiry, cardCvv, cardHolder). */
  | 'card'
  /** Generic key/value record via `fields`. */
  | 'custom'

/** One credential entry. All fields except `id`/`title`/timestamps are optional. */
export interface VaultEntry {
  /** Stable unique id (uuid v4). */
  id: string
  /** Human title, e.g. "GitHub personal". */
  title: string
  /** Entry category; defaults to `login`. */
  kind?: VaultEntryKind
  /** Sensitivity tier: `high` entries (e.g. banking, root SSH) additionally
   * require approval when read in ask mode. Defaults to `normal`. */
  sensitivity?: 'normal' | 'high'
  /** Rotation interval in days; the rotation report lists entries whose
   * `rotationDays` elapsed since `createdAt`/`updatedAt`. */
  rotationDays?: number
  /** Epoch millis when the entry was soft-deleted (moved to trash); absent
   * means the entry is active. Trashed entries are excluded from search/list
   * until purged or restored. */
  deletedAt?: number
  /** Pinned/favorite flag (Bitwarden-style): pinned entries rank first in
   * search and list. */
  favorite?: boolean
  /** Optional emoji/icon shown in the UI. */
  icon?: string
  /** Optional accent color shown in the UI. */
  color?: string
  /** Account username/login. */
  username?: string
  /** Account email. */
  email?: string
  /** Account phone number. */
  phone?: string
  /** The password. */
  password?: string
  /** SSH host or service hostname. */
  host?: string
  /** SSH/service port (string to allow non-numeric protocols). */
  port?: string
  /** SSH private key (PEM). */
  privateKey?: string
  /** SSH authentication variant. Legacy entries infer it from privateKey. */
  sshAuth?: 'password' | 'certificate'
  /** Optional literal IP address separate from the host alias. */
  ip?: string
  /** Optional OpenSSH user certificate; privateKey remains the signing key. */
  certificate?: string
  /** Passphrase protecting privateKey (never exposed in summaries). */
  keyPassphrase?: string
  /** API key. */
  apiKey?: string
  /** Generic secret (client secret, shared secret, …). */
  secret?: string
  /** OAuth access token. */
  accessToken?: string
  /** OAuth refresh token. */
  refreshToken?: string
  /** Token/credential expiry epoch millis. */
  expiresAt?: number
  /**
   * Exact environment-variable names for `vault_env` / `vault_export_env`,
   * e.g. `["DASHSCOPE_API_KEY"]`.
   *
   * Positional: `envKeys[0]` names the entry's primary secret (the first present
   * field in apiKey → secret → accessToken → refreshToken → privateKey →
   * password → cardNumber → cardCvv), `envKeys[1]` the next one, and so on.
   * Secrets beyond the listed names keep the derived `<envKeys[0]>_<SUFFIX>`
   * form, as do custom fields. With no `envKeys`, every name derives from the
   * title (`<TITLE>_<SUFFIX>`). Each name must be a POSIX identifier
   * (`[A-Za-z_][A-Za-z0-9_]*`); duplicates are rejected.
   *
   * `envKey` (singular, string) is accepted as a one-element shorthand.
   */
  envKeys?: string[]
  /** @deprecated single-name shorthand for {@link envKeys}; migrated on load. */
  envKey?: string
  /** TOTP secret: bare Base32 or an otpauth:// URI. */
  otpSecret?: string
  /** Bank/credit card number (kind `card`). */
  cardNumber?: string
  /** Card expiry as `MM/YY` or `MM/YYYY` (kind `card`). */
  cardExpiry?: string
  /** Card CVV/CVC (kind `card`). */
  cardCvv?: string
  /** Card holder name (kind `card`). */
  cardHolder?: string
  /** Associated URL (login page, service home). */
  url?: string
  /** Free-form notes. */
  notes?: string
  /** Searchable tags. */
  tags?: string[]
  /** Browser session cookies (kind `cookie`): the cookies collected after a
   * login, stored as structured CookieData rows. */
  cookies?: CookieData[]
  /** Password history (1Password/Bitwarden-style): previous passwords with
   * the epoch millis when each was superseded. Newest first, capped. */
  passwordHistory?: Array<{ password: string; at: number }>
  /** Files attached to the entry, keyed by file name (encrypted at rest). */
  attachments?: Record<string, AttachmentData>
  /** Arbitrary additional key/value fields (e.g. region, username hint). */
  fields?: Record<string, FieldValue>
  /** Creation epoch millis. */
  createdAt: number
  /** Last-update epoch millis. */
  updatedAt: number
}

/** An entry as returned by search/list — never carries secrets. */
export type VaultEntrySummary = Pick<
  VaultEntry,
  'id' | 'title' | 'kind' | 'sensitivity' | 'favorite' | 'username' | 'email' | 'phone' | 'host' | 'ip' | 'sshAuth' | 'port' | 'url' | 'tags' | 'icon' | 'color'
> & { updatedAt?: number; createdAt?: number; cookieCount?: number; attachmentCount?: number; cardExpiry?: string; cardHolder?: string; hasOtp?: boolean; fields?: Record<string, FieldValue> }

/** The fields `vault_update` may change, mirroring the entry minus identity/timestamps. */
export type VaultEntryPatch = Partial<Omit<VaultEntry, 'id' | 'createdAt' | 'updatedAt'>>

/** On-disk document shape: KDF header plus one encrypted envelope per entry. */
interface VaultFile {
  version: number
  kdf: KdfParams
  /** Password-verification envelope: a fixed plaintext encrypted under the
   * vault key, so a wrong master password fails fast even on an empty vault. */
  verify: EncryptedBlob
  /** One authenticated-encryption blob per entry, in insertion order. */
  entries: Array<EncryptedBlob & { id: string }>
}

/** Fixed plaintext inside the verification envelope. */
const VERIFY_PLAINTEXT = 'dsh-vault:password-ok'

/** Version of the portable encrypted export document (vault_export/vault_import). */
const EXPORT_FORMAT_VERSION = 2

/** Derive the default on-disk path for a named vault. */
export function defaultVaultPath(vaultName = 'default'): string {
  return join(dshHomePath('vault'), `${vaultName}.json`)
}

/**
 * Open (or lazily create) a vault and return a ready-to-use store. Loading
 * decrypts the whole document up front so search and reads are pure in-memory
 * operations.
 */
export async function openVault(options: {
  /** Master password. Required to decrypt; also used to create a new vault. */
  masterPassword: string
  /** Vault file path. Defaults to `$DSH_HOME/vault/default.json`. */
  path?: string
  /** Vault name used only for the default path. */
  name?: string
}): Promise<VaultStore> {
  if (options.masterPassword.length === 0) {
    throw new Error('vault master password must not be empty')
  }
  const path = options.path ?? defaultVaultPath(options.name)
  const store = new VaultStore(path, options.masterPassword)
  await store.load()
  return store
}

/**
 * In-memory vault handle. Mutations persist atomically under the file lock;
 * reads never touch the disk again until a reload.
 */
export class VaultStore {
  private readonly entries = new Map<string, VaultEntry>()
  private readonly path: string
  private readonly masterPassword: string
  /** KDF parameters fixed for this vault's life; set on first load/create. */
  private kdf: KdfParams | undefined
  /** Cached derived key; derived once after load and reused for every persist. */
  private key: Buffer | undefined
  /** Exact encrypted bytes last loaded or successfully committed by this handle. */
  private knownDiskHash: string | undefined
  /** Serializes in-process persist calls so concurrent mutations never
   * contend for the cross-process file lock and every write sees the latest
   * in-memory state. */
  private persistChain: Promise<unknown> = Promise.resolve()
  /** Sync replacement must not race ordinary methods that mutate before persist(). */
  private syncCommitInProgress = false
  private keyChangesInProgress = 0
  private loadInProgress = false
  /** A lock request revokes sync immediately, before its asynchronous audit flush. */
  private syncGeneration = 0
  /** Auto-lock: after this many ms of inactivity the vault re-locks (key
   * wiped). `0`/undefined disables auto-lock. */
  private lockTimeoutMs: number | undefined
  /** Epoch millis of the last operation; used for the auto-lock timer. */
  private lastActivity = Date.now()
  /** Whether the vault is currently locked (key wiped, requires re-unlock). */
  private locked = false
  /** Weak-password heuristic: too short or in a tiny common list. */
  private static readonly MIN_PASSWORD_LENGTH = 12
  /** How many previous passwords to keep per entry (1Password-style). */
  private static readonly MAX_PASSWORD_HISTORY = 10
  /** In-process audit trail: oldest first, capped at AUDIT_CAP. Persisted to
   * an encrypted sidecar file (`<vault>-audit.json`) so activity survives
   * restarts. Events carry only action + entry title + timestamp — the caller
   * must never pass a secret value (see `audit()`). */
  private readonly history: Array<{ action: string; id?: string; title?: string; at: number }> = []
  /** Audit entries retained in memory and in the encrypted log file. */
  private static readonly AUDIT_CAP = 600
  /** Debounce before writing non-mutation events (reads/searches/TOTP/switch)
   * to disk; mutations flush synchronously inside persist(). */
  private static readonly AUDIT_FLUSH_MS = 400
  private auditFlushTimer: ReturnType<typeof setTimeout> | undefined
  /** Serializes sidecar writes so a debounced flush and a persist-triggered
   * flush never interleave partial files. */
  private auditWriteChain: Promise<unknown> = Promise.resolve()

  constructor(path: string, masterPassword: string) {
    this.path = path
    this.masterPassword = masterPassword
  }

  /** Enable auto-lock with the given idle timeout (ms). */
  setAutoLock(timeoutMs: number | undefined): void {
    this.lockTimeoutMs = timeoutMs
    this.lastActivity = Date.now()
  }

  /** Whether the vault is currently locked. */
  get isLocked(): boolean {
    return this.locked
  }

  /** Touch the activity timestamp; call before every read/write. */
  touch(): void {
    this.lastActivity = Date.now()
  }

  /** Whether the auto-lock idle window has elapsed. */
  get expired(): boolean {
    if (this.lockTimeoutMs === undefined || this.lockTimeoutMs <= 0) return false
    return Date.now() - this.lastActivity > this.lockTimeoutMs
  }

  /** Lock the vault: wipe the derived key and require re-unlock. */
  async lock(): Promise<void> {
    this.syncGeneration++
    this.keyChangesInProgress++
    try {
      for (const observer of lockObservers) { try { observer(resolve(this.path)) } catch { /* revoke independent capabilities */ } }
      // Persist the trail before the key is wiped so no recent read/search/TOTP
      // event is lost on lock or process exit.
      if (!this.locked) await this.flushAuditLog().catch(() => {})
      this.key?.fill(0)
      this.key = undefined
      this.locked = true
      this.lastActivity = Date.now()
    } finally { this.keyChangesInProgress-- }
  }

  /** Re-derive the key from the master password (after a lock). */
  async unlock(): Promise<void> {
    this.assertNoSyncCommit()
    this.keyChangesInProgress++
    try {
      if (this.kdf === undefined) {
        await this.load()
        return
      }
      this.key = await deriveKey(this.masterPassword, this.kdf)
      this.locked = false
      this.lastActivity = Date.now()
    } finally { this.keyChangesInProgress-- }
  }

  /**
   * Load the vault document from disk (creating an empty one on first use)
   * and derive the vault key from the document's fixed KDF parameters.
   */
  async load(): Promise<void> {
    this.assertNoSyncCommit()
    this.loadInProgress = true
    this.keyChangesInProgress++
    this.knownDiskHash = undefined
    try {
      // Complete already-admitted local writes before loading an exact disk
      // revision. New ordinary mutations are excluded until publication.
      await this.persistChain
      // Ensure the vault directory exists before any lock-file or document
      // write, so first use never fails with ENOENT on a fresh install.
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      // Best-effort cleanup of a stale writer lock from a crashed process. The
      // lock is an exclusive-create sibling; an orphaned one only costs the next
      // writer its retry timeout, so removing it at open time is safe (no live
      // writer can exist while we are still booting this store).
      await rm(`${this.path}.lock`, { force: true }).catch(() => {})
      // Tighten a pre-existing directory (mkdir leaves existing dirs untouched)
      // so the vault tree stays owner-only even when a parent created it wider.
      await chmod(dirname(this.path), 0o700).catch(() => {})
      const { file, created, diskHash } = await this.readDocument()
      this.kdf = file.kdf
      this.key = await deriveKey(this.masterPassword, file.kdf)
      if (created) {
        // First run: persist the empty document so the file exists with the
        // chosen KDF (and its verify envelope) before any entry is added.
        await this.enqueuePersist()
        this.locked = false
        this.lastActivity = Date.now()
        return
      }
      // Verify the password FIRST, before touching any entry: a wrong password
      // would otherwise surface as a raw AEAD failure ("unable to authenticate
      // data") from whichever entry happens to be decrypted first, for every
      // caller (the CLI, the plugin, the tools).
      try {
        const verify = decrypt(file.verify!, this.key)
        if (!safeEqual(verify, Buffer.from(VERIFY_PLAINTEXT, 'utf8'))) {
          throw new Error('vault master password is incorrect')
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('incorrect')) throw err
        throw new Error('vault master password is incorrect')
      }
      const loaded = new Map<string, VaultEntry>()
      for (const blob of file.entries) {
        const plaintext = decrypt(blob, this.key)
        const entry = JSON.parse(plaintext.toString('utf8')) as VaultEntry
        // Heal timestamps written by an older, laxer build: a catalog template
        // hint ("expiry epoch millis") stored as `expiresAt` makes every read
        // path deal with an invalid date.
        normalizeTimestamps(entry as unknown as Record<string, unknown>)
        loaded.set(entry.id, entry)
      }
      // Restore the persisted audit trail (encrypted sidecar, same key). A
      // missing or unreadable log simply starts fresh.
      const persistedAudit = await this.readAuditLog()
      if (persistedAudit.length > 0) {
        this.history.push(...persistedAudit)
        if (this.history.length > VaultStore.AUDIT_CAP) {
          this.history.splice(0, this.history.length - VaultStore.AUDIT_CAP)
        }
      }
      this.entries.clear()
      for (const [id, entry] of loaded) this.entries.set(id, entry)
      this.knownDiskHash = diskHash
      this.locked = false
      this.lastActivity = Date.now()
    } catch (error) {
      this.knownDiskHash = undefined
      throw error
    } finally { this.loadInProgress = false; this.keyChangesInProgress-- }
  }

  /** The vault file path (useful for messages and debugging). */
  get filePath(): string {
    return this.path
  }

  /** Detached complete sync input, including trash. No disk access, touch or audit. */
  syncSnapshot(): VaultEntry[] {
    this.assertSyncUnlocked()
    try { return JSON.parse(stableSyncJson([...this.entries.values()])) as VaultEntry[] }
    catch { throw new Error('SYNC_INVALID_STATE') }
  }

  /** SHA-256 of every record, ordered by id and recursively sorted object keys. */
  syncFingerprint(): string {
    const snapshot = this.syncSnapshot()
    try { return syncEntriesFingerprint(snapshot) }
    catch { throw new Error('SYNC_INVALID_STATE') }
  }

  /** Cached exact encrypted-document revision, not a fresh disk observation.
   * Callers must compare actual disk bytes with this value before previewing. */
  syncDiskHash(): string {
    this.assertSyncUnlocked()
    if (this.knownDiskHash === undefined) throw new Error('SYNC_LOCAL_CHANGED')
    return this.knownDiskHash
  }

  /** Encrypt local ancestor/rollback metadata without disclosing the vault key. */
  sealLocalSyncState(value: unknown): string {
    this.assertSyncUnlocked()
    let plaintext: Buffer | undefined
    try {
      if (value === undefined) throw new Error()
      plaintext = Buffer.from(stableSyncJson({ magic: LOCAL_SYNC_MAGIC, value }), 'utf8')
      return JSON.stringify({ magic: LOCAL_SYNC_MAGIC, ...encrypt(plaintext, this.key!) })
    } catch { throw new Error('SYNC_INVALID_STATE') }
    finally { plaintext?.fill(0) }
  }

  /** Unseal only our authenticated local-state format, under the current key. */
  unsealLocalSyncState(raw: string): unknown {
    this.assertSyncUnlocked()
    let plaintext: Buffer | undefined
    try {
      const envelope = JSON.parse(raw) as EncryptedBlob & { magic?: unknown }
      if (envelope?.magic !== LOCAL_SYNC_MAGIC) throw new Error()
      plaintext = decrypt(envelope, this.key!)
      const payload = JSON.parse(plaintext.toString('utf8')) as { magic?: unknown; value?: unknown }
      if (payload?.magic !== LOCAL_SYNC_MAGIC || !Object.hasOwn(payload, 'value')) throw new Error()
      return payload.value
    } catch { throw new Error('SYNC_INVALID_STATE') }
    finally { plaintext?.fill(0) }
  }

  /**
   * Replace exactly the confirmed records, retaining their identities/timestamps
   * and trash markers. Validation precedes queue admission. Actual disk bytes
   * must always match this handle's known loaded/committed revision. The optional
   * caller preview hash must match that same revision; it cannot bless a newer
   * file that this handle has never loaded.
   */
  async replaceForSync(entries: VaultEntry[], expectedFingerprint: string, authorize: () => void, expectedDiskHash?: string): Promise<void> {
    const input = validateSyncEntries(entries)
    if (typeof authorize !== 'function' || !isSyncHash(expectedFingerprint)
      || (expectedDiskHash !== undefined && !isSyncHash(expectedDiskHash))) throw new Error('SYNC_INVALID_INPUT')
    this.assertSyncUnlocked()
    const diskHash = this.syncDiskHash()
    if (expectedDiskHash !== undefined && expectedDiskHash !== diskHash) throw new Error('SYNC_LOCAL_CHANGED')
    const key = this.key!
    const kdf = this.kdf!
    const generation = this.syncGeneration
    const run = async (): Promise<void> => {
      this.assertNoSyncCommit()
      this.assertSyncUnlocked()
      let committed = false
      const check = (): void => {
        try { authorize() } catch { throw new Error('SYNC_NOT_AUTHORIZED') }
        this.assertSyncUnlocked()
        if (this.key !== key || this.kdf !== kdf || this.syncGeneration !== generation) throw new Error('SYNC_LOCKED')
        if (this.knownDiskHash !== diskHash || this.syncFingerprint() !== expectedFingerprint) throw new Error('SYNC_LOCAL_CHANGED')
      }
      try {
        check()
        const { withFileLock, writeFileAtomic } = await atomicWrite()
        check()
        await withFileLock(this.path, async () => {
          check()
          const previous = await readFile(this.path)
          check()
          const previousText = previous.toString('utf8')
          if (!Buffer.from(previousText, 'utf8').equals(previous)) throw new Error('SYNC_INVALID_STATE')
          if (createHash('sha256').update(previous).digest('hex') !== diskHash) {
            throw new Error('SYNC_LOCAL_CHANGED')
          }
          this.syncCommitInProgress = true
          check()
          const file: VaultFile = {
            version: VAULT_FORMAT_VERSION, kdf,
            verify: encrypt(Buffer.from(VERIFY_PLAINTEXT, 'utf8'), key),
            entries: input.map(entry => ({ id: entry.id, ...encrypt(Buffer.from(JSON.stringify(entry), 'utf8'), key) })),
          }
          check()
          const serialized = JSON.stringify(file)
          await writeFileAtomic(this.path, serialized, { mode: 0o600, dirMode: 0o700 })
          try { check() }
          catch (error) {
            // Revocation may arrive during the atomic writer's await. Keep the
            // original encrypted document and memory instead of publishing a
            // result that no longer has authorization. The file lock is held.
            try { await writeFileAtomic(this.path, previousText, { mode: 0o600, dirMode: 0o700 }) }
            catch { this.knownDiskHash = undefined; throw new Error('SYNC_ROLLBACK_FAILED') }
            throw error
          }
          // No await between the final guard and publication. Ordinary CRUD is
          // excluded until this map contains the successfully written records.
          this.entries.clear()
          for (const entry of input) this.entries.set(entry.id, entry)
          this.knownDiskHash = createHash('sha256').update(serialized).digest('hex')
          this.recordHistory('sync')
          committed = true
        })
        this.syncCommitInProgress = false
        notifyVaultPersist(this.path)
        await this.flushAuditLog().catch(() => { /* encrypted audit cannot undo a committed sync */ })
      } catch (error) {
        if (committed) {
          // withFileLock also awaits lock-file cleanup after the callback. If
          // that fails, disk and memory already committed: never report this as
          // a safe-to-retry precommit write failure.
          this.syncCommitInProgress = false
          notifyVaultPersist(this.path)
          await this.flushAuditLog().catch(() => {})
          throw new Error('SYNC_COMMIT_UNCERTAIN')
        }
        const message = error instanceof Error ? error.message : ''
        if (SYNC_ERRORS.has(message)) throw new Error(message)
        throw new Error('SYNC_WRITE_FAILED')
      } finally { this.syncCommitInProgress = false }
    }
    const pending = this.persistChain.then(run, run)
    this.persistChain = pending.catch(() => {})
    return pending
  }

  private assertNoSyncCommit(): void {
    if (this.syncCommitInProgress || this.loadInProgress) throw new Error('SYNC_BUSY')
  }

  private assertSyncUnlocked(): void {
    if (this.locked || this.expired || !this.key || !this.kdf || this.keyChangesInProgress > 0) throw new Error('SYNC_LOCKED')
  }

  /** All active (non-trashed) entries, in insertion order. */
  list(): VaultEntry[] {
    return [...this.entries.values()].filter(entry => entry.deletedAt === undefined)
  }

  /** All trashed entries (soft-deleted, awaiting purge or restore). */
  listTrash(): VaultEntry[] {
    return [...this.entries.values()].filter(entry => entry.deletedAt !== undefined)
  }

  /** Read one active entry by id. */
  get(id: string): VaultEntry | undefined {
    const entry = this.entries.get(id)
    return entry !== undefined && entry.deletedAt === undefined ? entry : undefined
  }

  /** Read one entry by id, including trashed entries. */
  getIncludingTrash(id: string): VaultEntry | undefined {
    return this.entries.get(id)
  }

  /** Search entries across text fields; returns summaries without secrets.
   * Multiple whitespace-separated terms match when ANY term hits (OR).
   * Results are relevance-ranked: title prefix matches first, then title
   * contains, then any-field matches. */
  search(query: string, limit = 20): VaultEntrySummary[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    // Audit non-empty searches (the query itself is the caller's input, not a
    // stored secret); empty queries are list refreshes and stay silent.
    if (terms.length > 0) this.audit('search', undefined, query.trim())
    const ranked: Array<{ entry: VaultEntry; rank: number }> = []
    for (const entry of this.list()) {
      // Empty terms (query omitted) match everything: rank them all equally.
      const rank = terms.length === 0 ? 0 : relevanceRank(entry, terms)
      if (rank >= 0) ranked.push({ entry, rank })
    }
    ranked.sort((a, b) => a.rank - b.rank || Number(Boolean(b.entry.favorite)) - Number(Boolean(a.entry.favorite)))
    return ranked.slice(0, limit).map(r => toSummary(r.entry))
  }

  /** Search using a regular expression (case-insensitive); no secrets in results. */
  searchRegex(pattern: string, limit = 20): VaultEntrySummary[] {
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      return []
    }
    const results: VaultEntrySummary[] = []
    for (const entry of this.list()) {
      if (results.length >= limit) break
      if (regexMatches(entry, re)) results.push(toSummary(entry))
    }
    return results
  }

  /** Add a new entry; returns the stored entry with its assigned id. Empty
   * strings and empty arrays from the client form are dropped (a blank form
   * field means "not provided", not "store an empty value"). */
  async add(patch: VaultEntryPatch & { title: string }): Promise<VaultEntry> {
    this.assertNoSyncCommit()
    const now = Date.now()
    validatePatchTypes(patch as unknown as Record<string, unknown>)
    const entry: VaultEntry = {
      id: randomUUID(),
      title: patch.title,
      ...pickDefined(patch, { skipEmpty: true }),
      createdAt: now,
      updatedAt: now,
    }
    if ((patch as Record<string, unknown>).rotationDays === 0) {
      delete (entry as unknown as Record<string, unknown>).rotationDays
    }
    // Canonicalise: fold a legacy `envKey` into `envKeys` (and drop a zero
    // timestamp) so every reader sees one shape.
    normalizeTimestamps(entry as unknown as Record<string, unknown>)
    this.entries.set(entry.id, entry)
    this.recordHistory('add', entry.id, entry.title)
    await this.persist()
    return entry
  }

  /** Validate all rows before a single encrypted document commit. No partial batch on write failure. */
  async addMany(patches: Array<VaultEntryPatch & { title: string }>, uniqueBy?: (entry: VaultEntryPatch & { title: string }) => string, authorize?: () => void): Promise<VaultEntry[]> {
    this.assertNoSyncCommit()
    if (!Array.isArray(patches) || patches.length > 500) throw new Error('vault: batch must contain at most 500 entries')
    const input = structuredClone(patches)
    for (const patch of input) {
      validatePatchTypes(patch as unknown as Record<string, unknown>)
      if (typeof patch.title !== 'string' || patch.title.trim().length === 0) throw new Error('vault: batch title must not be empty')
    }
    if (input.length === 0) return []
    const run = async (): Promise<VaultEntry[]> => {
      authorize?.()
      if (this.locked || this.expired) throw new Error('vault: batch import requires an unlocked vault')
      // Duplicate decisions belong inside the serialized transaction, not in a stale preview.
      const existing = uniqueBy ? new Set(this.list().map(uniqueBy)) : undefined
      const selected = input.filter(patch => {
        if (!existing || !uniqueBy) return true
        const key = uniqueBy(patch)
        if (existing.has(key)) return false
        existing.add(key); return true
      })
      if (selected.length === 0) return []
      const now = Date.now()
      const added = selected.map(patch => {
        const entry: VaultEntry = { ...pickDefined(patch, { skipEmpty: true }), id: randomUUID(), title: patch.title.trim(), createdAt: now, updatedAt: now }
        normalizeTimestamps(entry as unknown as Record<string, unknown>)
        return entry
      })
      const kdf = this.kdf ?? newKdfParams()
      const key = this.key
      if (!key) throw new Error('vault: batch import requires an unlocked vault')
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const { withFileLock, writeFileAtomic } = await atomicWrite()
      let committedHash: string | undefined
      await withFileLock(this.path, async () => {
        authorize?.()
        if (this.locked || this.expired || this.key !== key) throw new Error('vault: batch import requires an unlocked vault')
        const file: VaultFile = {
          version: VAULT_FORMAT_VERSION, kdf,
          verify: encrypt(Buffer.from(VERIFY_PLAINTEXT, 'utf8'), key),
          entries: [...this.entries.values(), ...added].map(entry => ({ id: entry.id, ...encrypt(Buffer.from(JSON.stringify(entry), 'utf8'), key) })),
        }
        const serialized = JSON.stringify(file)
        await writeFileAtomic(this.path, serialized, { mode: 0o600, dirMode: 0o700 })
        committedHash = createHash('sha256').update(serialized).digest('hex')
      })
      // Only make imported entries visible after the atomic document replacement succeeded.
      for (const entry of added) {
        this.entries.set(entry.id, entry)
        this.recordHistory('add', entry.id, entry.title)
      }
      this.knownDiskHash = committedHash
      notifyVaultPersist(this.path)
      await this.flushAuditLog().catch(() => {})
      return added
    }
    const pending = this.persistChain.then(run, run)
    this.persistChain = pending.catch(() => {})
    return pending
  }

  /** Pin or unpin an entry (favorite); returns the updated entry or undefined. */
  async setFavorite(id: string, favorite: boolean): Promise<VaultEntry | undefined> {
    this.assertNoSyncCommit()
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt !== undefined) return undefined
    if (favorite) entry.favorite = true
    else delete entry.favorite
    entry.updatedAt = Date.now()
    await this.persist()
    return entry
  }

  /** Record one event in the audit trail (oldest first) and schedule a
   * debounced sidecar flush for events that do not ride on a mutation's
   * persist() (mutation events flush synchronously inside persist()). */
  private recordHistory(action: string, id?: string, title?: string): void {
    this.history.push({
      action,
      ...(id !== undefined ? { id } : {}),
      ...(title !== undefined ? { title } : {}),
      at: Date.now(),
    })
    if (this.history.length > VaultStore.AUDIT_CAP) this.history.shift()
    this.scheduleAuditFlush()
  }

  private scheduleAuditFlush(): void {
    if (this.auditFlushTimer !== undefined) return
    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = undefined
      void this.flushAuditLog().catch(() => { /* audit writes never break the vault */ })
    }, VaultStore.AUDIT_FLUSH_MS)
    // A pending debounce must not keep the process alive just to write logs.
    this.auditFlushTimer.unref?.()
  }

  /** Encrypt the current audit trail into the sidecar file. Serialized so a
   * debounced flush and a persist-triggered flush cannot interleave. Each
   * flush writes the newest full trail, so a queued older flush is harmless. */
  flushAuditLog(): Promise<void> {
    const run = async (): Promise<void> => {
      const key = this.key
      if (key === undefined || this.locked || this.history.length === 0) return
      // Only events that may be needed later are retained; a fresh read of the
      // file just rewrites the newest AUDIT_CAP events.
      const retained = this.history.slice(-VaultStore.AUDIT_CAP)
      const file = {
        kdf: this.kdf,
        events: encrypt(Buffer.from(JSON.stringify(retained), 'utf8'), key),
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const { writeFileAtomic } = await atomicWrite()
      await writeFileAtomic(this.auditPath, JSON.stringify(file), {
        mode: 0o600,
        dirMode: 0o700,
      })
    }
    const next = this.auditWriteChain.then(run, run)
    this.auditWriteChain = next.catch(() => {})
    return next
  }

  /** Sidecar file holding the encrypted audit trail (owner-only). */
  private get auditPath(): string {
    return this.path.replace(/\.json$/i, '-audit.json')
  }

  /** Read and decrypt the audit sidecar; tolerates absence and corruption
   * (a damaged audit log must never block vault access — it is rewritten on
   * the next flush). */
  private async readAuditLog(): Promise<Array<{ action: string; id?: string; title?: string; at: number }>> {
    let raw: string
    try {
      raw = await readFile(this.auditPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const key = this.key
      if (key === undefined) return []
      const file = JSON.parse(raw) as { kdf?: unknown; events: EncryptedBlob }
      if (!file || !file.events || typeof file.events !== 'object') return []
      const plaintext = decrypt(file.events as EncryptedBlob, key)
      const parsed = JSON.parse(plaintext.toString('utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((e): e is { action: string; id?: string; title?: string; at: number } =>
        typeof e === 'object' && e !== null && typeof (e as { action?: unknown }).action === 'string')
    } catch (error) {
      // Never fail the vault because a log is unreadable (tampered/corrupt/
      // foreign-keyed): drop it and let the next flush write a fresh one.
      console.warn('dsh-vault: audit log unreadable — starting a fresh log', (error as Error)?.message ?? '')
      return []
    }
  }

  /** Public audit hook for host-layer read operations (vault_get, UI get,
   * TOTP generation, searches, vault switches). SECURITY: callers must only
   * pass the entry's *title* (user-chosen metadata) — never a username,
   * password, key, token, OTP secret or any other secret value. */
  audit(action: 'read' | 'totp' | 'search' | 'switch', id?: string, title?: string): void {
    if (title !== undefined && title.length > 80) title = title.slice(0, 80)
    this.recordHistory(action, id, title)
  }

  /** Recent mutation history (audit trail), newest first. No secrets. */
  getHistory(): Array<{ action: string; id?: string; title?: string; at: number }> {
    return [...this.history].reverse()
  }

  /** Insert an entry directly (used by bulk import); caller owns timestamps. */
  insertDirect(entry: VaultEntry): void {
    this.assertNoSyncCommit()
    this.entries.set(entry.id, entry)
  }

  /** Update an existing entry's fields; returns the updated entry or undefined.
   * Every defined field in `patch` replaces the stored value; an empty string
   * clears (removes) that field. `id`/`createdAt` can never change. */
  async update(id: string, patch: VaultEntryPatch): Promise<VaultEntry | undefined> {
    this.assertNoSyncCommit()
    const current = this.entries.get(id)
    if (!current) return undefined
    // A title must never be blanked out: an empty-string title is an error
    // rather than a request to remove the entry's identity.
    if ('title' in patch && (patch.title ?? '').trim().length === 0) {
      throw new Error('vault: title must not be empty')
    }
    // Validate typed fields so a bad model argument can never corrupt an entry.
    validatePatchTypes(patch)
    const updated: VaultEntry = {
      ...current,
      ...pickDefined(patch, { allowTitle: true }),
      updatedAt: Date.now(),
    }
    // An empty string means "clear this field": drop it entirely instead of
    // storing a blank value, so search and summaries never surface it.
    const record = updated as unknown as Record<string, unknown>
    for (const key of Object.keys(patch)) {
      if ((patch as Record<string, unknown>)[key] === '') {
        delete record[key]
      }
    }
    this.entries.set(id, updated)
    // rotationDays: 0 means "never rotate"; expiresAt: 0 means "no expiry".
    // Clear the field entirely instead of keeping a zero value that would
    // report due/expired forever.
    const record2 = updated as unknown as Record<string, unknown>
    if ('rotationDays' in patch && (patch.rotationDays ?? 0) === 0) {
      delete record2.rotationDays
    }
    if ('expiresAt' in patch && (patch.expiresAt ?? 0) === 0) {
      delete record2.expiresAt
    }
    // Password history: when the password changes (to a different non-empty
    // value), record the old one (1Password/Bitwarden-style). Keep the newest
    // MAX_PASSWORD_HISTORY entries.
    if ('password' in patch && typeof patch.password === 'string' && patch.password.length > 0
      && current.password !== undefined && current.password !== patch.password) {
      // Monotonic timestamp: rapid back-to-back updates can share a millisecond,
      // which would make the newest-first sort unstable. Clamp to one more than
      // the newest existing stamp so order is deterministic.
      const newest = (current.passwordHistory ?? []).reduce((m, h) => Math.max(m, h.at), 0)
      const at = Math.max(Date.now(), newest + 1)
      const history = [...(current.passwordHistory ?? []), { password: current.password, at }]
        .sort((a, b) => b.at - a.at)
        .slice(0, VaultStore.MAX_PASSWORD_HISTORY)
      updated.passwordHistory = history
    }
    // `updated` is the same object stored in the map, so the deletes above
    // already took effect in place. Clearing through the legacy single-name
    // field (`envKey: ''`) must also drop the canonical list; an empty
    // `envKeys` array is dropped by the normaliser below.
    if ('envKey' in patch && (patch as Record<string, unknown>).envKey === '') {
      delete (updated as unknown as Record<string, unknown>).envKeys
    }
    normalizeTimestamps(updated as unknown as Record<string, unknown>)
    this.recordHistory('update', id, updated.title)
    await this.persist()
    return updated
  }

  /** Soft-delete an entry (move to trash); returns true when it existed.
   * The entry stays encrypted on disk until purged or restored. */
  async delete(id: string): Promise<boolean> {
    this.assertNoSyncCommit()
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt !== undefined) return false
    entry.deletedAt = Date.now()
    this.recordHistory('delete', id, entry.title)
    await this.persist()
    return true
  }

  /** Restore a trashed entry; returns true when it existed in trash. */
  async restore(id: string): Promise<boolean> {
    this.assertNoSyncCommit()
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt === undefined) return false
    delete entry.deletedAt
    this.recordHistory('restore', id, entry.title)
    await this.persist()
    return true
  }

  /** Undo the most recent delete: restore the trashed entry deleted last.
   * Returns the restored summary (or undefined when the trash is empty). */
  async restoreRecent(): Promise<VaultEntrySummary | undefined> {
    this.assertNoSyncCommit()
    const trashed = this.listTrash().sort((a, b) => ((b.deletedAt ?? 0) - (a.deletedAt ?? 0)) || b.id.localeCompare(a.id))
    const latest = trashed[0]
    if (!latest) return undefined
    delete latest.deletedAt
    this.recordHistory('restore', latest.id, latest.title)
    await this.persist()
    return toSummary(latest)
  }

  /** Permanently remove a trashed (or active) entry; returns true when it existed. */
  async purge(id: string): Promise<boolean> {
    this.assertNoSyncCommit()
    const existed = this.entries.delete(id)
    if (existed) {
      this.recordHistory('purge', id)
      await this.persist()
    }
    return existed
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size
  }

  /** Whether the vault is unlocked (loaded) with a usable key. */
  get unlocked(): boolean {
    return this.key !== undefined
  }

  /**
   * Rotation & expiry report: entries whose `rotationDays` elapsed since
   * their last update, or whose `expiresAt` is near/past. Returns only
   * summaries plus the computed due state (no secrets).
   */
  rotationReport(now = Date.now(), soonWindowDays = 7): Array<VaultEntrySummary & { due: 'expired' | 'due' | 'soon'; daysLeft: number }> {
    const report: Array<VaultEntrySummary & { due: 'expired' | 'due' | 'soon'; daysLeft: number }> = []
    for (const entry of this.list()) {
      const base = entry.updatedAt ?? entry.createdAt
      const rotationDays = entry.rotationDays !== undefined && entry.rotationDays > 0 ? entry.rotationDays : undefined
      const rotationAt = rotationDays !== undefined ? base + rotationDays * 86_400_000 : undefined
      const expiresAt = entry.expiresAt
      let due: 'expired' | 'due' | 'soon' | undefined
      let daysLeft: number
      if (rotationAt !== undefined && now >= rotationAt) {
        due = 'due'
        daysLeft = 0
      } else if (expiresAt !== undefined && now >= expiresAt) {
        due = 'expired'
        daysLeft = 0
      } else if (expiresAt !== undefined) {
        daysLeft = Math.ceil((expiresAt - now) / 86_400_000)
        if (daysLeft <= soonWindowDays) {
          due = 'soon'
        }
      } else if (rotationAt !== undefined) {
        daysLeft = Math.ceil((rotationAt - now) / 86_400_000)
        if (daysLeft <= soonWindowDays) {
          due = 'soon'
        }
      } else {
        continue
      }
      if (due === undefined) continue
      report.push({ ...toSummary(entry), due, daysLeft })
    }
    // Most urgent first: expired < rotation-due < soon, then fewest days left.
    const severity = { expired: 0, due: 1, soon: 2 } as const
    return report.sort((a, b) => severity[a.due] - severity[b.due] || a.daysLeft - b.daysLeft)
  }

  /** Advanced multi-criteria search: title/username/kind/tag text + created-after. */
  advancedSearch(criteria: {
    title?: string
    username?: string
    kind?: string
    tag?: string
    createdAfter?: number
    createdBefore?: number
    favoriteOnly?: boolean
    limit?: number
  }): VaultEntrySummary[] {
    const limit = criteria.limit ?? 20
    const t = criteria.title?.toLowerCase()
    const u = criteria.username?.toLowerCase()
    const results: VaultEntrySummary[] = []
    for (const entry of this.list()) {
      if (results.length >= limit) break
      if (t !== undefined && !entry.title.toLowerCase().includes(t)) continue
      if (u !== undefined && !(entry.username ?? entry.email ?? '').toLowerCase().includes(u)) continue
      if (criteria.kind !== undefined && (entry.kind ?? 'login') !== criteria.kind) continue
      if (criteria.tag !== undefined && !(entry.tags ?? []).includes(criteria.tag)) continue
      if (criteria.createdAfter !== undefined && entry.createdAt < criteria.createdAfter) continue
      if (criteria.createdBefore !== undefined && entry.createdAt > criteria.createdBefore) continue
      if (criteria.favoriteOnly === true && entry.favorite !== true) continue
      results.push(toSummary(entry))
    }
    return results
  }

  /** Vault overview statistics (1Password-style): counts by kind, TOTP,
   * high-sensitivity, expired entries. No secrets. */
  stats(): { total: number; byKind: Record<string, number>; byTag: Record<string, number>; withTotp: number; withPrivateKey: number; highSensitivity: number; expired: number; recent7d: number; trashCount: number; duplicates: number; favoriteCount: number } {
    const byKind: Record<string, number> = {}
    const byTag: Record<string, number> = {}
    let withTotp = 0
    let withPrivateKey = 0
    let highSensitivity = 0
    let expired = 0
    let recent7d = 0
    const now = Date.now()
    const weekAgo = now - 7 * 86_400_000
    const byTitle = new Map<string, number>()
    for (const entry of this.list()) {
      byTitle.set(entry.title.toLowerCase(), (byTitle.get(entry.title.toLowerCase()) ?? 0) + 1)
    }
    let duplicates = 0
    for (const count of byTitle.values()) if (count > 1) duplicates++
    for (const entry of this.list()) {
      const kind = entry.kind ?? 'login'
      byKind[kind] = (byKind[kind] ?? 0) + 1
      for (const tag of entry.tags ?? []) byTag[tag] = (byTag[tag] ?? 0) + 1
      if (entry.otpSecret !== undefined) withTotp++
      if (entry.privateKey !== undefined) withPrivateKey++
      if (entry.sensitivity === 'high') highSensitivity++
      if (entry.expiresAt !== undefined && entry.expiresAt < now) expired++
      if (entry.createdAt >= weekAgo) recent7d++
    }
    return { total: this.list().length, byKind, byTag, withTotp, withPrivateKey, highSensitivity, expired, recent7d, trashCount: this.listTrash().length, duplicates, favoriteCount: this.list().filter(e => e.favorite === true).length }
  }

  /** Merge `fromId` into `toId`: non-empty fields of `from` fill gaps in `to`,
   * then `from` is purged. Returns the merged entry or undefined. */
  async merge(fromId: string, toId: string, options: { keepSource?: boolean } = {}): Promise<VaultEntry | undefined> {
    this.assertNoSyncCommit()
    const from = this.entries.get(fromId)
    const to = this.entries.get(toId)
    if (!from || !to || from.deletedAt !== undefined || to.deletedAt !== undefined) return undefined
    const merged: VaultEntry = { ...to }
    for (const [key, value] of Object.entries(from)) {
      const typed = merged as unknown as Record<string, unknown>
      const existing = typed[key]
      if ((existing === undefined || existing === '') && value !== undefined && value !== '') {
        ;(typed[key] as unknown) = value
      }
    }
    merged.updatedAt = Date.now()
    this.entries.set(toId, merged)
    if (options.keepSource !== true) {
      this.entries.delete(fromId)
    }
    this.recordHistory('merge', toId, to.title)
    await this.persist()
    return merged
  }

  /** Touch an entry's updatedAt (mark as recently used); no other change. */
  async markUsed(id: string): Promise<VaultEntry | undefined> {
    this.assertNoSyncCommit()
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt !== undefined) return undefined
    entry.updatedAt = Date.now()
    await this.persist()
    return entry
  }

  /** The password history of an entry (newest first), or [] when none. */
  passwordHistoryOf(id: string): Array<{ password: string; at: number }> {
    const entry = this.entries.get(id)
    if (!entry) return []
    return [...(entry.passwordHistory ?? [])].sort((a, b) => b.at - a.at)
  }

  /** Roll the entry's password back to a stored history entry (by `at` epoch
   * millis). The current password is pushed onto the history first (so the
   * rollback itself is reversible). Returns the updated entry. */
  async rollbackPassword(id: string, at: number): Promise<VaultEntry | undefined> {
    this.assertNoSyncCommit()
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const history = [...(entry.passwordHistory ?? [])].sort((a, b) => b.at - a.at)
    const target = history.find(h => h.at === at)
    if (target === undefined) return undefined
    const currentPassword = entry.password
    const next = [...history.filter(h => h.at !== at), ...(currentPassword !== undefined ? [{ password: currentPassword, at: Date.now() }] : [])]
      .sort((a, b) => b.at - a.at)
      .slice(0, VaultStore.MAX_PASSWORD_HISTORY)
    const updated = { ...entry, password: target.password, passwordHistory: next, updatedAt: Date.now() }
    this.entries.set(id, updated)
    this.recordHistory('rollback', id, updated.title)
    await this.persist()
    return updated
  }

  /** Activity within the last `windowMs`: entries created, updated, or
   * soft-deleted in that window, with their action. No secrets. */
  changes(windowMs = 24 * 60 * 60 * 1000, now = Date.now()): Array<VaultEntrySummary & { action: 'created' | 'updated' | 'deleted'; at: number }> {
    const since = now - windowMs
    const out: Array<VaultEntrySummary & { action: 'created' | 'updated' | 'deleted'; at: number }> = []
    for (const entry of this.entries.values()) {
      if (entry.deletedAt !== undefined) {
        if (entry.deletedAt >= since) out.push({ ...toSummary(entry), action: 'deleted', at: entry.deletedAt })
      } else if (entry.createdAt >= since && entry.updatedAt - entry.createdAt < 60_000) {
        out.push({ ...toSummary(entry), action: 'created', at: entry.createdAt })
      } else if (entry.updatedAt >= since) {
        out.push({ ...toSummary(entry), action: 'updated', at: entry.updatedAt })
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /** Most recently created/updated entries (Bitwarden-style "recent"),
   * returned as summaries without secrets. */
  recent(limit = 10): VaultEntrySummary[] {
    return [...this.list()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(toSummary)
  }

  /**
   * Health scan: weak passwords (too short), and passwords/API keys reused
   * across entries. Returns non-secret findings keyed by entry id.
   */
  health(): {
    weak: Array<VaultEntrySummary>
    reused: Array<{ value: string; entries: VaultEntrySummary[] }>
    strength: { weak: number; fair: number; strong: number }
    no2fa: Array<VaultEntrySummary>
    httpSites: Array<VaultEntrySummary>
    score: number
    verdict: 'good' | 'fair' | 'poor'
  } {
    const weak: VaultEntrySummary[] = []
    const strength = { weak: 0, fair: 0, strong: 0 }
    const no2fa: VaultEntrySummary[] = []
    const httpSites: VaultEntrySummary[] = []
    const passwordCounts = new Map<string, VaultEntrySummary[]>()
    const keyCounts = new Map<string, VaultEntrySummary[]>()
    const now = Date.now()
    for (const entry of this.list()) {
      const summary = toSummary(entry)
      const kind = entry.kind ?? 'login'
      // Inactive 2FA (Bitwarden report): a credential with a password but no
      // TOTP secret on an account kind that supports it.
      if (entry.password !== undefined && (kind === 'login' || kind === 'ssh') && entry.otpSecret === undefined) {
        no2fa.push(summary)
      }
      // Unsecured websites (Bitwarden report): http:// URLs.
      if (typeof entry.url === 'string' && /^http:\/\//i.test(entry.url)) {
        httpSites.push(summary)
      }
      if (entry.password !== undefined) {
        const len = entry.password.length
        if (len < VaultStore.MIN_PASSWORD_LENGTH) { weak.push(summary); strength.weak++ }
        else if (len < 20) strength.fair++
        else strength.strong++
        const list = passwordCounts.get(entry.password) ?? []
        list.push(summary)
        passwordCounts.set(entry.password, list)
      }
      for (const key of [entry.apiKey, entry.accessToken, entry.refreshToken, entry.secret]) {
        if (key === undefined) continue
        const list = keyCounts.get(key) ?? []
        list.push(summary)
        keyCounts.set(key, list)
      }
      void now
    }
    const reused = [
      ...[...passwordCounts.entries()].filter(([, v]) => v.length > 1),
      ...[...keyCounts.entries()].filter(([, v]) => v.length > 1),
    ].map(([value, entries]) => ({ value, entries }))
    // Vault security score (Bitwarden-style): start at 100 and deduct for the
    // concrete risks found, floored at 0.
    let score = 100
    score -= Math.min(weak.length * 10, 40)
    score -= Math.min(reused.length * 15, 30)
    score -= Math.min(no2fa.length * 5, 20)
    score -= Math.min(httpSites.length * 5, 10)
    score -= Math.min([...this.list()].filter(e => e.expiresAt !== undefined && e.expiresAt < now).length * 5, 15)
    score = Math.max(0, score)
    const verdict = score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor'
    return { weak, reused, strength, no2fa, httpSites, score, verdict }
  }

  /**
   * Export the whole vault (including trash) as a single encrypted blob under
   * a separate export password: a portable, machine-independent document that
   * can be re-imported elsewhere. Returns the armored JSON string.
   */
  async exportEncrypted(exportPassword: string, now = Date.now(), onlyIds?: Set<string>): Promise<string> {
    if (exportPassword.length === 0) throw new Error('vault: export password must not be empty')
    const exportKdf = newKdfParams()
    const exportKey = await deriveKey(exportPassword, exportKdf)
    const entries = onlyIds === undefined
      ? [...this.entries.values()]
      : [...this.entries.values()].filter(e => onlyIds.has(e.id))
    const payload = {
      format: EXPORT_FORMAT_VERSION,
      vaultName: basename(this.path).replace(/\.json$/, ''),
      exportedAt: now,
      kdf: exportKdf,
      entries: entries.map(entry => ({
        id: entry.id,
        ...encrypt(Buffer.from(JSON.stringify(entry), 'utf8'), exportKey),
      })),
    }
    exportKey.fill(0)
    return JSON.stringify(payload)
  }

  /**
   * Import an exported vault blob, merging entries by id (existing entries win
   * unless `overwrite`). Returns the number of entries added.
   */
  async importEncrypted(blob: string, exportPassword: string, overwrite = false, dryRun = false): Promise<number> {
    this.assertNoSyncCommit()
    if (exportPassword.length === 0) throw new Error('vault: export password must not be empty')
    const parsed = JSON.parse(blob) as {
      format?: number
      kdf: KdfParams
      entries: Array<EncryptedBlob & { id: string }>
    }
    if (parsed.format !== undefined && parsed.format > EXPORT_FORMAT_VERSION) {
      throw new Error(`vault: export document format ${parsed.format} is newer than supported ${EXPORT_FORMAT_VERSION} — upgrade dsh-vault and retry`)
    }
    if (!parsed.kdf || !Array.isArray(parsed.entries)) {
      throw new Error('vault: invalid export document — expected { kdf, entries[] } from vault_export')
    }
    if (parsed.entries.length === 0) {
      return 0
    }
    const exportKey = await deriveKey(exportPassword, parsed.kdf)
    // A sync may have started while the export KDF was running.
    if (this.syncCommitInProgress || this.loadInProgress) { exportKey.fill(0); this.assertNoSyncCommit() }
    let added = 0
    try {
      for (const blobEntry of parsed.entries) {
        const plaintext = decrypt(blobEntry, exportKey)
      const entry = JSON.parse(plaintext.toString('utf8')) as VaultEntry
      const existing = this.entries.get(entry.id)
      if (existing !== undefined && !overwrite) {
        if (dryRun) { added++; continue }
        // Merge instead of skipping: fill gaps in the existing entry.
        const merged = { ...existing }
        const er = merged as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(entry)) {
          const cur = er[k]
          if ((cur === undefined || cur === '') && v !== undefined && v !== '') er[k] = v
        }
        merged.updatedAt = Date.now()
        delete merged.deletedAt
        this.entries.set(entry.id, merged)
        added++
        continue
      }
      if (dryRun) { added++; continue }
      // Imported entries come back as active (clear any soft-delete marker).
      const { deletedAt, ...active } = entry
      this.entries.set(entry.id, { ...active, updatedAt: Date.now() })
      added++
    }
    } catch {
      throw new Error('vault_import: export password is incorrect or the document is corrupted')
    } finally {
      exportKey.fill(0)
    }
    if (!dryRun) await this.persist()
    return added
  }

  /**
   * Persist the current in-memory state: encrypt every entry under the vault
   * key, then atomically replace the document under the cross-process lock.
   * Calls are serialized through an in-process chain so concurrent mutations
   * never contend for the lock and each write snapshots the entries visible
   * when it runs — the final file always reflects every completed mutation.
   * The derived key is cached after load and reused, so a mutation does not
   * re-run scrypt; only a fresh vault (no cached key yet) derives once.
   */
  /**
   * Re-key the vault with fresh scrypt KDF parameters (cost upgrade): derive a
   * new key from the master password under `newKdfParams()` and re-encrypt
   * every entry under it, atomically. The old key buffer is wiped. Returns the
   * new cost parameter `n` for reporting.
   */
  async rekey(): Promise<{ n: number }> {
    this.assertNoSyncCommit()
    this.keyChangesInProgress++
    try {
      if (this.key === undefined) {
        await this.load()
      }
      const newKdf = newKdfParams()
      const newKey = await deriveKey(this.masterPassword, newKdf)
      // Encrypt every entry under the new key first (in memory), so a failure
      // mid-encrypt leaves the on-disk document untouched.
      const reEncrypted = [...this.entries.values()].map(entry => ({
        id: entry.id,
        ...encrypt(Buffer.from(JSON.stringify(entry), 'utf8'), newKey),
      }))
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const { withFileLock, writeFileAtomic } = await atomicWrite()
      let committedHash: string | undefined
      await withFileLock(this.path, async () => {
        const file: VaultFile = {
          version: VAULT_FORMAT_VERSION,
          kdf: newKdf,
          verify: encrypt(Buffer.from(VERIFY_PLAINTEXT, 'utf8'), newKey),
          entries: reEncrypted,
        }
        const serialized = JSON.stringify(file)
        await writeFileAtomic(this.path, serialized, { mode: 0o600, dirMode: 0o700 })
        committedHash = createHash('sha256').update(serialized).digest('hex')
      })
      this.kdf = newKdf
      this.key?.fill(0)
      this.key = newKey
      this.knownDiskHash = committedHash
      notifyVaultPersist(this.path)
      return { n: newKdf.n }
    } finally { this.keyChangesInProgress-- }
  }

  /**
   * Verify the on-disk vault document: decrypts the verification envelope
   * with the in-memory key and compares the encrypted entry count against the
   * live store. Returns a non-secret integrity verdict.
   */
  async integrity(): Promise<{ fileEntries: number; memoryEntries: number; verifyOk: boolean; ok: boolean }> {
    let fileEntries = 0
    let verifyOk = false
    try {
      const raw = await readFile(this.path, 'utf8')
      const doc = JSON.parse(raw) as VaultFile
      fileEntries = doc.entries.length
      if (this.key !== undefined) {
        try {
          decrypt(doc.verify, this.key)
          verifyOk = true
        } catch {
          verifyOk = false
        }
      }
    } catch {
      fileEntries = 0
    }
    const memoryEntries = this.entries.size
    return { fileEntries, memoryEntries, verifyOk, ok: verifyOk && fileEntries === memoryEntries }
  }

  async persist(): Promise<void> {
    if (this.loadInProgress) throw new Error('SYNC_BUSY')
    return this.enqueuePersist()
  }

  private enqueuePersist(): Promise<void> {
    const run = async (): Promise<void> => {
      const kdf = this.kdf ?? newKdfParams()
      this.kdf = kdf
      if (this.key === undefined) {
        this.key = await deriveKey(this.masterPassword, kdf)
      }
      const key = this.key
      // `withFileLock` creates the `<file>.lock` sibling with exclusive create,
      // which fails when the parent directory is absent, so ensure the directory
      // exists before taking the lock.
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const { withFileLock, writeFileAtomic } = await atomicWrite()
      await withFileLock(this.path, async () => {
        const file: VaultFile = {
          version: VAULT_FORMAT_VERSION,
          kdf,
          verify: encrypt(Buffer.from(VERIFY_PLAINTEXT, 'utf8'), key),
          entries: [...this.entries.values()].map(entry => ({
            id: entry.id,
            ...encrypt(Buffer.from(JSON.stringify(entry), 'utf8'), key),
          })),
        }
        const serialized = JSON.stringify(file)
        await writeFileAtomic(this.path, serialized, {
          mode: 0o600,
          dirMode: 0o700,
        })
        this.knownDiskHash = createHash('sha256').update(serialized).digest('hex')
      })
      // Notification is after the atomic write, never exposes decrypted data,
      // and observer failures must not turn a successful save into an error.
      notifyVaultPersist(this.path)
      // Mutations flush the audit sidecar with the document so the trail on
      // disk never lags the entries behind it.
      await this.flushAuditLog()
    }
    // Append to the chain; a rejected write must not stall later writes, so
    // the chain continues with the next operation regardless of outcome.
    const next = this.persistChain.then(run, run)
    this.persistChain = next.catch(() => {})
    return next
  }

  /** Read and parse the vault document, tolerating first-run absence. */
  private async readDocument(): Promise<{ file: VaultFile; created: boolean; diskHash: string | undefined }> {
    let raw: string
    let diskHash: string
    try {
      const bytes = await readFile(this.path)
      raw = bytes.toString('utf8')
      diskHash = createHash('sha256').update(bytes).digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { file: { version: VAULT_FORMAT_VERSION, kdf: newKdfParams(), verify: EMPTY_BLOB, entries: [] }, created: true, diskHash: undefined }
      }
      throw error
    }
    // Name the file in every failure below: a vault can live at an explicit
    // --path, and "Unexpected token 'o'" or "version undefined" told the user
    // neither which file was damaged nor that it was damaged at all.
    let parsed: VaultFile
    try {
      parsed = JSON.parse(raw) as VaultFile
    } catch {
      throw new Error(`${this.path} is not valid JSON — it is corrupt or not a vault file`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.path} is not a vault file (expected a JSON object)`)
    }
    if (parsed.version !== VAULT_FORMAT_VERSION) {
      throw new Error(`${this.path} has unsupported vault format version ${JSON.stringify(parsed.version)} (expected ${VAULT_FORMAT_VERSION})`)
    }
    if (!parsed.kdf || parsed.kdf.algo !== 'scrypt' || !parsed.kdf.saltHex) {
      throw new Error(`${this.path} is missing valid KDF parameters`)
    }
    if (!parsed.verify) {
      throw new Error(`${this.path} is missing its password-verification envelope`)
    }
    return { file: parsed, created: false, diskHash }
  }
}

const LOCAL_SYNC_MAGIC = 'dsh-vault:local-sync-state:v1'
const SYNC_ERRORS = new Set(['SYNC_BUSY', 'SYNC_LOCKED', 'SYNC_NOT_AUTHORIZED', 'SYNC_LOCAL_CHANGED', 'SYNC_INVALID_STATE', 'SYNC_ROLLBACK_FAILED'])

function isSyncHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** JSON semantics with deterministic object keys, but no getters, cycles,
 * exotic objects or silent non-finite-number coercion at the sync boundary. */
function stableSyncJson(value: unknown): string {
  const seen = new Set<object>()
  let nodes = 0
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 2_000_000 || depth > 64) throw new Error('SYNC_INVALID_INPUT')
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || seen.has(item)) throw new Error('SYNC_INVALID_INPUT')
    const array = Array.isArray(item)
    if (array && item.length > 2_000_000) throw new Error('SYNC_INVALID_INPUT')
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('SYNC_INVALID_INPUT')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) throw new Error('SYNC_INVALID_INPUT')
    seen.add(item)
    try {
      if (array) return '[' + Array.from({ length: item.length }, (_, i) => encode(descriptors[String(i)]?.value, depth + 1)).join(',') + ']'
      return '{' + Object.keys(descriptors).filter(key => descriptors[key]!.enumerable && descriptors[key]!.value !== undefined).sort()
        .map(key => JSON.stringify(key) + ':' + encode(descriptors[key]!.value, depth + 1)).join(',') + '}'
    } finally { seen.delete(item) }
  }
  return encode(value, 0)
}

function syncEntriesFingerprint(entries: VaultEntry[]): string {
  const sorted = entries.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return createHash('sha256').update(stableSyncJson(sorted)).digest('hex')
}

/** Full entries, not patches: reject the entire result instead of normalizing
 * away fields, reviving trash or overwriting caller-supplied timestamps. */
function validateSyncEntries(value: unknown): VaultEntry[] {
  try {
    if (!Array.isArray(value) || value.length > 100_000) throw new Error()
    const entries = JSON.parse(stableSyncJson(value)) as Array<Record<string, unknown>>
    const ids = new Set<string>()
    const stringFields = new Set(['id', 'title', 'icon', 'color', 'username', 'email', 'phone', 'password', 'host', 'port', 'privateKey', 'ip', 'certificate', 'keyPassphrase', 'apiKey', 'secret', 'accessToken', 'refreshToken', 'envKey', 'otpSecret', 'cardNumber', 'cardExpiry', 'cardCvv', 'cardHolder', 'url', 'notes'])
    const numericFields = new Set(['createdAt', 'updatedAt', 'deletedAt', 'expiresAt', 'rotationDays'])
    const specialFields = new Set(['kind', 'sshAuth', 'sensitivity', 'favorite', 'envKeys', 'tags', 'cookies', 'passwordHistory', 'attachments', 'fields'])
    const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
    const finite = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item)
    for (const entry of entries) {
      if (!object(entry) || typeof entry.id !== 'string' || entry.id.trim().length === 0 || ids.has(entry.id)
        || typeof entry.title !== 'string' || entry.title.trim().length === 0
        || !finite(entry.createdAt) || entry.createdAt < 0 || !finite(entry.updatedAt) || entry.updatedAt < 0) throw new Error()
      ids.add(entry.id)
      for (const [key, field] of Object.entries(entry)) {
        if (stringFields.has(key)) { if (typeof field !== 'string') throw new Error() }
        else if (numericFields.has(key)) { if (!finite(field) || field < 0) throw new Error() }
        else if (!specialFields.has(key)) throw new Error()
      }
      validatePatchTypes(entry)
      if (entry.kind !== undefined && !['login', 'ssh', 'api-key', 'secret', 'oauth', 'cookie', 'card', 'custom'].includes(entry.kind as string)) throw new Error()
      if (entry.sshAuth !== undefined && entry.sshAuth !== 'password' && entry.sshAuth !== 'certificate') throw new Error()
      if (entry.sensitivity !== undefined && entry.sensitivity !== 'normal' && entry.sensitivity !== 'high') throw new Error()
      if (entry.favorite !== undefined && typeof entry.favorite !== 'boolean') throw new Error()
      if (entry.envKeys !== undefined && (!Array.isArray(entry.envKeys) || entry.envKeys.some(key => typeof key !== 'string'))) throw new Error()
      if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some(tag => typeof tag !== 'string'))) throw new Error()
      if (entry.cookies !== undefined) {
        if (!Array.isArray(entry.cookies)) throw new Error()
        for (const cookie of entry.cookies) {
          if (!object(cookie) || !['name', 'value', 'domain', 'path'].every(key => typeof cookie[key] === 'string')
            || !finite(cookie.expires) || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean'
            || (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite as string))) throw new Error()
        }
      }
      if (entry.passwordHistory !== undefined) {
        if (!Array.isArray(entry.passwordHistory) || entry.passwordHistory.some(history => !object(history) || typeof history.password !== 'string' || !finite(history.at) || history.at < 0)) throw new Error()
      }
      if (entry.attachments !== undefined) {
        if (!object(entry.attachments)) throw new Error()
        for (const attachment of Object.values(entry.attachments)) {
          if (!object(attachment) || typeof attachment.data !== 'string' || typeof attachment.name !== 'string'
            || !Number.isSafeInteger(attachment.size) || (attachment.size as number) < 0
            || (attachment.mime !== undefined && typeof attachment.mime !== 'string')) throw new Error()
        }
      }
      if (entry.fields !== undefined && !object(entry.fields)) throw new Error()
    }
    return entries as unknown as VaultEntry[]
  } catch { throw new Error('SYNC_INVALID_INPUT') }
}

/** Placeholder envelope for a not-yet-persisted vault; replaced on first persist. */
const EMPTY_BLOB: EncryptedBlob = { ivHex: '', tagHex: '', dataHex: '' }


/** Relevance rank for search: 0 = title prefix, 1 = title contains,
 * 2 = any field contains, -1 = no match. Lower is better. */
function relevanceRank(entry: VaultEntry, terms: string[]): number {
  const title = entry.title.toLowerCase()
  const primary = terms[0]!
  if (title.startsWith(primary)) return 0
  if (title.includes(primary)) return 1
  return terms.some(term => matches(entry, term)) ? 2 : -1
}

/** Regex match across the entry's searchable fields. */
function regexMatches(entry: VaultEntry, re: RegExp): boolean {
  const fieldValues: string[] = []
  collectSearchable(entry.fields ?? {}, fieldValues)
  const haystack = [
    entry.title, entry.kind, entry.username, entry.email, entry.phone, entry.host, entry.port,
    entry.url, entry.notes, ...(entry.tags ?? []), ...fieldValues,
  ].filter(Boolean).join('\n')
  re.lastIndex = 0
  return re.test(haystack)
}

/** Case-insensitive substring match across the entry's searchable fields. */
function matches(entry: VaultEntry, needle: string): boolean {
  const fieldValues: string[] = []
  collectSearchable(entry.fields ?? {}, fieldValues)
  return [
    entry.title,
    entry.kind,
    entry.username,
    entry.email,
    entry.phone,
    entry.host,
    entry.ip,
    entry.port,
    entry.url,
    entry.notes,
    ...(entry.tags ?? []),
    ...fieldValues,
  ].some(value => value?.toLowerCase().includes(needle))
}

/** Recursively collect every scalar string from a fields value (numbers and
 * booleans stringified so they are searchable too). */
function collectSearchable(value: FieldValue, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
  } else if (Array.isArray(value)) {
    for (const item of value) collectSearchable(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectSearchable(item, out)
  }
}

/** Project an entry to its non-secret summary shape. */
function toSummary(entry: VaultEntry): VaultEntrySummary {
  return {
    id: entry.id,
    title: entry.title,
    updatedAt: entry.updatedAt,
    ...(entry.sensitivity !== undefined ? { sensitivity: entry.sensitivity } : {}),
    ...(entry.favorite !== undefined ? { favorite: entry.favorite } : {}),
    ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
    ...(entry.color !== undefined ? { color: entry.color } : {}),
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.email !== undefined ? { email: entry.email } : {}),
    ...(entry.phone !== undefined ? { phone: entry.phone } : {}),
    ...(entry.host !== undefined ? { host: entry.host } : {}),
    ...(entry.ip !== undefined ? { ip: entry.ip } : {}),
    ...(entry.sshAuth !== undefined ? { sshAuth: entry.sshAuth } : {}),
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    ...(entry.cardExpiry !== undefined ? { cardExpiry: entry.cardExpiry } : {}),
    ...(entry.cardHolder !== undefined ? { cardHolder: entry.cardHolder } : {}),
    ...(entry.otpSecret !== undefined ? { hasOtp: true } : {}),
    ...(entry.attachments !== undefined && Object.keys(entry.attachments).length > 0 ? { attachmentCount: Object.keys(entry.attachments).length } : {}),
    ...(Array.isArray(entry.cookies) ? { cookieCount: entry.cookies.length } : {}),
    ...(entry.fields !== undefined && Object.keys(entry.fields).length > 0 ? { fields: entry.fields } : {}),
  }
}

/** Copy only the defined properties of a patch, excluding identity fields.
 * `title` is excluded by default (add sets it explicitly); pass
 * `{ allowTitle: true }` for updates, which may rename an entry. With
 * `{ skipEmpty: true }` (adds) empty strings and empty arrays are dropped so
 * blank form fields never land in storage. */
/** Validate typed patch fields, throwing on an invalid type so a bad model
 * argument can never corrupt an entry. Empty strings are allowed (they mean
 * "clear this field"); absent fields are skipped. */
function validatePatchTypes(patch: Record<string, unknown>): void {
  const kindSet = new Set(['login', 'ssh', 'api-key', 'secret', 'oauth', 'cookie', 'card', 'custom'])
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') continue
    switch (key) {
      case 'kind':
        if (typeof value !== 'string' || !kindSet.has(value)) {
          throw new Error(`vault: kind must be one of ${[...kindSet].join(', ')}`)
        }
        break
      case 'sshAuth':
        if (value !== 'password' && value !== 'certificate') throw new Error('vault: sshAuth must be password or certificate')
        break
      case 'ip':
      case 'certificate':
      case 'keyPassphrase':
        if (typeof value !== 'string') throw new Error(`vault: ${key} must be a string`)
        break
      case 'sensitivity':
        if (value !== 'normal' && value !== 'high') {
          throw new Error('vault: sensitivity must be "normal" or "high"')
        }
        break
      case 'rotationDays':
      case 'expiresAt':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`vault: ${key} must be a finite number`)
        }
        break
      case 'envKey':
        // Legacy single-name shorthand, accepted from older callers/UI.
        if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
          throw new Error('vault: envKey must match [A-Za-z_][A-Za-z0-9_]* (e.g. DASHSCOPE_API_KEY)')
        }
        break
      case 'envKeys':
        // An empty array clears the names (falls back to the derived form).
        if (!Array.isArray(value) || value.length > MAX_ENV_KEYS) {
          throw new Error(`vault: envKeys must be an array of at most ${MAX_ENV_KEYS} names`)
        }
        for (const name of value) {
          if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`vault: envKeys entries must match [A-Za-z_][A-Za-z0-9_]* (got ${JSON.stringify(name)})`)
          }
        }
        if (new Set(value).size !== value.length) {
          throw new Error('vault: envKeys must not repeat a name')
        }
        break
      case 'port':
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new Error('vault: port must be a string or number')
        }
        break
      case 'favorite':
        if (typeof value !== 'boolean') {
          throw new Error('vault: favorite must be a boolean')
        }
        break
      case 'icon':
      case 'color':
      case 'cardNumber':
      case 'cardExpiry':
      case 'cardCvv':
      case 'cardHolder':
        if (typeof value !== 'string') throw new Error(`vault: ${key} must be a string`)
        break
      case 'tags':
        if (!Array.isArray(value) || value.some(t => typeof t !== 'string')) {
          throw new Error('vault: tags must be an array of strings')
        }
        break
      case 'cookies':
        if (!Array.isArray(value) || value.some(c => typeof c !== 'object' || c === null
          || typeof (c as { name?: unknown }).name !== 'string'
          || typeof (c as { value?: unknown }).value !== 'string'
          || typeof (c as { domain?: unknown }).domain !== 'string')) {
          throw new Error('vault: cookies must be an array of { name, value, domain, … }')
        }
        break
      case 'passwordHistory':
        if (!Array.isArray(value) || value.some(h => typeof h !== 'object' || h === null
          || typeof (h as { password?: unknown }).password !== 'string'
          || typeof (h as { at?: unknown }).at !== 'number')) {
          throw new Error('vault: passwordHistory must be an array of { password, at }')
        }
        break
      case 'attachments':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('vault: attachments must be an object')
        }
        for (const [name, att] of Object.entries(value as Record<string, unknown>)) {
          const a = att as { data?: unknown; size?: unknown }
          if (typeof att !== 'object' || att === null || typeof a.data !== 'string' || typeof a.size !== 'number') {
            throw new Error(`vault: attachment "${name}" must be { data, size, … }`)
          }
        }
        break
      case 'fields':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('vault: fields must be an object')
        }
        break
    }
  }
}

function pickDefined(patch: Record<string, unknown>, options: { allowTitle?: boolean; skipEmpty?: boolean } = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const identityField = key === 'id' || key === 'createdAt' || key === 'updatedAt' || (!options.allowTitle && key === 'title')
    if (value === undefined || identityField) continue
    if (options.skipEmpty && (value === '' || (Array.isArray(value) && value.length === 0))) continue
    result[key] = value
  }
  return result
}

/**
 * The harness's atomic-write helpers, loaded on demand.
 *
 * They are only needed when *writing*; the CLI's read commands (`list`, `get`,
 * `env`, …) must work from a plain npm install where no harness package is
 * installed, so the import happens inside the write paths instead of at module
 * load. The plugin always has them, so its behaviour is unchanged.
 */
type AtomicWrite = {
  withFileLock: <T>(path: string, fn: () => Promise<T>) => Promise<T>
  writeFileAtomic: (path: string, data: string, options?: { mode?: number; dirMode?: number }) => Promise<void>
}
let atomicWriteModule: AtomicWrite | undefined
async function atomicWrite(): Promise<AtomicWrite> {
  if (atomicWriteModule !== undefined) return atomicWriteModule
  try {
    atomicWriteModule = await import('@deepseek-ai/dsh-atomic-write') as unknown as AtomicWrite
    return atomicWriteModule
  } catch {
    throw new Error('dsh-vault: writing needs the DSH runtime (@deepseek-ai/dsh-atomic-write is not installed); reads work standalone')
  }
}

/** How many explicit env names one entry may carry. Secrets are few (a token
 * pair, a key + secret), so this is a guard against a runaway model call. */
const MAX_ENV_KEYS = 8

/** Fold the legacy single `envKey` into `envKeys`, so every read path (env
 * export, CLI, UI) only ever looks at one field. */
function normalizeEnvKeys(record: Record<string, unknown>): void {
  const legacy = record.envKey
  const list = record.envKeys
  if (Array.isArray(list)) {
    const clean = list.filter((name): name is string => typeof name === 'string' && name.length > 0)
    if (clean.length > 0) record.envKeys = clean
    else delete record.envKeys
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    const current = Array.isArray(record.envKeys) ? record.envKeys as string[] : []
    if (!current.includes(legacy)) record.envKeys = [legacy, ...current]
  }
  delete record.envKey
}

/** Keep the numeric epoch fields numeric and sane. A catalog template hint
 * ("expiry epoch millis") or a hand-edited import can otherwise persist a
 * non-numeric `expiresAt`, which every read path then has to defend against
 * (and which used to crash the editor with `RangeError: Invalid time value`).
 * Numeric strings are coerced; anything unusable is dropped. */
function normalizeTimestamps(record: Record<string, unknown>): void {
  normalizeEnvKeys(record)
  for (const key of ['expiresAt', 'rotationDays']) {
    const value = record[key]
    if (value === undefined || value === null) continue
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n <= 0) delete record[key]
    else record[key] = n
  }
}
