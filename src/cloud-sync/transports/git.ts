/** Actual local-Git clone/fetch/ff-only/commit/push transport. Upstream MIT: LICENSE.reference. */
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import type { VaultSyncMeta, VaultSyncSnapshot, VaultSyncTransport } from '../types.ts'
import { assertExpectedHead, canonical, checkedDownload, fail, MAX_BYTES, metaFromSnapshot, parseIndex, parseJson, record, remoteIndexVersion, safeId, safePrefix, serializeIndex, text, validateSnapshot, VaultTransportError } from './documents.ts'
import { endpoint, secret, timeoutMs } from './http.ts'
import type { HostTransportOptions } from './http.ts'
import { cleanEnvironment, runProcess } from './process.ts'

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
/** Refuse symlinks/junctions in every existing path component, including stateDir ancestors. */
async function safePath(path: string): Promise<void> {
  const absolute = resolve(path); let cursor = parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try { if ((await lstat(cursor)).isSymbolicLink()) fail('unsafe-workdir', 'Symlinked vault workdir paths are not allowed.') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}
function branchName(value: unknown): string {
  const b = text(value, 128)
  if (!b.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) && !p.endsWith('.') && !p.endsWith('.lock')) || b.includes('..') || b.includes('@{')) fail('invalid-config', 'Invalid Git branch.')
  return b
}
const OWNER = '1pass-git-worktree-v1'
export class GitTransport implements VaultSyncTransport {
  readonly type = 'git' as const
  private readonly state: string
  private readonly work: string
  private readonly repo: string
  private readonly namespace: string
  private branch: string | undefined
  private remoteRef: string | undefined
  private readonly local: boolean
  private readonly ssh: boolean
  constructor(private readonly o: HostTransportOptions) {
    const state = text(o.stateDir, 4096)
    if (!isAbsolute(state)) fail('unsafe-workdir', 'Git stateDir must be an absolute dedicated state directory.')
    this.state = resolve(state)
    if ([parse(this.state).root, resolve(homedir()), resolve(process.cwd())].includes(this.state)) fail('unsafe-workdir', 'Git stateDir must not be a filesystem, home or workspace root.')
    this.work = join(this.state, 'worktree')
    // Saved UI configurations represent the default as an empty string, never the repository root.
    this.namespace = safePrefix(o.config.subdir === '' ? '1pass' : o.config.subdir ?? '1pass')
    this.branch = o.config.branch === undefined ? undefined : branchName(o.config.branch)
    const raw = text(o.config.repoUrl, 4096)
    this.local = isAbsolute(raw)
    this.ssh = raw.startsWith('ssh://') || /^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:/.test(raw)
    if (this.local) {
      if (!o.allowLocalGitForTests) fail('invalid-config', 'Local Git repositories are permitted only by the explicit host test option.')
      this.repo = resolve(raw)
      const r = relative(this.state, this.repo)
      if (!r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))) fail('unsafe-workdir', 'Local remote must be outside transport stateDir.')
    } else if (this.ssh) {
      // No command, port option, password, query, escapes or shell syntax in SSH/scp locations.
      if (raw.startsWith('ssh://')) {
        let u: URL
        try { u = new URL(raw) } catch { fail('invalid-config', 'Invalid SSH repository URL.') }
        if (u.protocol !== 'ssh:' || !/^[A-Za-z0-9_-]+$/.test(u.username) || u.password || !/^[A-Za-z0-9.-]+$/.test(u.hostname) || (u.port && !/^\d{1,5}$/.test(u.port)) || !/^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(u.pathname) || u.pathname.includes('..') || u.hash || u.search) fail('invalid-config', 'Invalid SSH repository URL.')
      } else if (!/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) || raw.includes('..')) fail('invalid-config', 'Invalid scp-style repository URL.')
      this.repo = raw
    } else {
      const url = endpoint(raw, o)
      if (url.protocol !== 'https:') fail('invalid-config', 'Git remote must use HTTPS (local fixtures require the test option).')
      this.repo = url.href
    }
  }
  private async run(args: string[], auth = false, allowNonzero = false, cwd: string = this.work): Promise<{ code: number; stdout: string }> {
    const env = cleanEnvironment()
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    env.GIT_TERMINAL_PROMPT = '0'; env.GCM_INTERACTIVE = 'Never'; env.GIT_LFS_SKIP_SMUDGE = '1'
    env.GIT_ALLOW_PROTOCOL = this.local ? 'file' : this.ssh ? 'ssh' : 'https'
    env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=15'
    if (this.ssh) for (const key of ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[key]) env[key] = process.env[key]
    let helper: string | undefined
    let helperDir: string | undefined
    try {
      if (auth && !this.local && !this.ssh) {
        const token = await secret(this.o)
        // Askpass source contains NO credential. Only this child's memory/environment holds it.
        helperDir = join(this.state, 'askpass-' + randomUUID())
        await mkdir(helperDir, { mode: 0o700 })
        helper = join(helperDir, 'askpass.cjs')
        await writeFile(helper, 'process.stdout.write((process.env.ONEPASS_GIT_TOKEN || "") + "\\n")\n', { mode: 0o600, flag: 'wx' })
        if (process.platform === 'win32') {
          const cmd = join(helperDir, 'askpass.cmd')
          await writeFile(cmd, '@"' + process.execPath + '" "' + helper + '"\r\n', { mode: 0o600, flag: 'wx' })
          env.GIT_ASKPASS = cmd
        } else {
          const script = join(helperDir, 'askpass.sh')
          await writeFile(script, '#!/bin/sh\nexec "$ONEPASS_GIT_NODE" "$ONEPASS_GIT_HELPER"\n', { mode: 0o700, flag: 'wx' })
          env.GIT_ASKPASS = script
          env.ONEPASS_GIT_NODE = process.execPath
          env.ONEPASS_GIT_HELPER = helper
        }
        env.ONEPASS_GIT_TOKEN = token
      }
      const flags = ['-c', 'credential.helper=', '-c', 'credential.username=oauth2', '-c', 'core.hooksPath=' + join(this.state, 'disabled-hooks'), '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.fsmonitor=false', '-c', 'http.followRedirects=false', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=20', '-c', 'core.autocrlf=false']
      const result = await runProcess('git', [...flags, ...args], { cwd, env, timeoutMs: timeoutMs(this.o), ...(this.o.signal ? { signal: this.o.signal } : {}) })
      if (result.code !== 0 && !allowNonzero) fail('git-failed', 'Git operation failed; no remote output is exposed. Inspect workdir facts before retrying a write.')
      return result
    } finally {
      delete env.ONEPASS_GIT_TOKEN
      if (helperDir) await rm(helperDir, { recursive: true, force: true })
    }
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.o.signal?.aborted) fail('aborted', 'Vault Git operation aborted.')
    await safePath(this.state)
    await mkdir(this.state, { recursive: true, mode: 0o700 })
    await safePath(this.state)
    const lock = join(this.state, '.worktree-lock')
    let handle
    try { handle = await open(lock, 'wx', 0o600) }
    catch { fail('workdir-busy', 'Vault Git workdir is locked; retry after the current operation finishes. Stale locks require explicit host inspection.') }
    try { return await fn() }
    catch (e) { if (e instanceof VaultTransportError) throw e; fail('git-failed', 'Vault Git operation failed; local and remote details suppressed.') }
    finally { await handle.close(); await rm(lock, { force: true }) }
  }
  private marker(): string { return join(this.state, 'worktree-owner.json') }
  private async owned(): Promise<void> {
    await safePath(this.work); await safePath(this.marker())
    if (!await exists(this.marker())) fail('unsafe-workdir', 'Worktree ownership marker is missing; refusing to adopt or delete unknown data.')
    const marker = record(parseJson(await this.readLocal(this.marker())))
    if (marker.format !== OWNER || marker.subdir !== this.namespace) fail('unsafe-workdir', 'Git workdir namespace/ownership differs from configured state.')
    if (!(await lstat(join(this.work, '.git'))).isDirectory()) fail('unsafe-workdir', 'Expected an owned Git directory, not a linked worktree.')
    await safePath(join(this.work, '.git'))
    const root = (await this.run(['rev-parse', '--show-toplevel'])).stdout.trim()
    if (resolve(root) !== resolve(await realpath(this.work))) fail('unsafe-workdir', 'Unexpected Git worktree root.')
  }
  private async readLocal(file: string): Promise<string> {
    await safePath(file)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('size-limit', 'Invalid or oversized local vault document.')
    const result = await readFile(file, 'utf8')
    if (Buffer.byteLength(result) > MAX_BYTES) fail('size-limit', 'Local vault document exceeds 21 MiB.')
    return result
  }
  private file(name: string): string { return join(this.work, this.namespace, name) }
  private async defaultBranch(): Promise<string> {
    const head = await this.run(['ls-remote', '--symref', 'origin', 'HEAD'], true)
    const symbolic = /^ref: refs\/heads\/([^\r\n]+)\tHEAD$/m.exec(head.stdout)
    if (symbolic) return branchName(symbolic[1])
    // Empty remotes may not advertise an unborn HEAD. Clone preserves its initial branch;
    // populated remotes with a broken/detached HEAD must not silently fork a fake main.
    const refs = await this.run(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])
    if (refs.stdout.trim()) fail('workdir-branch', 'Remote default branch is unavailable; configure an explicit branch before syncing.')
    return branchName((await this.run(['symbolic-ref', '--short', 'HEAD'])).stdout.trim())
  }
  private async ensure(): Promise<void> {
    this.remoteRef = undefined
    if (this.local) {
      await safePath(this.repo)
      const bare = await this.run(['rev-parse', '--is-bare-repository'], false, false, this.repo)
      if (bare.stdout.trim() !== 'true') fail('invalid-config', 'Local Git test remote must be bare.')
    }
    const fresh = !await exists(this.work)
    if (fresh) {
      await this.run(['clone', '--no-checkout', '--no-hardlinks', '--origin', 'origin', '--', this.repo, this.work], true, false, this.state)
      await writeFile(this.marker(), canonical({ format: OWNER, subdir: this.namespace }), { mode: 0o600 })
    }
    await this.owned()
    await this.relink()
    const branch = this.branch ??= await this.defaultBranch()
    if (fresh) {
      // Limit worktree checkout to the configured vault namespace; unrelated repository files stay untouched.
      const hasBranch = await this.run(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + branch], false, true)
      if (hasBranch.code !== 0) await this.run(['symbolic-ref', 'HEAD', 'refs/heads/' + branch])
      await this.run(['sparse-checkout', 'set', '--cone', '--', this.namespace])
      if (hasBranch.code === 0) await this.run(['checkout', '-B', branch, 'refs/remotes/origin/' + branch])
    }
    const current = (await this.run(['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
    if (current !== branch) fail('workdir-branch', 'Worktree branch differs; use an explicitly confirmed reset.')
    if ((await this.run(['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) fail('workdir-dirty', 'Worktree contains local changes; inspect before syncing.')
    // Fetch one explicit ref; never pull, merge unrelated histories, reset or force-push.
    const heads = await this.run(['ls-remote', '--heads', 'origin', 'refs/heads/' + branch], true)
    if (heads.stdout.trim()) {
      const ref = 'refs/remotes/origin/' + branch
      await this.run(['fetch', '--no-tags', 'origin', 'refs/heads/' + branch + ':' + ref], true)
      const merged = await this.run(['merge', '--ff-only', ref], false, true)
      if (merged.code !== 0) fail('index-conflict', 'Git remote cannot fast-forward; inspect workdir facts and explicitly resolve diverged history.')
      this.remoteRef = ref
    }
  }
  private async relink(): Promise<void> {
    await this.run(['remote', 'set-url', 'origin', this.repo])
    await this.run(['remote', 'set-url', '--push', 'origin', this.repo])
  }
  private async index(writing = false): Promise<{ entries: VaultSyncMeta[]; missing: boolean }> {
    const path = this.file('index.json')
    if (await exists(path)) return { entries: parseIndex(await this.readLocal(path), this.type), missing: false }
    if (writing && await exists(this.file(''))) {
      const files = await readdir(this.file(''))
      if (files.length) fail('index-missing-with-content', 'Git vault index is missing after prior content; refusing write/delete.')
    }
    return { entries: [], missing: true }
  }
  private async readRemote(name: string): Promise<string | undefined> {
    if (!this.remoteRef) return undefined
    const path = this.namespace + '/' + name
    const entry = (await this.run(['ls-tree', this.remoteRef, '--', path])).stdout.trim()
    if (!entry) return undefined
    const blob = /^100(?:644|755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t/.exec(entry)
    if (!blob || entry.slice(entry.indexOf('\t') + 1) !== path) fail('invalid-document', 'Remote vault document must be a regular Git blob.')
    return (await this.run(['cat-file', 'blob', blob[1]!])).stdout
  }
  private async remoteIndex(writing = false): Promise<VaultSyncMeta[]> {
    const index = await this.readRemote('index.json')
    if (index !== undefined) return parseIndex(index, this.type)
    if (writing && this.remoteRef && (await this.run(['ls-tree', '-r', '--name-only', this.remoteRef, '--', this.namespace])).stdout.trim()) fail('index-missing-with-content', 'Remote Git vault index is missing after prior content; refusing write/delete.')
    return []
  }
  async list(): Promise<VaultSyncMeta[]> { return this.locked(async () => { await this.ensure(); return this.remoteIndex() }) }
  async download(value: string): Promise<VaultSyncSnapshot> {
    const id = safeId(value)
    return this.locked(async () => {
      await this.ensure()
      const meta = (await this.remoteIndex()).find(m => m.id === id)
      if (!meta) fail('not-found', 'Snapshot is not in the authoritative Git vault index.')
      const snapshot = await this.readRemote(id + '.json')
      if (snapshot === undefined) fail('not-found', 'Snapshot is missing from the remote Git tree.')
      return checkedDownload(snapshot, id, meta, this.type)
    })
  }
  async upload(value: VaultSyncSnapshot, expectedHead?: string): Promise<VaultSyncMeta> {
    const snapshot = validateSnapshot(parseJson(canonical(validateSnapshot(value, this.type))), this.type)
    const meta = metaFromSnapshot(snapshot)
    return this.locked(async () => {
      await this.ensure()
      const remote = await this.remoteIndex(true)
      const published = remote.find(m => m.id === meta.id)
      if (published) {
        if (canonical(published) !== canonical(meta)) fail('snapshot-id-conflict', 'Snapshot id already names different Git content.')
        const stored = await this.readRemote(meta.id + '.json')
        if (stored === undefined) fail('not-found', 'Snapshot is missing from the remote Git tree.')
        checkedDownload(stored, meta.id, meta, this.type)
        // A lost success reply may replay the old preview token. Only this exact
        // publication may explain the difference; unrelated remote writes still fail CAS.
        if (expectedHead !== undefined && remoteIndexVersion(remote) !== expectedHead) assertExpectedHead(remote.filter(item => item.id !== meta.id), expectedHead)
        return meta
      }
      assertExpectedHead(remote, expectedHead)
      // A rejected push can leave a clean encrypted commit ahead of origin. Check CAS
      // against origin above, but retain that commit/index so an exact retry can publish it.
      const before = await this.index(true)
      const pending = before.entries.find(m => m.id === meta.id)
      if (pending) {
        if (canonical(pending) !== canonical(meta)) fail('snapshot-id-conflict', 'Snapshot id already names different local Git content.')
        checkedDownload(await this.readLocal(this.file(meta.id + '.json')), meta.id, meta, this.type)
        await this.push()
        return meta
      }
      const index = serializeIndex([...before.entries, meta], this.type)
      await safePath(this.file('')); await mkdir(this.file(''), { recursive: true, mode: 0o700 })
      if (await exists(this.file(meta.id + '.json'))) checkedDownload(await this.readLocal(this.file(meta.id + '.json')), meta.id, meta, this.type)
      else await writeFile(this.file(meta.id + '.json'), canonical(snapshot), { mode: 0o600, flag: 'wx' })
      await safePath(this.file('content-present.json'))
      await writeFile(this.file('content-present.json'), '{"format":"1pass-vault-content-present-v1"}', { mode: 0o600 })
      await safePath(this.file('index.json')); await writeFile(this.file('index.json'), index, { mode: 0o600 })
      await this.commitAndPush()
      return meta
    })
  }
  async delete(value: string): Promise<void> {
    const id = safeId(value)
    return this.locked(async () => {
      await this.ensure()
      const remote = await this.remoteIndex(true)
      if (!remote.some(m => m.id === id)) return
      const before = await this.index(true)
      await writeFile(this.file('index.json'), serializeIndex(before.entries.filter(m => m.id !== id), this.type), { mode: 0o600 })
      await safePath(this.file(id + '.json')); await rm(this.file(id + '.json'), { force: true })
      await this.commitAndPush()
    })
  }
  private async commitAndPush(): Promise<void> {
    await this.run(['add', '-A', '--', this.namespace])
    const diff = await this.run(['diff', '--cached', '--quiet', '--', this.namespace], false, true)
    if (diff.code === 1) await this.run(['-c', 'user.name=1pass Vault Sync', '-c', 'user.email=1pass@localhost', 'commit', '-m', '1pass: encrypted vault snapshot update', '--only', '--', this.namespace])
    else if (diff.code !== 0) fail('git-failed', 'Unable to inspect staged vault changes.')
    await this.push()
  }
  private async push(): Promise<void> {
    const result = await this.run(['push', '--porcelain', 'origin', 'HEAD:refs/heads/' + this.branch], true, true)
    if (result.code !== 0) fail('index-conflict', 'Git push was rejected or failed; local encrypted commit remains. Refresh workdir facts; never force-push.')
  }
  async probe(): Promise<{ message: string; hint: string }> {
    return this.locked(async () => {
      const anonymous = await this.run(['ls-remote', '--', this.repo], false, true, this.state)
      let privateRemote = false
      if (anonymous.code !== 0) {
        if (this.local || this.ssh) fail('git-failed', 'Git remote cannot be reached.')
        await this.run(['ls-remote', '--', this.repo], true, false, this.state)
        privateRemote = true
      }
      return { message: 'Git remote is readable; write permission has not been verified.', hint: (this.local ? 'Local bare repository test fixture.' : this.ssh ? 'SSH reachability is verified; repository visibility cannot be inferred from authenticated SSH.' : privateRemote ? 'Anonymous read failed and authenticated read succeeded (private-remote hint).' : 'WARNING: anonymous read succeeded; remote appears public. Private storage is recommended.') + ' Deletes do not remove encrypted content from Git history.' }
    })
  }
  async workdirFacts(): Promise<{ path: string; exists: boolean; origin: string | null; pushUrl: string | null; match: boolean; ahead: number | null; dirty: boolean | null; remoteSnapshots: number | null }> {
    return this.locked(async () => {
      if (!await exists(this.work)) return { path: this.work, exists: false, origin: null, pushUrl: null, match: false, ahead: null, dirty: null, remoteSnapshots: null }
      await this.owned()
      const originRaw = (await this.run(['remote', 'get-url', 'origin'], false, true)).stdout.trim()
      const pushRaw = (await this.run(['remote', 'get-url', '--push', 'origin'], false, true)).stdout.trim()
      // Unknown externally changed URLs may contain secrets. Never expose them to UI.
      const origin = originRaw === this.repo ? this.repo : null
      const pushUrl = pushRaw === this.repo ? this.repo : null
      const dirty = !!(await this.run(['status', '--porcelain', '--untracked-files=all'])).stdout.trim()
      const branch = this.branch ?? branchName((await this.run(['symbolic-ref', '--short', 'HEAD'])).stdout.trim())
      const aheadResult = await this.run(['rev-list', '--count', 'refs/remotes/origin/' + branch + '..HEAD'], false, true)
      const ahead = aheadResult.code === 0 && /^\d+\s*$/.test(aheadResult.stdout) ? Number(aheadResult.stdout.trim()) : null
      // Tracking refs can be stale; do not pretend a local worktree count is current remote state.
      return { path: this.work, exists: true, origin, pushUrl, match: !!origin && !!pushUrl, ahead, dirty, remoteSnapshots: null }
    })
  }
  async resetWorkdir(mode: 'relink' | 'adopt' | 'reclone', confirm: boolean): Promise<void> {
    if (!['relink', 'adopt', 'reclone'].includes(mode)) fail('invalid-config', 'Invalid Git workdir reset mode.')
    if (mode !== 'relink' && confirm !== true) fail('confirmation-required', 'Explicit confirmation is required for adopt/reclone workdir reset.')
    return this.locked(async () => {
      if (!await exists(this.work)) { await this.ensure(); return }
      await this.owned()
      if (mode === 'relink') { await this.relink(); return }
      if (mode === 'adopt') {
        // Conservative adoption: only existing owned, clean history that fast-forwards. No reset or unrelated merge.
        await this.ensure(); return
      }
      await safePath(this.work)
      await rm(this.work, { recursive: true, force: false })
      await rm(this.marker(), { force: true })
      if (this.o.config.branch === undefined) this.branch = undefined
      await this.ensure()
    })
  }
}
