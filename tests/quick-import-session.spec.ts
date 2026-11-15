import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuickImportSessions, quickImportIdentity } from '../src/quick-import-session.ts'
import { DEFAULT_QUICK_IMPORT_FORMAT } from '../src/quick-import.ts'
import { openVault, onVaultPersist } from '../src/store.ts'
const options = { format: DEFAULT_QUICK_IMPORT_FORMAT, kind: 'ssh' as const }
const source = 'root@192.0.2.10:22|synthetic-secret|demo\nroot@192.0.2.11:2200|1|other'
const services: QuickImportSessions[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); vi.useRealTimers() })
function setup() {
  let now = 1000, locked = false, readonly = false
  let id = {}, path = '/synthetic/vault.json'
  const entries: Array<{ title: string; kind: 'ssh'; host: string; username: string; port: string }> = []
  const write = vi.fn(async (patches: Array<{ title: string; kind: 'ssh' | 'login'; host: string; username: string; port?: string }>) => patches.map(patch => {
    if (entries.some(entry => quickImportIdentity(entry) === quickImportIdentity(patch))) return false
    entries.push({ ...patch, kind: 'ssh', port: patch.port ?? '22' }); return true
  }))
  const s = new QuickImportSessions(async writing => {
    if (locked) throw new Error('LOCKED')
    if (writing && readonly) throw new Error('READONLY')
    return { identity: id, path, vaultName: 'test', entries: [...entries], write }
  }, () => now)
  services.push(s)
  return { s, write, entries, expire: () => { now += 300001 }, lock: () => { locked = true }, readonly: () => { readonly = true }, switch: () => { id = {}; path = '/different/vault.json' } }
}
test('preview is metadata only and explicit confirmation is required', async () => {
  const f = setup(); const p = await f.s.preview(source, options)
  expect(p.valid).toBe(2); expect(p.rows[0]?.hasPassword).toBe(true)
  expect(JSON.stringify(p)).not.toContain('synthetic-secret')
  expect(JSON.stringify(p)).not.toContain('password')
  expect(f.write).not.toHaveBeenCalled()
  await expect(f.s.commit(p.token, [1,2], false)).rejects.toThrow(/CONFIRM/)
  expect(f.write).not.toHaveBeenCalled()
  expect((await f.s.commit(p.token, [2], true)).added).toBe(1)
})
test('same confirmed selection is idempotent, including concurrent replies', async () => {
  const f = setup(); const p = await f.s.preview(source, options)
  const [a,b] = await Promise.all([f.s.commit(p.token, [1,2], true),f.s.commit(p.token,[2,1],true)])
  expect(a).toEqual(b); expect(a.added).toBe(2); expect(f.write).toHaveBeenCalledTimes(1)
  expect(await f.s.commit(p.token,[1,2],true)).toEqual(a)
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow(/SELECTION_CHANGED/)
})
test('duplicates in the vault and batch are skipped rather than overwritten', async () => {
  const f = setup(); f.entries.push({ title:'existing',kind:'ssh',host:'192.0.2.10',username:'root',port:'22' })
  const p = await f.s.preview(source+'\nroot@192.0.2.11:2200|different-password|duplicate',options)
  expect(p.duplicates).toBe(2); expect(p.valid).toBe(1)
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow(/INVALID_SELECTION/)
  expect((await f.s.commit(p.token,[2],true)).added).toBe(1)
})
test.each(['lock','readonly','switch','expire'] as const)('commit rechecks %s instead of trusting its preview', async change => {
  const f=setup(); const p=await f.s.preview(source,options); f[change]()
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow()
  expect(f.write).not.toHaveBeenCalled()
})
test('new preview and discard revoke earlier capabilities', async () => {
  const f=setup();const p=await f.s.preview(source,options);const q=await f.s.preview(source,options)
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow(/EXPIRED/)
  expect(f.s.discard(q.token)).toEqual({discarded:true})
  await expect(f.s.commit(q.token,[1],true)).rejects.toThrow(/EXPIRED/)
})
test('failed atomic write returns generic error and retry preserves same selection', async () => {
  const f=setup(); f.write.mockRejectedValueOnce(new Error('synthetic-secret-not-echoed'))
  const p=await f.s.preview(source,options)
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow('QUICK_IMPORT_WRITE_FAILED')
  expect((await f.s.commit(p.token,[1],true)).added).toBe(1)
})
test('metadata expiry clears preview, not just UI navigation', async () => {
  vi.useFakeTimers(); const f=setup();const p=await f.s.preview(source,options)
  await vi.advanceTimersByTimeAsync(300001)
  await expect(f.s.commit(p.token,[1],true)).rejects.toThrow(/EXPIRED/)
})
test('batch storage writes once, validates all, and does not publish a failed batch', async () => {
  const dir=await mkdtemp(join(tmpdir(),'quick-batch-'));const path=join(dir,'vault.json')
  const observed:string[]=[];const off=onVaultPersist(p=>observed.push(p))
  try {
    const store=await openVault({path,masterPassword:'synthetic-batch-password'})
    const before=observed.length
    await store.addMany([{title:'A',kind:'ssh',sshAuth:'password',host:'192.0.2.10',port:'22',username:'root',password:'SYNTHETIC-BATCH-SECRET'},{title:'B',password:'1'}])
    expect(observed.length-before).toBe(1);expect(store.list()).toHaveLength(2)
    expect(await readFile(path,'utf8')).not.toContain('SYNTHETIC-BATCH-SECRET')
    await expect(store.addMany([{title:'C'},{title:''}])).rejects.toThrow()
    expect(store.list()).toHaveLength(2)
    const batches=await Promise.all([store.addMany([{title:'same',kind:'ssh',username:'u',host:'h'}],quickImportIdentity),store.addMany([{title:'same',kind:'ssh',username:'u',host:'h'}],quickImportIdentity)])
    expect(batches.map(a=>a.length).sort()).toEqual([0,1])
    await store.lock()
  }finally{off();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50})}
})
test('failed document replacement leaves the in-memory batch unpublished', async () => {
  const dir=await mkdtemp(join(tmpdir(),'quick-batch-fail-'));const path=join(dir,'vault.json')
  try {
    const store=await openVault({path,masterPassword:'synthetic-fail-password'})
    await store.add({title:'Existing'})
    await rm(path);await mkdir(path)
    await expect(store.addMany([{title:'Must not publish',password:'SYNTHETIC'}])).rejects.toThrow()
    expect(store.list().map(e=>e.title)).toEqual(['Existing'])
    await store.lock()
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50})}
})

test('revocation does not orphan an in-flight commit during disposal', async () => {
  let release: (()=>void)|undefined
  const gate=new Promise<void>(resolve=>{release=resolve})
  const write=vi.fn(async (entries:unknown[])=>{await gate;return entries.map(()=>true)})
  const id={}
  const s=new QuickImportSessions(async()=>({identity:id,path:'/synthetic',vaultName:'v',entries:[],write}))
  services.push(s)
  const p=await s.preview(source,options)
  const commit=s.commit(p.token,[1],true)
  await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(1))
  s.revoke()
  await expect(s.preview(source,options)).rejects.toThrow(/BUSY/)
  let disposed=false
  const disposal=s.dispose().then(()=>{disposed=true})
  await Promise.resolve();await Promise.resolve()
  expect(disposed).toBe(false)
  release!()
  await commit;await disposal
  expect(disposed).toBe(true)
})
