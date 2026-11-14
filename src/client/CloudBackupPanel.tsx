import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { VaultTranslate } from './host-contracts.ts'
import type { CloudBackupProvider, CloudBackupSettings, CloudBackupTarget, CloudBackupTargetStatus, CloudBackupView } from '../cloud-backup-types.ts'
import type { CloudBackupLocaleKey } from './cloud-backup-locales.ts'
import css from './CloudBackupPanel.module.css'

/** All operations use the host gateway. No credential value is accepted by this component. */
export interface CloudBackupPanelProps {
  t: VaultTranslate
  cloudBackup: () => Promise<CloudBackupView>
  setCloudBackup: (settings: CloudBackupSettings) => Promise<CloudBackupView>
  runCloudBackup: () => Promise<CloudBackupView>
  readonly: boolean
  locked: boolean
  /** Parent policy/status checks or another vault operation are still pending. */
  unavailable: boolean
  vaultName: string
}

type Draft = Omit<CloudBackupSettings, 'intervalMinutes' | 'retention'> & {
  intervalMinutes: string
  retention: string
}
type FieldIssue = { field: string; label: CloudBackupLocaleKey; message: CloudBackupLocaleKey; target?: number }
const providers: CloudBackupProvider[] = ['github', 's3', 'oss', 'r2']
const providerKeys: Record<CloudBackupProvider, CloudBackupLocaleKey> = {
  github: 'cloudGitHub', s3: 'cloudS3', oss: 'cloudOSS', r2: 'cloudR2',
}
const stateKeys: Record<CloudBackupTargetStatus['state'], CloudBackupLocaleKey> = {
  idle: 'cloudStateIdle', running: 'cloudStateRunning', success: 'cloudStateSuccess', error: 'cloudStateError',
}

function toDraft(config: CloudBackupSettings): Draft {
  return { ...config, intervalMinutes: String(config.intervalMinutes), retention: String(config.retention), targets: config.targets.map(target => ({ ...target })) }
}

function newTarget(provider: CloudBackupProvider, label: string): CloudBackupTarget {
  const id = globalThis.crypto?.randomUUID?.() ?? 'target-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  const base = { id, label, enabled: true, prefix: 'dsh-vault' }
  if (provider === 'github') return { ...base, provider, owner: '', repo: '', branch: 'main', tokenEnv: 'DSH_VAULT_GITHUB_TOKEN' }
  return {
    ...base, provider, endpoint: '', region: provider === 'r2' ? 'auto' : '', bucket: '',
    accessKeyIdEnv: 'DSH_VAULT_BACKUP_ACCESS_KEY_ID', secretAccessKeyEnv: 'DSH_VAULT_BACKUP_SECRET_ACCESS_KEY', forcePathStyle: false,
  }
}

