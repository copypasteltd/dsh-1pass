/** SPDX-License-Identifier: MIT. Original dictionaries: Copyright (c) 2026 xiajiajun516.
 * Full permission and warranty notice: vendor/config-manager/LICENSE. Vault-specific truthful wording only. */
import { zh, en } from './sync/sync-locales.ts';
import type { SyncKey } from './sync/sync-locales.ts';
import { makeUiT } from '../ui/i18n.ts';
import type { UiT } from '../ui/i18n.ts';
import type { TranslateNS } from './client-types.ts';
const zhOverrides: Partial<Record<SyncKey, string>> = {
  'section.description': '通过 Git、WebDAV、S3 或 Gist 同步此密码库；密码库载荷始终加密。',
  'privateRepoHint': '请使用私有仓库。密码库载荷始终加密；通道凭据只供访问远端，不写入同步内容或日志。',
  'mode.encryptHint': '密码库同步必须加密，不能关闭。加密密码仅在内存中传送，由本机安全凭据槽保存。',
  'mode.encryptAutosyncNotice': '自动同步同样只传输加密的密码库载荷。',
  'mode.passwordClearNotice': '密码库必须加密，不能取消勾选。',
  'mode.includeSecrets': '导出 DSH 凭据（不适用）',
  'mode.includeSecretsHint': '此开关在密码库同步中禁用。密码库条目已包含在加密载荷内，不会额外导出 DSH 凭据。',
  'config.tokenHint': '仅传送至本机密码库同步服务的安全凭据槽；不会写入同步内容或日志。留空沿用已保存凭据。',
  'config.gitSubdirPlaceholder': '1pass',
  'channel.perChannelHint': '每条通道的配置、凭据、自动同步和加密密码相互独立，只同步当前密码库。',
};
const enOverrides: Partial<Record<SyncKey, string>> = {
  'section.description': 'Sync this password vault through Git, WebDAV, S3 or Gist. Vault payloads are always encrypted.',
  'privateRepoHint': 'Use a private repository. Vault payloads are always encrypted; channel credentials are never included in sync content or logs.',
  'mode.encryptHint': 'Encryption is mandatory for password-vault sync and cannot be disabled. The password is transmitted in memory to a secure local credential slot.',
  'mode.encryptAutosyncNotice': 'Automatic sync also transfers only encrypted vault payloads.',
  'mode.passwordClearNotice': 'Vault encryption is required and cannot be unchecked.',
  'mode.includeSecrets': 'Export DSH credentials (not applicable)',
  'mode.includeSecretsHint': 'Disabled for vault sync. Vault entries already belong to the encrypted payload; DSH credentials are never exported separately.',
  'config.tokenHint': 'Sent only to the local vault-sync secure credential slot, never sync content or logs. Leave blank to keep the saved credential.',
  'config.gitSubdirPlaceholder': '1pass',
  'channel.perChannelHint': 'Each channel has independent configuration, credentials, automatic sync and encryption passwords for this vault only.',
};
export function vaultTranslations(readLanguage: () => 'zh' | 'en'): { syncT: TranslateNS<'config-manager-sync'>; cmT: TranslateNS<'config-manager'>; uiT: UiT } {
  const zhUi = makeUiT('zh'); const enUi = makeUiT('en');
  const interpolate = (value: string, params?: (Record<string,unknown>) | undefined): string => value.replace(/\{(\w+)\}/g, (whole, key: string) => params?.[key] === undefined ? whole : String(params[key]));
  const syncT: TranslateNS<'config-manager-sync'> = (key, params) => { const cn = readLanguage() === 'zh'; let value = (cn ? zhOverrides : enOverrides)[key] ?? (cn ? zh : en)[key]; value = (key === 'mode.includeSecrets' || key === 'mode.includeSecretsHint' ? value : value.replaceAll('DSH credentials', cn ? '本机安全凭据槽' : 'secure local credential slots')).replaceAll('DSH_CONFIG_MANAGER', 'PASSWORDVAULT'); return interpolate(value, params); };
  const cmT: TranslateNS<'config-manager'> = (key, params) => { const cn = readLanguage() === 'zh'; const values: Record<string,string> = { 'section.vault': cn ? '密码库' : 'Password vault', 'common.close': cn ? '关闭' : 'Close', 'common.cancel': cn ? '取消' : 'Cancel', 'common.infoHint': cn ? '说明' : 'Information', 'backupFiles.encryptedHint': cn ? '密码库载荷始终加密' : 'Vault payloads are always encrypted', 'library.moreActions': cn ? '更多操作' : 'More actions', 'library.expand': cn ? '展开 {name}' : 'Expand {name}' }; return interpolate(values[key] ?? (cn ? zhUi : enUi)(key as Parameters<UiT>[0]), params); };
  const uiT: UiT = (key, params) => { const cn = readLanguage() === 'zh'; if (key === 'sync.privateRepoHint') return syncT('privateRepoHint'); return (cn ? zhUi : enUi)(key, params); };
  return { syncT, cmT, uiT };
}
