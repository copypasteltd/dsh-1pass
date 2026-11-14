/** Scoped dialogs follow dsh-config-manager's Modal/ConfirmDialog interaction contract (MIT).
 * No dependency on its business APIs, no body portal, and no password persistence. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { VaultTranslate } from '../host-contracts.ts'
import css from './WorkbenchDialogs.module.css'
interface Request { kind: 'confirm' | 'prompt'; message: string; initial: string; password: boolean; resolve: (value: string | boolean | null) => void }
export function useWorkbenchDialogs(t: VaultTranslate, root: RefObject<HTMLElement | null>) {
  const [request, setRequest] = useState<Request | null>(null)
  const [value, setValue] = useState('')
  const current = useRef<Request | null>(null)
  const focusBefore = useRef<HTMLElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const cancel = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  const finish = useCallback((answer: string | boolean | null) => {
    const pending = current.current
    if (!pending) return
    current.current = null
    setRequest(null); setValue('')
    pending.resolve(answer)
    const target = focusBefore.current
    queueMicrotask(() => { if (target?.isConnected) target.focus() })
  }, [])
  const ask = useCallback((kind: Request['kind'], message: string, initial = '', password = false): Promise<string | boolean | null> => {
    // A second request cannot silently orphan the first promise.
    current.current?.resolve(current.current.kind === 'confirm' ? false : null)
    focusBefore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return new Promise(resolve => { const next = { kind, message, initial, password, resolve }; current.current = next; setValue(initial); setRequest(next) })
  }, [])
  useEffect(() => {
    if (!request) return
    const focus = () => (request.kind === 'prompt' ? input.current : cancel.current)?.focus()
    focus()
    // Also contain programmatic focus changes, not just Tab traversal.
    const contain = (event: FocusEvent) => { if (event.target instanceof Node && !box.current?.contains(event.target)) focus() }
    document.addEventListener('focusin', contain)
    return () => document.removeEventListener('focusin', contain)
  }, [request])
  useEffect(() => () => { const pending = current.current; current.current = null; pending?.resolve(pending.kind === 'confirm' ? false : null) }, [])
  const confirm = useCallback(async (message: string): Promise<boolean> => (await ask('confirm', message)) === true, [ask])
  const prompt = useCallback(async (message: string, initial = '', options?: { password?: boolean }): Promise<string | null> => {
    const answer = await ask('prompt', message, initial, options?.password === true)
    return typeof answer === 'string' ? answer : null
  }, [ask])
  let node: ReactNode = null
  const container = root.current?.closest('[data-vault-workbench]') ?? root.current
  if (request && container) node = createPortal(
    <div className={css.mask} data-vault-dialog="" onMouseDown={event => { if (event.target === event.currentTarget) finish(request.kind === 'confirm' ? false : null) }}>
      <div ref={box} className={css.card} role="dialog" aria-modal="true" aria-labelledby={id + '-title'} aria-describedby={id + '-message'}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); finish(request.kind === 'confirm' ? false : null) }
          if (event.key === 'Tab') {
            const nodes = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
            const first = nodes[0], last = nodes[nodes.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
          if (event.key === 'Enter' && request.kind === 'prompt' && event.target === input.current) { event.preventDefault(); finish(value) }
        }}>
        <header className={css.header} id={id + '-title'}>{request.kind === 'confirm' ? t('wbConfirm') : t('wbPrompt')}</header>
        <div className={css.body}>
          <p id={id + '-message'}>{request.message}</p>
          {request.kind === 'prompt' && <input ref={input} aria-labelledby={id + '-message'} type={request.password ? 'password' : 'text'} value={value} onChange={event => setValue(event.target.value)} autoComplete="off" spellCheck={false} />}
        </div>
        <footer className={css.footer}>
          <button ref={cancel} type="button" onClick={() => finish(request.kind === 'confirm' ? false : null)}>{t('wbCancel')}</button>
          <button type="button" className={css.primary} onClick={() => finish(request.kind === 'confirm' ? true : value)}>{t('wbConfirm')}</button>
        </footer>
      </div>
    </div>, container)
  return { confirm, prompt, node, open: request !== null }
}
