import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_QUICK_IMPORT_FORMAT, QUICK_IMPORT_PRESETS, SUPPORTED_QUICK_IMPORT_PLACEHOLDERS } from '../quick-import.ts'
import type { QuickImportApi, QuickImportCommitResult, QuickImportOptions, QuickImportPreview, QuickImportPreviewRow } from '../quick-import-types.ts'
import type { VaultTranslate } from './host-contracts.ts'
import type { QuickImportLocaleKey } from './quick-import-locales.ts'
import css from './QuickImportPanel.module.css'

/** This page owns only an in-memory draft. Every write requires a reviewed server preview. */
export interface QuickImportPanelProps {
  t: VaultTranslate
  previewQuickImport: QuickImportApi['previewQuickImport']
  commitQuickImport: QuickImportApi['commitQuickImport']
  discardQuickImport?: (token: string) => Promise<{ discarded: boolean }>
  readonly: boolean
  locked: boolean
  unavailable: boolean
  vaultName: string
  onImported?: () => void
  onBusyChange?: (busy: boolean) => void
}

type Stage = 'paste' | 'preview' | 'confirm' | 'result'
type Operation = 'preview' | 'commit' | null
type Request = { generation: number; environment: string; operation: Exclude<Operation, null> }
type CommitAttempt = { token: string; lines: number[] }
const MAX_BYTES = 1024 * 1024
const MAX_ROWS = 500
const SYNTHETIC_EXAMPLE = 'root@192.0.2.10:22|TEST-NOT-REAL|demo'
const stages: Array<{ stage: Stage; key: QuickImportLocaleKey }> = [
  { stage: 'paste', key: 'quickImportStagePaste' }, { stage: 'preview', key: 'quickImportStagePreview' },
  { stage: 'confirm', key: 'quickImportStageConfirm' }, { stage: 'result', key: 'quickImportStageResult' },
]

