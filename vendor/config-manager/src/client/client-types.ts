/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Full MIT permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adapter: no config-manager HTTP or host I/O.
 */
import type { SyncKey } from './sync/sync-locales.ts';
export type ConfigManagerKey = 'section.vault' | 'common.close' | 'common.cancel' | 'common.loading' | 'common.infoHint' | string;
export type TranslateNS<N extends 'config-manager-sync' | 'config-manager'> = (key: N extends 'config-manager-sync' ? SyncKey : ConfigManagerKey, params?: (Record<string, unknown>) | undefined) => string;
