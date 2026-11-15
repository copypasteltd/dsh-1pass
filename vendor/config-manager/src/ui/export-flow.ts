/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */
import type { ExportCategory } from './types.ts';
export const DEFAULT_CATEGORIES: readonly ExportCategory[] = [{ id: 'vault', label: 'Password vault', descriptionKey: 'vault.description', defaultIncluded: true, portability: 'portable', group: 'general', sensitive: true }];
