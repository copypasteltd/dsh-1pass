import{expect,test}from'vitest'
import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises'
import{join}from'node:path'
import{tmpdir}from'node:os'
import{syncScopeDirectory,changeSyncScope}from'../src/cloud-sync/scope.ts'
test('vault rename preserves channel slots/baseline directory; delete/recreate revokes old opt-in',async()=>{const dir=await mkdtemp(join(tmpdir(),'sync-scope-'));try{const a=join(dir,'a.json'),b=join(dir,'b.json'),before=await syncScopeDirectory(a);await mkdir(before,{recursive:true});await writeFile(join(before,'sync-config.json'),'synthetic-no-secrets');await changeSyncScope(a,b);expect(await syncScopeDirectory(b)).toBe(before);expect(await syncScopeDirectory(a)).not.toBe(before);await changeSyncScope(b);expect(await syncScopeDirectory(b)).not.toBe(before)}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50})}})
