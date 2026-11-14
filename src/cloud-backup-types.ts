/** Browser-safe configuration and status contracts. Secrets are environment references only. */
export type CloudBackupProvider = 'github' | 's3' | 'oss' | 'r2'

interface TargetBase {
  id: string
  label: string
  enabled: boolean
  /** Remote directory/object prefix; never a local file path. */
  prefix: string
}

export interface GitHubBackupTarget extends TargetBase {
  provider: 'github'
  owner: string
  repo: string
  branch: string
  tokenEnv: string
}

export interface ObjectStorageBackupTarget extends TargetBase {
  provider: 's3' | 'oss' | 'r2'
  endpoint: string
  region: string
  bucket: string
  accessKeyIdEnv: string
  secretAccessKeyEnv: string
  sessionTokenEnv?: string
  forcePathStyle: boolean
}

export type CloudBackupTarget = GitHubBackupTarget | ObjectStorageBackupTarget

export interface CloudBackupSettings {
  enabled: boolean
  onChange: boolean
  /** Zero disables the interval; otherwise 5..10080 minutes. */
  intervalMinutes: number
  /** Retain 1..100 snapshots per target and vault namespace. */
  retention: number
  targets: CloudBackupTarget[]
}

export interface CloudBackupTargetStatus {
  id: string
  provider: CloudBackupProvider
  state: 'idle' | 'running' | 'success' | 'error'
  lastAttemptAt?: number
  lastSuccessAt?: number
  lastObjectKey?: string
  lastError?: string
  warning?: string
}

export interface CloudBackupView {
  config: CloudBackupSettings
  statuses: CloudBackupTargetStatus[]
  running: boolean
  lastRunAt?: number
  nextRunAt?: number
  warning?: string
}

/** Exact encrypted vault JSON, not decrypted entries or a settings directory. */
export interface CloudBackupSnapshot {
  vaultId: string
  filename: string
  data: string
}

export interface CloudBackupUploadResult {
  objectKey: string
  warning?: string
}
