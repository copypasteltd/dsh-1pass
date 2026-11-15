/**
 * Password workbench adapted from dsh-config-manager's ConfigManagerSection,
 * HomePanel and TaskShell (MIT). Its host APIs are deliberately not copied:
 * one persistent VaultSection continues to own every existing vault operation.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import metadata from '../../package.json' with { type: 'json' }
import { VaultSection, type VaultSectionProps, type VaultWorkbenchCommand, type VaultWorkbenchSnapshot } from './VaultSection.tsx'
import type { VaultLocaleKey } from './locales.ts'
import { MAIN_PAGES, TASK_PAGES, activeTask, navLayout, openPage, openTask, readNavigation, routeTab, type MainPage, type TaskPage, type VaultTab } from './workbench/workbench-model.ts'
import css from './VaultWorkbench.module.css'
import { QuickImportPanel } from './QuickImportPanel.tsx'

const NAV_KEYS: Record<MainPage, VaultLocaleKey> = { home: 'wbHome', entries: 'wbEntries', backup: 'wbBackup', permissions: 'wbSettings' }
const TASK_KEYS: Record<TaskPage, VaultLocaleKey> = { security: 'wbSecurity', transfer: 'wbTransfer', sessions: 'wbSessions', audit: 'wbAudit', trash: 'wbTrash', about: 'wbAbout', activity: 'wbAudit', 'quick-import': 'quickImportTitle', 'local-backups': 'wbLocalBackups' }
const STORAGE_KEY = 'dsh-onepass-workbench-navigation'
const INITIAL_SNAPSHOT: VaultWorkbenchSnapshot = { busy: false, locked: false, count: 0, vaultName: '', accessMode: '', editorOpen: false, ready: false, message: null, backups: 0, weak: 0, reused: 0, score: null, activity: [] }
type Glyph = 'search' | 'activity' | 'history' | 'about' | 'back' | 'close' | 'down' | 'key' | 'cloud' | 'shield' | 'transfer' | 'sessions' | 'trash' | 'plus' | 'refresh'
function Icon({ name, size = 14 }: { name: Glyph; size?: number }): ReactNode {
  const paths: Record<Glyph, ReactNode> = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /><path d="M12 7v5l3 2" /></>,
    about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.5" /></>,
    back: <path d="m10 5-7 7 7 7m-7-7h18" />, close: <path d="m6 6 12 12M6 18 18 6" />,
    down: <path d="m6 9 6 6 6-6" />, key: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-3-3 3-3m-6 0 3-3" /></>,
    cloud: <path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11H6Z" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    transfer: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />,
    sessions: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.1m3 0h.1" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M9 10v7m6-7v7" /></>,
    plus: <path d="M12 4v16M4 12h16" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

/** Registration API: identical business injections to VaultSectionProps. */
export function VaultWorkbench(props: VaultSectionProps): ReactNode {
  const { t } = props
  const root = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const [navigation, setNavigation] = useState(() => {
    try { return readNavigation(sessionStorage.getItem(STORAGE_KEY)) } catch { return readNavigation(null) }
  })
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT)
  const [importBusy, setImportBusy] = useState(false)
  const [command, setCommand] = useState<VaultWorkbenchCommand | null>(null)
  const commandId = useRef(0)
  const [boot, setBoot] = useState<'loading' | 'ready' | 'password' | 'error'>(props.setupStatus ? 'loading' : 'ready')
  const [exists, setExists] = useState(true)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [bootBusy, setBootBusy] = useState(false)
  const [bootError, setBootError] = useState('')
  const bootLive = useRef(false)
  const bootGeneration = useRef(0)
  useEffect(() => { bootLive.current = true; return () => { bootLive.current = false; bootGeneration.current++ } }, [])
  const task = activeTask(navigation)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButton = useRef<HTMLButtonElement | null>(null)
  const moreMenu = useRef<HTMLDivElement | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const paletteInput = useRef<HTMLInputElement | null>(null)
  const paletteBox = useRef<HTMLDivElement | null>(null)
  const overlayOpener = useRef<HTMLElement | null>(null)
  const taskHead = useRef<HTMLElement | null>(null)
  const engineScroll = useRef<HTMLDivElement | null>(null)
  const scrollPositions = useRef<Record<string, number>>({})
  const previousView = useRef('')
  const navRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [widths, setWidths] = useState<{ available: number; items: number[]; more: number } | null>(null)
  const issueCommand = useCallback((kind: VaultWorkbenchCommand['kind'], value?: string) => {
    setCommand({ id: ++commandId.current, kind, ...(value !== undefined ? { value } : {}) })
  }, [])
  const goto = useCallback((page: MainPage) => { if (importBusy) return; setMoreOpen(false); setNavigation(state => openPage(state, page)) }, [importBusy])
  const open = useCallback((kind: TaskPage) => {
    if (importBusy) return
    overlayOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setNavigation(state => openTask(state, kind))
  }, [importBusy])
  const closeTask = useCallback(() => {
    if (importBusy) return
    setNavigation(state => ({ ...state, task: null }))
    queueMicrotask(() => { if (overlayOpener.current?.isConnected) overlayOpener.current.focus() })
  }, [importBusy])
  const onNavigate = useCallback((tab: VaultTab) => { setNavigation(state => routeTab(state, tab)) }, [])
  const create = useCallback(() => { setNavigation({ page: 'entries', task: null }); issueCommand('create') }, [issueCommand])
  const search = useCallback(() => { setNavigation({ page: 'entries', task: null }); issueCommand('search') }, [issueCommand])
  const loadBoot = useCallback(async () => {
    if (!props.setupStatus) { setBoot('ready'); return }
    const generation = ++bootGeneration.current
    setBoot('loading'); setBootError('')
    try { const result = await props.setupStatus(); if (!bootLive.current || generation !== bootGeneration.current) return; setExists(result.exists); setBoot(result.configured ? 'ready' : 'password') }
    catch { if (bootLive.current && generation === bootGeneration.current) setBoot('error') }
  }, [props.setupStatus])
  useEffect(() => { void loadBoot() }, [loadBoot])
  useEffect(() => { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ page: navigation.page })) } catch { /* optional navigation memory */ } }, [navigation.page])
  const submitPassword = async (): Promise<void> => {
    if (bootBusy || !props.openWithPassword) return
    if (password.length === 0) { setBootError(t('wbRequired')); return }
    if (!exists && password !== confirmation) { setBootError(t('wbMismatch')); return }
    const generation = ++bootGeneration.current
    setBootBusy(true); setBootError('')
    try { const result = await props.openWithPassword(password); if (!bootLive.current || generation !== bootGeneration.current) return; if (result.locked) throw new Error('locked'); setPassword(''); setConfirmation(''); setBoot('ready') }
    catch { if (bootLive.current && generation === bootGeneration.current) { setBootError(t('wbSetupFailed')); setPassword(''); setConfirmation('') } }
    finally { if (bootLive.current && generation === bootGeneration.current) setBootBusy(false) }
  }
  useLayoutEffect(() => {
    const strip = navRef.current, measure = measureRef.current
    if (!strip || !measure) return
    const update = () => {
      const style = getComputedStyle(strip)
      const children = Array.from(measure.children)
      const available = strip.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      const more = children[0]?.getBoundingClientRect().width ?? 0
      const items = children.slice(1).map(child => child.getBoundingClientRect().width)
      setWidths(old => old && old.available === available && old.more === more && old.items.every((value, i) => value === items[i]) ? old : { available, more, items })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(strip)
    let live = true
    void document.fonts?.ready.then(() => { if (live) update() })
    return () => { live = false; observer?.disconnect() }
  }, [t, boot])
  const layout = widths ? navLayout(widths.items, widths.available, widths.more) : { visible: MAIN_PAGES.map((_, i) => i), overflow: [] }
  const visibleNav = layout.visible.map(index => MAIN_PAGES[index]!)
  const overflowNav = layout.overflow.map(index => MAIN_PAGES[index]!)
  const tabKey = (page: MainPage) => id + '-nav-' + page
  const activeTabId = visibleNav.includes(navigation.page) ? tabKey(navigation.page) : id + '-more'
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"], [data-nav-more]') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault(); buttons[next]?.focus()
  }
  useEffect(() => {
    if (!moreOpen) return
    moreMenu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !moreMenu.current?.contains(event.target) && !moreButton.current?.contains(event.target)) setMoreOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [moreOpen])
  useEffect(() => { if (task) taskHead.current?.focus() }, [task])
  const viewKey = task ?? navigation.page
  useLayoutEffect(() => {
    const body = engineScroll.current
    if (!body) return
    if (previousView.current) scrollPositions.current[previousView.current] = body.scrollTop
    previousView.current = viewKey
    body.scrollTop = scrollPositions.current[viewKey] ?? 0
  }, [viewKey])
  const commandItems = useMemo(() => [
    ...MAIN_PAGES.map(page => ({ id: page, label: t(NAV_KEYS[page]), disabled: false, run: () => goto(page) })),
    ...TASK_PAGES.map(kind => ({ id: kind, label: t(TASK_KEYS[kind]), disabled: false, run: () => open(kind) })),
    { id: 'new', label: t('wbNew'), disabled: snapshot.locked || snapshot.accessMode === 'readonly' || !snapshot.ready, run: create },
    { id: 'search', label: t('wbSearch'), disabled: snapshot.locked, run: search },
    { id: 'refresh', label: t('wbRefresh'), disabled: snapshot.busy, run: () => issueCommand('refresh') },
    { id: 'lock', label: t('wbLock'), disabled: snapshot.locked || snapshot.busy, run: () => issueCommand('lock') },
  ], [t, goto, open, snapshot, create, search, issueCommand])
  const filteredCommands = commandItems.filter(item => item.label.toLocaleLowerCase().includes(paletteQuery.trim().toLocaleLowerCase()))
  const closePalette = useCallback(() => {
    setPaletteOpen(false); setPaletteQuery(''); setPaletteIndex(0)
    queueMicrotask(() => { if (overlayOpener.current?.isConnected) overlayOpener.current.focus() })
  }, [])
  const showPalette = useCallback(() => {
    if (snapshot.editorOpen || importBusy) return
    overlayOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPaletteQuery(''); setPaletteIndex(0); setPaletteOpen(true)
  }, [snapshot.editorOpen, importBusy])
  useEffect(() => { if (paletteOpen) paletteInput.current?.focus() }, [paletteOpen])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-vault-dialog]')) return
      const typing = event.target instanceof Element && !!event.target.closest('input,textarea,select,[contenteditable="true"]')
      if (typing) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !snapshot.editorOpen && !importBusy) {
        event.preventDefault(); event.stopPropagation(); if (paletteOpen) closePalette(); else showPalette()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !snapshot.editorOpen && !importBusy && boot === 'ready') {
        const typing = event.target instanceof Element && !!event.target.closest('input,textarea,select,[contenteditable="true"]')
        if (!typing) { event.preventDefault(); event.stopPropagation(); if (!snapshot.locked && snapshot.accessMode !== 'readonly') create() }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [showPalette, closePalette, paletteOpen, snapshot.editorOpen, snapshot.locked, snapshot.accessMode, create, boot, importBusy])
  // Boot and list states outrank operation messages, which may describe an older view.
  const loadState = snapshot.loadState ?? (snapshot.ready ? 'ready' : 'loading')
  const footerStatus = boot === 'loading' ? { text: t('wbBootLoading'), dot: 'unknown' }
    : boot === 'error' ? { text: t('wbLoadFailed'), dot: 'warn' }
    : boot === 'password' ? bootBusy ? { text: t('wbWorking'), dot: 'unknown' }
      : { text: t(bootError ? 'wbOpenFailedStatus' : exists ? 'wbWaitingUnlock' : 'wbWaitingCreate'), dot: 'warn' }
    : snapshot.locked ? { text: t('lockedShort'), dot: 'warn' }
    : snapshot.busy ? { text: t('wbWorking'), dot: 'unknown' }
    : loadState === 'error' ? { text: t('wbEntriesLoadFailed'), dot: 'warn' }
    : loadState === 'loading' ? { text: t('wbEntriesLoading'), dot: 'unknown' }
    : { text: snapshot.message || t('wbReady'), dot: 'ok' }
  const taskIsLocal = task === 'about' || task === 'activity' || task === 'quick-import'
  const engineVisible = boot === 'ready' && ((!task && navigation.page !== 'home') || (!!task && !taskIsLocal) || snapshot.editorOpen)
  const engineTab: VaultTab = task === 'local-backups' ? 'backup' : task && !taskIsLocal ? task as VaultTab : navigation.page === 'home' ? 'entries' : navigation.page
  const activityTable = <div className={css.card}>
    <header className={css.cardHead}><strong>{t('wbRecent')}</strong><button type="button" className={css.ghostButton} onClick={() => open('audit')}>{t('wbAudit')}</button></header>
    {!snapshot.ready ? <div className={css.empty} role="status">{t('loading')}</div> : snapshot.activity.length === 0 ? <div className={css.empty}>{t('wbNoActivity')}</div> : <>
      <div className={css.activityHead}><span>{t('wbTime')}</span><span>{t('wbEvent')}</span><span>{t('wbDetail')}</span></div>
      {snapshot.activity.map((item, index) => <div className={css.activityRow} key={index}><time title={item.at > 0 ? new Date(item.at).toLocaleString() : undefined}>{item.at > 0 ? new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</time><span>{item.action || '—'}</span><span title={item.title}>{item.title || '—'}</span></div>)}
    </>}
  </div>
  return <div ref={root} className={css.section} data-vault-workbench="" aria-label={t('nav')}>
    <nav className={css.shellNav} aria-label={t('nav')}>
      <div ref={navRef} className={css.navStrip} role="tablist" onKeyDown={onTabsKeyDown}>
        {visibleNav.map(page => <button key={page} id={tabKey(page)} className={css.navTab} type="button" role="tab" aria-selected={navigation.page === page} aria-controls={id + '-page'} tabIndex={navigation.page === page ? 0 : -1} data-active={navigation.page === page ? '' : undefined} disabled={snapshot.editorOpen || importBusy} onClick={() => goto(page)}>{t(NAV_KEYS[page])}</button>)}
        {overflowNav.length > 0 && <button ref={moreButton} type="button" id={id + '-more'} data-nav-more="" className={css.navMore} data-active={overflowNav.includes(navigation.page) ? '' : undefined} aria-haspopup="menu" aria-expanded={moreOpen} disabled={snapshot.editorOpen || importBusy} onClick={() => setMoreOpen(value => !value)}>{t('wbMore')}<Icon name="down" size={12} /></button>}
      </div>
      <div className={css.navActions}>
        <button type="button" className={css.iconButton} title={t('wbCommands') + ' · Ctrl / ⌘ K'} aria-label={t('wbCommands')} disabled={snapshot.editorOpen || importBusy} onClick={showPalette}><Icon name="search" /></button>
        <button type="button" className={css.iconButton} aria-label={t('wbRecent')} title={t('wbRecent')} data-active={task === 'activity' ? '' : undefined} disabled={snapshot.editorOpen || importBusy} onClick={() => open('activity')}><Icon name="activity" /></button>
        <button type="button" className={css.iconButton} aria-label={t('wbAudit')} title={t('wbAudit')} data-active={task === 'audit' ? '' : undefined} disabled={snapshot.editorOpen || importBusy} onClick={() => open('audit')}><Icon name="history" /></button>
        <button type="button" className={css.iconButton} aria-label={t('wbAbout')} title={t('wbAbout')} data-active={task === 'about' ? '' : undefined} disabled={snapshot.editorOpen || importBusy} onClick={() => open('about')}><Icon name="about" /></button>
      </div>
    </nav>
    {moreOpen && <div ref={moreMenu} className={css.moreMenu} role="menu" aria-label={t('wbMore')} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); moreButton.current?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const buttons = Array.from(moreMenu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []); const at = buttons.indexOf(document.activeElement as HTMLButtonElement); event.preventDefault(); buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
    }}>{overflowNav.map(page => <button key={page} type="button" role="menuitem" data-active={navigation.page === page ? '' : undefined} onClick={() => { goto(page); queueMicrotask(() => root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()) }}>{t(NAV_KEYS[page])}</button>)}</div>}
    <div className={css.shellContent} onKeyDown={event => {
      if (event.key !== 'Escape' || !task || snapshot.editorOpen || importBusy || root.current?.querySelector('[data-vault-dialog]')) return
      if (task === 'transfer' || task === 'sessions') { event.stopPropagation(); return }
      event.preventDefault(); event.stopPropagation(); closeTask()
    }}>
      {boot !== 'ready' && <main className={css.bootstrap}>
        {boot === 'loading' ? <p role="status">{t('loading')}</p> : boot === 'error' ? <div role="alert"><p>{t('wbLoadFailed')}</p><button className={css.ghostButton} type="button" onClick={() => void loadBoot()}>{t('wbRetry')}</button></div> : <form className={css.card} onSubmit={event => { event.preventDefault(); void submitPassword() }}>
          <header className={css.cardHead}><strong>{exists ? t('wbOpenVault') : t('wbCreateVault')}</strong></header>
          <div className={css.formBody}><p className={css.hint}>{exists ? t('wbSetupHint') : t('wbCreateHint')}</p>
            <label className={css.field}>{t('wbMasterPassword')}<input autoFocus type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={bootBusy} /></label>
            {!exists && <label className={css.field}>{t('wbConfirmPassword')}<input type="password" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={bootBusy} /></label>}
            {bootError && <p className={css.error} role="alert">{bootError}</p>}
            <button className={css.primaryButton} type="submit" disabled={bootBusy || !props.openWithPassword} aria-busy={bootBusy}>{bootBusy ? t('wbWorking') : exists ? t('wbOpenVault') : t('wbCreateVault')}</button>
          </div>
        </form>}
      </main>}
      <main className={css.shellMain} id={navigation.page === 'home' ? id + '-page' : undefined} role="tabpanel" aria-labelledby={activeTabId} tabIndex={-1} hidden={boot !== 'ready' || navigation.page !== 'home' || task !== null || snapshot.editorOpen}>
        <div className={css.pagePad}>
          <div className={css.statStrip}>
            <span className={css.statHealth}><span className={css.statusDot} data-state={!snapshot.ready ? 'unknown' : snapshot.locked ? 'warn' : 'ok'} />{!snapshot.ready ? t('loading') : snapshot.locked ? t('lockedShort') : t('wbReady')}</span>
            <button type="button" className={css.statSegment} onClick={() => goto('entries')}>{t('wbEntries')} <b>{snapshot.ready ? snapshot.count : '—'}</b></button>
            <button type="button" className={css.statSegment} onClick={() => open('local-backups')}>{t('wbLocalBackups')} <b>{snapshot.ready ? snapshot.backups : '—'}</b></button>
            <button type="button" className={css.statSegment} onClick={() => open('security')}>{t('wbSecurity')} <b>{snapshot.ready && snapshot.score !== null ? snapshot.score : '—'}</b></button>
          </div>
          <div className={css.toolRow} aria-label={t('wbQuickActions')}>
            <button className={css.primaryButton} type="button" onClick={create} disabled={!snapshot.ready || snapshot.locked || snapshot.accessMode === 'readonly'}><Icon name="plus" />{t('wbNew')}</button>
            <button className={css.ghostButton} type="button" onClick={() => open('quick-import')} disabled={!snapshot.ready || snapshot.locked || snapshot.accessMode === 'readonly'}><Icon name="transfer" />{t('quickImportEntry')}</button>
            <button className={css.ghostButton} type="button" onClick={() => open('transfer')}><Icon name="transfer" />{t('wbTransfer')}</button>
            <button className={css.ghostButton} type="button" onClick={() => goto('backup')}><Icon name="cloud" />{t('wbBackup')}</button>
            <button className={css.ghostButton} type="button" onClick={() => issueCommand('refresh')} disabled={snapshot.busy}><Icon name="refresh" />{t('wbRefresh')}</button>
          </div>
          <div className={css.quickGrid}>
            {([{ kind: 'security', icon: 'shield', hint: 'wbSecurityHint' }, { kind: 'sessions', icon: 'sessions', hint: 'wbSessionsHint' }, { kind: 'transfer', icon: 'transfer', hint: 'wbTransferHint' }, { kind: 'trash', icon: 'trash', hint: 'wbTrashHint' }] as const).map(item => <button key={item.kind} type="button" className={css.quickCard} onClick={() => open(item.kind)}><Icon name={item.icon} size={18} /><span><strong>{t(TASK_KEYS[item.kind])}</strong><small>{t(item.hint)}</small></span><span className={css.quickArrow} aria-hidden="true">›</span></button>)}
          </div>
          {activityTable}
        </div>
      </main>
      {task !== null && <header ref={taskHead} tabIndex={-1} className={css.taskHead} aria-label={t(TASK_KEYS[task])}>
        <button className={css.ghostButton} type="button" onClick={closeTask} disabled={snapshot.editorOpen || importBusy}><Icon name="back" />{t('wbBack').replace('{page}', t(NAV_KEYS[navigation.page]))}</button>
        <strong>{t(TASK_KEYS[task])}</strong><span className={css.spacer} />
        <button className={css.iconButton} type="button" aria-label={t('wbClose')} disabled={snapshot.editorOpen || importBusy} onClick={closeTask}><Icon name="close" /></button>
      </header>}
      {boot === 'ready' && <div ref={engineScroll} className={task ? css.taskBody : css.engineBody} hidden={!engineVisible} data-editor-open={snapshot.editorOpen ? '' : undefined} role={task ? 'region' : 'tabpanel'} id={navigation.page !== 'home' && !task ? id + '-page' : undefined} aria-labelledby={!task && navigation.page !== 'home' ? activeTabId : undefined} aria-label={task ? t(TASK_KEYS[task]) : undefined} onKeyDown={event => {
        if (event.key === 'Escape' && task && (task === 'audit' || task === 'security' || task === 'trash') && !snapshot.editorOpen && !root.current?.querySelector('[data-vault-dialog]')) { event.stopPropagation(); event.preventDefault(); closeTask() }
      }}><VaultSection {...props} embedded backupView={task === 'local-backups' ? 'local' : 'cloud'} onQuickImport={() => open('quick-import')} activeTab={engineTab} onNavigate={onNavigate} onStatusChange={setSnapshot} command={command} /></div>}
      {taskIsLocal && <section className={css.localTask} role="region" aria-label={t(TASK_KEYS[task!])} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTask() } }}><div className={css.pagePad}>
        {task === 'quick-import' ? (props.previewQuickImport && props.commitQuickImport ? <QuickImportPanel key={snapshot.vaultName} t={t} previewQuickImport={props.previewQuickImport} commitQuickImport={props.commitQuickImport} {...(props.discardQuickImport ? { discardQuickImport: props.discardQuickImport } : {})} readonly={snapshot.accessMode === 'readonly'} locked={snapshot.locked} unavailable={!snapshot.ready || snapshot.busy} vaultName={snapshot.vaultName || 'default'} onImported={() => issueCommand('refresh')} onBusyChange={setImportBusy} /> : <p role="alert">{t('quickImportUnavailable')}</p>) : task === 'activity' ? activityTable : <div className={css.card}><header className={css.cardHead}><Icon name="key" size={18} /><strong>{t('nav')}</strong><span className={css.spacer} /><span>v{metadata.version}</span></header><div className={css.formBody}><p>{t('wbAboutText')}</p><p className={css.hint}>{t('wbAboutStorage')}</p><p className={css.hint}>{t('wbPrivacy')}</p><a href="https://github.com/copypasteltd/dsh-1pass" target="_blank" rel="noreferrer">GitHub · DSH-1pass</a></div></div>}
      </div></section>}
    </div>
    <footer className={css.statusBar}>
      <span className={css.statusDot} data-state={footerStatus.dot} aria-hidden="true" />
      <span className={css.statusText} role="status" aria-live="polite">{footerStatus.text}</span>
      {snapshot.vaultName && <span className={css.statusVault}>{snapshot.vaultName}</span>}<span className={css.spacer} /><span title={t('wbVersion')}>v{metadata.version}</span>
    </footer>
    <div ref={measureRef} className={css.navMeasure} aria-hidden="true"><button type="button" tabIndex={-1} className={css.navMore}>{t('wbMore')}<Icon name="down" size={12} /></button>{MAIN_PAGES.map(page => <button type="button" tabIndex={-1} className={css.navTab} key={page}>{t(NAV_KEYS[page])}</button>)}</div>
    {paletteOpen && <div className={css.paletteMask} data-vault-dialog="" onMouseDown={event => { if (event.target === event.currentTarget) closePalette() }}><div ref={paletteBox} className={css.palette} role="dialog" aria-modal="true" aria-label={t('wbCommands')} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); closePalette() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % Math.max(1, filteredCommands.length)) }
      if (event.key === 'Enter') { const item = filteredCommands[paletteIndex]; if (item && !item.disabled) { event.preventDefault(); closePalette(); item.run() } }
      if (event.key === 'Tab') { const nodes = Array.from(paletteBox.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? []); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
    }}><div className={css.paletteSearch}><Icon name="search" size={16} /><input ref={paletteInput} value={paletteQuery} onChange={event => { setPaletteQuery(event.target.value); setPaletteIndex(0) }} placeholder={t('wbCommandSearch')} aria-label={t('wbCommandSearch')} role="combobox" aria-expanded="true" aria-controls={id + '-commands'} aria-activedescendant={filteredCommands[paletteIndex] ? id + '-command-' + paletteIndex : undefined} /><button type="button" className={css.iconButton} aria-label={t('wbClose')} onClick={closePalette}><Icon name="close" /></button></div><div id={id + '-commands'} className={css.paletteList} role="listbox">{filteredCommands.length === 0 ? <p className={css.empty}>{t('wbNoCommands')}</p> : filteredCommands.map((item, index) => <button id={id + '-command-' + index} key={item.id} type="button" role="option" aria-selected={index === paletteIndex} disabled={item.disabled} className={css.paletteItem} onMouseEnter={() => setPaletteIndex(index)} onClick={() => { closePalette(); item.run() }}>{item.label}</button>)}</div></div></div>}
  </div>
}
