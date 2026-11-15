/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */

import type { Manifest, SectionId } from '../schema/types.ts';
export type ConsultSourceType = 'export-zip' | 'local-snapshot' | 'remote-snapshot';
export type HealthVerdict = 'healthy' | 'needs-attention' | 'critical';
export type Recommendation = 'proceed' | 'review' | 'block';
export type ConsultDimensionId =
  | 'compatibility' | 'integrity' | 'sections' | 'consistency' | 'sensitive' | 'migratability';
export interface ConsultSourceRef {
  type: ConsultSourceType;
  /** 源标识：ZIP 路径 / snapshotId / 远端快照 id / profile 名 */
  id: string;
  /** 关联 snapshotId（local-snapshot / remote-snapshot） */
  snapshotId?: (string) | undefined;
}
export interface ConsultIssue {
  severity: 'info' | 'warning' | 'error';
  /** 稳定问题码（i18n 键后缀；如 'integrity.manifestInvalid'） */
  code: string;
  /** 已 redact 的可读消息（宿主/UI 层负责脱敏） */
  message: string;
  /** 已 redact 的证据（可选） */
  evidence?: (string) | undefined;
}
export interface HealthDimension {
  id: ConsultDimensionId;
  /** 0-100 */
  score: number;
  verdict: HealthVerdict;
  issues: ConsultIssue[];
}
export interface ConsultWillApply {
  sections: SectionId[];
  itemCount: number;
  conflicts: number;
  risks: number;
  overwritten: number;
  /** 咨询恒为 dry-run（只读分析） */
  dryRun: boolean;
}
export interface ConsultReport {
  source: ConsultSourceRef;
  /** 0-100 */
  healthScore: number;
  verdict: HealthVerdict;
  recommendation: Recommendation;
  /**
   * 硬阻断项数（**只有 >0 才会建议 block**）：包不可信 / 照做会失败。
   * UI 用它把「为什么不能继续」与「需要你处理什么」分开显示，不再让一个分数代替结论。
   */
  blockerCount: number;
  /** 需处理项数（warning/error 但非硬阻断）：冲突、缺分区、凭据要补录、敏感提醒等。 */
  attentionCount: number;
  /** 触发项（已 redact；硬阻断在前） */
  recommendationReasons: string[];
  dimensions: HealthDimension[];
  willApply: ConsultWillApply;
  bound: { manifest?: (Manifest) | undefined; snapshotId?: (string) | undefined; sourceId: string };
  generatedAt: string;
}
