import { expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault, type VaultEntry } from '../src/store.ts'
import { VaultCloudSync } from '../src/cloud-sync/controller.ts'
import { metaFromSnapshot } from '../src/cloud-sync/transports.ts'
import type { VaultSyncMeta, VaultSyncSnapshot, VaultSyncTransport } from '../src/cloud-sync/types.ts'
const syntheticPassword='synthetic-controller-secret'
function secrets(){const values=new Map<string,string>();return {get:async(ref:string)=>values.get(ref),has:async(ref:string)=>values.has(ref),set:async(ref:string,value:string)=>{values.set(ref,value)},unset:async(ref:string)=>{values.delete(ref)}}}
function remote(){
 const snapshots=new Map<string,VaultSyncSnapshot>();let revision=0
 const io:VaultSyncTransport={type:'git',list:vi.fn(async()=>[...snapshots.values()].map(metaFromSnapshot).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))),upload:vi.fn(async s=>{snapshots.set(s.id,structuredClone(s));revision++;return metaFromSnapshot(s)}),download:vi.fn(async id=>{const s=snapshots.get(id);if(!s)throw new Error('notfound');return structuredClone(s)}),delete:vi.fn(async id=>{snapshots.delete(id)}),probe:vi.fn(async()=>({message:'Synthetic channel connected',snapshotCount:snapshots.size}))}
 return {io,snapshots}
}
async function fixture(run:(f:Awaited<ReturnType<typeof build>>)=>Promise<void>){const f=await build();try{await run(f)}finally{await f.a.dispose();await f.b.dispose();await f.sa.lock();await f.sb.lock();await rm(f.dir,{recursive:true,force:true,maxRetries:15,retryDelay:50})}}
async function build(){
 const dir=await mkdtemp(join(tmpdir(),'vault-sync-controller-')),sa=await openVault({path:join(dir,'a.json'),masterPassword:'synthetic-local-a'}),sb=await openVault({path:join(dir,'b.json'),masterPassword:'synthetic-local-b'}),r=remote()
 let allowed=true;let tick=1700000000000
 const create=(store:typeof sa,name:string)=>new VaultCloudSync({stateDir:join(dir,name),vaultName:name,secrets:secrets(),now:()=>++tick,context:async()=>({store,authorize:()=>{if(!allowed)throw new Error('READONLY')}}),transport:()=>r.io})
 const a=create(sa,'a'),b=create(sb,'b')
 for(const c of [a,b]){await c.call('saveConfig',{transport:'git',repoUrl:'git@github.com:synthetic/onepass.git',subdir:'1pass'});await c.call('saveSelection',{transport:'git',encrypt:true,includeSecrets:false,sections:['vault'],mode:'advanced',encryptPassword:syntheticPassword,decryptPassword:syntheticPassword})}
 return {dir,sa,sb,a,b,r,deny:()=>{allowed=false}}
}
const rec=(v:unknown)=>v as Record<string,unknown>
async function push(c:VaultCloudSync){const p=rec(await c.call('pushPreview',{transport:'git'}));return rec(await c.call('push',{transport:'git',planId:p.planId}))}
async function adopt(c:VaultCloudSync){const p=rec(await c.call('sync',{transport:'git'}));const items=p.items as Array<{itemId:string}>;return rec(await c.call('applyItems',{syncSessionId:p.syncSessionId,adoptions:items.map(i=>({itemId:i.itemId,adopt:true}))}))}
test('two devices push preview and pull confirmation preserve encrypted secrets',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic record',password:'SYNTHETIC-ENTRY-PASSWORD',username:'synthetic-user'})
 const p=rec(await f.a.call('pushPreview',{transport:'git'}));expect(f.r.snapshots.size).toBe(0);expect(JSON.stringify(p)).not.toContain('SYNTHETIC-ENTRY-PASSWORD')
 await expect(f.a.call('push',{transport:'git'})).rejects.toThrow(/PREVIEW/)
 const report=rec(await f.a.call('push',{transport:'git',planId:p.planId}));expect(report.ok).toBe(true)
 expect(JSON.stringify([...f.r.snapshots.values()])).not.toContain('SYNTHETIC-ENTRY-PASSWORD')
 const preview=rec(await f.b.call('sync',{transport:'git'}));expect(f.sb.list()).toHaveLength(0);expect(JSON.stringify(preview)).not.toContain('SYNTHETIC-ENTRY-PASSWORD')
 await adopt(f.b);expect(f.sb.list()).toHaveLength(1);expect(f.sb.list()[0]?.password).toBe('SYNTHETIC-ENTRY-PASSWORD')
 const baseline=await readFile(join(f.dir,'b','baselines',f.r.io.type+'-'+(await import('../src/cloud-sync/engine.ts')).syncHash({config:(await f.b.config.read()).channels.git.config,selection:(await f.b.config.read()).channels.git.selection})+'.json'),'utf8')
 expect(baseline).not.toContain('SYNTHETIC-ENTRY-PASSWORD')
}))
test('stale local/target/remote previews cannot overwrite newer work',async()=>fixture(async f=>{
 const entry=await f.sa.add({title:'Synthetic',password:'before'})
 const p=rec(await f.a.call('pushPreview',{transport:'git'}));await f.sa.update(entry.id,{password:'after'})
 await expect(f.a.call('push',{transport:'git',planId:p.planId})).rejects.toThrow(/LOCAL_CHANGED/)
 expect(f.r.snapshots.size).toBe(0)
 const q=rec(await f.a.call('pushPreview',{transport:'git'}));await f.a.call('saveConfig',{transport:'git',repoUrl:'git@github.com:synthetic/other.git'})
 await expect(f.a.call('push',{transport:'git',planId:q.planId})).rejects.toThrow(/PREVIEW/)
}))
test('common ancestor merges disjoint edits but secret conflicts require explicit choice',async()=>fixture(async f=>{
 const item=await f.sa.add({title:'Synthetic',username:'u',password:'initial'});await push(f.a);await adopt(f.b)
 await f.sa.update(item.id,{username:'remote-user'});await push(f.a)
 await f.sb.update(item.id,{password:'local-password'})
 const p=rec(await f.b.call('mergePreview',{transport:'git'}));expect(JSON.stringify(p)).not.toMatch(/remote-user|local-password/)
 const applied=rec(await f.b.call('applyMerge',{transport:'git',planId:p.planId,snapshotId:p.snapshotId,resolutions:[{id:'vault',action:'useMerged'}]}));expect(applied.ok).toBe(true)
 expect(f.sb.get(item.id)).toMatchObject({username:'remote-user',password:'local-password'})
 await push(f.b)
 await adopt(f.a)
 await f.sa.update(item.id,{password:'remote-conflict'});await push(f.a)
 await f.sb.update(item.id,{password:'local-conflict'})
 const q=rec(await f.b.call('mergePreview',{transport:'git'}));expect((q.summary as {conflicts:number}).conflicts).toBeGreaterThan(0);expect(JSON.stringify(q)).not.toMatch(/remote-conflict|local-conflict/)
 await f.b.call('applyMerge',{transport:'git',planId:q.planId,snapshotId:q.snapshotId,resolutions:[{id:'vault',action:'useRemote'}]})
 expect(f.sb.get(item.id)?.password).toBe('remote-conflict')
}))
test('readonly, lock and explicit revocation block confirmed writes',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic'});const p=rec(await f.a.call('pushPreview',{transport:'git'}));f.deny()
 await expect(f.a.call('push',{transport:'git',planId:p.planId})).rejects.toThrow(/READONLY/);expect(f.r.snapshots.size).toBe(0)
}))
test('rollback refuses any post-merge local edit rather than discard it',async()=>fixture(async f=>{
 const e=await f.sa.add({title:'Synthetic',password:'original'});await push(f.a)
 const result=await adopt(f.b);expect(f.sb.get(e.id)).toBeTruthy()
 await f.sb.update(e.id,{notes:'new local edit'})
 await expect(f.b.call('rollback',{restoreId:result.restoreId})).rejects.toThrow(/ROLLBACK_LOCAL_CHANGED/)
 expect(f.sb.get(e.id)?.notes).toBe('new local edit')
}))

