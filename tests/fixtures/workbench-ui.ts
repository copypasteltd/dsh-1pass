import { vi } from 'vitest'
import type { VaultSectionProps } from '../../src/client/VaultSection.tsx'
import { en } from '../../src/client/locales.ts'
import type { VaultLocaleKey } from '../../src/client/locales.ts'
export function workbenchFixture(options: { configured?: boolean; exists?: boolean } = {}) {
  let configured = options.configured ?? true
  let entries = [{ id: 'entry-fixture', title: 'Example account', kind: 'login', username: 'example-user', url: 'https://example.com', tags: ['test'], createdAt: 1794670000000, updatedAt: 1794670000000 }]
  let locked = false
  const api = {
    t: (key: VaultLocaleKey) => en[key],
    setupStatus: vi.fn(async () => ({ configured, exists: options.exists ?? false })),
    openWithPassword: vi.fn(async (_password: string) => { configured = true; return { locked: false, entries: entries.length } }),
    config: vi.fn(async () => ({ accessMode: 'auto' as const, autoCapture: false, autoLockSeconds: 0, toolProfile: 'basic' as const, toolGroups: ['core'] })),
    list: vi.fn(async () => entries), search: vi.fn(async (query: string) => entries.filter(e => e.title.toLowerCase().includes(query.toLowerCase()))),
    get: vi.fn(async (id: string) => ({ found: true, entry: { ...entries.find(e => e.id === id), password: 'synthetic-entry-password' } })),
    add: vi.fn(async (patch: { title: string }) => { const e = { ...entries[0]!, ...patch, id: 'created-fixture' }; entries = [...entries, e]; return e }),
    update: vi.fn(async (id: string, patch: object) => ({ found: true, entry: { ...entries.find(e => e.id === id), ...patch } })),
    remove: vi.fn(async (id: string) => { entries = entries.filter(e => e.id !== id); return { deleted: true } }),
    status: vi.fn(async () => ({ locked, entries: entries.length })),
    lock: vi.fn(async () => { locked = true; return { locked } }), unlock: vi.fn(async () => { locked = false; return { locked } }),
    listVaults: vi.fn(async () => [{ name: 'default', active: true, entries: entries.length }]),
    stats: vi.fn(async () => ({ total: entries.length, byKind: { login: entries.length }, withTotp: 0, trashCount: 0 })),
    backupStatus: vi.fn(async () => ({ daysSinceBackup: 1, backups: 2 })),
    health: vi.fn(async () => ({ weak: [], reused: [], no2fa: [], httpSites: [], score: 100, verdict: 'good', strength: { weak: 0, fair: 0, strong: 1 } })),
    duplicates: vi.fn(async () => ({ groups: 0 })),
    backup: vi.fn(async () => ({ path: 'synthetic-backup.json', kept: 1, pruned: 0 })),
    cloudBackup: vi.fn(async () => ({ config: { enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] }, statuses: [], running: false })),
    setCloudBackup: vi.fn(async (config: unknown) => ({ config, statuses: [], running: false })),
    runCloudBackup: vi.fn(async () => ({ config: { enabled: false, onChange: true, intervalMinutes: 60, retention: 10, targets: [] }, statuses: [], running: false })),
    history: vi.fn(async () => [{ action: 'add', title: 'Example account', at: 1794670000000 }]),
    recent: vi.fn(async () => entries),
    templates: vi.fn(async () => []), watchtower: vi.fn(async () => []), sessionListOpen: vi.fn(async () => []), sessionListSaved: vi.fn(async () => []),
    rotation: vi.fn(async () => []), duplicateGroups: vi.fn(async () => []), verifyAll: vi.fn(async () => []), tags: vi.fn(async () => []), generatorHistory: vi.fn(async () => []), backups: vi.fn(async () => []), trash: vi.fn(async () => []),
  }
  return { api, props: api as unknown as VaultSectionProps }
}
