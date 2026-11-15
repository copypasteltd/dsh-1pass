/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Vendored from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Original MIT permission and warranty notice: vendor/config-manager/LICENSE.
 */
/**
 * Toast 公共类型 —— 独立成文件是为了让 store（无 React）与视图（React）都能引用，
 * 且不产生「store → 视图」的反向依赖。
 */

/** 通知语义：与 Badge / Banner / StatusDot 的既有四态保持一致。 */
export type ToastKind = 'ok' | 'info' | 'warn' | 'error'
