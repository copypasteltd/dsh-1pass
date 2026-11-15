/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */

import type { SectionId } from '../schema/types.ts';
import type { ExportUnit } from '../core/types.ts';
export interface ExportPreviewResponse {
  ok: boolean;
  /**
   * Phase 1：每个分区附带**可单独勾选的最小单元**清单（`items`）。
   * items 为空数组 = 本分区不可细分（UI 只给整体开关）。单元由 adapter.listUnits()
   * 零 I/O 派生，id 命名空间与导入侧 PlanItem.id 一致。
   */
  sections: { section: SectionId; count: number; sizeBytes: number; items: ExportUnit[] }[];
  totalSections: number;
  totalSizeBytes: number;
  /** 读取失败的分区**数量**（既有契约，语义与类型均不变） */
  sectionsFailed: number;
  /**
   * 读取失败的分区 **id 列表**（t7，可选）。
   *
   * 宿主逐个分区调用 adapter.export 失败时一并收集。有了它，客户端不必再靠
   * 「请求了但没回来」推断失败分区，可以直接精确标注。
   *
   * 向后兼容：**可选**字段 —— 旧宿主（或第三方实现）不回该字段时，客户端回退到
   * 推断路径（见 `ui/export-flow.ts` 的 `failedSectionsFromResponse`）；
   * 旧客户端看到未知字段也会忽略，不受影响。
   */
  failedSections?: (SectionId[]) | undefined;
}
