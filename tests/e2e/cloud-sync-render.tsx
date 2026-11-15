/** Offline QA only: real reference SyncPanel vs real CloudSyncPanel, with typed in-memory data.
 * No host, credentials, login flow, transport, replacement server, or persistent browser profile.
 * Reference receives the same vault-specific translation callback and catalog as the wrapper;
 * original components, CSS, layout and business handlers are imported without source changes.
 */
import { createRoot } from 'react-dom/client'
import { SyncPanel as OriginalSyncPanel } from '../../.references/dsh-config-manager/src/client/sync/SyncPanel.tsx'
import { ToastViewport as OriginalToasts } from '../../.references/dsh-config-manager/src/client/common/ToastViewport.tsx'
import originalCss from '../../.references/dsh-config-manager/src/client/config-manager.module.css'
import type { SyncApi as OriginalSyncApi } from '../../.references/dsh-config-manager/src/client/sync/sync-api.ts'
import { CloudSyncPanel } from '../../src/client/CloudSyncPanel.tsx'
import vaultSectionCss from '../../src/client/VaultSection.module.css'
import { vaultTranslations } from '../../vendor/config-manager/src/client/vault-translations.ts'
import { en, zh } from '../../src/client/locales.ts'
import type {
  AutosyncStatusResponse, SyncStatusResponse, MergePreviewResponse,
  SyncConfigSaveResponse, SyncSelectionPayload, GithubValidateResponse,
} from '../../vendor/config-manager/src/client/sync/sync-api.ts'
import type { SyncPushPreview, SyncPushReport } from '../../vendor/config-manager/src/sync/sync-engine.ts'

