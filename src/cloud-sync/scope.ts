/** Stable local sync directories; registry contains no secrets or vault entry data. */
import {createHash,randomUUID} from 'node:crypto'
import {readFile,mkdir,writeFile,rename,unlink,stat} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
interface Registry{version:1;paths:Record<string,string>}
const queues=new Map<string,Promise<unknown>>()
function key(path:string):string{const full=resolve(path);return createHash('sha256').update(process.platform==='win32'?full.toLowerCase():full).digest('hex').slice(0,24)}
function root(path:string):string{return join(dirname(resolve(path)),'onepass-sync')}
async function registry(path:string):Promise<Registry>{try{const bytes=await readFile(join(root(path),'scopes.json'));if(bytes.length>128*1024)throw new Error();const data=JSON.parse(bytes.toString('utf8')) as Registry;if(data.version!==1||!data.paths||typeof data.paths!=='object'||Array.isArray(data.paths)||Object.entries(data.paths).some(([k,v])=>!/^[a-f0-9]{24}$/.test(k)||typeof v!=='string'||!(/^[a-f0-9]{24}$/.test(v)||/^[a-f0-9-]{36}$/.test(v))))throw new Error();return data}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,paths:{}};throw new Error('SYNC_SCOPE_REGISTRY_INVALID')}}
async function save(path:string,data:Registry):Promise<void>{await mkdir(root(path),{recursive:true,mode:0o700});const file=join(root(path),'scopes.json'),temp=file+'.tmp-'+randomUUID();try{await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});await rename(temp,file)}finally{await unlink(temp).catch(()=>{})}}
export async function syncScopeDirectory(path:string):Promise<string>{const data=await registry(path);return join(root(path),data.paths[key(path)]??key(path))}
/** Commit only AFTER a successful vault rename/delete. The old state remains an encrypted safety artifact. */
export async function changeSyncScope(source:string,target?:string):Promise<void>{const r=root(source),previous=queues.get(r)??Promise.resolve();const work=previous.catch(()=>{}).then(async()=>{const data=await registry(source),from=key(source),id=data.paths[from]??from;if(target&&root(target)!==r)throw new Error('SYNC_SCOPE_CROSS_DIRECTORY');if(target){const dest=key(target),existing=data.paths[dest]??dest;try{await stat(join(r,existing,'sync-config.json'));throw new Error('SYNC_SCOPE_TARGET_CONFIGURED')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}data.paths[dest]=id}data.paths[from]=randomUUID();await save(source,data)});queues.set(r,work);try{await work}finally{if(queues.get(r)===work)queues.delete(r)}}