test('host readonly blocks MKCOL-capable probes and preference disk mutations',async()=>fixture(async f=>{
 f.deny()
 await expect(f.a.call('probe',{transport:'git'})).rejects.toThrow(/READONLY/)
 await expect(f.a.call('saveUiPrefs',{lastSyncChannel:'gist'})).rejects.toThrow(/READONLY/)
 expect(f.r.io.probe).not.toHaveBeenCalled()
}))
test('remote consultation returns a complete opaque report without decrypting entries',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic',password:'SYNTHETIC-CONSULT-SECRET'});const report=await push(f.a)
 const consult=rec(await f.a.call('consult',{transport:'git',type:'remote-snapshot',id:report.snapshotId}))
 expect(Array.isArray(consult.dimensions)).toBe(true);expect(Array.isArray(consult.recommendationReasons)).toBe(true)
 expect(consult.willApply).toMatchObject({dryRun:true,itemCount:0})
 expect(JSON.stringify(consult)).not.toContain('SYNTHETIC-CONSULT-SECRET')
}))
test('an external writer before preview is rejected rather than blessed by a fresh disk hash',async()=>fixture(async f=>{
 const second=await openVault({path:f.sa.filePath,masterPassword:'synthetic-local-a'})
 try{await second.add({title:'External new entry',password:'SYNTHETIC-EXTERNAL'})
  await expect(f.a.call('pushPreview',{transport:'git'})).rejects.toThrow(/LOCAL_CHANGED/)
  expect(f.r.snapshots.size).toBe(0)
 }finally{await second.lock()}
}))
test('revocation invalidates previews and locked input never uploads',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic'});const p=rec(await f.a.call('pushPreview',{transport:'git'}));f.a.revoke()
 await expect(f.a.call('push',{transport:'git',planId:p.planId})).rejects.toThrow(/PREVIEW/)
 await f.sa.lock();await expect(f.a.call('pushPreview',{transport:'git'})).rejects.toThrow(/LOCKED/)
 expect(f.r.snapshots.size).toBe(0)
}))


