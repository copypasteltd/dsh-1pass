/** Password-vault-only composition of the licensed config-manager sync UI. */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { VaultTranslate } from './host-contracts.ts'
import { cloudAccessMessage, type CloudAccessReason } from './vault-access.ts'
import { SyncPanel } from '../../vendor/config-manager/src/client/sync/SyncPanel.tsx'
import { SyncApi } from '../../vendor/config-manager/src/client/sync/sync-api.ts'
import { VaultRunStore, VaultStoreProvider } from '../../vendor/config-manager/src/client/run-store.ts'
import { ModalRootProvider } from '../../vendor/config-manager/src/client/common/Modal.tsx'
import { ToastViewport } from '../../vendor/config-manager/src/client/common/ToastViewport.tsx'
import { toastStore } from '../../vendor/config-manager/src/client/common/toast-store.ts'
import { Banner } from '../../vendor/config-manager/src/client/common/ui.tsx'
import { vaultTranslations } from '../../vendor/config-manager/src/client/vault-translations.ts'
import { createGuardedCloudSyncCall } from '../../vendor/config-manager/src/client/vault-policy.ts'
import { VaultReadonlyProvider } from '../../vendor/config-manager/src/client/vault-access.tsx'
import { VaultRemoteHistory } from '../../vendor/config-manager/src/client/VaultRemoteHistory.tsx'
import css from '../../vendor/config-manager/src/client/config-manager.module.css'

export interface CloudSyncPanelProps {
  t: VaultTranslate
  cloudSyncCall: (action: string, payload?: unknown) => Promise<unknown>
  readonly: boolean
  locked: boolean
  unavailable: boolean
  unavailableReason?: CloudAccessReason
  vaultName: string
  /** Unrelated parent work blocks new mutations without revoking this draft. */
  busy?: boolean
  onRetry?: () => void | Promise<void>
  onBusyChange?: (busy: boolean) => void
}

export function CloudSyncPanel(props: CloudSyncPanelProps) {
  const [unloaded, setUnloaded] = useState(false)
  useEffect(() => { const close = () => { setUnloaded(true) }; window.addEventListener('pagehide', close); return () => { window.removeEventListener('pagehide', close) } }, [])
  const scope = props.vaultName + ':' + String(props.readonly) + ':' + String(props.locked) + ':' + String(props.unavailable)
  if (unloaded) return null
  return <CloudSyncScope key={scope} {...props} />
}

function CloudSyncScope(props: CloudSyncPanelProps) {
  const latest = useRef(props); latest.current = props
  const active = useRef(true)
  const [store] = useState(() => new VaultRunStore(props.vaultName))
  const [retrying, setRetrying] = useState(false)
  const retryPending = useRef(false)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const rootId = 'dsh-vault-cloud-sync-' + encodeURIComponent(props.vaultName) + '-' + id
  const language = () => /[\u3400-\u9fff]/.test(latest.current.t('heading')) ? 'zh' as const : 'en' as const
  const tr = useMemo(() => vaultTranslations(language), [])
  const guard = useMemo(() => createGuardedCloudSyncCall((action,payload) => latest.current.cloudSyncCall(action,payload), () => ({ ...latest.current, readonly: latest.current.readonly || Boolean(latest.current.busy) }), () => active.current, busy => latest.current.onBusyChange?.(busy)), [])
  const api = useMemo(() => new SyncApi(tr.uiT, guard.call), [tr, guard])
  useEffect(() => () => { active.current = false; guard.clear(); store.dispose(); toastStore.clear() }, [guard,store])
  const blocked = props.locked || props.unavailable
  const cn = language() === 'zh'
  async function retry(): Promise<void> {
    if (retryPending.current || latest.current.busy || !latest.current.onRetry) return
    retryPending.current = true
    setRetrying(true)
    try { await latest.current.onRetry() } catch { /* Only localized availability copy is safe to display. */ }
    finally { retryPending.current = false; if (active.current) setRetrying(false) }
  }
  return (
    <ModalRootProvider id={rootId}>
      <VaultReadonlyProvider readonly={props.readonly || Boolean(props.busy)}><VaultStoreProvider store={store}>
        <div id={rootId} className={css.section} data-vault-cloud-sync={props.vaultName}>
          {blocked ? (props.locked
            ? <Banner kind="warn">{cn ? '请先解锁密码库以使用云同步。' : 'Unlock the password vault to use cloud sync.'}</Banner>
            : <>
              <div role={props.unavailableReason === 'checking' ? 'status' : 'alert'}><Banner kind={props.unavailableReason === 'checking' ? 'info' : 'error'}>{props.unavailableReason ? cloudAccessMessage(props.unavailableReason, cn) : cn ? '云同步暂不可用。请重试以重新检查密码库状态和访问权限。' : 'Cloud sync is temporarily unavailable. Retry to recheck the vault status and access policy.'}</Banner></div>
              {props.onRetry && props.unavailableReason !== 'checking' && <button type="button" className={css.ghostButton} disabled={retrying || props.busy} onClick={() => { void retry() }}>{cn ? '重试' : 'Retry'}</button>}
            </>) : <>
            {props.readonly && <Banner kind="info">{cn ? '只读模式：可以查看配置，不能修改或同步。' : 'Read-only mode: view configuration without changing or syncing it.'}</Banner>}
            {state.panel === 'library'
              ? <VaultRemoteHistory api={api} t={tr.syncT} cmT={tr.cmT} readonly={props.readonly || Boolean(props.busy)} onBack={() => { store.patch({panel:'sync'}) }} />
              : <div className={css.shellMain}><div className={css.pagePad}><SyncPanel api={api} t={tr.syncT} cmT={tr.cmT} /></div></div>}
          </>}
          <ToastViewport t={tr.cmT} />
        </div>
      </VaultStoreProvider></VaultReadonlyProvider>
    </ModalRootProvider>
  )
}