function validate(draft: Draft): FieldIssue[] {
  const errors: FieldIssue[] = []
  const add = (field: string, label: CloudBackupLocaleKey, message: CloudBackupLocaleKey, target?: number): void => {
    errors.push({ field, label, message, ...(target !== undefined ? { target } : {}) })
  }
  if (!/^(0|[1-9][0-9]*)$/.test(draft.intervalMinutes) || (Number(draft.intervalMinutes) !== 0 && (Number(draft.intervalMinutes) < 5 || Number(draft.intervalMinutes) > 10080))) add('interval', 'cloudInterval', 'cloudErrInterval')
  if (!/^[1-9][0-9]*$/.test(draft.retention) || Number(draft.retention) > 100) add('retention', 'cloudRetention', 'cloudErrRetention')
  if (draft.targets.length > 8 || (draft.enabled && !draft.targets.some(target => target.enabled))) add('targets', 'cloudDestinations', 'cloudErrTargets')
  for (const [index, target] of draft.targets.entries()) {
    const field = (name: string): string => target.id + '-' + name
    const issue = (name: string, label: CloudBackupLocaleKey, message: CloudBackupLocaleKey): void => add(field(name), label, message, index)
    const env = (name: string, label: CloudBackupLocaleKey, value: string, optional = false): void => {
      if (optional && value === '') return
      if (value.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) issue(name, label, 'cloudErrEnv')
    }
    if (!target.label.trim() || target.label.length > 100 || /[\x00-\x1f\x7f]/.test(target.label)) issue('label', 'cloudLabel', 'cloudErrLabel')
    if (!target.prefix || target.prefix.length > 512 || !target.prefix.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9 _.!()+@=-]{0,63}$/.test(part) && !part.endsWith('.') && !part.endsWith(' '))) issue('prefix', 'cloudPrefix', 'cloudErrPrefix')
    if (target.provider === 'github') {
      if (target.owner.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(target.owner)) issue('owner', 'cloudOwner', 'cloudErrOwner')
      if (target.repo.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.repo) || target.repo.endsWith('.')) issue('repo', 'cloudRepo', 'cloudErrRepo')
      if (!target.branch || target.branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target.branch) || target.branch.includes('..') || !target.branch.split('/').every(part => /^[A-Za-z0-9]/.test(part) && !part.endsWith('.') && !part.endsWith('.lock'))) issue('branch', 'cloudBranch', 'cloudErrBranch')
      env('tokenEnv', 'cloudTokenEnv', target.tokenEnv)
    } else {
      let validEndpoint = false
      try {
        const endpoint = new URL(target.endpoint)
        validEndpoint = target.endpoint.length <= 2048 && /^https:\/\/[^\s/?#@\\]+\/?$/.test(target.endpoint) && endpoint.protocol === 'https:' && !!endpoint.hostname && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/' && !/[?#]/.test(target.endpoint)
      } catch { /* Invalid URL is a field error, never sent to a provider. */ }
      if (!validEndpoint) issue('endpoint', 'cloudEndpoint', 'cloudErrEndpoint')
      if (target.region.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.region)) issue('region', 'cloudRegion', 'cloudErrRegion')
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket) || target.bucket.includes('..') || target.bucket.includes('.-') || target.bucket.includes('-.') || /^\d+\.\d+\.\d+\.\d+$/.test(target.bucket) || (target.provider === 'oss' && target.bucket.includes('.'))) issue('bucket', 'cloudBucket', 'cloudErrBucket')
      env('accessKeyIdEnv', 'cloudAccessKeyIdEnv', target.accessKeyIdEnv)
      env('secretAccessKeyEnv', 'cloudSecretAccessKeyEnv', target.secretAccessKeyEnv)
      env('sessionTokenEnv', 'cloudSessionTokenEnv', target.sessionTokenEnv ?? '', true)
    }
  }
  return errors
}

interface TextFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string | undefined
  error?: string | undefined
  type?: 'text' | 'url' | 'number'
  placeholder?: string | undefined
  min?: number
  max?: number
  required?: boolean
  mono?: boolean
}

function TextField({ id, label, value, onChange, hint, error, type = 'text', placeholder, min, max, required = true, mono = false }: TextFieldProps): ReactNode {
  const describedBy = [hint ? id + '-hint' : '', error ? id + '-error' : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={css.field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} onChange={event => onChange(event.target.value)}
        className={mono ? css.mono : undefined} autoComplete="off" autoCapitalize="none" spellCheck={false}
        placeholder={placeholder} min={min} max={max} step={type === 'number' ? 1 : undefined}
        aria-required={required} aria-invalid={!!error} aria-describedby={describedBy} />
      {hint && <p className={css.hint} id={id + '-hint'}>{hint}</p>}
      {error && <p className={css.fieldError} id={id + '-error'}>{error}</p>}
    </div>
  )
}

