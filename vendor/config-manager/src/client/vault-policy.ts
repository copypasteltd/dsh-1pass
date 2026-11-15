/** Vault-only adapter; no remote I/O. The host independently enforces all authorization. */
import { cloudSyncErrorCode, type CloudSyncCall } from './sync/sync-api.ts';
export const CLOUD_SYNC_ACTIONS = ['status','workdirReset','probe','exportPreview','push','pushPreview','pull','download','deleteSnapshot','githubStart','githubPoll','githubCancel','githubValidate','githubListRepositories','githubCreateRepository','history','snapshotsList','sync','applyItems','cancel','autosyncStatusAll','autosyncStatus','autosyncUpdate','saveSelection','saveConfig','clearChannel','saveUiPrefs','rollback','mergePreview','applyMerge','consult'] as const;
export type CloudSyncAction = typeof CLOUD_SYNC_ACTIONS[number];
const READ_ONLY = new Set<CloudSyncAction>(['status','history','autosyncStatusAll','autosyncStatus','exportPreview','pushPreview','snapshotsList','githubValidate','githubListRepositories','mergePreview','consult']);
const ENCRYPTED = new Set<CloudSyncAction>(['push','pushPreview','pull','download','sync','mergePreview','applyMerge','saveSelection','saveConfig']);
export interface CloudSyncAccess { readonly: boolean; locked: boolean; unavailable: boolean }
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function assertCloudSyncAction(action: string, access: CloudSyncAccess): asserts action is CloudSyncAction {
  if (!(CLOUD_SYNC_ACTIONS as readonly string[]).includes(action)) throw new Error('Unsupported cloud sync action.');
  if (access.unavailable || access.locked) throw new Error('Unlock the password vault before using cloud sync.');
  if (access.readonly && !READ_ONLY.has(action as CloudSyncAction)) throw new Error('Cloud sync is read-only.');
}
export function vaultPayload(action: CloudSyncAction, payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = { ...payload };
  if (Array.isArray(out.sections)) out.sections = out.sections.filter(v => v === 'vault');
  if (action === 'exportPreview') out.only = ['vault'];
  if (ENCRYPTED.has(action)) { out.encrypt = true; out.includeSecrets = false; delete out.clearEncryptPassword; delete out.deletePlugins; delete out.sessions; delete out.sessionsInclude; delete out.sessionsLimit; }
  if (action === 'githubCreateRepository') out.private = true;
  return out;
}
const DROP = /^(?:password|passwordConfirm|encryptPassword|decryptPassword|token|secret|apiKey|accessToken|refreshToken|privateKey|otpSecret|encryptedPayload|ciphertext|decryptedCredentials|raw|contents?|diff|local|remote|ancestor)$/i;
/** Do not deliver entry values or raw conflict sides to React, even if a host accidentally includes them. */
export function safeCloudSyncResponse(value: unknown, knownSecrets: readonly string[], depth = 0): unknown {
  if (depth > 40) return null;
  if (typeof value === 'string') { let text = value; for (const secret of knownSecrets) if (secret !== '') text = text.split(secret).join('[REDACTED]'); return text; }
  if (Array.isArray(value)) return value.map(v => safeCloudSyncResponse(v, knownSecrets, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROP.test(key)) continue;
    if (key === 'entries' && Array.isArray(item) && item.some(entry => isRecord(entry) && ('password' in entry || 'fields' in entry || 'username' in entry))) continue;
    if (/^(?:localPreview|remotePreview|ancestorPreview)$/.test(key)) out[key] = '[REDACTED]';
    else out[key] = safeCloudSyncResponse(item, knownSecrets, depth + 1);
  }
  return out;
}
export function rememberSecrets(payload: unknown, known: Set<string>): void { if (!isRecord(payload)) return; for (const [key,value] of Object.entries(payload)) { if (/password|token|secret|accessKeyId/i.test(key) && typeof value === 'string' && value !== '') known.add(value); } }
export function createGuardedCloudSyncCall(call: CloudSyncCall, access: () => CloudSyncAccess, active: () => boolean, onBusy: (busy: boolean) => void): { call: CloudSyncCall; clear: () => void } {
  const known = new Set<string>(); let inFlight = 0;
  return {
    call: async (action, payload) => {
      assertCloudSyncAction(action, access());
      if (!active()) throw new Error('Cloud sync scope has closed.');
      rememberSecrets(payload, known);
      inFlight++; onBusy(true);
      try {
        const response = await call(action, vaultPayload(action, payload));
        if (!active()) throw new Error('Cloud sync scope has closed.');
        return safeCloudSyncResponse(response, [...known]);
      } catch (error) { throw new Error(cloudSyncErrorCode(error) ?? 'Cloud sync request did not complete. Check the channel configuration and try again.'); }
      finally { inFlight--; if (active()) onBusy(inFlight > 0); }
    },
    clear: () => { known.clear(); inFlight = 0; onBusy(false); },
  };
}
