/** Offline visual fixture: no host connection, real credentials, or provider calls. */
import { createRoot } from 'react-dom/client'
import { CloudBackupPanel } from '../../src/client/CloudBackupPanel.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { CloudBackupSettings, CloudBackupView } from '../../src/cloud-backup-types.ts'
const chinese = new URLSearchParams(window.location.search).get('lang') !== 'en'
let config: CloudBackupSettings = { enabled: true, onChange: true, intervalMinutes: 60, retention: 10, targets: [
  { id: 'github', label: 'Private GitHub archive', provider: 'github', enabled: true, prefix: 'dsh-vault', owner: 'example', repo: 'vault-backups', branch: 'main', tokenEnv: 'DSH_VAULT_GITHUB_TOKEN' },
  { id: 'r2', label: 'R2 offsite archive', provider: 'r2', enabled: true, prefix: 'dsh-vault', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', bucket: 'vault-backups', accessKeyIdEnv: 'DSH_VAULT_BACKUP_ACCESS_KEY_ID', secretAccessKeyEnv: 'DSH_VAULT_BACKUP_SECRET_ACCESS_KEY', forcePathStyle: true },
] }
const view = (): CloudBackupView => ({ config: structuredClone(config), running: false, nextRunAt: Date.now() + 3600000,
  statuses: config.targets.map(target => ({ id: target.id, provider: target.provider, state: 'success', lastSuccessAt: Date.now() - 120000 })) })
createRoot(document.getElementById('root')!).render(<CloudBackupPanel t={key => (chinese ? zh : en)[key]}
  cloudBackup={async () => view()} setCloudBackup={async settings => { config = settings; return view() }}
  runCloudBackup={async () => view()} readonly={false} locked={false} unavailable={false} vaultName="work" />)
