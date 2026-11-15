/** Supervised host processes. No shell, inherited tracing, raw child errors or unbounded output. */
import { spawn } from 'node:child_process'
import { fail, MAX_BYTES, VaultTransportError } from './documents.ts'
export interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }
export interface ProcessResult { code: number; stdout: string }
export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]
  env.LC_ALL = 'C'; env.LANG = 'C'
  return env
}
/** Await close AND tree-termination collector. Failed/unknown completion never counts as success. */
export async function runProcess(command: string, args: string[], o: ProcessOptions): Promise<ProcessResult> {
  if (o.signal?.aborted) fail('aborted', 'Vault process aborted before launch.')
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(command, args, { ...(o.cwd ? { cwd: o.cwd } : {}), env: o.env ?? cleanEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { reject(new VaultTransportError('process-failed', 'Unable to launch vault transport process.')); return }
    let bytes = 0; let stdout = ''; let reason: string | undefined; let settled = false
    let killerDone: Promise<void> = Promise.resolve()
    let fallback: ReturnType<typeof setTimeout> | undefined
    const stop = (code: string) => {
      if (reason || settled) return
      reason = code
      if (child.pid) {
        if (process.platform === 'win32') {
          killerDone = new Promise<void>(done => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env: cleanEnvironment(), shell: false, windowsHide: true, stdio: 'ignore' })
            const killTimer = setTimeout(() => { killer.kill(); done() }, 2000)
            killer.once('error', () => { clearTimeout(killTimer); child.kill(); done() })
            killer.once('close', () => { clearTimeout(killTimer); done() })
          })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      }
      // Broken child stdio cannot retain the caller indefinitely after tree termination.
      fallback = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); void finish(null) }, 2500)
    }
    const onAbort = () => stop('aborted')
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs)
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = async (code: number | null) => {
      if (settled) return
      settled = true; clearTimeout(timer); if (fallback) clearTimeout(fallback)
      o.signal?.removeEventListener('abort', onAbort)
      await killerDone
      if (reason || code === null) { reject(new VaultTransportError(reason ?? 'process-failed', reason === 'aborted' ? 'Vault transport process aborted and terminated.' : reason === 'timeout' ? 'Vault transport process timed out and was terminated.' : 'Vault transport process failed or exceeded its output bound.')); return }
      resolve({ code, stdout })
    }
    const collect = (data: Buffer, keep: boolean) => { bytes += data.length; if (bytes > MAX_BYTES) stop('size-limit'); else if (keep) stdout += data.toString('utf8') }
    child.stdout?.on('data', (data: Buffer) => collect(data, true))
    child.stderr?.on('data', (data: Buffer) => collect(data, false))
    child.once('error', () => { reason = 'process-failed'; void finish(null) })
    child.once('close', code => { void finish(code) })
    // A signal can race with spawning/listener installation.
    if (o.signal?.aborted) onAbort()
  })
}
