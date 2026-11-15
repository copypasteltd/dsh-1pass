/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Vendored from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Original MIT permission and warranty notice: vendor/config-manager/LICENSE.
 */
/**
 * CSS Modules 类型声明（dsh-ssh 同款：src/client/css-modules.d.ts）。
 * p3 的 tsdown 构建需配置 CSS Modules 处理（dsh-ssh 用 lightningcss）。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
