/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */

import type { SectionId } from '../schema/types.ts';
import type { PlanItemKind, PlanItem } from '../core/types.ts';
export interface SyncPushReport {
  ok: boolean;
  snapshotId: string;
  /** 实际进入同步的 portable 分区 */
  sections: SectionId[];
  /** 分区级告警（单项失败不拖垮整体，§34.17 语义） */
  warnings: string[];
  message?: (string) | undefined;
  /**
   * 本次推送**被前置检测拒绝**（远端已被其它设备推进）：未写远端、未记基线、未改 sync-state。
   * 这是「需要先合并远端」的冲突态，不是通道/凭据故障 —— 调用方（自动同步 / 路由）应按冲突处理，
   * 而不是记成「同步失败」。
   */
  conflict?: (boolean) | undefined;
  /**
   * 本次推送前**收养了本机自己推上去的远端最新快照**（0.4.1 自愈）：该值 = 被收养的快照 id。
   *
   * 触发场景：上次推送在上传成功、写基线之前被打断（进程退出/崩溃/断电），远端已前进而本机
   * `lastSnapshotId` 仍是上一版 → 前置检测会永久拒绝推送（每次都说「远端被别人推进了」），
   * 单设备用户因此被自己的快照锁死。判据只看「远端最新快照的 manifest.deviceId == 本机
   * deviceId」，别的设备推进过就仍然按冲突返回，绝不越过。
   */
  adoptedBase?: (string) | undefined;
}
export interface PullChange {
  id: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  severity: PlanItem['severity'];
}
export interface SyncPullReport {
  ok: boolean;
  snapshotId: string;
  changes: PullChange[];
  /** 是否存在需要人工决策的项（Conflict / MissingSecret / MissingDependency / 路径问题）。
   * 插件 Install 不算 —— 插件安装随同步自动采用（product requirement）。 */
  needsReview: boolean;
  message?: (string) | undefined;
}
export interface SyncPushPreviewSection {
  /** 分区 id（将进入快照的 portable 分区） */
  section: SectionId;
  /** 分区内条目计数（adapter.export 的 counts 聚合；无计数时为 0） */
  count: number;
  /** 相对上次基线（sync-state）是否变化：true = 本次会更新该分区；false = 与基线一致 */
  changed: boolean;
}
export interface SyncPushPreview {
  ok: boolean;
  /** 将推送的分区清单（含计数与变化标记） */
  sections: SyncPushPreviewSection[];
  /** 远端现有快照数（0 = 首次推送将创建首个基线） */
  remoteSnapshotCount: number;
  /** 加密快照：载荷将整体加密（分区计数与基线比较不可得） */
  encrypted: boolean;
  /** 本次推送是否真的会带上凭据载荷（.credentials.yaml 可读且非空；issue #38） */
  credentialsIncluded: boolean;
  message?: (string) | undefined;
}
