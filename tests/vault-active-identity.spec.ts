// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest'
import {createElement} from 'react'
import {cleanup,render,screen,waitFor} from '@testing-library/react'
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {VaultGateway,resetVaultSwitch} from '../src/index.ts'
import {VaultWorkbench} from '../src/client/VaultWorkbench.tsx'
import {workbenchFixture} from './fixtures/workbench-ui.ts'
import {en} from '../src/client/locales.ts'
import {vaultTranslations} from '../vendor/config-manager/src/client/vault-translations.ts'
const tr=vaultTranslations(()=> 'en')
afterEach(()=>{cleanup();sessionStorage.clear();localStorage.clear();vi.restoreAllMocks()})
async function fixture(run:(g:VaultGateway,root:string)=>Promise<void>,config:Record<string,unknown>={}){
 const root=await mkdtemp(join(tmpdir(),'vault-active-identity-')),ctx=new Context(),previous=process.env.DSH_HOME
 process.env.DSH_HOME=root;resetVaultSwitch()
 try{
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
  const cfg={masterPassword:'synthetic-identity-local',accessMode:'auto',...config}
  if(cfg.path==='CUSTOM')cfg.path=join(root,'vault','custom.json')
  await ctx.plugin(VaultGateway,cfg)
  await run(ctx.get('vault') as VaultGateway,root)
 }finally{
  cleanup();ctx.registry.delete(VaultGateway);ctx.registry.delete(ToolRuntime);ctx.registry.delete(SystemPrompt);resetVaultSwitch()
  if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50})
 }
}
test('omitted name identifies default as the single active vault, including locked state',async()=>fixture(async g=>{
 await g.add({title:'Synthetic default'})
 let roster=await g.listVaults();expect(roster.filter(v=>v.active).map(v=>v.name)).toEqual(['default'])
 await g.lock();roster=await g.listVaults();expect(roster.filter(v=>v.active).map(v=>v.name)).toEqual(['default'])
}))
test('an unopened existing default vault still has one active identity without password attempts',async()=>fixture(async(g,root)=>{
 const {openVault}=await import('../src/store.ts')
 const path=join(root,'vault','default.json')
 const existing=await openVault({path,masterPassword:'synthetic-existing-key'})
 await existing.add({title:'Synthetic unopened item'});await existing.lock()
 const before=await readFile(path,'utf8')
 const roster=await g.listVaults()
 expect(roster).toEqual([{name:'default',active:true}])
 expect(await readFile(path,'utf8')).toBe(before)
 const {existsSync}=await import('node:fs')
 expect(existsSync(join(root,'vault','meta.json'))).toBe(false)
},{masterPassword:''}))

test('explicit path identifies the actual file even when configured name differs',async()=>fixture(async g=>{
 await g.add({title:'Synthetic custom path'})
 expect((await g.listVaults()).filter(v=>v.active).map(v=>v.name)).toEqual(['custom'])
},{path:'CUSTOM',name:'not-the-file'}))
test('default then named switch keeps exactly one truthful active row and preserves separate entries',async()=>fixture(async g=>{
 await g.add({title:'Synthetic default'})
 await g.switchVault('work');await g.add({title:'Synthetic work'})
 expect((await g.listVaults()).filter(v=>v.active).map(v=>v.name)).toEqual(['work'])
 await g.switchVault('default')
 expect((await g.listVaults()).filter(v=>v.active).map(v=>v.name)).toEqual(['default'])
 expect((await g.list()).entries.map(e=>e.title)).toEqual(['Synthetic default'])
}))
test('actual unnamed Gateway feeds UI current identity and does not block cloud page',async()=>fixture(async(g,root)=>{
 await g.add({title:'Synthetic connected identity'})
 const {props}=workbenchFixture()
 window.matchMedia=vi.fn().mockImplementation(()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent(){return true}}))
 // Only the unrelated cloud history/status view is synthetic: access identity/status/policy/list are actual Gateway methods.
 const cloud=vi.fn(async(action:string)=>action==='status'?{ok:true,configured:false,credentialConfigured:false,credentialWritable:true,sectionCount:1,syncSections:[{id:'vault',displayName:'Password vault',portability:'portable',defaultIncluded:true}]}:action==='history'?{entries:[]}:action==='githubValidate'?{ok:true,valid:false}:{ok:true})
 const before=await readFile(join(root,'vault','default.json'),'utf8')
 render(createElement(VaultWorkbench,{...props,setupStatus:()=>g.setupStatus(),status:()=>g.status(),config:()=>g.config(),listVaults:()=>g.listVaults(),list:()=>g.list().then(r=>r.entries),cloudSyncCall:cloud}))
 await screen.findByText('Synthetic connected identity')
 const {fireEvent}=await import('@testing-library/react')
 fireEvent.click(screen.getByRole('tab',{name:en.wbBackup}))
 await screen.findByText(tr.syncT('history.empty'),{},{timeout:7000})
 expect(screen.queryByRole('alert')).toBeNull()
 expect(cloud.mock.calls.some(([action])=>action==='status')).toBe(true)
 expect(await readFile(join(root,'vault','default.json'),'utf8')).toBe(before)
},{}),20000)
