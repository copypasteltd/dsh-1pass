// @vitest-environment jsdom
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {createElement} from 'react'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile,execFileSync} from 'node:child_process'
import {promisify} from 'node:util'
import {CloudSyncPanel} from '../src/client/CloudSyncPanel.tsx'
import {VaultCloudSync} from '../src/cloud-sync/controller.ts'
import {openVault} from '../src/store.ts'
import {createVaultSyncTransport} from '../src/cloud-sync/transports.ts'
import {en} from '../src/client/locales.ts'
import {vaultTranslations} from '../vendor/config-manager/src/client/vault-translations.ts'
import {toastStore} from '../vendor/config-manager/src/client/common/toast-store.ts'
const tr=vaultTranslations(()=> 'en')
const synthetic='synthetic-connected-encryption'
const roots:string[]=[]
const controllers:VaultCloudSync[]=[]
const lockers:Array<()=>Promise<void>>=[]
function git(cwd:string,...args:string[]):string{return execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'}}).trim()}
function port(){const map=new Map<string,string>();return {get:async(ref:string)=>map.get(ref),has:async(ref:string)=>map.has(ref),set:async(ref:string,value:string)=>{map.set(ref,value)},unset:async(ref:string)=>{map.delete(ref)}}}
beforeEach(()=>{sessionStorage.clear();localStorage.clear();window.matchMedia=vi.fn().mockImplementation(()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent(){return true}}))})
afterEach(async()=>{cleanup();toastStore.clear();for(const c of controllers.splice(0))await c.dispose();for(const lock of lockers.splice(0))await lock();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:75});vi.restoreAllMocks()})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'vault-connected-ui-'));roots.push(root)
 const remote=join(root,'remote.git');git(root,'init','--bare','--initial-branch=trunk',remote)
 const store=await openVault({path:join(root,'local.json'),masterPassword:'synthetic-local-key'});lockers.push(()=>store.lock())
 await store.add({title:'Synthetic connected item',password:'SYNTHETIC-ENTRY-NOT-A-CREDENTIAL'})
 const service=new VaultCloudSync({stateDir:join(root,'sync-a'),vaultName:'synthetic-connected',secrets:port(),context:async()=>({store,authorize(){}}),transport:(config,stateDir,signal,getSecret)=>createVaultSyncTransport({config,stateDir,signal,credentials:{getSecret},allowLocalGitForTests:true,timeoutMs:15000})});controllers.push(service)
 const calls:Array<{action:string;transport:unknown}> = []
 const call=async(action:string,payload?:unknown)=>{calls.push({action,transport:(payload as {transport?:unknown}|undefined)?.transport});return service.call(action,payload)}
 return {root,remote,store,service,call,calls}
}
async function setupThroughRealForm(remote:string){
 await screen.findByText(tr.syncT('history.empty'))
 fireEvent.click(screen.getAllByRole('button',{name:tr.syncT('channel.open')})[0]!)
 let dialog=await screen.findByRole('dialog')
 fireEvent.change(within(dialog).getByRole('textbox',{name:tr.syncT('config.repoUrl')}),{target:{value:remote}})
 // The normal default namespace field is deliberately EMPTY, exactly like the live first-use form.
 expect((within(dialog).getByRole('textbox',{name:tr.syncT('config.gitSubdir')}) as HTMLInputElement).value).toBe('')
 await waitFor(()=>expect(within(dialog).getAllByRole('button',{name:tr.syncT('common.close')})[0]!).toBeTruthy(),{timeout:6000})
 await waitFor(()=>expect((within(dialog).getAllByRole('button',{name:tr.syncT('common.close')})[0]! as HTMLButtonElement).disabled).toBe(false),{timeout:6000})
 // Close normally; action handlers must flush pending configuration rather than racing its timer.
 fireEvent.click(within(dialog).getAllByRole('button',{name:tr.syncT('common.close')})[0]!)
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull(),{timeout:6000})
 const password=await screen.findByLabelText(tr.syncT('mode.password'))
 fireEvent.change(password,{target:{value:synthetic}})
 let confirm:HTMLElement;try{confirm=await screen.findByLabelText(tr.syncT('mode.passwordConfirm'),{},{timeout:5000})}catch(error){console.error('CONNECTED_FIELDS',JSON.stringify([...document.querySelectorAll<HTMLInputElement>('input')].map(input=>({label:input.getAttribute('aria-label'),type:input.type,length:input.value.length}))),document.querySelector('[data-push-blocked]')?.textContent);throw error}fireEvent.change(confirm,{target:{value:synthetic}})
 // Click without blur: push itself must persist matching password fields and await configuration.
}
test('actual Git configuration form enables Push, previews, confirms an encrypted commit, and a second device syncs it',async()=>{
 const f=await fixture()
 render(createElement(CloudSyncPanel,{t:key=>en[key],cloudSyncCall:f.call,readonly:false,locked:false,unavailable:false,vaultName:'synthetic-connected'}))
 await setupThroughRealForm(f.remote)
 const push=screen.getByRole('button',{name:'Push to remote'}) as HTMLButtonElement
 await waitFor(()=>{const current=screen.queryByRole('button',{name:'Push to remote'}) as HTMLButtonElement|null;expect(current!==null&&!current.disabled,JSON.stringify({block:document.querySelector('[data-push-blocked]')?.textContent,dialogs:screen.queryAllByRole('dialog').map(d=>d.getAttribute('aria-labelledby')),buttons:screen.queryAllByRole('button').map(b=>b.textContent),calls:f.calls,fields:[...document.querySelectorAll<HTMLInputElement>('input[type=password]')].map(input=>({label:input.getAttribute('aria-label'),length:input.value.length,disabled:input.disabled}))})).toBe(true)},{timeout:5000})
 fireEvent.click(push)
 const preview=await screen.findByRole('dialog',{name:tr.syncT('syncflow.pushPreviewTitle')},{timeout:20000})
 expect(preview.textContent).not.toContain('SYNTHETIC-ENTRY-NOT-A-CREDENTIAL')
 expect(git(f.root,'--git-dir',f.remote,'for-each-ref','--format=%(refname)','refs/heads')).toBe('')
 fireEvent.click(within(preview).getByRole('button',{name:tr.syncT('syncflow.pushConfirm')}))
 await waitFor(async()=>{const result=await promisify(execFile)('git',['--git-dir',f.remote,'for-each-ref','--format=%(refname)','refs/heads'],{cwd:f.root,encoding:'utf8',windowsHide:true});expect(result.stdout).toContain('refs/heads/trunk')},{timeout:30000,interval:150})
 const tree=git(f.root,'--git-dir',f.remote,'ls-tree','-r','--name-only','trunk')
 expect(tree).toContain('1pass/index.json')
 const index=git(f.root,'--git-dir',f.remote,'show','trunk:1pass/index.json')
 expect(index).not.toContain('SYNTHETIC-ENTRY-NOT-A-CREDENTIAL')
 expect(f.calls.filter(c=>c.action==='pushPreview'||c.action==='push').map(c=>c.transport)).toEqual(['git','git'])
 const otherStore=await openVault({path:join(f.root,'other.json'),masterPassword:'synthetic-other-key'});lockers.push(()=>otherStore.lock())
 const other=new VaultCloudSync({stateDir:join(f.root,'sync-b'),vaultName:'other',secrets:port(),context:async()=>({store:otherStore,authorize(){}}),transport:(config,stateDir,signal,getSecret)=>createVaultSyncTransport({config,stateDir,signal,credentials:{getSecret},allowLocalGitForTests:true,timeoutMs:15000})});controllers.push(other)
 await other.call('saveConfig',{transport:'git',repoUrl:f.remote})
 await other.call('saveSelection',{transport:'git',mode:'advanced',sections:['vault'],encrypt:true,includeSecrets:false,encryptPassword:synthetic,decryptPassword:synthetic})
 const sync=await other.call('sync',{transport:'git'}) as {ok:boolean;syncSessionId:string;items:Array<{itemId:string}>}
 expect(sync.ok).toBe(true)
 await other.call('applyItems',{syncSessionId:sync.syncSessionId,adoptions:sync.items.map(i=>({itemId:i.itemId,adopt:true}))})
 expect(otherStore.list()[0]?.password).toBe('SYNTHETIC-ENTRY-NOT-A-CREDENTIAL')
 const saved=await readFile(join(f.root,'sync-a','sync-config.json'),'utf8')
 expect(saved).not.toContain(synthetic)
},60000)
