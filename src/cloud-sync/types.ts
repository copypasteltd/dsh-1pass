/** Password-vault cloud channel contract. All payload bytes are encrypted before reaching a transport. */
export type VaultSyncChannel = 'git' | 'webdav' | 's3' | 'gist'
export interface VaultSyncSnapshot {
  format: '1pass-cloud-snapshot-v1'
  contentHash: string
  id: string
  createdAt: string
  manifest: { schemaVersion: 1; encrypted: true; transport: VaultSyncChannel; vaultName: string; deviceId: string; deviceName: string; platform: string; dshVersion: string; sections: string[] }
  encryptedPayload: { version: 1; kdf: { algo: 'scrypt'; n: number; r: number; p: number; saltHex: string }; nonce: string; ciphertext: string; tag: string }
}
export interface VaultSyncMeta {
  id: string; createdAt: string; contentHash: string; manifest: VaultSyncSnapshot['manifest']; sectionCount: number
}
export interface VaultSyncChannelConfig {
  transport: VaultSyncChannel
  repoUrl?: string; subdir?: string; branch?: string
  webdavUrl?: string; webdavUsername?: string
  provider?: 's3' | 'oss' | 'cos' | 'minio' | 'kodo'
  endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyId?: string; pathStyle?: boolean; dialectId?: string
  gistId?: string; apiBaseUrl?: string; filePrefix?: string
}
export interface VaultSyncTransport {
  readonly type: VaultSyncChannel
  list(): Promise<VaultSyncMeta[]>
  upload(snapshot: VaultSyncSnapshot, expectedHead?: string): Promise<VaultSyncMeta>
  download(id: string): Promise<VaultSyncSnapshot>
  delete(id: string): Promise<void>
  probe(): Promise<{ message: string; hint?: string; snapshotCount?: number; createdCollections?: string[] }>
  workdirFacts?(): Promise<{ path: string; exists: boolean; origin: string | null; pushUrl: string | null; match: boolean; ahead: number | null; dirty: boolean | null; remoteSnapshots: number | null }>
  resetWorkdir?(mode: 'relink' | 'adopt' | 'reclone', confirm: boolean): Promise<void>
}
export interface VaultSyncTransportOptions {
  config: VaultSyncChannelConfig
  stateDir: string
  credentials: { getSecret(): Promise<string | undefined> }
  signal?: AbortSignal
  fetch?: typeof fetch
}