test('automatic first sync never uploads or imports without an established baseline',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic first-run'})
 await f.a.call('autosyncUpdate',{transport:'git',enabled:true,interval:'30m',realtime:false})
 await (f.a as unknown as {auto(ch:'git',reason:'startup'):Promise<void>}).auto('git','startup')
 expect(f.r.snapshots.size).toBe(0)
 const status=rec(await f.a.call('autosyncStatus',{transport:'git'}))
 expect(status).toMatchObject({lastRunStatus:'skipped',lastRunSkipReason:'conflict'})
}))
test('startup and remote polling do not push dirty local records',async()=>fixture(async f=>{
 const e=await f.sa.add({title:'Synthetic baseline'});await push(f.a)
 await f.a.call('autosyncUpdate',{transport:'git',enabled:true,interval:'30m',realtime:false})
 await f.sa.update(e.id,{notes:'synthetic local-only change'})
 const count=f.r.snapshots.size
 await (f.a as unknown as {auto(ch:'git',reason:'remote'):Promise<void>}).auto('git','remote')
 expect(f.r.snapshots.size).toBe(count)
 await (f.a as unknown as {auto(ch:'git',reason:'local'):Promise<void>}).auto('git','local')
 expect(f.r.snapshots.size).toBe(count+1)
}))


test('remote deletion is a review conflict, not automatic credential removal',async()=>fixture(async f=>{
 const e=await f.sa.add({title:'Synthetic deletion candidate',password:'SYNTHETIC-NOT-REAL'});await push(f.a);await adopt(f.b)
 await f.sa.purge(e.id);await push(f.a)
 const p=rec(await f.b.call('sync',{transport:'git'})),items=p.items as Array<{itemId:string;kind:string;adopt:boolean}>
 expect(items.some(i=>i.kind==='Conflict'&&i.adopt===false)).toBe(true)
 await expect(f.b.call('applyItems',{syncSessionId:p.syncSessionId,adoptions:items.map(i=>({itemId:i.itemId,adopt:true}))})).rejects.toThrow(/RESOLUTION_REQUIRED/)
 expect(f.sb.get(e.id)?.password).toBe('SYNTHETIC-NOT-REAL')
}))


