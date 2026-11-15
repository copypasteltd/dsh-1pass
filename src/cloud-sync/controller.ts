/** Reference sync workflow adapted to encrypted vault data only. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VaultEntry, VaultStore } from '../store.ts'
import { canonical, syncHash, sealSyncSnapshot, openSyncSnapshot, mergeVaultEntries, resolveVaultMerge, type VaultMergePlan } from './engine.ts'
import { VaultSyncConfigStore, type SyncSecretPort } from './config.ts'
import { VaultSyncGitHub } from './github.ts'
import { selectRetentionKeepers, DEFAULT_RETENTION_POLICY } from './retention.ts'
import { createVaultSyncTransport, remoteIndexVersion } from './transports.ts'
import type { VaultSyncChannel, VaultSyncChannelConfig, VaultSyncMeta, VaultSyncSnapshot, VaultSyncTransport } from './types.ts'
const CHANNELS: VaultSyncChannel[]=['git','webdav','s3','gist']
const INTERVAL:Record<string,number>={'5m':300000,'15m':900000,'30m':1800000,'60m':3600000,'6h':21600000,'12h':43200000,'24h':86400000}
const TTL=30*60000
interface Context {store:VaultStore;authorize():void}
interface Capture extends Context {entries:VaultEntry[];fingerprint:string;diskHash:string}
interface Baseline {version:1;target:string;lastSnapshotId:string;ancestor:string;at:string}
interface Plan {token:string;expires:number;generation:number;channel:VaultSyncChannel;target:string;capture:Capture;remoteHead:string;remoteVersion:string;snapshot?:VaultSyncSnapshot;remote?:VaultSyncSnapshot;remoteEntries?:VaultEntry[];merge?:VaultMergePlan;hasAncestor?:boolean;result?:Record<string,unknown>;signature?:string}
interface Runtime {lastRunAt?:string;lastRunStatus?:'success'|'skipped'|'failed'|'partial';lastRunMessage?:string;lastRunSkipReason?:string;consecutiveFailures:number}
export interface VaultCloudSyncOptions {
 stateDir:string;vaultName:string;secrets:SyncSecretPort;context():Promise<Context>;authorizeSync?:()=>void;now?:()=>number
 transport?:(config:VaultSyncChannelConfig,stateDir:string,signal:AbortSignal,getSecret:()=>Promise<string|undefined>)=>VaultSyncTransport
}
function object(value:unknown):Record<string,unknown>{if(value===undefined)return {};if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('SYNC_INVALID_REQUEST');return value as Record<string,unknown>}
function string(value:unknown):string|undefined{return typeof value==='string'&&value.length>0?value:undefined}
function channel(value:unknown,fallback:VaultSyncChannel):VaultSyncChannel{if(value===undefined)return fallback;if(!CHANNELS.includes(value as VaultSyncChannel))throw new Error('SYNC_INVALID_CHANNEL');return value as VaultSyncChannel}
function remoteVersion(list:VaultSyncMeta[]):string{return remoteIndexVersion(list)}
function newest(list:VaultSyncMeta[]):string{return [...list].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1)?.id??''}
async function jsonRead<T>(path:string):Promise<T|undefined>{try{const b=await readFile(path);if(b.length>24*1024*1024)throw new Error();return JSON.parse(b.toString('utf8')) as T}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw new Error('SYNC_LOCAL_STATE_INVALID')}}
async function jsonWrite(path:string,value:unknown):Promise<void>{await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.tmp-'+randomUUID();try{await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temp,path)}finally{await unlink(temp).catch(()=>{})}}
export class VaultCloudSync {
 readonly config:VaultSyncConfigStore
 private readonly github:VaultSyncGitHub
 private readonly now:()=>number
 private abort=new AbortController()
 private generation=0
 private authorityEpoch=0
 private disposed=false
 private readonly plans=new Map<string,Plan>()
 private readonly pushes=new Map<VaultSyncChannel,string>()
 private readonly merges=new Map<VaultSyncChannel,string>()
 private timers:Array<ReturnType<typeof setTimeout>>=[]
 private debounce:ReturnType<typeof setTimeout>|undefined
 private running:Promise<unknown>|undefined
 private readonly calls=new Set<Promise<unknown>>()
 private readonly expiryTimers=new Map<string,ReturnType<typeof setTimeout>>()
 private pending=new Map<VaultSyncChannel,'startup'|'remote'|'interval'|'local'>()
 private suppress=false
 private logEntries:Array<Record<string,unknown>>|undefined
 private readonly runtime:Record<VaultSyncChannel,Runtime>={git:{consecutiveFailures:0},webdav:{consecutiveFailures:0},s3:{consecutiveFailures:0},gist:{consecutiveFailures:0}}
 constructor(private readonly opts:VaultCloudSyncOptions){this.now=opts.now??Date.now;this.config=new VaultSyncConfigStore({stateDir:opts.stateDir,secrets:opts.secrets,authorize:()=>{this.live();opts.authorizeSync?.()}});this.github=new VaultSyncGitHub({secrets:opts.secrets,credentialRef:this.config.secretRef('git','auth'),now:this.now,authorize:()=>{this.live();opts.authorizeSync?.()}})}
 async start():Promise<void>{await this.schedules()}
 private live(g=this.generation):void{if(this.disposed||g!==this.generation||this.abort.signal.aborted)throw new Error('SYNC_SCOPE_CHANGED')}
 private invalidatePreviews():void{this.generation++;this.abort.abort();this.abort=new AbortController();this.plans.clear();for(const timer of this.expiryTimers.values())clearTimeout(timer);this.expiryTimers.clear();this.pushes.clear();this.merges.clear();this.pending.clear()}
 revoke():void{this.authorityEpoch++;this.config.revoke();this.github.revoke();this.invalidatePreviews()}
 private async authorizeRequest(epoch:number):Promise<void>{if(this.disposed||epoch!==this.authorityEpoch)throw new Error('SYNC_SCOPE_CHANGED');const ctx=await this.opts.context();if(this.disposed||epoch!==this.authorityEpoch)throw new Error('SYNC_SCOPE_CHANGED');ctx.authorize()}
 private async capture(write=false):Promise<Capture>{const g=this.generation;this.live(g);const ctx=await this.opts.context();this.live(g);if(write)ctx.authorize();const entries=ctx.store.syncSnapshot(),fingerprint=ctx.store.syncFingerprint(),knownDisk=ctx.store.syncDiskHash();const bytes=await readFile(ctx.store.filePath);if(createHash('sha256').update(bytes).digest('hex')!==knownDisk)throw new Error('SYNC_LOCAL_CHANGED');this.live(g);if(ctx.store.syncFingerprint()!==fingerprint)throw new Error('SYNC_LOCAL_CHANGED');return {...ctx,entries,fingerprint,diskHash:createHash('sha256').update(bytes).digest('hex')}}
 private async target(ch:VaultSyncChannel):Promise<string>{const s=(await this.config.read()).channels[ch];if(!s.config)throw new Error('SYNC_CHANNEL_UNCONFIGURED');return syncHash({config:s.config,selection:s.selection})}
 private async transport(ch:VaultSyncChannel):Promise<VaultSyncTransport>{this.live();const config=(await this.config.read()).channels[ch].config;if(!config)throw new Error('SYNC_CHANNEL_UNCONFIGURED');const dir=join(this.opts.stateDir,ch,syncHash(config).slice(0,24)),getSecret=()=>this.config.getSecret(ch,'auth');return this.opts.transport?.(config,dir,this.abort.signal,getSecret)??createVaultSyncTransport({config,stateDir:dir,signal:this.abort.signal,credentials:{getSecret}})}
 private path(ch:VaultSyncChannel,target:string):string{return join(this.opts.stateDir,'baselines',ch+'-'+target+'.json')}
 private async baseline(ch:VaultSyncChannel,target:string):Promise<Baseline|undefined>{const b=await jsonRead<Baseline>(this.path(ch,target));if(b&&(b.version!==1||b.target!==target||typeof b.lastSnapshotId!=='string'||typeof b.ancestor!=='string'))throw new Error('SYNC_LOCAL_STATE_INVALID');return b}
 private ancestor(capture:Capture,b:Baseline|undefined):VaultEntry[]|undefined{if(!b)return undefined;try{const data=capture.store.unsealLocalSyncState(b.ancestor) as {format:string;entries:VaultEntry[]};return data.format==='1pass-ancestor-v1'&&Array.isArray(data.entries)?data.entries:undefined}catch{return undefined}}
 private async advance(plan:Plan,snapshotId:string,entries:VaultEntry[]):Promise<void>{this.live(plan.generation);const ancestor=plan.capture.store.sealLocalSyncState({format:'1pass-ancestor-v1',entries});await jsonWrite(this.path(plan.channel,plan.target),{version:1,target:plan.target,lastSnapshotId:snapshotId,ancestor,at:new Date(this.now()).toISOString()} satisfies Baseline)}
 private async password(ch:VaultSyncChannel,body:Record<string,unknown>,kind:'encrypt'|'decrypt'):Promise<string>{const p=string(body[kind==='encrypt'?'encryptPassword':'decryptPassword'])??await this.config.getSecret(ch,kind);if(!p)throw new Error(kind==='encrypt'?'SYNC_ENCRYPT_PASSWORD_REQUIRED':'SYNC_DECRYPT_PASSWORD_REQUIRED');return p}
 private plan(input:Omit<Plan,'token'|'expires'|'generation'>):Plan{for(const [id,p]of this.plans)if(p.expires<=this.now())this.plans.delete(id);if(this.plans.size>=16){const id=this.plans.keys().next().value;if(id)this.plans.delete(id)}const p={...input,token:randomUUID(),expires:this.now()+TTL,generation:this.generation};this.plans.set(p.token,p);const timer=setTimeout(()=>{this.plans.delete(p.token);this.expiryTimers.delete(p.token)},TTL);timer.unref?.();this.expiryTimers.set(p.token,timer);return p}
 private async check(p:Plan):Promise<Capture>{this.live(p.generation);if(p.expires<=this.now())throw new Error('SYNC_PREVIEW_EXPIRED');if(await this.target(p.channel)!==p.target)throw new Error('SYNC_TARGET_CHANGED');const c=await this.capture(true);if(c.store!==p.capture.store||c.fingerprint!==p.capture.fingerprint||c.diskHash!==p.capture.diskHash)throw new Error('SYNC_LOCAL_CHANGED');return c}
 private async history():Promise<Array<Record<string,unknown>>>{if(!this.logEntries){const items=await jsonRead<unknown>(join(this.opts.stateDir,'history.json'));if(items!==undefined&&!Array.isArray(items))throw new Error('SYNC_LOCAL_STATE_INVALID');this.logEntries=(items??[]) as Array<Record<string,unknown>>}return this.logEntries}
 private async log(kind:string,ch:VaultSyncChannel,extra:Record<string,unknown>={}):Promise<void>{const entries=await this.history();entries.unshift({id:randomUUID(),createdAt:new Date(this.now()).toISOString(),kind,transport:ch,sectionCount:1,...extra});entries.length=Math.min(entries.length,200);await jsonWrite(join(this.opts.stateDir,'history.json'),entries)}
 private async status(detail=false):Promise<Record<string,unknown>>{
  const doc=await this.config.read(),view=await this.config.view(),autosync:Record<string,unknown>={},selection:Record<string,unknown>={},creds:Record<string,unknown>={};let hasBaseline=false
  for(const ch of CHANNELS){const s=doc.channels[ch],r=this.runtime[ch];creds[ch]={encryptPasswordConfigured:!!await this.config.getSecret(ch,'encrypt'),decryptPasswordConfigured:!!await this.config.getSecret(ch,'decrypt')};selection[ch]={transport:ch,...s.selection,...creds[ch] as object};autosync[ch]={...s.autosync,...r,elapsedMs:r.lastRunAt?Math.max(0,this.now()-Date.parse(r.lastRunAt)):0};if(ch===doc.active&&s.config)hasBaseline=!!await this.baseline(ch,await this.target(ch))}
  let workDir:unknown
  if(detail&&doc.channels.git.config){try{workDir={facts:await(await this.transport('git')).workdirFacts?.()}}catch{workDir={error:'工作副本检查未完成，请重试。'}}}
  return {...view,ok:true,hasBaseline,sectionCount:1,lastSyncChannel:doc.active,syncSections:[{id:'vault',displayName:'密码库',portability:'portable',defaultIncluded:true}],syncSelection:selection[doc.active],syncSelectionByChannel:selection,syncCredentialsByChannel:creds,autosync:autosync[doc.active],autosyncByChannel:autosync,...(workDir?{workDir}:{})}
 }
 private async pushPreview(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Record<string,unknown>>{
  if(!(await this.config.read()).channels[ch].selection.sections.includes('vault'))throw new Error('SYNC_SELECTION_EMPTY');const generation=this.generation,capture=await this.capture(),target=await this.target(ch),remote=await this.transport(ch),list=await remote.list(),base=await this.baseline(ch,target),doc=await this.config.read();this.live(generation)
  if(!doc.deviceId)throw new Error('SYNC_CONFIG_SAVE_REQUIRED')
  const snapshot=await sealSyncSnapshot(capture.entries,await this.password(ch,b,'encrypt'),{id:'sync-'+randomUUID(),createdAt:new Date(this.now()).toISOString(),transport:ch,vaultName:this.opts.vaultName,deviceId:doc.deviceId,deviceName:doc.deviceName})
  this.live(generation);const p=this.plan({capture,target,channel:ch,remoteHead:newest(list),remoteVersion:remoteVersion(list),snapshot});this.pushes.set(ch,p.token)
  return {ok:true,planId:p.token,sections:[{section:'vault',count:capture.entries.length,changed:syncHash(capture.entries)!==syncHash(this.ancestor(capture,base)??null)}],remoteSnapshotCount:list.length,encrypted:true,credentialsIncluded:false}
 }
 private async push(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Record<string,unknown>>{
  const token=string(b.planId),p=token?this.plans.get(token):undefined;if(!p?.snapshot||p.channel!==ch)throw new Error('SYNC_PUSH_PREVIEW_REQUIRED');if(p.result)return p.result
  const c=await this.check(p),remote=await this.transport(ch),list=await remote.list(),base=await this.baseline(ch,p.target)
  const published=list.find(meta=>meta.id===p.snapshot!.id);const acknowledged=published?.contentHash===p.snapshot.contentHash&&remoteVersion(list.filter(meta=>meta.id!==p.snapshot!.id))===p.remoteVersion
  if(!acknowledged&&(remoteVersion(list)!==p.remoteVersion||(list.length>0&&newest(list)!==base?.lastSnapshotId)))return {ok:false,snapshotId:'',sections:[],warnings:[],conflict:true,message:'远端已有尚未合并的快照，请先执行一键同步。'}
  this.live(p.generation);c.authorize();await remote.upload(p.snapshot,p.remoteVersion);this.live(p.generation)
  const warnings:string[]=[];try{const metas=await remote.list(),keepers=selectRetentionKeepers(metas,DEFAULT_RETENTION_POLICY);keepers.add(p.snapshot.id);for(const meta of metas){this.live(p.generation);c.authorize();if(!keepers.has(meta.id))await remote.delete(meta.id)}}catch{warnings.push('上传已完成，但旧快照清理未完成。')}try{await this.advance(p,p.snapshot.id,c.entries)}catch{warnings.push('上传已完成，但本机基准保存失败；请重新同步。')}
  await this.log('push',ch).catch(()=>warnings.push('同步日志保存失败。'));p.result={ok:true,snapshotId:p.snapshot.id,sections:['vault'],warnings};p.capture.entries=[];return p.result
 }
 private async prepare(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Plan|undefined>{
  if(!(await this.config.read()).channels[ch].selection.sections.includes('vault'))throw new Error('SYNC_SELECTION_EMPTY');const generation=this.generation,capture=await this.capture(),target=await this.target(ch),transport=await this.transport(ch),list=await transport.list();this.live(generation);if(!list.length)return undefined
  const id=string(b.snapshotId)??newest(list);if(!list.some(m=>m.id===id))throw new Error('SYNC_SNAPSHOT_NOT_FOUND')
  const remote=await transport.download(id),remoteEntries=await openSyncSnapshot(remote,await this.password(ch,b,'decrypt')),ancestor=this.ancestor(capture,await this.baseline(ch,target));this.live(generation)
  const merge=mergeVaultEntries(capture.entries,remoteEntries,ancestor)
  // Remote absence/trash is a destructive proposal, never an automatic credential deletion.
  for(const item of merge.items){if(item.local&&item.local.deletedAt===undefined&&(!item.remote||item.remote.deletedAt!==undefined)&&item.decision==='useRemote'){item.decision='conflict';item.conflicts=[{path:'',reason:'modify-delete'}];delete item.merged}}
  return this.plan({capture,target,channel:ch,remoteHead:newest(list),remoteVersion:remoteVersion(list),remote,remoteEntries,merge,hasAncestor:ancestor!==undefined})
 }
 private confirm(p:Plan):Array<Record<string,unknown>>{return p.merge!.items.filter(i=>i.decision!=='skip').map(i=>({itemId:'vault:'+i.id,adapter:'vault',kind:i.decision==='conflict'?'Conflict':!i.local?'Create':'Update',description:'密码库条目 '+i.id.slice(0,8),detail:i.decision==='conflict'?'两侧均有变更。机密值只在宿主内处理。':'根据共同基准比较条目变更。',severity:i.decision==='conflict'?'warning':'info',defaultAdopt:i.decision!=='conflict',adopt:i.decision!=='conflict',...(i.decision==='conflict'?{conflict:{path:i.id,kind:'key',local:'[机密值已隐藏]',remote:'[机密值已隐藏]',ancestor:p.hasAncestor?'[机密值已隐藏]':'无共同基准'}}:{})}))}
 private view(p:Plan):Record<string,unknown>{
  const changed=p.merge!.items.filter(i=>i.decision!=='skip'),conflicts=changed.filter(i=>i.decision==='conflict'),decision=conflicts.length?'conflict':!changed.length?'skip':changed.every(i=>i.decision==='keepLocal')?'keepLocal':changed.every(i=>i.decision==='useRemote')?'useRemote':'merge'
  return {ok:true,planId:p.token,snapshotId:p.remote!.id,hasAncestor:p.hasAncestor,sections:[{id:'vault',decision,autoMerged:changed.length-conflicts.length,conflictCount:conflicts.length,conflicts:conflicts.flatMap(i=>i.conflicts.map(c=>({path:i.id+'::'+c.path,kind:'key',reason:c.reason,localPreview:'[机密值已隐藏]',remotePreview:'[机密值已隐藏]',ancestorPreview:p.hasAncestor?'[机密值已隐藏]':'无共同基准'})))}],summary:{auto:changed.length-conflicts.length,review:conflicts.length?1:0,conflicts:conflicts.length,skipped:changed.length?0:1}}
 }
 private async mergePreview(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Record<string,unknown>>{const p=await this.prepare(ch,b);if(!p)return {ok:false,snapshotId:'',reason:'remote-empty',hasAncestor:false,sections:[],summary:{auto:0,review:0,conflicts:0,skipped:0},message:'远端尚无快照，请先推送。'};this.merges.set(ch,p.token);return this.view(p)}
 private async sync(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Record<string,unknown>>{const p=await this.prepare(ch,b);if(!p)return {ok:false,syncSessionId:'',snapshotId:'',items:[],needsReview:false,compatibility:'excellent',reason:'remote-empty',message:'远端尚无快照，请先推送。'};this.merges.set(ch,p.token);const items=this.confirm(p);return {ok:true,syncSessionId:p.token,snapshotId:p.remote!.id,items,needsReview:items.some(i=>i.kind==='Conflict'),compatibility:'excellent'}}
 private async apply(p:Plan,resolutions:Array<{id:string;action:'keepLocal'|'useRemote'|'useMerged'|'skip'}>):Promise<Record<string,unknown>>{
  const signature=canonical(resolutions);if(p.result){if(p.signature!==signature)throw new Error('SYNC_SELECTION_CHANGED');return p.result}
  const c=await this.check(p),remote=await this.transport(p.channel);if(remoteVersion(await remote.list())!==p.remoteVersion)throw new Error('SYNC_REMOTE_CHANGED')
  const result=resolveVaultMerge(p.merge!,resolutions),unadopted=resolutions.filter(r=>r.action==='skip'&&p.merge!.items.some(i=>i.id===r.id&&i.decision!=='skip')).map(r=>r.id),pending=[...new Set([...result.pending,...unadopted])]
  const restoreId='restore-'+randomUUID(),ciphertext=c.store.sealLocalSyncState({format:'1pass-rollback-v1',entries:c.entries,afterFingerprint:syncHash([...result.entries].sort((a,b)=>a.id.localeCompare(b.id)))})
  await jsonWrite(join(this.opts.stateDir,'rollback',restoreId+'.json'),{ciphertext});this.live(p.generation);c.authorize();this.suppress=true
  try{await c.store.replaceForSync(result.entries,c.fingerprint,()=>{this.live(p.generation);c.authorize()},c.diskHash)}finally{this.suppress=false}
  const warnings:string[]=[];if(!pending.length){try{await this.advance(p,p.remote!.id,p.remoteEntries!)}catch{warnings.push('密码库已写入，但同步基准保存失败；请重新预览。')}}
  await this.log('apply',p.channel,{reviewCount:pending.length}).catch(()=>warnings.push('同步日志保存失败。'))
  p.signature=signature;p.result={ok:true,applied:syncHash(result.entries)!==syncHash(c.entries)?['vault']:[],skipped:pending.length?['vault']:[],warnings,restoreId,rolledBack:false,rollbackFull:true,needsRestart:false,failed:[],ineffective:[],result:null,pendingConflicts:pending.length?['vault']:[]};p.capture.entries=[];return p.result
 }
 private async applyItems(b:Record<string,unknown>):Promise<Record<string,unknown>>{
  const id=string(b.syncSessionId),p=id?this.plans.get(id):undefined;if(!p?.merge)throw new Error('SYNC_PREVIEW_EXPIRED');if(!Array.isArray(b.adoptions)||b.adoptions.length>10000)throw new Error('SYNC_INVALID_SELECTION')
  const choices=new Map<string,Record<string,unknown>>();for(const raw of b.adoptions){const c=object(raw),id=string(c.itemId);if(!id||choices.has(id)||!p.merge.items.some(i=>'vault:'+i.id===id))throw new Error('SYNC_INVALID_SELECTION');choices.set(id,c)}
  const resolutions=p.merge.items.map(i=>{const c=choices.get('vault:'+i.id);if(!c||c.adopt!==true)return {id:i.id,action:'skip' as const};if(i.decision==='conflict'&&c.resolution!=='useRemote'&&c.resolution!=='keepLocal')throw new Error('SYNC_CONFLICT_RESOLUTION_REQUIRED');return {id:i.id,action:c.resolution==='useRemote'?'useRemote' as const:c.resolution==='keepLocal'?'keepLocal' as const:'useMerged' as const}})
  return this.apply(p,resolutions)
 }
 private async applyMerge(ch:VaultSyncChannel,b:Record<string,unknown>):Promise<Record<string,unknown>>{
  const token=string(b.planId),p=token?this.plans.get(token):undefined;if(!p?.merge||p.channel!==ch||(b.snapshotId!==undefined&&b.snapshotId!==p.remote?.id))throw new Error('SYNC_PREVIEW_EXPIRED')
  if(!Array.isArray(b.resolutions)||b.resolutions.length>10000)throw new Error('SYNC_INVALID_SELECTION');const choices=b.resolutions.map(object),allowed=['keepLocal','useRemote','useMerged','skip'];if(choices.some(c=>typeof c.id!=='string'||!allowed.includes(String(c.action))))throw new Error('SYNC_INVALID_SELECTION')
  const whole=choices.find(c=>c.id==='vault'),resolutions=whole?p.merge.items.map(i=>({id:i.id,action:whole.action as 'keepLocal'|'useRemote'|'useMerged'|'skip'})):choices.map(c=>({id:String(c.id).replace(/^vault::/,''),action:c.action as 'keepLocal'|'useRemote'|'useMerged'|'skip'}));return this.apply(p,resolutions)
 }
 private async rollback(b:Record<string,unknown>):Promise<Record<string,unknown>>{const id=string(b.restoreId);if(!id||!/^restore-[a-f0-9-]{36}$/.test(id))throw new Error('SYNC_ROLLBACK_INVALID');const c=await this.capture(true),data=await jsonRead<{ciphertext:string}>(join(this.opts.stateDir,'rollback',id+'.json'));if(!data)throw new Error('SYNC_ROLLBACK_NOT_FOUND');const saved=c.store.unsealLocalSyncState(data.ciphertext) as {format:string;entries:VaultEntry[];afterFingerprint:string};if(saved.format!=='1pass-rollback-v1'||syncHash([...c.entries].sort((a,b)=>a.id.localeCompare(b.id)))!==saved.afterFingerprint)throw new Error('SYNC_ROLLBACK_LOCAL_CHANGED');await c.store.replaceForSync(saved.entries,c.fingerprint,c.authorize,c.diskHash);this.plans.clear();await this.log('rollback',(await this.config.read()).active);return {ok:true,full:true,failed:[]}}
 private async snapshots(ch:VaultSyncChannel):Promise<Record<string,unknown>>{const list=await(await this.transport(ch)).list(),base=await this.baseline(ch,await this.target(ch));return {ok:true,snapshots:[...list].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(m=>({id:m.id,createdAt:m.createdAt,sectionCount:1,platform:m.manifest.platform,dshVersion:m.manifest.dshVersion,deviceName:m.manifest.deviceName,deviceId:m.manifest.deviceId})),...(base?{currentSnapshotId:base.lastSnapshotId}:{})}}
 notifyChange():void{if(this.disposed||this.suppress)return;if(this.debounce)clearTimeout(this.debounce);this.debounce=setTimeout(()=>{this.debounce=undefined;void this.config.read().then(doc=>{for(const ch of CHANNELS)if(doc.channels[ch].autosync.enabled&&doc.channels[ch].autosync.realtime)this.schedule(ch,'local')}).catch(()=>{})},600);this.debounce.unref?.()}
 private async schedules():Promise<void>{
  for(const t of this.timers)clearTimeout(t);this.timers=[];if(this.disposed)return
  const doc=await this.config.read()
  for(const ch of CHANNELS){const a=doc.channels[ch].autosync;if(!a.enabled)continue
   const interval=setInterval(()=>this.schedule(ch,'interval'),INTERVAL[a.interval]??1800000);interval.unref?.();this.timers.push(interval)
   if(a.realtime){const poll=setInterval(()=>this.schedule(ch,'remote'),a.remoteCheckMs);poll.unref?.();this.timers.push(poll)}
   const last=this.runtime[ch].lastRunAt?Date.parse(this.runtime[ch].lastRunAt!):0
   if(this.now()-last>=a.startupMinIntervalMs){const startup=setTimeout(()=>this.schedule(ch,'startup'),0);startup.unref?.();this.timers.push(startup)}
  }
 }
 private schedule(ch:VaultSyncChannel,reason:'startup'|'remote'|'interval'|'local'):void{
  if(this.disposed)return
  const old=this.pending.get(ch);if(old!=='local'&&old!=='interval'||reason==='local'||reason==='interval')this.pending.set(ch,reason)
  if(!this.running)void this.drain().catch(()=>{})
 }
 private async drain():Promise<void>{if(this.running||this.disposed||!this.pending.size)return;await this.exclusive(async()=>{while(this.pending.size&&!this.disposed){const [ch,reason]=this.pending.entries().next().value!;this.pending.delete(ch);await this.auto(ch,reason)}})}
 private async auto(ch:VaultSyncChannel,reason:'startup'|'remote'|'interval'|'local'):Promise<void>{
  const r=this.runtime[ch],at=new Date(this.now()).toISOString(),generation=this.generation;r.lastRunAt=at;delete r.lastRunSkipReason;delete r.lastRunMessage
  try{
   const state=(await this.config.read()).channels[ch];if(!state.autosync.enabled)return
   let c=await this.capture(true),target=await this.target(ch),base=await this.baseline(ch,target)
   if(!base){r.lastRunStatus='skipped';r.lastRunSkipReason='conflict';r.lastRunMessage='首次同步需要人工确认。';return}
   const list=await(await this.transport(ch)).list()
   if(newest(list)!==base.lastSnapshotId){
    const p=await this.prepare(ch,{});if(!p)return
    const conflicts=p.merge!.items.filter(i=>i.decision==='conflict')
    if(state.autosync.autoApplyTier==='low'||conflicts.length&&state.autosync.conflictPolicy==='ask'){r.lastRunStatus='skipped';r.lastRunSkipReason='conflict';return}
    // A local-wins policy is an explicit opt-in. It still merges nonconflicting remote fields.
    const choices=conflicts.map(i=>({id:i.id,action:'keepLocal' as const}))
    const applied=await this.apply(p,choices)
    if((applied.pendingConflicts as string[]|undefined)?.length){r.lastRunStatus='partial';r.lastRunSkipReason='conflict';return}
   }
   if(reason==='startup'||reason==='remote'){r.lastRunStatus='success';r.consecutiveFailures=0;return}
   c=await this.capture(true);base=await this.baseline(ch,await this.target(ch))
   if(syncHash(c.entries)===syncHash(this.ancestor(c,base)??null)){r.lastRunStatus='skipped';r.lastRunSkipReason='unchanged';return}
   const preview=await this.pushPreview(ch,{}),result=await this.push(ch,{planId:preview.planId})
   r.lastRunStatus=result.ok===true?'success':'skipped';if(result.ok!==true)r.lastRunSkipReason='conflict';r.consecutiveFailures=0
  }catch{r.lastRunStatus='failed';r.lastRunMessage='自动同步未完成；请解锁密码库并检查连接和同步密码。';r.consecutiveFailures++}
  finally{if(!this.disposed&&generation===this.generation)await this.log('autosync',ch,{autosync:{transport:ch,direction:reason==='startup'||reason==='remote'?'pull':'both',status:r.lastRunStatus??'skipped',failureCountAtRun:r.consecutiveFailures,createdAt:at,...(r.lastRunSkipReason?{skipReason:r.lastRunSkipReason}:{})}}).catch(()=>{})}
 }
 private async exclusive<T>(work:()=>Promise<T>):Promise<T>{if(this.running)throw new Error('SYNC_BUSY');const pending=Promise.resolve().then(work);this.running=pending;try{return await pending}finally{this.running=undefined;if(this.pending.size&&!this.disposed)queueMicrotask(()=>{void this.drain().catch(()=>{})})}}
 async call(action:string,payload?:unknown):Promise<unknown>{
  const work=this.perform(action,payload);this.calls.add(work)
  try{return await work}catch(error){const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';const safe:Record<string,string>={'git-failed':'SYNC_GIT_FAILED','index-conflict':'SYNC_GIT_PUSH_REJECTED','workdir-branch':'SYNC_GIT_BRANCH','workdir-busy':'SYNC_GIT_BUSY','workdir-dirty':'SYNC_GIT_DIRTY','unsafe-workdir':'SYNC_GIT_WORKDIR','invalid-config':'SYNC_CONFIG_INVALID','timeout':'SYNC_GIT_TIMEOUT','process-failed':'SYNC_GIT_UNAVAILABLE'};if(safe[code])throw new Error(safe[code]);throw error}finally{this.calls.delete(work)}
 }
 private async perform(action:string,payload?:unknown):Promise<unknown>{
  this.live();const epoch=this.authorityEpoch,b=object(payload),doc=await this.config.read(),ch=channel(b.transport,doc.active);if(this.disposed||epoch!==this.authorityEpoch)throw new Error('SYNC_SCOPE_CHANGED')
  const reads=new Set(['status','history','autosyncStatusAll','autosyncStatus','githubValidate','githubListRepositories','exportPreview','snapshotsList','pushPreview','pull','sync','mergePreview']);if(!reads.has(action)&&!['cancel','githubCancel'].includes(action))await this.authorizeRequest(epoch)
  switch(action){
   case 'status':return this.status(b.workDirDetail===true)
   case 'history':return {entries:await this.history()}
   case 'autosyncStatusAll':return (await this.status()).autosyncByChannel
   case 'autosyncStatus':return ((await this.status()).autosyncByChannel as Record<string,unknown>)[ch]
   case 'saveUiPrefs':await this.config.setUiChannel(channel(b.lastSyncChannel,doc.active));return {ok:true,lastSyncChannel:b.lastSyncChannel}
   case 'saveConfig':{const before=(await this.config.read()).channels[ch].config;const authField=ch==='git'?'token':ch==='webdav'?'password':'secret';const previousAuth=typeof b[authField]==='string'&&b[authField]!==''?await this.config.getSecret(ch,'auth'):undefined;const result=await this.config.saveConfig(b);const after=(await this.config.read()).channels[ch].config;const authChanged=typeof b[authField]==='string'&&b[authField]!==''&&b[authField]!==previousAuth;if(canonical(before??null)!==canonical(after??null)||authChanged)this.invalidatePreviews();if(authChanged&&ch==='git')this.github.revoke();await this.schedules();return result}
   case 'clearChannel':{const result=await this.config.clearChannel(ch);this.revoke();await this.schedules();return result}
   case 'saveSelection':{const before=(await this.config.read()).channels[ch].selection;const encryptBefore=await this.config.getSecret(ch,'encrypt'),decryptBefore=await this.config.getSecret(ch,'decrypt');const result=await this.config.saveSelection(b);const after=(await this.config.read()).channels[ch].selection;const secretChanged=(b.encryptPassword!==undefined&&b.encryptPassword!==encryptBefore)||(b.decryptPassword!==undefined&&b.decryptPassword!==decryptBefore)||(b.clearEncryptPassword===true&&encryptBefore!==undefined)||(b.clearDecryptPassword===true&&decryptBefore!==undefined);if(canonical(before)!==canonical(after)||secretChanged)this.invalidatePreviews();return result}
   case 'autosyncUpdate':await this.config.updateAutosync(b);this.invalidatePreviews();await this.schedules();return ((await this.status()).autosyncByChannel as Record<string,unknown>)[ch]
   case 'githubStart':return this.github.start()
   case 'githubPoll':return this.github.poll(String(b.flowId??''))
   case 'githubCancel':return this.github.cancel(String(b.flowId??''))
   case 'githubValidate':return this.github.validate()
   case 'githubListRepositories':return this.github.listRepositories()
   case 'githubCreateRepository':return this.github.createRepository(String(b.name??''),String(b.description??''))
   case 'probe':try{return {ok:true,transport:ch,...await(await this.transport(ch)).probe()}}catch{return {ok:false,error:'通道连接失败，请检查地址、权限和网络。'}}
   case 'exportPreview':{const c=await this.capture(),bytes=Buffer.byteLength(canonical(c.entries));return {ok:true,sections:[{section:'vault',count:c.entries.length,sizeBytes:bytes,items:[]}],totalSections:1,totalSizeBytes:bytes,sectionsFailed:0}}
   case 'pushPreview':return this.exclusive(()=>this.pushPreview(ch,b))
   case 'push':return this.exclusive(()=>this.push(ch,b))
   case 'sync':return this.exclusive(()=>this.sync(ch,b))
   case 'mergePreview':return this.exclusive(()=>this.mergePreview(ch,b))
   case 'pull':{const p=await this.prepare(ch,b);return p?{ok:true,snapshotId:p.remote!.id,changes:this.confirm(p).map(i=>({id:i.itemId,adapter:'vault',kind:i.kind,description:i.description,severity:i.severity})),needsReview:p.merge!.items.some(i=>i.decision==='conflict')}:{ok:false,snapshotId:'',changes:[],needsReview:false,message:'远端尚无快照，请先推送。'}}
   case 'applyItems':return this.exclusive(()=>this.applyItems(b))
   case 'applyMerge':return this.exclusive(()=>this.applyMerge(ch,b))
   case 'cancel':this.plans.delete(String(b.syncSessionId??''));return {ok:true}
   case 'rollback':return this.exclusive(()=>this.rollback(b))
   case 'snapshotsList':return this.snapshots(ch)
   case 'deleteSnapshot':{const id=string(b.snapshotId);if(!id)throw new Error('SYNC_INVALID_SNAPSHOT');await(await this.transport(ch)).delete(id);return {ok:true,snapshotId:id}}
   case 'download':{const id=string(b.snapshotId);if(!id||!/^sync-[a-f0-9-]{36}$/.test(id))throw new Error('SYNC_INVALID_SNAPSHOT');const snapshot=await(await this.transport(ch)).download(id),path=join(this.opts.stateDir,'downloads',id+'.json');await jsonWrite(path,snapshot);return {ok:true,zipPath:path,snapshotId:id}}
   case 'workdirReset':{const t=await this.transport('git');if(!t.resetWorkdir||!['relink','adopt','reclone'].includes(String(b.mode)))throw new Error('SYNC_WORKDIR_UNAVAILABLE');await t.resetWorkdir(b.mode as 'relink'|'adopt'|'reclone',b.confirm===true);return {ok:true,mode:b.mode,workDir:{facts:await t.workdirFacts?.()}}}
   case 'consult':{const id=string(b.snapshotId)??string(b.id);if(!id)throw new Error('SYNC_INVALID_SNAPSHOT');const list=await(await this.transport(ch)).list(),meta=list.find(item=>item.id===id);if(!meta)throw new Error('SYNC_SNAPSHOT_NOT_FOUND');return {source:{type:'remote-snapshot',id,snapshotId:id},healthScore:0,verdict:'needs-attention',recommendation:'review',blockerCount:0,attentionCount:1,recommendationReasons:['这是加密密码库快照。完整性与条目差异将在解锁后的同步预览中验证；此处不读取或展示密码。'],dimensions:[],willApply:{sections:['vault'],itemCount:0,conflicts:0,risks:0,overwritten:0,dryRun:true},bound:{snapshotId:id,sourceId:id},generatedAt:new Date(this.now()).toISOString()}}
   default:throw new Error('SYNC_UNKNOWN_ACTION')
  }
 }
 async dispose():Promise<void>{this.disposed=true;this.authorityEpoch++;this.generation++;this.config.revoke();this.abort.abort();for(const timer of this.expiryTimers.values())clearTimeout(timer);this.expiryTimers.clear();for(const t of this.timers)clearTimeout(t);this.timers=[];if(this.debounce)clearTimeout(this.debounce);this.pending.clear();await this.github.dispose();await Promise.allSettled([...this.calls]);await this.running?.catch(()=>{});this.plans.clear();this.pushes.clear();this.merges.clear()}
}