const params = new URLSearchParams(location.search)
const lang = params.get('lang') === 'en' ? 'en' : 'zh'
const side = params.get('side') === 'reference' ? 'reference' : 'vault'
const configured = params.get('configured') === '1'
const cn = lang === 'zh'
const tr = vaultTranslations(() => lang)
const channels = ['git', 'webdav', 's3', 'gist'] as const
const calls: Array<{ action: string; payload: unknown }> = []
const unexpected: string[] = []
const auto = (enabled = false): AutosyncStatusResponse => ({
  enabled, interval: '15m', realtime: false, remoteCheckMs: 60000,
  autoApplyTier: 'medium', conflictPolicy: 'ask', consecutiveFailures: 0, elapsedMs: 0,
})
const selection = (transport: typeof channels[number]): SyncSelectionPayload => ({
  transport, mode: 'advanced', sections: ['vault'], encrypt: true, includeSecrets: false,
  encryptPasswordConfigured: configured, decryptPasswordConfigured: configured,
})
const status: SyncStatusResponse = {
  ok: true, configured, hasBaseline: configured,
  credentialConfigured: configured, credentialWritable: true,
  repoUrl: configured ? 'https://github.com/example/visual-fixture.git' : '',
  sectionCount: configured ? 1 : 0, transport: { type: 'git', ref: 'fixture' },
  lastSyncChannel: 'git',
  webdav: { url: '', username: '', usernameConfigured: false, passwordConfigured: false },
  syncSections: [{ id: 'vault', displayName: cn ? '密码库' : 'Password vault', portability: 'portable', defaultIncluded: true }],
  syncSelectionByChannel: Object.fromEntries(channels.map(ch => [ch, selection(ch)])) as NonNullable<SyncStatusResponse['syncSelectionByChannel']>,
  autosyncByChannel: Object.fromEntries(channels.map(ch => [ch, auto(configured && ch === 'git')])) as NonNullable<SyncStatusResponse['autosyncByChannel']>,
  syncCredentialsByChannel: Object.fromEntries(channels.map(ch => [ch, { encryptPasswordConfigured: configured, decryptPasswordConfigured: configured }])) as NonNullable<SyncStatusResponse['syncCredentialsByChannel']>,
}
const conflict: MergePreviewResponse & { planId: string } = {
  ok: true, planId: 'synthetic-merge-plan', snapshotId: 'synthetic-snapshot', hasAncestor: true,
  sections: [{ id: 'vault', decision: 'conflict', conflictCount: 1, conflicts: [{ path: 'vault', kind: 'file', reason: 'both-modified', localPreview: '[REDACTED]', remotePreview: '[REDACTED]', ancestorPreview: '[REDACTED]' }] }],
  summary: { auto: 0, review: 0, conflicts: 1, skipped: 0 },
}
const preview: SyncPushPreview & { planId: string } = {
  ok: true, planId: 'synthetic-push-plan', sections: [{ section: 'vault', count: 2, changed: true }],
  remoteSnapshotCount: 0, encrypted: true, credentialsIncluded: false,
}
const github: GithubValidateResponse = { ok: true, configured, valid: configured, ...(configured ? { login: 'example' } : {}) }
/** Unexpected requests throw; no default success response can hide missing fixture coverage. */
async function call(action: string, payload?: unknown): Promise<unknown> {
  calls.push({ action, payload: structuredClone(payload ?? null) })
  switch (action) {
    case 'status': return structuredClone(status)
    case 'githubValidate': return github
    case 'githubListRepositories': return { ok: true, repos: [] }
    case 'history': return { entries: [] }
    case 'snapshotsList': return { snapshots: [], unreadable: [] }
    case 'autosyncStatusAll': return status.autosyncByChannel
    case 'autosyncStatus': return auto(configured)
    case 'mergePreview': return structuredClone(conflict)
    case 'pushPreview': return structuredClone(preview)
    case 'saveUiPrefs': return { ok: true, lastSyncChannel: (payload as { lastSyncChannel?: string })?.lastSyncChannel }
    case 'saveSelection': return payload
    case 'saveConfig': {
      const result: SyncConfigSaveResponse = { ok: true, configured, transport: 'git', credentialConfigured: configured }
      return result
    }
    case 'autosyncUpdate': return { ...auto(), ...payload as object }
    case 'push': {
      const result: SyncPushReport = { ok: true, snapshotId: 'synthetic-pushed-snapshot', sections: ['vault'], warnings: [] }
      return result
    }
    default: unexpected.push(action); throw new Error('Unimplemented synthetic fixture action: ' + action)
  }
}
/** Reference port is injected in memory. It does not instantiate the original HTTP SyncApi. */
const referencePort = {
  t: tr.uiT,
  status: () => call('status'), githubValidate: () => call('githubValidate'),
  githubListRepositories: () => call('githubListRepositories'),
  history: () => call('history'), snapshotsList: (p: unknown) => call('snapshotsList', p),
  autosyncStatusAll: () => call('autosyncStatusAll'), autosyncStatus: () => call('autosyncStatus'),
  saveUiPrefs: (p: unknown) => call('saveUiPrefs', p), saveSelection: (p: unknown) => call('saveSelection', p),
  saveConfig: (p: unknown) => call('saveConfig', p), autosyncUpdate: (p: unknown) => call('autosyncUpdate', p),
  mergePreview: (p: unknown) => call('mergePreview', p), pushPreview: (p: unknown) => call('pushPreview', p),
  push: (p: unknown) => call('push', p),
} as unknown as OriginalSyncApi
;(window as unknown as { __cloudSyncQA: unknown }).__cloudSyncQA = {
  side, lang, configured, calls, unexpected,
  protocol: 'original-full-SyncPanel-same-labels-and-data',
}
const rootElement = document.getElementById('root')!
if (params.get('embedded') === '1' && side === 'vault') rootElement.className = vaultSectionCss.embedded
const root = createRoot(rootElement)
if (side === 'reference') {
  root.render(<div id="dsh-config-manager-root" className={originalCss.section} data-reference-cloud-sync="fixture">
    <div className={originalCss.shellMain}><div className={originalCss.pagePad}>
      <OriginalSyncPanel api={referencePort} t={tr.syncT as never} cmT={tr.cmT as never} />
    </div></div>
    <OriginalToasts t={tr.cmT as never} />
  </div>)
} else {
  root.render(<CloudSyncPanel t={(key => (cn ? zh : en)[key])} cloudSyncCall={call} readonly={false} locked={false} unavailable={false} vaultName="visual-fixture" />)
}
