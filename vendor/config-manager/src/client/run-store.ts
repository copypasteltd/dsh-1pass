/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: scoped memory state and strict nonsecret persistence.
 */
import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { SyncPullReport, SyncPushPreview, SyncPushReport } from '../sync/sync-engine.ts';
import type { SyncStartResponse } from './sync/sync-api.ts';
import { channelMapOf, defaultChannelSyncState } from './sync/sync-view.ts';
import type { ChannelSyncState, SyncChannel, SyncConflictResolution } from './sync/sync-view.ts';
export interface SyncStoreSlice {
  channel: SyncChannel
  repoUrl: string
  /** git 通道：仓库内子目录前缀（空 = 仓库根；非敏感，随切片持久化） */
  gitSubdir: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化/回显 */
  token: string
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空，绝不持久化/回显 */
  webdavPassword: string
  /**
   * **每条通道**各自独立的设置状态（自动同步、同步模式、加密、快照）。
   *
   * 键集合从 `SYNC_CHANNELS` 派生（`SyncChannel` 类型 + `channelMapOf` 构造）—— 这里曾是全仓
   * 最后一处手维护的通道清单；手写 `{ git, webdav }` 的表现是加通道时**静默漏一项**，
   * 而漏掉的那一项要等到某人索引它时才会炸，离现场往往很远。
   */
  byChannel: Record<SyncChannel, ChannelSyncState>
  /**
   * 进行中的同步操作（瞬态：切 tab 由模块级单例保留 → 切回仍显示进行中；
   * 刷新时被白名单剔除 → 回复空闲，异步请求结果经 /runs 等宿主侧恢复）。
   */
  busy: SyncBusyState
  /** 「保存配置」进行中（瞬态；同 busy 语义） */
  savingConfig: boolean
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
  /** P0-②：push 前只读预览弹窗（preview 结果 + 打开状态；非敏感，切 tab/刷新不丢） */
  pushPreview: { preview: SyncPushPreview | null; open: boolean }
  /** 一键同步差异确认会话（items 供 UI 逐项确认；宿主侧 30 分钟 TTL 内存登记） */
  confirmSession: SyncStartResponse | null
  /** 一键同步差异确认的逐项决策（adopted/resolution；非敏感，与 confirmSession 生命周期绑定——切 tab/刷新不丢，刷新后会话仍在可恢复决策） */
  confirmDecisions: SyncConfirmDecisions | null
  /** 最近一次一键同步执行结果（回滚入口） */
  lastRestoreId: string | null
  /** 已 redact 的错误文本 */
  error: string | null
  loadError: string | null
}

export type SyncBusyState = 'sync' | 'push' | 'pull' | 'rollback' | null

export type SyncConfirmDecision = { adopted: boolean; resolution?: (SyncConflictResolution) | undefined }

export type SyncConfirmDecisions = Record<string, SyncConfirmDecision>

function defaultSyncState(): SyncStoreSlice {
  return {
    channel: 'git',
    repoUrl: '',
    gitSubdir: '',
    token: '',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    byChannel: channelMapOf(() => defaultChannelSyncState()),
    busy: null,
    savingConfig: false,
    pushReport: null,
    pullReport: null,
    pushPreview: { preview: null, open: false },
    confirmSession: null,
    confirmDecisions: null,
    lastRestoreId: null,
    error: null,
    loadError: null,
  }
}

export function toSyncStoreSlice(s: SyncStoreSlice): SyncStoreSlice {
  return {
    channel: s.channel,
    repoUrl: s.repoUrl,
    gitSubdir: s.gitSubdir,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    // 每条通道都要复制快照数组引用（避免跨切片共享可变数组）；键集合由枚举遍历得来，
    // 加通道时自动覆盖，不需要在这里再补一行。
    byChannel: channelMapOf((ch) => ({ ...s.byChannel[ch], snapshots: [...s.byChannel[ch].snapshots] })),
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
    pullReport: s.pullReport,
    pushPreview: s.pushPreview,
    confirmSession: s.confirmSession,
    confirmDecisions: s.confirmDecisions,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export interface VaultUiSnapshot { sync: SyncStoreSlice; panel: 'sync' | 'library'; library: { sourceFilter: 'remote-snapshot' } }
export function vaultStoragePrefix(vaultName: string): string { return 'dsh.vault.cloudSync.' + encodeURIComponent(vaultName) }
export class VaultRunStore {
  private value: VaultUiSnapshot = { sync: defaultSyncState(), panel: 'sync', library: { sourceFilter: 'remote-snapshot' } };
  private listeners = new Set<() => void>();
  private disposed = false;
  readonly key: string;
  readonly channelStorage: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(readonly vaultName: string) {
    this.key = vaultStoragePrefix(vaultName) + '.state.v1';
    const channelKey = vaultStoragePrefix(vaultName) + '.channel';
    this.channelStorage = { getItem: () => { try { return globalThis.localStorage?.getItem(channelKey) ?? null } catch { return null } }, setItem: (_key, value) => { if (this.disposed) return; if (!['git','webdav','s3','gist'].includes(value)) return; try { globalThis.localStorage?.setItem(channelKey, value) } catch { /* private browsing */ } } };
    // Parse only the small nonsecret whitelist. Never hydrate reports, credentials, URLs or drafts.
    try {
      const raw: unknown = JSON.parse(globalThis.sessionStorage?.getItem(this.key) ?? 'null');
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        if (o.channel === 'git' || o.channel === 'webdav' || o.channel === 's3' || o.channel === 'gist') this.value.sync.channel = o.channel;
      }
    } catch { /* malformed storage cannot restore authority or secret drafts */ }
  }
  getSnapshot = (): VaultUiSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } };
  patch = (patch: Partial<VaultUiSnapshot>): void => {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    try { globalThis.sessionStorage?.setItem(this.key, JSON.stringify({ channel: this.value.sync.channel })) } catch { /* no persistence available */ }
    for (const listener of this.listeners) listener();
  };
  patchSyncPasswords = (patch: Pick<SyncStoreSlice, 'token' | 'webdavPassword'>): void => { if (!this.disposed) this.value = { ...this.value, sync: { ...this.value.sync, ...patch } } };
  dispose(): void { this.disposed = true; this.value = { sync: defaultSyncState(), panel: 'sync', library: { sourceFilter: 'remote-snapshot' } }; this.listeners.clear() }
}
const StoreContext = createContext<VaultRunStore | null>(null);
export function VaultStoreProvider({ store, children }: { store: VaultRunStore; children: ReactNode }) { return createElement(StoreContext.Provider, { value: store }, children) }
export function useRunStore(): VaultRunStore { const store = useContext(StoreContext); if (store === null) throw new Error('Vault sync scope missing'); return store }