/** Only fixed local copy is rendered for diagnostics, never a backend error message. */
const diagnosticKeys: Record<string, QuickImportLocaleKey> = {
  EMPTY_FORMAT: 'quickImportErrFormat', FORMAT_TOO_LONG: 'quickImportErrFormat', INVALID_FORMAT: 'quickImportErrFormat',
  FORMAT_INVALID_ESCAPE: 'quickImportErrFormat', UNSUPPORTED_PLACEHOLDER: 'quickImportErrFormat', FORMAT_TOO_MANY_FIELDS: 'quickImportErrFormat',
  AMBIGUOUS_FORMAT: 'quickImportErrFormat', DUPLICATE_PLACEHOLDER: 'quickImportErrFormat', FORMAT_MISSING_USERNAME: 'quickImportErrRequired',
  FORMAT_MISSING_ADDRESS: 'quickImportErrRequired', FORMAT_MISSING_PASSWORD: 'quickImportErrRequired', FORMAT_MISMATCH: 'quickImportErrMatch',
  INVALID_ESCAPE: 'quickImportErrMatch', EMPTY_USERNAME: 'quickImportErrRequired', INVALID_USERNAME: 'quickImportErrInvalid',
  INVALID_IP: 'quickImportErrHost', INVALID_HOST: 'quickImportErrHost', EMPTY_PASSWORD: 'quickImportErrRequired',
  PASSWORD_TOO_LONG: 'quickImportErrRowLimit', INVALID_PORT: 'quickImportErrRowPort', INVALID_TAGS: 'quickImportErrInvalid',
  INVALID_LABEL: 'quickImportErrInvalid', INVALID_INPUT: 'quickImportErrInvalid', INPUT_TOO_LARGE: 'quickImportErrBytes',
  INVALID_OPTIONS: 'quickImportErrInvalid', INVALID_KIND: 'quickImportErrInvalid', INVALID_DEFAULT_PORT: 'quickImportErrPort',
  INVALID_DEFAULT_TAGS: 'quickImportErrInvalid', ROW_LIMIT_EXCEEDED: 'quickImportErrRows',
}
function diagnostic(code?: string): QuickImportLocaleKey {
  return code && Object.hasOwn(diagnosticKeys, code) ? diagnosticKeys[code]! : 'quickImportErrInvalid'
}
function nonnegative(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

/** Explicit allow-list: even accidental extra password/raw properties are never retained. */
function previewMetadata(value: QuickImportPreview): QuickImportPreview | null {
  if (!value || typeof value.token !== 'string' || !value.token || typeof value.vaultName !== 'string'
    || !Number.isFinite(value.expiresAt) || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS
    || ![value.valid, value.invalid, value.duplicates, value.ignored].every(nonnegative)) return null
  const seen = new Set<number>()
  const rows: QuickImportPreviewRow[] = []
  for (const row of value.rows) {
    if (!row || !nonnegative(row.line) || seen.has(row.line) || !['ready', 'duplicate', 'invalid'].includes(row.status)
      || (row.status !== 'invalid' && row.line === 0)) return null
    seen.add(row.line)
    const safe: QuickImportPreviewRow = { line: row.line, status: row.status }
    if (row.status !== 'invalid') {
      if (typeof row.title === 'string') safe.title = row.title
      if (typeof row.username === 'string') safe.username = row.username
      if (typeof row.host === 'string') safe.host = row.host
      if (typeof row.ip === 'string') safe.ip = row.ip
      if (typeof row.port === 'string') safe.port = row.port
      if (Array.isArray(row.tags)) safe.tags = row.tags.filter((tag): tag is string => typeof tag === 'string')
      safe.hasPassword = row.hasPassword === true
    }
    if (row.error) safe.error = Object.hasOwn(diagnosticKeys, row.error) ? row.error : 'INVALID_ROW'
    if (row.warning) safe.warning = 'REVIEW'
    rows.push(safe)
  }
  return { token: value.token, expiresAt: value.expiresAt, vaultName: value.vaultName, rows,
    valid: value.valid, invalid: value.invalid, duplicates: value.duplicates, ignored: value.ignored }
}

export function QuickImportPanel(props: QuickImportPanelProps): ReactNode {
  const { t, readonly, locked, unavailable, vaultName } = props
  const id = useId()
  // The parent spreads the isolated dictionaries into VaultTranslate's central key type.
  const text = (key: QuickImportLocaleKey): string => t(key as Parameters<VaultTranslate>[0])
  const countText = (key: QuickImportLocaleKey, count: number): string => text(key).replace('{n}', String(count))
  const [stage, setStage] = useState<Stage>('paste')
  const [source, setSource] = useState('')
  const [rawVisible, setRawVisible] = useState(false)
  const [format, setFormat] = useState(DEFAULT_QUICK_IMPORT_FORMAT)
  const [preset, setPreset] = useState<string>(QUICK_IMPORT_PRESETS.find(item => item.format === DEFAULT_QUICK_IMPORT_FORMAT)?.id ?? 'custom')
  const [kind, setKind] = useState<QuickImportOptions['kind']>('ssh')
  const [defaultPort, setDefaultPort] = useState('22')
  const [defaultTags, setDefaultTags] = useState('')
  const [preview, setPreview] = useState<QuickImportPreview | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [reviewed, setReviewed] = useState(false)
  const [operation, setOperation] = useState<Operation>(null)
  const [notice, setNotice] = useState<QuickImportLocaleKey | null>(null)
  const [expired, setExpired] = useState(false)
  const [ambiguous, setAmbiguous] = useState(false)
  const [result, setResult] = useState<Pick<QuickImportCommitResult, 'added' | 'skipped' | 'lines'> | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const activeRequest = useRef<Request | null>(null)
  const previewRef = useRef<QuickImportPreview | null>(null)
  const commitAttempt = useRef<CommitAttempt | null>(null)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const sourceElement = useRef<HTMLTextAreaElement | null>(null)
  const selectAll = useRef<HTMLInputElement | null>(null)
  const api = useRef(props)
  api.current = props
  const environment = vaultName + '\u0000' + String(locked) + '\u0000' + String(unavailable)
  const liveEnvironment = useRef(environment)
  liveEnvironment.current = environment
  const previousEnvironment = useRef(environment)

  function discardToken(token: string): void {
    try { void api.current.discardQuickImport?.(token).catch(() => { /* Best effort; no sensitive diagnostics. */ }) } catch { /* Also tolerate synchronous host failures. */ }
  }
  function invalidate(): void {
    generation.current++
    activeRequest.current = null
    if (previewRef.current) discardToken(previewRef.current.token)
    previewRef.current = null
    commitAttempt.current = null
    setPreview(null); setSelected([]); setReviewed(false); setOperation(null); setNotice(null)
    setExpired(false); setAmbiguous(false); setResult(null); setStage('paste'); setRawVisible(false)
    api.current.onBusyChange?.(false)
  }
  function clearInput(): void { invalidate(); setSource(''); sourceElement.current?.focus() }
  function current(request: Request): boolean {
    return mounted.current && activeRequest.current === request && generation.current === request.generation
      && liveEnvironment.current === request.environment
  }
  function begin(operation: Exclude<Operation, null>): Request {
    const request = { generation: generation.current, environment: liveEnvironment.current, operation }
    activeRequest.current = request; setOperation(operation); setNotice(null)
    api.current.onBusyChange?.(true)
    return request
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; generation.current++; activeRequest.current = null
      if (previewRef.current) discardToken(previewRef.current.token)
      previewRef.current = null; commitAttempt.current = null
      if (sourceElement.current) sourceElement.current.value = ''
      api.current.onBusyChange?.(false)
    }
  }, [])
  useEffect(() => {
    if (previousEnvironment.current === environment) return
    const previousVault = previousEnvironment.current.split('\u0000')[0]
    previousEnvironment.current = environment
    // The parent refreshes its snapshot after success; its temporary busy state must not erase the result.
    if (stage === 'result' && previousVault === vaultName && !locked) return
    invalidate()
    // Switching/locking a vault must not carry its pasted secrets into another scope.
    setSource('')
  }, [environment])
  useEffect(() => { if (stage !== 'paste') heading.current?.focus() }, [stage])
  useEffect(() => {
    if (!preview) return
    const remaining = preview.expiresAt - Date.now()
    if (remaining <= 0) { setExpired(true); return }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [preview])

  const size = useMemo(() => ({
    bytes: new TextEncoder().encode(source).byteLength,
    rows: source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).filter(line => line.trim() && !line.trimStart().startsWith('#')).length,
  }), [source])
  const sourceIssue: QuickImportLocaleKey | null = size.bytes > MAX_BYTES ? 'quickImportErrBytes' : size.rows > MAX_ROWS ? 'quickImportErrRows' : null
  const portValid = /^[0-9]{1,5}$/.test(defaultPort.trim()) && Number(defaultPort) >= 1 && Number(defaultPort) <= 65535
  const ready = preview?.rows.filter(row => row.status === 'ready').map(row => row.line) ?? []
  const allSelected = ready.length > 0 && ready.every(line => selected.includes(line))
  const attempted = commitAttempt.current !== null
  const busyCommit = operation === 'commit'
  const previewBlocked = locked || unavailable
  const writeBlocked = readonly || previewBlocked
  const guard = locked ? 'quickImportLocked' : unavailable ? 'quickImportUnavailable' : readonly ? 'quickImportReadOnly' : null
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allSelected }, [selected, allSelected, stage])

  async function requestPreview(): Promise<void> {
    if (!mounted.current || activeRequest.current || api.current.locked || api.current.unavailable) return
    const issue = sourceIssue ?? (size.rows === 0 ? 'quickImportErrEmpty' : !format.trim() ? 'quickImportErrFormat' : !portValid ? 'quickImportErrPort' : null)
    if (issue) { setNotice(issue); return }
    const options: QuickImportOptions = { format, kind, defaultPort: defaultPort.trim(), defaultTags: defaultTags.split(',').map(tag => tag.trim()).filter(Boolean) }
    const request = begin('preview')
    try {
      const response = await api.current.previewQuickImport(source, options)
      if (!current(request)) { if (typeof response?.token === 'string') discardToken(response.token); return }
      const next = previewMetadata(response)
      if (!next || next.vaultName !== api.current.vaultName || next.expiresAt <= Date.now()) {
        if (typeof response?.token === 'string') discardToken(response.token)
        setNotice(!next ? 'quickImportErrPreview' : next.vaultName !== api.current.vaultName ? 'quickImportErrScope' : 'quickImportExpired')
        return
      }
      previewRef.current = next; setPreview(next); setSelected(next.rows.filter(row => row.status === 'ready').map(row => row.line))
      setReviewed(false); setExpired(false); setRawVisible(false); setStage('preview')
    } catch { if (current(request)) setNotice('quickImportErrPreview') }
    finally { if (current(request)) { activeRequest.current = null; setOperation(null); api.current.onBusyChange?.(false) } }
  }
  function changeSelection(lines: number[]): void {
    if (attempted || busyCommit) return
    setSelected(lines); setReviewed(false); setNotice(null)
  }
  function reviewSelection(): void {
    if (!preview || expired || preview.expiresAt <= Date.now() || !selected.length || writeBlocked) return
    setReviewed(false); setNotice(null); setStage('confirm')
  }
  async function commit(): Promise<void> {
    const view = previewRef.current
    if (!mounted.current || activeRequest.current || !view || !reviewed || api.current.readonly || api.current.locked || api.current.unavailable
      || view.vaultName !== api.current.vaultName) return
    if (!commitAttempt.current && (expired || view.expiresAt <= Date.now())) { setExpired(true); return }
    const lines = commitAttempt.current?.lines ?? selected.filter(line => view.rows.some(row => row.line === line && row.status === 'ready')).sort((a, b) => a - b)
    if (!lines.length) return
    // Freeze token AND selection across ambiguous failures; backend retries are idempotent.
    const attempt = commitAttempt.current ?? { token: view.token, lines }
    commitAttempt.current = attempt
    const request = begin('commit')
    try {
      const response = await api.current.commitQuickImport(attempt.token, [...attempt.lines], true)
      if (!current(request)) return
      if (!response || !nonnegative(response.added) || !nonnegative(response.skipped) || !Array.isArray(response.lines)) throw new Error('Invalid import result')
      const lines = response.lines.filter(line => nonnegative(line.line) && ['added', 'skipped'].includes(line.status))
        .map(line => ({ line: line.line, status: line.status }))
      setResult({ added: response.added, skipped: response.skipped, lines })
      setSource(''); setRawVisible(false); previewRef.current = null; setPreview(null); commitAttempt.current = null
      setSelected([]); setReviewed(false); setAmbiguous(false); setExpired(false); setStage('result')
      try { api.current.onImported?.() } catch { /* A parent refresh failure must not turn a successful write into a retry. */ }
    } catch { if (current(request)) { setAmbiguous(true); setNotice('quickImportAmbiguous') } }
    finally { if (current(request)) { activeRequest.current = null; setOperation(null); api.current.onBusyChange?.(false) } }
  }

  const rowStatus = (row: QuickImportPreviewRow): string => text(row.status === 'ready' ? 'quickImportReady' : row.status === 'duplicate' ? 'quickImportDuplicate' : 'quickImportInvalid')
  const presetLabel = (presetId: string, n: number): string => text(presetId === 'host-port' ? 'quickImportPresetDefault' : presetId === 'host-only' ? 'quickImportPresetHostOnly'
    : presetId === 'host-ip' ? 'quickImportPresetActualIp' : presetId === 'ip-port' ? 'quickImportPresetIpPort' : 'quickImportPresetOther').replace('{n}', String(n))
  const selectedCount = commitAttempt.current?.lines.length ?? selected.length
  const confirmMessage = countText('quickImportConfirmText', selectedCount).replace('{vault}', preview?.vaultName ?? vaultName)

  return (
    <section className={css.panel} aria-labelledby={id + '-title'} aria-busy={operation !== null}>
      <header className={css.header}>
        <div><h3 id={id + '-title'}>{text('quickImportTitle')}</h3><p>{text('quickImportDescription')}</p>
          <p className={css.hint}>{text('quickImportScope').replace('{vault}', vaultName || text('quickImportCurrentVault'))}</p></div>
        {stage !== 'result' && <button type="button" className={css.button} onClick={clearInput} disabled={busyCommit || (!source && !preview && operation === null)}>{text('quickImportClear')}</button>}
      </header>
      <ol className={css.stages} aria-label={text('quickImportStageLabel')}>
        {stages.map((item, index) => <li key={item.stage} aria-current={stage === item.stage ? 'step' : undefined}>
          <span className={css.stepNumber} aria-hidden="true">{index + 1}</span>{text(item.key)}</li>)}
      </ol>
      {guard && <p className={css.warning} role="status">{text(guard)}</p>}
      {notice && <p className={css.error} role="alert">{text(notice)}</p>}

      {stage === 'paste' && <div className={css.draft}>
        <div className={css.fields}>
          <div className={css.field}><label htmlFor={id + '-preset'}>{text('quickImportPreset')}</label>
            <select id={id + '-preset'} value={preset} onChange={event => {
              invalidate(); setPreset(event.target.value)
              const next = QUICK_IMPORT_PRESETS.find(item => item.id === event.target.value)
              if (next) setFormat(next.format)
            }}>
              {QUICK_IMPORT_PRESETS.map((item, index) => <option key={item.id} value={item.id}>{presetLabel(item.id, index + 1)}</option>)}
              <option value="custom">{text('quickImportCustom')}</option>
            </select></div>
          <div className={css.field}><label htmlFor={id + '-kind'}>{text('quickImportKind')}</label>
            <select id={id + '-kind'} value={kind} onChange={event => { invalidate(); setKind(event.target.value as QuickImportOptions['kind']) }}>
              <option value="ssh">{text('quickImportSsh')}</option><option value="login">{text('quickImportLogin')}</option>
            </select></div>
          <div className={css.field + ' ' + css.wide}><label htmlFor={id + '-format'}>{text('quickImportFormat')}</label>
            <input id={id + '-format'} className={css.mono} value={format} onChange={event => { invalidate(); setPreset('custom'); setFormat(event.target.value) }} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <p className={css.hint}>{text('quickImportPortHint')}</p></div>
          <div className={css.field}><label htmlFor={id + '-port'}>{text('quickImportDefaultPort')}</label>
            <input id={id + '-port'} inputMode="numeric" value={defaultPort} onChange={event => { invalidate(); setDefaultPort(event.target.value) }} autoComplete="off" aria-invalid={!portValid} aria-describedby={id + '-port-hint'} />
            <p id={id + '-port-hint'} className={!portValid ? css.error : css.hint}>{text(!portValid ? 'quickImportErrPort' : 'quickImportDefaultPortHint')}</p></div>
          <div className={css.field}><label htmlFor={id + '-tags'}>{text('quickImportTags')}</label>
            <input id={id + '-tags'} value={defaultTags} onChange={event => { invalidate(); setDefaultTags(event.target.value) }} autoComplete="off" spellCheck={false} aria-describedby={id + '-tags-hint'} />
            <p id={id + '-tags-hint'} className={css.hint}>{text('quickImportTagsHint')}</p></div>
        </div>
        <div className={css.sourceHeader}><label htmlFor={id + '-source'}>{text('quickImportSource')}</label>
          <button type="button" className={css.button} aria-pressed={rawVisible} aria-controls={id + '-source'} onClick={() => setRawVisible(value => !value)}>{text(rawVisible ? 'quickImportHide' : 'quickImportShow')}</button></div>
        <p id={id + '-privacy'} className={css.privacy}>{text('quickImportPrivacy')}</p>
        <textarea ref={sourceElement} id={id + '-source'} value={source} onChange={event => { invalidate(); setSource(event.target.value) }}
          rows={7} className={css.source} style={{ WebkitTextSecurity: rawVisible ? 'none' : 'disc' } as React.CSSProperties}
          autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={id + '-privacy ' + id + '-limits' + (sourceIssue ? ' ' + id + '-source-error' : '')} aria-invalid={!!sourceIssue} />
        <div className={css.sourceFooter}><p id={id + '-limits'} className={css.hint}>{text('quickImportLimits')}</p>
          <span className={css.counter}>{text('quickImportCounter').replace('{rows}', String(size.rows)).replace('{bytes}', String(size.bytes))}</span></div>
        {sourceIssue && <p className={css.error} id={id + '-source-error'}>{text(sourceIssue)}</p>}
        <p className={css.example}><span>{text('quickImportExample')}</span><code>{SYNTHETIC_EXAMPLE}</code></p>
        <details className={css.help}><summary>{text('quickImportHelp')}</summary>
          <p>{text('quickImportPlaceholderHelp')}</p><strong>{text('quickImportPlaceholders')}</strong>
          <ul className={css.placeholders}>{SUPPORTED_QUICK_IMPORT_PLACEHOLDERS.map(placeholder => <li key={placeholder}><code>{placeholder}</code></li>)}</ul>
          <p>{text('quickImportEscapeHelp')}</p></details>
        <div className={css.actions}><button type="button" className={css.primaryButton} onClick={() => { void requestPreview() }} disabled={previewBlocked || operation !== null || !!sourceIssue || !source.trim() || !format.trim() || !portValid}>
          {text(operation === 'preview' ? 'quickImportPreviewing' : 'quickImportPreviewAction')}</button></div>
      </div>}

      {(stage === 'preview' || stage === 'confirm') && preview && <div className={css.preview}>
        <h4 ref={heading} tabIndex={-1}>{text(stage === 'confirm' ? 'quickImportConfirmTitle' : 'quickImportStagePreview')}</h4>
        <p className={css.hint}>{text('quickImportBackendTruth')}</p>
        <p className={css.summary}>{text('quickImportPreviewSummary').replace('{ready}', String(preview.valid)).replace('{duplicates}', String(preview.duplicates)).replace('{invalid}', String(preview.invalid)).replace('{ignored}', String(preview.ignored))}</p>
        <p className={css.hint}>{text('quickImportExpires').replace('{time}', new Date(preview.expiresAt).toLocaleString())}</p>
        {expired && !attempted && <p className={css.error} role="status">{text('quickImportExpired')}</p>}
        {stage === 'preview' && <label className={css.check}><input ref={selectAll} type="checkbox" checked={allSelected} disabled={!ready.length || expired || busyCommit}
          onChange={event => changeSelection(event.target.checked ? [...ready] : [])} />{text('quickImportSelectAll')}<span className={css.hint}>{countText('quickImportSelection', selected.length)}</span></label>}
        <div className={css.tableContainer} role="region" aria-label={text('quickImportTable')} tabIndex={0}>
          <table className={css.table}><caption className={css.srOnly}>{text('quickImportTable')}</caption>
            <thead><tr><th scope="col">{text('quickImportLine')}</th><th scope="col">{text('quickImportRowTitle')}</th><th scope="col">{text('quickImportUser')}</th><th scope="col">{text('quickImportHost')}</th><th scope="col">{text('quickImportIp')}</th><th scope="col">{text('quickImportPort')}</th><th scope="col">{text('quickImportRowTags')}</th><th scope="col">{text('quickImportPassword')}</th><th scope="col">{text('quickImportStatus')}</th></tr></thead>
            <tbody>{preview.rows.map(row => <tr key={row.line} data-state={row.status}>
              <td><label className={css.rowCheck}><input type="checkbox" checked={selected.includes(row.line)} disabled={stage !== 'preview' || row.status !== 'ready' || expired || attempted}
                aria-label={text('quickImportSelectLine').replace('{line}', String(row.line))} onChange={event => changeSelection(event.target.checked ? [...selected, row.line] : selected.filter(line => line !== row.line))} /><span>{row.line}</span></label></td>
              <td>{row.title || '—'}</td><td className={css.mono}>{row.username || '—'}</td><td className={css.mono}>{row.host || '—'}</td><td className={css.mono}>{row.ip || '—'}</td><td className={css.mono}>{row.port || '—'}</td><td>{row.tags?.join(', ') || '—'}</td>
              <td><span aria-label={text(row.hasPassword ? 'quickImportPasswordPresent' : 'quickImportNoPassword')}>{row.hasPassword ? '••••••••' : '—'}</span></td>
              <td><strong>{rowStatus(row)}</strong>{row.status === 'invalid' && <span className={css.rowHint}>{text(diagnostic(row.error))}</span>}{row.warning && <span className={css.rowHint}>{text('quickImportWarning')}</span>}</td>
            </tr>)}</tbody></table>
        </div>
        {preview.rows.length === 0 && <p className={css.hint}>{text('quickImportNoRows')}</p>}
        {stage === 'preview' && !selected.length && ready.length > 0 && <p className={css.hint}>{text('quickImportNoSelection')}</p>}
        {stage === 'confirm' && <div className={css.confirmation}>
          <p>{confirmMessage}</p>
          <label className={css.check}><input type="checkbox" checked={reviewed} disabled={busyCommit || attempted || writeBlocked} onChange={event => setReviewed(event.target.checked)} />{countText('quickImportReviewed', selectedCount)}</label>
          {ambiguous && <p className={css.warning}>{text('quickImportDiscardAmbiguous')}</p>}
        </div>}
        <div className={css.actions}>
          <button type="button" className={css.button} onClick={invalidate} disabled={busyCommit}>{text('quickImportEdit')}</button>
          {stage === 'confirm' && !attempted && <button type="button" className={css.button} disabled={busyCommit} onClick={() => { setStage('preview'); setReviewed(false); setNotice(null) }}>{text('quickImportBackToPreview')}</button>}
          {stage === 'preview' ? <button type="button" className={css.primaryButton} onClick={reviewSelection} disabled={!selected.length || expired || writeBlocked}>{countText('quickImportReviewAction', selected.length)}</button>
            : <button type="button" className={css.primaryButton} onClick={() => { void commit() }} disabled={!reviewed || !selectedCount || writeBlocked || busyCommit || (expired && !attempted)}>
              {text(busyCommit ? 'quickImportCommitting' : ambiguous ? 'quickImportRetryCommit' : 'quickImportCommit').replace('{n}', String(selectedCount))}</button>}
        </div>
      </div>}

      {stage === 'result' && result && <div className={css.result} role="status">
        <h4 ref={heading} tabIndex={-1}>{text('quickImportResultTitle')}</h4>
        <p className={css.summary}>{text('quickImportResultSummary').replace('{added}', String(result.added)).replace('{skipped}', String(result.skipped))}</p>
        <p className={css.hint}>{text('quickImportResultPrivacy')}</p>
        <ul className={css.resultLines}>{result.lines.map((line, index) => <li key={index}>{text('quickImportLine')} {line.line}: {text(line.status === 'added' ? 'quickImportAdded' : 'quickImportSkipped')}</li>)}</ul>
        <button type="button" className={css.button} onClick={invalidate}>{text('quickImportAgain')}</button>
      </div>}
    </section>
  )
}