test('reference confirmation can re-save the same encryption password without invalidating its preview',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic reference push'})
 const p=rec(await f.a.call('pushPreview',{transport:'git'}))
 await f.a.call('saveSelection',{transport:'git',mode:'advanced',sections:['vault'],encrypt:true,includeSecrets:false,encryptPassword:syntheticPassword})
 const done=rec(await f.a.call('push',{transport:'git',planId:p.planId}))
 expect(done.ok).toBe(true)
 const changed=rec(await f.a.call('pushPreview',{transport:'git'}))
 await f.a.call('saveSelection',{transport:'git',mode:'advanced',sections:['vault'],encrypt:true,includeSecrets:false,encryptPassword:'different-synthetic-password'})
 await expect(f.a.call('push',{transport:'git',planId:changed.planId})).rejects.toThrow(/PREVIEW/)
}))


test('unchanged debounced Git configuration does not revoke an already confirmed preview capability',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic no-op config'})
 const preview=rec(await f.a.call('pushPreview',{transport:'git'}))
 await f.a.call('saveConfig',{transport:'git',repoUrl:'git@github.com:synthetic/onepass.git',subdir:'1pass'})
 const result=rec(await f.a.call('push',{transport:'git',planId:preview.planId}))
 expect(result.ok).toBe(true)
}))


test('an uncertain upload retry acknowledges only the exact confirmed snapshot without another remote writer',async()=>fixture(async f=>{
 await f.sa.add({title:'Synthetic lost acknowledgment'})
 const p=rec(await f.a.call('pushPreview',{transport:'git'}))
 const realUpload=f.r.io.upload.bind(f.r.io)
 vi.mocked(f.r.io.upload).mockImplementationOnce(async snapshot=>{await realUpload(snapshot);throw new Error('synthetic-lost-reply')})
 await expect(f.a.call('push',{transport:'git',planId:p.planId})).rejects.toThrow('synthetic-lost-reply')
 expect(f.r.snapshots.size).toBe(1)
 const result=rec(await f.a.call('push',{transport:'git',planId:p.planId}))
 expect(result.ok).toBe(true);expect(f.r.snapshots.size).toBe(1)
}))


test('encryption-password save does not revoke a legitimate queued Git configuration save',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vault-concurrent-config-'))
 const store=await openVault({path:join(dir,'vault.json'),masterPassword:'synthetic-local'})
 const values=new Map<string,string>()
 let started!:()=>void,release!:()=>void
 const didStart=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const port={get:async(ref:string)=>values.get(ref),has:async(ref:string)=>values.has(ref),set:async(ref:string,value:string)=>{values.set(ref,value);if(ref.endsWith('_ENCRYPT')){started();await gate}},unset:async(ref:string)=>{values.delete(ref)}}
 const service=new VaultCloudSync({stateDir:join(dir,'sync'),vaultName:'synthetic',secrets:port,context:async()=>({store,authorize(){}}),transport:()=>remote().io})
 try{
  const passwordSave=service.call('saveSelection',{transport:'git',mode:'advanced',sections:['vault'],encrypt:true,includeSecrets:false,encryptPassword:'synthetic-sync'})
  await didStart
  const configSave=service.call('saveConfig',{transport:'git',repoUrl:'https://github.com/synthetic/private.git',subdir:''})
  release()
  await expect(passwordSave).resolves.toMatchObject({encryptPasswordConfigured:true})
  await expect(configSave).resolves.toMatchObject({configured:true})
  expect((await service.config.read()).channels.git.config?.repoUrl).toBe('https://github.com/synthetic/private.git')
 }finally{release();await service.dispose();await store.lock();await rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:50})}
})
