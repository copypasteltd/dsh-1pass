/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Full MIT permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adapter: no config-manager HTTP or host I/O.
 */
import type { SectionId } from '../../schema/types.ts';
import type { TranslateNS } from '../client-types.ts';
export const SECTION_LABEL_KEY = { vault: 'section.vault' } as const;
export function sectionLabel(id: SectionId, t: TranslateNS<'config-manager'>): string { return id === 'vault' ? t(SECTION_LABEL_KEY.vault) : ''; }
export function sectionLabeler(t: TranslateNS<'config-manager'>): (id: SectionId) => string { return id => sectionLabel(id,t); }
