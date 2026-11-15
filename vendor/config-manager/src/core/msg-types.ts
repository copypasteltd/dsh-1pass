/** SPDX-License-Identifier: MIT. Copyright (c) 2026 xiajiajun516.
 * From dsh-config-manager 0.8.2 commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Full permission and warranty notice: vendor/config-manager/LICENSE. */
/**
 * 消息翻译器的最小契约（引擎注入点）。
 * 实现见 ./messages.ts（zh/en 目录 + makeMsg / msgOf）。
 */

/** 插值形参：{param} 占位符的值。 */
export type MsgParams = Record<string, string | number>;

/** 翻译函数：key → 当前语言文案（{param} 插值；未知键回退 zh/键名，绝不抛错）。 */
export type MsgFunc = (key: string, params?: (MsgParams) | undefined) => string;