/** Mounted only in the backup tab. The parent keys this component by active vault. */
export function CloudBackupPanel({ t, cloudBackup, setCloudBackup, runCloudBackup, readonly, locked, unavailable, vaultName }: CloudBackupPanelProps): ReactNode {
  const id = useId()
  const [view, setView] = useState<CloudBackupView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [operation, setOperation] = useState<'save' | 'upload' | null>(null)
  const [notice, setNotice] = useState<CloudBackupLocaleKey | null>(null)
  const [errors, setErrors] = useState<FieldIssue[]>([])
  const [errorFocus, setErrorFocus] = useState(0)
  const [provider, setProvider] = useState<CloudBackupProvider>('github')
  const summary = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const request = useRef(false)
  const api = useRef({ cloudBackup, setCloudBackup, runCloudBackup })
  api.current = { cloudBackup, setCloudBackup, runCloudBackup }

  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current || request.current) return
    request.current = true
    setRefreshing(true)
    try {
      const next = await api.current.cloudBackup()
      if (!mounted.current) return
      setView(next)
      // Polling updates runtime status, but it must never discard an in-progress edit.
      if (!dirtyRef.current) setDraft(toDraft(next.config))
      setLoadFailed(false)
    } catch {
      if (mounted.current) setLoadFailed(true)
    } finally {
      request.current = false
      if (mounted.current) { setLoading(false); setRefreshing(false) }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll(): Promise<void> {
      await refresh()
      if (!cancelled) timer = setTimeout(() => { void poll() }, 5000)
    }
    void poll()
    return () => {
      cancelled = true
      mounted.current = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [refresh])

  useEffect(() => { if (errorFocus > 0) summary.current?.focus() }, [errorFocus])

  const running = view?.running === true
  const guarded = readonly || locked || unavailable
  const formDisabled = guarded || loading || operation !== null || running
  const fieldId = (field: string): string => id + '-' + field
  const errorFor = (field: string): string | undefined => {
    const issue = errors.find(error => error.field === field)
    return issue ? t(issue.message) : undefined
  }
  const editDraft = (next: Draft, field?: string): void => {
    if (formDisabled) return
    dirtyRef.current = true
    setDirty(true)
    setDraft(next)
    setNotice(null)
    if (field) setErrors(previous => previous.filter(error => error.field !== field))
    else setErrors([])
  }
  const editTarget = (target: CloudBackupTarget, field: string, value: string | boolean): void => {
    if (!draft) return
    const next = { ...target, [field]: value } as CloudBackupTarget
    if (next.provider !== 'github' && next.sessionTokenEnv === '') delete next.sessionTokenEnv
    editDraft({ ...draft, targets: draft.targets.map(item => item.id === target.id ? next : item) }, field === 'enabled' ? 'targets' : target.id + '-' + field)
  }

  async function save(): Promise<void> {
    if (!draft || formDisabled || request.current || !dirtyRef.current) return
    const issues = validate(draft)
    setErrors(issues)
    if (issues.length) { setErrorFocus(previous => previous + 1); return }
    request.current = true
    setOperation('save')
    setNotice(null)
    const settings: CloudBackupSettings = { ...draft, intervalMinutes: Number(draft.intervalMinutes), retention: Number(draft.retention) }
    try {
      // Saving arms future automatic triggers; it never invokes runCloudBackup.
      const next = await api.current.setCloudBackup(settings)
      if (!mounted.current) return
      dirtyRef.current = false
      setDirty(false)
      setView(next)
      setDraft(toDraft(next.config))
      setLoadFailed(false)
      setNotice('cloudSaved')
    } catch {
      if (mounted.current) setNotice('cloudSaveFailed')
    } finally {
      request.current = false
      if (mounted.current) setOperation(null)
    }
  }

  async function upload(): Promise<void> {
    if (!view || formDisabled || request.current || dirtyRef.current || loadFailed || !view.config.enabled || !view.config.targets.some(target => target.enabled)) return
    request.current = true
    setOperation('upload')
    setNotice(null)
    try {
      const next = await api.current.runCloudBackup()
      if (!mounted.current) return
      setView(next)
      setNotice('cloudUploadFinished')
    } catch {
      if (mounted.current) setNotice('cloudUploadFailed')
    } finally {
      request.current = false
      if (mounted.current) setOperation(null)
    }
  }

  const date = (at: number | undefined): string => at !== undefined && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toLocaleString() : t('cloudNever')
  const enabledDestinations = view?.config.targets.some(target => target.enabled) === true
  const savedEnabled = view?.config.enabled === true && enabledDestinations
  const automatic = savedEnabled && (view!.config.onChange || view!.config.intervalMinutes > 0)
  const guardMessage = readonly ? t('cloudReadOnly') : locked ? t('cloudLocked') : unavailable ? t('cloudUnavailable') : ''
  const uploadHint = dirty ? t('cloudUploadSaveFirst') : !savedEnabled ? t('cloudUploadEnableFirst') : ''

  return (
    <section className={css.panel} aria-labelledby={fieldId('title')} aria-busy={loading || operation !== null || running}>
      <header className={css.header}>
        <div>
          <h3 id={fieldId('title')}>{t('cloudTitle')}</h3>
          <p>{t('cloudIntro')}</p>
          <p className={css.scope}>{t('cloudScope').replace('{vault}', vaultName || t('cloudCurrentVault'))}</p>
        </div>
        {view && <span className={css.savedState} data-active={automatic}>{automatic ? t('cloudAutoArmed') : savedEnabled ? t('cloudManualOnly') : t('cloudDisabled')}</span>}
      </header>
      <p className={css.encryptedNote}>{t('cloudEncryptedOnly')}</p>
      <details className={css.setup}>
        <summary>{t('cloudSetup')}</summary>
        <ol><li>{t('cloudSetupDestination')}</li><li>{t('cloudSetupEnvironment')}</li><li>{t('cloudSetupNames')}</li></ol>
      </details>
      <p className={css.hint}>{t('cloudServiceHint')}</p>
      <div className={css.liveStatus} role="status" aria-live="polite" aria-atomic="true">
        {loading && <p>{t('cloudLoading')}</p>}
        {operation === 'save' && <p>{t('cloudSaving')}</p>}
        {(operation === 'upload' || running) && <p>{t('cloudRunning')}</p>}
        {notice && <p className={notice.endsWith('Failed') ? css.fieldError : undefined}>{t(notice)}</p>}
        {loadFailed && <p className={css.warning}>{t('cloudLoadFailed')}</p>}
        {view?.warning && <p className={css.warning}>{t('cloudWarning')}: {view.warning}</p>}
      </div>
      {loadFailed && <button type="button" className={css.button} disabled={refreshing || operation !== null} onClick={() => void refresh()}>{t('cloudRetry')}</button>}
      {guardMessage && <p className={css.warning}>{guardMessage}</p>}
      {draft && view && (
        <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
          {errors.length > 0 && <div ref={summary} className={css.errorSummary} role="alert" tabIndex={-1} aria-labelledby={fieldId('error-title')}>
            <h4 id={fieldId('error-title')}>{t('cloudErrorSummary')}</h4>
            <ul>{errors.map(error => <li key={error.field}><a href={'#' + fieldId(error.field)} onClick={event => { event.preventDefault(); document.getElementById(fieldId(error.field))?.focus() }}>
              {error.target !== undefined ? t(providerKeys[draft.targets[error.target]?.provider ?? 'github']) + ' ' + (error.target + 1) + ' · ' : ''}{t(error.label)}: {t(error.message)}
            </a></li>)}</ul>
          </div>}
          <fieldset className={css.automation} disabled={formDisabled}>
            <legend>{t('cloudAutomation')}</legend>
            <label className={css.check}><input type="checkbox" checked={draft.enabled} onChange={event => editDraft({ ...draft, enabled: event.target.checked }, 'targets')} />{t('cloudEnabled')}</label>
            <label className={css.check}><input type="checkbox" checked={draft.onChange} aria-describedby={fieldId('change-hint')} onChange={event => editDraft({ ...draft, onChange: event.target.checked })} />{t('cloudOnChange')}</label>
            <p className={css.hint} id={fieldId('change-hint')}>{t('cloudOnChangeHint')}</p>
            <div className={css.fields}>
              <TextField id={fieldId('interval')} label={t('cloudInterval')} type="number" min={0} max={10080} value={draft.intervalMinutes} onChange={value => editDraft({ ...draft, intervalMinutes: value }, 'interval')} hint={t('cloudIntervalHint')} error={errorFor('interval')} />
              <TextField id={fieldId('retention')} label={t('cloudRetention')} type="number" min={1} max={100} value={draft.retention} onChange={value => editDraft({ ...draft, retention: value }, 'retention')} hint={t('cloudRetentionHint')} error={errorFor('retention')} />
            </div>
          </fieldset>
          <div className={css.destinationHeading} id={fieldId('targets')} tabIndex={-1} aria-describedby={errorFor('targets') ? fieldId('targets-error') : undefined}>
            <h4>{t('cloudDestinations')} <span className={css.count}>{draft.targets.length}/8</span></h4>
            <p className={css.hint}>{t('cloudDestinationHint')}</p>
            {errorFor('targets') && <p id={fieldId('targets-error')} className={css.fieldError}>{errorFor('targets')}</p>}
          </div>
          <div className={css.targets}>
            {draft.targets.length === 0 && <p className={css.empty}>{t('cloudNoDestinations')}</p>}
            {draft.targets.map(target => {
              const status = view.statuses.find(item => item.id === target.id)
              const saved = view.config.targets.some(item => item.id === target.id)
              const textField = (field: string, label: CloudBackupLocaleKey, value: string, options: { hint?: CloudBackupLocaleKey; optional?: boolean; mono?: boolean; placeholder?: string; type?: 'text' | 'url' } = {}): ReactNode => (
                <TextField key={field} id={fieldId(target.id + '-' + field)} label={t(label)} value={value} onChange={value => editTarget(target, field, value)}
                  hint={options.hint ? t(options.hint) : undefined} error={errorFor(target.id + '-' + field)} required={!options.optional}
                  mono={options.mono === true} placeholder={options.placeholder} type={options.type ?? 'text'} />
              )
              return (
                <article className={css.target} key={target.id}>
                  <header className={css.targetHeader}>
                    <div><h5>{target.label || t(providerKeys[target.provider])}</h5><span className={css.provider}>{t(providerKeys[target.provider])}</span></div>
                    <span className={css.targetState} data-state={status?.state ?? 'idle'} role="status" aria-live="polite">{!saved ? t('cloudNotSaved') : t(stateKeys[status?.state ?? 'idle'])}</span>
                    <button type="button" className={css.remove} disabled={formDisabled} aria-label={t('cloudRemove') + ': ' + (target.label || t(providerKeys[target.provider]))} onClick={() => editDraft({ ...draft, targets: draft.targets.filter(item => item.id !== target.id) })}>{t('cloudRemove')}</button>
                  </header>
                  <div className={css.targetStatus} aria-live="polite">
                    <p>{t('cloudLastSuccess')}: <strong>{date(status?.lastSuccessAt)}</strong></p>
                    {status?.lastError && <p className={css.fieldError}>{t('cloudLastError')}: {status.lastError}</p>}
                    {status?.warning && <p className={css.warning}>{t('cloudWarning')}: {status.warning}</p>}
                  </div>
                  <fieldset className={css.targetFields} disabled={formDisabled}>
                    <legend className={css.srOnly}>{target.label || t(providerKeys[target.provider])}</legend>
                    <label className={css.check}><input type="checkbox" checked={target.enabled} onChange={event => editTarget(target, 'enabled', event.target.checked)} />{t('cloudTargetEnabled')}</label>
                    <div className={css.fields}>
                      {textField('label', 'cloudLabel', target.label)}
                      {textField('prefix', 'cloudPrefix', target.prefix, { hint: 'cloudPrefixHint', mono: true })}
                      {target.provider === 'github' ? <>
                        {textField('owner', 'cloudOwner', target.owner)}
                        {textField('repo', 'cloudRepo', target.repo)}
                        {textField('branch', 'cloudBranch', target.branch, { mono: true })}
                        {textField('tokenEnv', 'cloudTokenEnv', target.tokenEnv, { hint: 'cloudCredentialsHint', mono: true })}
                      </> : <>
                        {textField('endpoint', 'cloudEndpoint', target.endpoint, { hint: 'cloudEndpointHint', type: 'url', placeholder: target.provider === 'r2' ? 'https://<account-id>.r2.cloudflarestorage.com' : target.provider === 'oss' ? 'https://oss-cn-hangzhou.aliyuncs.com' : 'https://s3.us-east-1.amazonaws.com' })}
                        {textField('region', 'cloudRegion', target.region, { hint: 'cloudRegionHint', mono: true })}
                        {textField('bucket', 'cloudBucket', target.bucket)}
                        {textField('accessKeyIdEnv', 'cloudAccessKeyIdEnv', target.accessKeyIdEnv, { hint: 'cloudCredentialsHint', mono: true })}
                        {textField('secretAccessKeyEnv', 'cloudSecretAccessKeyEnv', target.secretAccessKeyEnv, { hint: 'cloudCredentialsHint', mono: true })}
                        {textField('sessionTokenEnv', 'cloudSessionTokenEnv', target.sessionTokenEnv ?? '', { optional: true, hint: 'cloudCredentialsHint', mono: true })}
                      </>}
                    </div>
                    {target.provider !== 'github' && <>
                      <label className={css.check}><input type="checkbox" checked={target.forcePathStyle} aria-describedby={fieldId(target.id + '-path-hint')} onChange={event => editTarget(target, 'forcePathStyle', event.target.checked)} />{t('cloudPathStyle')}</label>
                      <p className={css.hint} id={fieldId(target.id + '-path-hint')}>{t('cloudPathStyleHint')}</p>
                    </>}
                    {target.provider === 'github' && <p className={css.warning}>{t('cloudGitHistoryWarning')}</p>}
                  </fieldset>
                </article>
              )
            })}
          </div>
          <fieldset className={css.addRow} disabled={formDisabled || draft.targets.length >= 8}>
            <legend className={css.srOnly}>{t('cloudAdd')}</legend>
            <label htmlFor={fieldId('provider')}>{t('cloudDestinationType')}</label>
            <select id={fieldId('provider')} value={provider} onChange={event => setProvider(event.target.value as CloudBackupProvider)}>
              {providers.map(item => <option value={item} key={item}>{t(providerKeys[item])}</option>)}
            </select>
            <button type="button" className={css.button} onClick={() => { if (draft.targets.length < 8) editDraft({ ...draft, targets: [...draft.targets, newTarget(provider, t(providerKeys[provider]) + ' ' + (draft.targets.length + 1))] }) }}>{t('cloudAdd')}</button>
          </fieldset>
          {draft.targets.length >= 8 && <p className={css.hint}>{t('cloudTargetLimit')}</p>}
          <div className={css.saveArea}>
            <p className={css.consent}>{t('cloudSaveConsent')}</p>
            {dirty && <p className={css.warning}>{t('cloudUnsaved')}</p>}
            <div className={css.actions}>
              <button type="submit" className={css.primaryButton} disabled={formDisabled || refreshing || !dirty}>{operation === 'save' ? t('cloudSaving') : t('cloudSave')}</button>
              <button type="button" className={css.button} disabled={formDisabled || !dirty} onClick={() => { dirtyRef.current = false; setDirty(false); setDraft(toDraft(view.config)); setErrors([]); setNotice(null) }}>{t('cloudDiscard')}</button>
            </div>
          </div>
          <div className={css.uploadArea}>
            <div><p>{t('cloudNextRun')}: <strong>{view.nextRunAt !== undefined ? date(view.nextRunAt) : t('cloudNoNextRun')}</strong></p><p className={css.hint}>{t('cloudPollHint')}</p></div>
            <button type="button" className={css.button} disabled={formDisabled || refreshing || loadFailed || dirty || !savedEnabled} aria-describedby={uploadHint ? fieldId('upload-hint') : undefined} onClick={() => void upload()}>{operation === 'upload' ? t('cloudUploading') : t('cloudUpload')}</button>
            {uploadHint && <p className={css.hint} id={fieldId('upload-hint')}>{uploadHint}</p>}
          </div>
        </form>
      )}
    </section>
  )
}
