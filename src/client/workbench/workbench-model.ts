/** Navigation model adapted from dsh-config-manager (MIT), src/ui/nav-model.ts. */
export type VaultTab = 'entries' | 'security' | 'transfer' | 'backup' | 'permissions' | 'sessions' | 'audit' | 'trash'
export type MainPage = 'home' | 'entries' | 'backup' | 'permissions'
export type TaskPage = Exclude<VaultTab, 'entries' | 'backup' | 'permissions'> | 'about' | 'activity' | 'quick-import' | 'local-backups'
export const MAIN_PAGES: readonly MainPage[] = ['home', 'entries', 'backup', 'permissions']
export const TASK_PAGES: readonly TaskPage[] = ['security', 'transfer', 'sessions', 'audit', 'trash', 'about', 'quick-import', 'local-backups']
export interface WorkbenchNavigation { page: MainPage; task: { kind: TaskPage; origin: MainPage } | null }
export const INITIAL_NAVIGATION: WorkbenchNavigation = { page: 'home', task: null }
/** Only navigation is persisted. No entry, draft, password, query or dialog enters storage. */
export function readNavigation(raw: string | null): WorkbenchNavigation {
  try { const value: unknown = raw === null ? null : JSON.parse(raw)
    const page = typeof value === 'object' && value !== null ? (value as { page?: unknown }).page : undefined
    return { page: MAIN_PAGES.includes(page as MainPage) ? page as MainPage : 'home', task: null }
  } catch { return INITIAL_NAVIGATION }
}
export function openPage(state: WorkbenchNavigation, page: MainPage): WorkbenchNavigation { return { ...state, page } }
export function openTask(state: WorkbenchNavigation, kind: TaskPage): WorkbenchNavigation { return { ...state, task: { kind, origin: state.page } } }
export function activeTask(state: WorkbenchNavigation): TaskPage | null { return state.task?.origin === state.page ? state.task.kind : null }
export function routeTab(state: WorkbenchNavigation, tab: VaultTab): WorkbenchNavigation {
  if (tab === 'entries' || tab === 'backup' || tab === 'permissions') return { page: tab, task: null }
  return openTask(state, tab)
}
/** Widths are measured from the real translated labels, not estimated character counts. */
export function navLayout(widths: readonly number[], available: number, moreWidth: number, gap = 2): { visible: number[]; overflow: number[] } {
  const all = () => ({ visible: widths.map((_, i) => i), overflow: [] as number[] })
  if (!widths.length) return all()
  if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(moreWidth) || moreWidth < 0 || widths.some(w => !Number.isFinite(w) || w < 0)) return all()
  const space = Number.isFinite(gap) && gap > 0 ? gap : 0
  const row = (n: number) => widths.slice(0, n).reduce((sum, w) => sum + w, 0) + Math.max(0, n - 1) * space
  if (row(widths.length) <= available + 1) return all()
  for (let n = widths.length - 1; n >= 1; n--) {
    if (row(n) + space + moreWidth <= available + 1) return { visible: widths.slice(0, n).map((_, i) => i), overflow: widths.slice(n).map((_, i) => i + n) }
  }
  return all()
}
