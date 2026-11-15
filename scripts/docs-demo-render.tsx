/** SYNTHETIC DOCUMENTATION FIXTURE. Actual production UI, no host bridge or HTTP APIs.
 * Every value is invented; no profile/vault/credential/transport is read or contacted.
 * Mutations below only change this disposable document's in-memory arrays.
 */
import { createRoot } from 'react-dom/client'
import { VaultWorkbench } from '../src/client/VaultWorkbench.tsx'
import type { VaultSectionProps, VaultFullWire } from '../src/client/VaultSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as syncEn, zh as syncZh } from '../vendor/config-manager/src/client/sync/sync-locales.ts'
import type { SyncStatusResponse, MergePreviewResponse, AutosyncStatusResponse, SyncSelectionPayload } from '../vendor/config-manager/src/client/sync/sync-api.ts'
import type { SyncPushPreview } from '../vendor/config-manager/src/sync/sync-engine.ts'
const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh'
const cn = lang === 'zh', stamp = 1794672000000
const calls: string[] = []
let locked=false, vault='demo-vault'
let config = { accessMode:'ask', autoCapture:false, autoLockSeconds:300, toolProfile:'full', toolGroups:['core','management','transfer','sessions'] }
let entries: VaultFullWire[] = [
 {id:'demo-login', title:'demo-account',kind:'login',username:'demo-user',url:'https://example.com',password:'DEMO ONLY — not a credential',tags:['demo','work'],createdAt:stamp,updatedAt:stamp,passwordStrength:84} as VaultFullWire,
 {id:'demo-server',title:'demo-server',kind:'ssh',sshAuth:'password',host:'192.0.2.10',port:'22',username:'demo-user',password:'DEMO ONLY — not a credential',tags:['demo','ssh'],createdAt:stamp,updatedAt:stamp} as VaultFullWire,
 {id:'demo-api',title:'demo-api',kind:'api-key',apiKey:'DEMO ONLY — no usable key',url:'https://example.com/api',tags:['demo'],createdAt:stamp,updatedAt:stamp} as VaultFullWire,
 {id:'demo-card',title:'demo-card',kind:'card',cardHolder:'DEMO HOLDER',cardExpiry:'12/2030',cardNumber:'0000 0000 0000 0000',cardCvv:'000',tags:['demo'],createdAt:stamp,updatedAt:stamp} as VaultFullWire,
]
let trashed = [{id:'demo-trash-restore',title:'demo-restore',kind:'login',username:'demo-user',tags:['demo']},{id:'demo-trash-purge',title:'demo-purge',kind:'secret',tags:['demo']}]
let backupRows=[{path:'demo-vault.backup.synthetic.json',at:stamp,vaultName:vault,size:2048}]
let openSessions: Array<{sessionId:string;url:string;openedAt:number}>=[]
let savedSessions: Array<{id:string;title:string;url:string;cookieCount:number;updatedAt:number}>=[]
const summary=(e:VaultFullWire)=>{const {password,privateKey,certificate,keyPassphrase,apiKey,secret,accessToken,refreshToken,otpSecret,cardNumber,cardCvv,...safe}=e;return safe}
const channels=['git','webdav','s3','gist'] as const
const auto=():AutosyncStatusResponse=>({enabled:false,interval:'15m',realtime:false,remoteCheckMs:60000,autoApplyTier:'medium',conflictPolicy:'ask',consecutiveFailures:0,elapsedMs:0})
const selection=(transport:typeof channels[number]):SyncSelectionPayload=>({transport,mode:'advanced',sections:['vault'],encrypt:true,includeSecrets:false,encryptPasswordConfigured:true,decryptPasswordConfigured:true})
const cloud:SyncStatusResponse={ok:true,configured:true,hasBaseline:true,credentialConfigured:true,credentialWritable:true,repoUrl:'https://example.com/demo-vault.git',sectionCount:1,transport:{type:'git',ref:'demo'},lastSyncChannel:'git',webdav:{url:'',username:'',usernameConfigured:false,passwordConfigured:false},syncSections:[{id:'vault',displayName:cn?'密码库':'Password vault',portability:'portable',defaultIncluded:true}],syncSelectionByChannel:Object.fromEntries(channels.map(ch=>[ch,selection(ch)])) as SyncStatusResponse['syncSelectionByChannel'],autosyncByChannel:Object.fromEntries(channels.map(ch=>[ch,auto()])) as SyncStatusResponse['autosyncByChannel'],syncCredentialsByChannel:Object.fromEntries(channels.map(ch=>[ch,{encryptPasswordConfigured:true,decryptPasswordConfigured:true}])) as SyncStatusResponse['syncCredentialsByChannel']}
const merge:MergePreviewResponse & {planId:string}={ok:true,planId:'synthetic-merge-plan',snapshotId:'synthetic-snapshot',hasAncestor:true,sections:[{id:'vault',decision:'conflict',conflictCount:1,conflicts:[{path:'vault',kind:'file',reason:'both-modified',localPreview:'[SYNTHETIC LOCAL]',remotePreview:'[SYNTHETIC REMOTE]',ancestorPreview:'[SYNTHETIC BASE]'}]}],summary:{auto:0,review:0,conflicts:1,skipped:0}}
const push:SyncPushPreview & {planId:string}={ok:true,planId:'synthetic-push-plan',sections:[{section:'vault',count:entries.length,changed:true}],remoteSnapshotCount:0,encrypted:true,credentialsIncluded:false}
async function cloudSyncCall(action:string,payload?:unknown):Promise<unknown>{calls.push('cloud:'+action);switch(action){
 case 'status':return structuredClone(cloud)
 case 'githubValidate':return {ok:true,configured:true,valid:true,login:'demo-user'}
 case 'githubListRepositories':return {ok:true,repos:[]}
 case 'history':return {entries:[]}
 case 'snapshotsList':return {snapshots:[],unreadable:[]}
 case 'autosyncStatusAll':return cloud.autosyncByChannel
 case 'autosyncStatus':return auto()
 case 'saveUiPrefs':return {ok:true,...payload as object}
 case 'saveSelection':return payload
 case 'saveConfig':return {ok:true,configured:true,transport:'git',credentialConfigured:true}
 case 'autosyncUpdate':return {...auto(),...payload as object}
 case 'mergePreview':return structuredClone(merge)
 case 'pushPreview':return structuredClone(push)
 case 'push':return {ok:true,snapshotId:'synthetic-pushed-snapshot',sections:['vault'],warnings:[]}
 case 'mergeApply':return {ok:true,applied:['vault'],skipped:[]}
 default:throw new Error('Unimplemented synthetic cloud action: '+action)
}}
const api = {
 t:(key:keyof typeof en)=>(cn?zh:en)[key],
 setupStatus:async()=>({configured:true,exists:true}),openWithPassword:async()=>({locked:false,entries:entries.length}),
 config:async()=>({...config}),setAccessMode:async(accessMode:string)=>(config={...config,accessMode}),setAutoCapture:async(autoCapture:boolean)=>(config={...config,autoCapture}),setAutoLock:async(seconds:number)=>{config.autoLockSeconds=seconds;return {seconds}},setToolProfile:async(toolProfile:string,toolGroups=config.toolGroups)=>{config={...config,toolProfile,toolGroups};return {...config,tools:42}},
 list:async()=>entries.map(summary),search:async(q:string)=>entries.filter(e=>JSON.stringify(summary(e)).toLowerCase().includes(q.toLowerCase())).map(summary),get:async(id:string)=>({found:true,entry:entries.find(e=>e.id===id)}),add:async(p:VaultFullWire)=>{const e={...p,id:'demo-created-'+entries.length,createdAt:stamp,updatedAt:stamp};entries.push(e);return summary(e)},update:async(id:string,p:object)=>{const e=entries.find(e=>e.id===id);Object.assign(e??{},p);return {found:!!e,entry:e&&summary(e)}},
 remove:async(id:string)=>{entries=entries.filter(e=>e.id!==id);return {deleted:true}},trash:async()=>trashed,restore:async(id:string)=>{trashed=trashed.filter(e=>e.id!==id);return {restored:true}},purge:async(id:string)=>{trashed=trashed.filter(e=>e.id!==id);return {purged:true}},undeleteAll:async()=>{const restored=trashed.length;trashed=[];return {restored}},
 status:async()=>({locked,entries:entries.length}),lock:async()=>({locked:locked=true}),unlock:async()=>({locked:locked=false}),listVaults:async()=>[{name:vault,active:true},{name:'demo-archive',active:false}],switchVault:async(name:string)=>({switched:true,name:vault=name}),vaultRename:async(from:string,to:string)=>({renamed:true,from,to,vaults:[{name:to,active:true}],note:'Synthetic only'}),vaultDelete:async()=>({deleted:false,active:vault,vaults:[{name:vault,active:true}],note:'Synthetic only'}),
 stats:async()=>({total:entries.length,byKind:{login:1,ssh:1,'api-key':1,card:1},withTotp:0,trashCount:trashed.length}),recent:async()=>entries.map(summary),history:async()=>[{action:'add',title:'demo-account',at:stamp},{action:'update',title:'demo-server',at:stamp-60000},{action:'backup',title:'demo-vault',at:stamp-120000}],
 health:async()=>({weak:[{id:'demo-server',title:'demo-server',score:28}],reused:[],no2fa:[{id:'demo-login',title:'demo-account'}],httpSites:[],score:82,verdict:'good',strength:{weak:1,fair:0,strong:3}}),duplicates:async()=>({groups:0}),duplicateGroups:async()=>[],watchtower:async()=>[{id:'demo-server',title:'demo-server',kind:'ssh',flags:['weak'],score:28,verdict:'weak'}],rotation:async()=>[],verifyAll:async()=>[],breachCheck:async()=>({checked:entries.length,pwned:[],weak:[],offline:true}),
 tags:async()=>[{name:'demo',count:4},{name:'ssh',count:1}],generatorHistory:async()=>[],generatePassword:async()=>({password:'DEMO ONLY — not a credential'}),generateUsername:async()=>({username:'demo-user'}),strength:async()=>({score:84,verdict:'strong',feedback:'Synthetic estimate',bits:64}),touch:async()=>({touched:true}),setFavorite:async()=>({found:true}),attachments:async()=>({found:true,attachments:[]}),passwordHistory:async()=>[],
 templates:async()=>[{name:'builtin:login',kind:'login',fields:{}},{name:'builtin:totp',kind:'totp',fields:{}},{name:'builtin:ssh-password',kind:'ssh-password',fields:{}},{name:'builtin:ssh-certificate',kind:'ssh-certificate',fields:{}},{name:'builtin:api-key',kind:'api-key',fields:{}},{name:'builtin:card',kind:'card',fields:{}}],
 backupStatus:async()=>({daysSinceBackup:1,backups:backupRows.length}),backups:async()=>backupRows,backup:async()=>{backupRows=[{path:'demo-vault.backup.new.synthetic.json',at:stamp,vaultName:vault,size:2048},...backupRows];return {path:backupRows[0]!.path,kept:backupRows.length,pruned:0}},deleteBackup:async(path:string)=>{backupRows=backupRows.filter(e=>e.path!==path);return {deleted:true,path}},restoreBackup:async()=>({entries:4,safetyBackup:'demo-safety.synthetic.json',note:'SYNTHETIC'}),
 recoveryStatus:async()=>({set:true,issuedAt:stamp}),recoveryCode:async()=>({code:'DEMO ONLY — NOT A RECOVERY CODE',note:'Synthetic only'}),verifyRecovery:async()=>({verified:true}),
 previewQuickImport:async()=>({token:'synthetic-preview',expiresAt:Date.now()+300000,vaultName:vault,rows:[{line:1,title:'demo-server-import',username:'demo-user',host:'192.0.2.20',port:'22',tags:['demo'],hasPassword:true,status:'ready'},{line:2,title:'demo-server',username:'demo-user',host:'192.0.2.10',port:'22',tags:['demo'],hasPassword:true,status:'duplicate'}],valid:1,invalid:0,duplicates:1,ignored:0}),commitQuickImport:async()=>{entries.push({id:'demo-import',title:'demo-server-import',kind:'ssh',host:'192.0.2.20',username:'demo-user',port:'22',tags:['demo']});return {added:1,skipped:0,lines:[{line:1,status:'added'}],note:'QUICK_IMPORT_COMPLETE'}},discardQuickImport:async()=>({discarded:true}),
 sessionListOpen:async()=>openSessions,sessionListSaved:async()=>savedSessions,sessionOpen:async(url:string)=>{const s={sessionId:'demo-browser-window',url,openedAt:stamp};openSessions=[s];return s},sessionCollect:async()=>({cookies:[{name:'demo-cookie',value:'SYNTHETIC-NOT-VALID',domain:'example.com',path:'/',secure:true,httpOnly:true,expires:-1}],count:1}),sessionSave:async(o:{title:string;url:string})=>{savedSessions=[{id:'demo-session',title:o.title,url:o.url,cookieCount:1,updatedAt:stamp}];return {saved:1,id:'demo-session'}},sessionClose:async()=>{openSessions=[];return {closed:true}},sessionGet:async()=>({id:'demo-session',title:'demo-session',url:'https://example.com',cookies:[{name:'demo-cookie',domain:'example.com',value:'SYNTHETIC-NOT-VALID',path:'/',expires:-1}]}),
 cloudSyncCall,
} as unknown as VaultSectionProps
;(window as unknown as {__docsDemo:unknown}).__docsDemo={synthetic:true,lang,calls,labels:cn?zh:en,cloudLabels:cn?syncZh:syncEn}
createRoot(document.getElementById('root')!).render(<VaultWorkbench {...api} />)
