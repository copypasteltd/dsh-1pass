/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Vendored from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Original MIT permission and warranty notice: vendor/config-manager/LICENSE.
 */
/**
 * 远端快照的**推送方设备身份**投影（React 无关、可单测；cloud-sync 借鉴项 ⑥）。
 *
 * 唯一规则（诚实性）：**只有快照真的带非空 \`deviceName\` 才产出文案**。
 * 旧快照没有该字段 —— 界面必须整段不显示，既不显示空串占位，也不把 \`undefined\` 渲染成任何文案。
 */
/** 单条快照 → 设备文案；缺字段/空串 → undefined（调用方据此不渲染）。 */
export function deviceLabel(snapshot: { deviceName?: (unknown) | undefined }, format: (device: string) => string): string | undefined {
  const name = snapshot.deviceName
  if (typeof name !== 'string' || name === '') return undefined
  return format(name)
}

/** 快照列表 → id → 设备文案（缺字段的行不进表，绝不用空串占位）。 */
export function deviceLabelsById(
  snapshots: readonly { id: string; deviceName?: (unknown) | undefined }[],
  format: (device: string) => string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const snapshot of snapshots) {
    const label = deviceLabel(snapshot, format)
    if (label !== undefined) map.set(snapshot.id, label)
  }
  return map
}
