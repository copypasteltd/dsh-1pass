/** QA-only real React view; the binding delegates every action to the actual host controller. */
import { createRoot } from 'react-dom/client'
import { CloudSyncPanel } from '../../src/client/CloudSyncPanel.tsx'
import { en } from '../../src/client/locales.ts'
import { vaultTranslations } from '../../vendor/config-manager/src/client/vault-translations.ts'
const tr = vaultTranslations(() => 'en')
const qa = window as unknown as { __githubConnectedHost(action: string, payload?: unknown): Promise<unknown>; __githubConnectedQA: unknown }
const calls: Array<{ action: string; status: string }> = []
qa.__githubConnectedQA = { calls, labels: Object.fromEntries(['history.empty','channel.open','common.close','config.repoUrl','config.gitSubdir','mode.password','mode.passwordConfirm','syncflow.pushPreviewTitle','syncflow.pushConfirm'].map(key => [key, tr.syncT(key as never)])) }
async function call(action: string, payload?: unknown) {
  const entry = { action, status: 'pending' }; calls.push(entry)
  try { const result = await qa.__githubConnectedHost(action, payload); entry.status = 'complete'; return result }
  catch (error) { entry.status = 'failed'; throw error }
}
createRoot(document.getElementById('root')!).render(<CloudSyncPanel t={key => en[key]} cloudSyncCall={call} readonly={false} locked={false} unavailable={false} vaultName="synthetic-browser-connected" />)
