import { expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as VaultPlugin from '../src/index.ts'
import { openVault } from '../src/store.ts'
import { DEFAULT_QUICK_IMPORT_FORMAT } from '../src/quick-import.ts'
const options={format:DEFAULT_QUICK_IMPORT_FORMAT,kind:'ssh' as const}
const raw='root@192.0.2.10:22|SYNTHETIC-PRIVATE-IMPORT-PWD|demo\nroot@192.0.2.11:2200|1|other\nbad row'
async function fixture(run:(g:VaultPlugin.VaultGateway,ctx:Context,path:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'quick-import-gateway-'));const path=join(dir,'vault.json');const ctx=new Context()
  try {
    await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
    await ctx.plugin(VaultPlugin,{path,masterPassword:'synthetic-gateway-password',accessMode:'auto',tools:'full'})
    await run(ctx.get('vault') as VaultPlugin.VaultGateway,ctx,path)
  }finally{ctx.registry.delete(VaultPlugin);ctx.registry.delete(ToolRuntime);ctx.registry.delete(SystemPrompt);VaultPlugin.resetVaultSwitch();await rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:50})}
}
test('preview exposes metadata only; confirmed valid rows persist in one encrypted batch',async()=>{
  await fixture(async(g,ctx,path)=>{
    const before=await g.list()
    const p=await g.previewQuickImport(raw,options)
    expect(p.valid).toBe(2);expect(p.invalid).toBe(1)
    expect(JSON.stringify(p)).not.toContain('SYNTHETIC-PRIVATE-IMPORT-PWD')
    expect((await g.list()).entries).toEqual(before.entries)
    await expect(g.commitQuickImport(p.token,[1,3],true)).rejects.toThrow(/INVALID_SELECTION/)
    const result=await g.commitQuickImport(p.token,[1,2],true)
    expect(result.added).toBe(2);expect(result.skipped).toBe(0)
    expect(await g.commitQuickImport(p.token,[2,1],true)).toEqual(result)
    expect((await g.list()).entries).toHaveLength(2)
    const first=(await g.list()).entries.find(e=>e.title==='demo')!
    const full=await g.get(first.id)
    expect(full.entry).toMatchObject({kind:'ssh',sshAuth:'password',host:'192.0.2.10',port:'22',username:'root',password:'SYNTHETIC-PRIVATE-IMPORT-PWD',tags:['demo']})
    expect(await readFile(path,'utf8')).not.toContain('SYNTHETIC-PRIVATE-IMPORT-PWD')
    expect(ctx.tools.schemas().some(s=>/quickImport/i.test(s.name))).toBe(false)
  })
})
test('readonly and lock changes invalidate write authority after preview',async()=>{
  await fixture(async g=>{
    const p=await g.previewQuickImport(raw,options)
    await g.setAccessMode('readonly')
    await expect(g.commitQuickImport(p.token,[1],true)).rejects.toThrow(/readonly|EXPIRED/)
    await g.setAccessMode('auto');await g.lock()
    await expect(g.previewQuickImport(raw,options)).rejects.toThrow(/locked/)
    await expect(g.commitQuickImport(p.token,[1],true)).rejects.toThrow(/locked|EXPIRED/)
    await g.unlock()
    await expect(g.commitQuickImport(p.token,[1],true)).rejects.toThrow(/EXPIRED/)
    expect((await g.list()).entries).toHaveLength(0)
  })
})
test('switching active vault cannot commit a preview into a different vault',async()=>{
  await fixture(async(g,_ctx,path)=>{
    const p=await g.previewQuickImport(raw,options)
    const otherPath=join(dirname(path),'other.json')
    const other=await openVault({path:otherPath,masterPassword:'synthetic-gateway-password'});await other.lock()
    await g.switchVault('other')
    await expect(g.commitQuickImport(p.token,[1],true)).rejects.toThrow(/VAULT_CHANGED|EXPIRED/)
    expect((await g.list()).entries).toHaveLength(0)
  })
})
test('duplicates created after preview are skipped without overwriting their password',async()=>{
  await fixture(async g=>{
    const p=await g.previewQuickImport(raw,options)
    const existing=await g.add({title:'Already here',kind:'ssh',username:'root',host:'192.0.2.10',port:'22',password:'EXISTING-SYNTHETIC'})
    const result=await g.commitQuickImport(p.token,[1,2],true)
    expect(result).toMatchObject({added:1,skipped:1})
    expect((await g.get(existing.id)).entry?.password).toBe('EXISTING-SYNTHETIC')
  })
})
test('new SSH certificate fields remain encrypted and never leak in summaries',async()=>{
  await fixture(async(g,_ctx,path)=>{
    const added=await g.add({title:'Certificate fixture',kind:'ssh',sshAuth:'certificate',username:'root',host:'host.example',ip:'192.0.2.20',port:'22',privateKey:'SYNTHETIC-PRIVATE-KEY',certificate:'SYNTHETIC-CERTIFICATE',keyPassphrase:'SYNTHETIC-KEY-PASSPHRASE'})
    expect(JSON.stringify(await g.list())).not.toMatch(/SYNTHETIC-PRIVATE-KEY|SYNTHETIC-KEY-PASSPHRASE|SYNTHETIC-CERTIFICATE/)
    expect((await g.get(added.id)).entry).toMatchObject({sshAuth:'certificate',ip:'192.0.2.20',keyPassphrase:'SYNTHETIC-KEY-PASSPHRASE',certificate:'SYNTHETIC-CERTIFICATE'})
    const reopened=await openVault({path,masterPassword:'synthetic-gateway-password'})
    expect(reopened.get(added.id)?.keyPassphrase).toBe('SYNTHETIC-KEY-PASSPHRASE');await reopened.lock()
    expect(await readFile(path,'utf8')).not.toContain('SYNTHETIC-KEY-PASSPHRASE')
  })
})

test('GUI templates persist only field names, never accidental actual secret values',async()=>{
  await fixture(async(g,_ctx,path)=>{
    await g.saveTemplate('synthetic-ssh','ssh',{host:'host.example',password:'SYNTHETIC-PASSWORD',privateKey:'SYNTHETIC-KEY',certificate:'SYNTHETIC-CERT',keyPassphrase:'SYNTHETIC-PASSPHRASE',notes:'SYNTHETIC-NOTES'})
    const file=await readFile(join(dirname(path),'templates.json'),'utf8')
    expect(file).not.toMatch(/SYNTHETIC-PASSWORD|SYNTHETIC-KEY|SYNTHETIC-CERT|SYNTHETIC-PASSPHRASE|SYNTHETIC-NOTES|host\.example/)
    const t=(await g.templates()).find(t=>t.name==='synthetic-ssh')!
    expect(t.fields).toMatchObject({host:'host',password:'password',privateKey:'privateKey',certificate:'certificate',keyPassphrase:'keyPassphrase'})
    await g.setAccessMode('readonly')
    await expect(g.saveTemplate('no','ssh',{host:'secret'})).rejects.toThrow(/readonly/)
  })
})
