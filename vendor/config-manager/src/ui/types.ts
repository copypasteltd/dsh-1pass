/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */

import type { SectionId } from '../schema/types.ts';
import type { UiTextKey } from './i18n.ts';
import type { Portability } from '../core/types.ts';
export interface ExportCategory { id: SectionId; label: string; descriptionKey: UiTextKey; defaultIncluded: boolean; portability: Portability; group: ExportGroup; sensitive?: (boolean) | undefined }
export type ExportGroup =
  | 'general' | 'ai' | 'extensions' | 'mcp' | 'customization'
  | 'automation' | 'workspace' | 'ui' | 'optional';
export interface ExportGroupDef {
  id: ExportGroup;
  label: string;
  /** automation 组在 DSH 无对应配置时的说明（**字典键**：由渲染层用 UiT 解析） */
  noteKey?: (UiTextKey) | undefined;
}
export const EXPORT_GROUPS: readonly ExportGroupDef[] = [
  { id: 'general', label: 'Password vault' },
  { id: 'ai', label: 'AI' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'mcp', label: 'MCP / Tools' },
  { id: 'customization', label: 'Customization' },
  { id: 'automation', label: 'Automation', noteKey: 'export.group.automationNote' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'ui', label: 'UI' },
  { id: 'optional', label: 'Optional Data' },
] as const;
export interface ProgressEvent {
  /** 阶段 id（见 progress.ts 的 STAGE_TEXTS） */
  stage: string;
  detail?: (string) | undefined;
  /** 阶段序号（从 1 起，供 UI 显示 n/m） */
  step?: (number) | undefined;
  /** 阶段总数 */
  total?: (number) | undefined;
}
export type ProgressListener = (event: ProgressEvent) => void;
export interface ImportSectionStat {
  section: SectionId;
  ok: number;
  skipped: number;
  warned: number;
  failed: number;
  items: { itemId: string; status: 'ok' | 'skipped' | 'warning' | 'failed'; message?: (string) | undefined }[];
}
export type ImportResultAction = 'fixIssues' | 'viewDetails' | 'done';
