/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */
import type { ImportAnalysis } from '../core/types.ts';
export type CompatibilityLevel = 'unsupported' | 'partial' | 'good' | 'excellent'

export function compatibilityLevel(compatibility: ImportAnalysis['compatibility'] | string): CompatibilityLevel {
  return compatibility === 'unsupported' || compatibility === 'partial' || compatibility === 'good'
    ? compatibility
    : 'excellent'
}

export function compatibilityBadgeKind(level: CompatibilityLevel): 'error' | 'warn' | 'ok' {
  return level === 'unsupported' ? 'error' : level === 'partial' ? 'warn' : 'ok'
}
