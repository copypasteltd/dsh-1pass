/** QA-only, offline original/full-wrapper render comparison. Run after the scoped tsdown build. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'lib/cloud-sync-visual')
await mkdir(output, { recursive: true })
const bundle = await readFile(join(output, 'cloud-sync.js'), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originalCSS = await readFile(join(root, '.references/dsh-config-manager/src/client/config-manager.module.css'))
const vendorCSS = await readFile(join(root, 'vendor/config-manager/src/client/config-manager.module.css'))
const sourceHashes = Object.fromEntries(await Promise.all(['src/client/CloudSyncPanel.tsx', 'src/client/VaultSection.module.css', 'tests/e2e/cloud-sync-render.tsx', 'tests/e2e/cloud-sync.config.ts', 'tests/e2e/cloud-sync-visual.mjs'].map(async path => [path, hash(await readFile(join(root, path)))])))
assert.equal(hash(originalCSS), hash(vendorCSS), 'Original CSS must remain byte-identical')

// Synthetic host token values on BODY (the native tokens are body-scoped, not :root).
// Identical, explicit values on both sides; this is not a capture of the running host theme.
function html(theme) {
  const dark = theme === 'dark'
  return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    'html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:system-ui,sans-serif;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);' +
    '--dsw-font-family:system-ui,sans-serif;--dsw-alias-label-primary:' + (dark?'#e8eaf0':'#202124') + ';' +
    '--dsw-alias-label-secondary:' + (dark?'#b6bdcc':'#62666d') + ';--dsw-alias-label-tertiary:' + (dark?'#9aa5b8':'#707780') + ';' +
    '--dsw-alias-bg-base:' + (dark?'#191d26':'#ffffff') + ';--dsw-alias-bg-layer-1:' + (dark?'#191d26':'#fafafa') + ';' +
    '--dsw-alias-bg-layer-2:' + (dark?'#242a36':'#ffffff') + ';--dsw-specific-input-major:' + (dark?'#1d2430':'#f4f5f7') + ';' +
    '--dsw-alias-border-l1:' + (dark?'#3b4354':'#dedfe3') + ';--dsw-alias-border-l2:' + (dark?'#4c576c':'#d0d2d8') + ';' +
    '--dsw-alias-interactive-bg-hover:' + (dark?'#303b50':'#f0f1f4') + ';--dsw-alias-label-primary-foreground:#ffffff;' +
    '--dsw-alias-state-business-primary:#4d7ee8;--dsw-alias-button-info-fill:#356dca;--dsw-alias-button-info-hover:#285caf;' +
    '--dsw-alias-state-success-primary:' + (dark?'#60c68d':'#237d4e') + ';--dsw-alias-state-warn-primary:' + (dark?'#e9b85d':'#996409') + ';' +
    '--dsw-alias-state-error-primary:' + (dark?'#ef8c8c':'#bf3d3d') + ';--dsw-alias-bg-mask-1:rgba(0,0,0,.45);' +
    '--dsw-radius-xs:4px;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px;' +
    '}#root{width:min(564px,100vw);height:720px;margin:auto;position:relative;overflow:hidden}' +
    '@media(max-width:400px){#root{height:min(720px,100vh)}}' +
    '</style><div id="root"></div></html>'
}
// Dependency-free exact PNG decoder for Chromium screenshots (8-bit RGB/RGBA).
function pixels(png) {
  let width, height, color, at=8; const chunks=[]
  while(at<png.length){const n=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+n);at+=12+n
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);color=data[9];assert.ok(color===2||color===6)}
    if(type==='IDAT')chunks.push(data)
  }
  const bpp=color===6?4:3, stride=width*bpp, raw=inflateSync(Buffer.concat(chunks)), decoded=Buffer.alloc(width*height*bpp)
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
  for(let y=0,pos=0;y<height;y++){const filter=raw[pos++];for(let x=0;x<stride;x++){
    const a=x>=bpp?decoded[y*stride+x-bpp]:0,b=y?decoded[(y-1)*stride+x]:0,c=y&&x>=bpp?decoded[(y-1)*stride+x-bpp]:0
    decoded[y*stride+x]=(raw[pos++]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255
  }}
  return {width,height,bpp,data:decoded}
}
function pixelDiff(a,b){
  const x=pixels(a),y=pixels(b);assert.equal(x.width,y.width);assert.equal(x.height,y.height)
  let changed=0,maxDelta=0,minX=x.width,minY=x.height,maxX=-1,maxY=-1;const tiles={}
  for(let i=0;i<x.width*x.height;i++){let delta=0;for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(x.data[i*x.bpp+c]-y.data[i*y.bpp+c]));if(!delta)continue
    changed++;maxDelta=Math.max(maxDelta,delta);const px=i%x.width,py=Math.floor(i/x.width);minX=Math.min(minX,px);minY=Math.min(minY,py);maxX=Math.max(maxX,px);maxY=Math.max(maxY,py)
    const tile=Math.floor(px/64)+','+Math.floor(py/64);tiles[tile]=(tiles[tile]??0)+1
  }
  return {changed,total:x.width*x.height,percent:100*changed/(x.width*x.height),maxDelta,bounds:changed?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null,tiles}
}
async function dom(page){return page.locator('#root').evaluate(root=>{
  const all=[root,...root.querySelectorAll('*')],round=n=>Math.round(n*100)/100
  return all.filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(e).visibility!=='hidden'}).map(e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e)
    return {tag:e.tagName.toLowerCase(),classes:[...e.classList].map(c=>c.slice(c.lastIndexOf('_') + 1)).sort(),role:e.getAttribute('role'),label:e.getAttribute('aria-label'),text:[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim(),value:'value'in e?e.value:null,disabled:'disabled'in e?e.disabled:null,checked:'checked'in e?e.checked:null,rect:[r.x,r.y,r.width,r.height].map(round),font:s.font,bg:s.backgroundColor,color:s.color,border:s.borderRadius}
  })
})}
function compareDOM(a,b){const details=[];for(let i=0;i<Math.max(a.length,b.length);i++){if(JSON.stringify(a[i])!==JSON.stringify(b[i]))details.push({index:i,reference:a[i],vault:b[i]})}return{equal:!details.length,referenceNodes:a.length,vaultNodes:b.length,differenceCount:details.length,details}}
const matrix=[
 ...['zh','en'].flatMap(lang=>['light','dark'].map(theme=>({name:'unconfigured-'+lang+'-'+theme,lang,theme,width:564}))),
 {name:'mobile-zh-light',lang:'zh',theme:'light',width:390},
 {name:'mobile-en-dark',lang:'en',theme:'dark',width:390},
 ...['git','webdav','s3','gist'].map((channel,index)=>({name:'dialog-'+channel,lang:'zh',theme:'light',width:564,dialog:index})),
 {name:'configured-git',lang:'zh',theme:'light',width:564,configured:true},
 {name:'configured-security',lang:'zh',theme:'light',width:564,configured:true,security:true},
 {name:'merge-conflict',lang:'zh',theme:'light',width:564,configured:true,merge:true},
 {name:'push-preview',lang:'zh',theme:'light',width:564,configured:true,push:true},
 {name:'embedded-ancestor',lang:'zh',theme:'light',width:564,embedded:true},
]
const results=[],errors=[],network=[];let context,browser
const manifest={protocol:'original-full-SyncPanel-same-labels-and-data',generatedAt:new Date().toISOString(),scope:'Synthetic standalone; not host-shell or cloud integration verification.',commands:['npx --no-install tsdown --config tests/e2e/cloud-sync.config.ts','node tests/e2e/cloud-sync-visual.mjs'],css:{reference:hash(originalCSS),vendor:hash(vendorCSS),byteIdentical:originalCSS.equals(vendorCSS)},bundle:hash(bundle),sourceHashes,pixelMethod:'Exact RGB pixels from PNG, zero tolerance, no masks or exclusions',domMethod:'Rendered #root tree with nonzero geometry and CSS visibility (including offscreen/clipped nodes); CSS module hash prefix normalized; unstable id/aria-controls omitted; labels, text, control state, geometry, font, foreground and background retained',results,errors,network}
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.DSH_TEST_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'})
  context=await browser.newContext({viewport:{width:564,height:720},reducedMotion:'reduce',serviceWorkers:'block',locale:'zh-CN'})
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(request.isNavigationRequest()&&url.origin==='https://cloud-sync.invalid'){network.push({kind:'in-memory-document',path:url.pathname+url.search});await route.fulfill({contentType:'text/html',body:html(url.searchParams.get('theme'))})}else{network.push({kind:'blocked',url:request.url()});await route.abort()}})
  for(const state of matrix){
    const sides={}
    for(const side of ['reference','vault']){
      const page=await context.newPage();page.on('pageerror',error=>errors.push({state:state.name,side,message:error.message}))
      try{
        await page.setViewportSize({width:state.width,height:720})
        await page.goto('https://cloud-sync.invalid/?'+new URLSearchParams({side,lang:state.lang,theme:state.theme,configured:state.configured?'1':'0',embedded:state.embedded?'1':'0'}))
        await page.addScriptTag({content:bundle})
        await page.getByRole('button',{name:state.lang==='en'?'Configure':'配置',exact:true}).first().waitFor({timeout:8000})
        await page.waitForFunction(()=>window.__cloudSyncQA?.calls.some(c=>c.action==='githubValidate'))
        if(state.dialog!==undefined){await page.getByRole('button',{name:'配置',exact:true}).nth(state.dialog).click();await page.getByRole('dialog').waitFor()}
        if(state.security){await page.locator('[class$="_shellMain"]').evaluate(el=>{el.scrollTop=550; if(el.scrollTop<=0||getComputedStyle(el).overflowY!=='auto') throw new Error('Expected real shell scroll container')})}
        if(state.merge){await page.getByRole('button',{name:'从远端合并到本机',exact:true}).click();await page.getByRole('dialog').waitFor()}
        if(state.push){await page.getByRole('button',{name:'推送到远端',exact:true}).click();await page.getByRole('dialog').waitFor()}
        await page.mouse.move(state.width-1,719)
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        const name=state.name+'-'+side,shot=await page.screenshot({path:join(output,name+'.png'),animations:'disabled'})
        const tree=await dom(page),qa=await page.evaluate(()=>window.__cloudSyncQA),bounds=await page.locator('#root').boundingBox()
        assert.equal(qa.unexpected.length,0,'Unexpected fake-port request')
        assert.equal(bounds.width,state.width);assert.equal(bounds.height,720)
        assert.equal(await page.locator(side==='vault'?'[data-vault-cloud-sync]':'[data-reference-cloud-sync]').count(),1)
        assert.equal(await page.getByRole('heading',{name:/加密云备份|Encrypted cloud backup/}).count(),0,'No legacy local/cloud-backup fixture block')
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)
        const visibleText=await page.locator('#root').innerText()
        await writeFile(join(output,name+'.dom.json'),JSON.stringify({tree,bounds,overflow,qa,visibleText},null,2))
        sides[side]={shot,tree,qa,overflow,artifact:name+'.png'}
      }finally{await page.close()}
    }
    const pixels=pixelDiff(sides.reference.shot,sides.vault.shot),domResult=compareDOM(sides.reference.tree,sides.vault.tree)
    await writeFile(join(output,state.name+'.comparison.json'),JSON.stringify({pixels,dom:domResult},null,2))
    if (!state.configured) { assert.equal(pixels.changed, 0, state.name + ': exact pixel parity'); if (!state.embedded) assert.equal(domResult.equal, true, state.name + ': normalized DOM/geometry parity') }
    const modalA=sides.reference.tree.findIndex(n=>n.role==='dialog'),modalB=sides.vault.tree.findIndex(n=>n.role==='dialog')
    const modal=modalA>=0&&modalB>=0?compareDOM(sides.reference.tree.slice(modalA),sides.vault.tree.slice(modalB)):null
    if(modal)await writeFile(join(output,state.name+'.modal-comparison.json'),JSON.stringify(modal,null,2))
    results.push({modal:modal?{...modal,details:undefined}:undefined,state:state.name,viewport:{width:state.width,height:720},pixels,dom:{...domResult,details:undefined},overflow:{reference:sides.reference.overflow,vault:sides.vault.overflow},artifacts:[sides.reference.artifact,sides.vault.artifact,state.name+'.comparison.json'],calls:{reference:sides.reference.qa.calls.map(c=>c.action),vault:sides.vault.qa.calls.map(c=>c.action)}})
    console.log(JSON.stringify({state:state.name,pixelChanged:pixels.changed,pixelPercent:pixels.percent,domEqual:domResult.equal,domDifferences:domResult.differenceCount}))
  }
  assert.equal(errors.length,0,'Browser page errors')
  assert.equal(network.filter(n=>n.kind==='blocked').length,0,'No UI HTTP request should escape the fake API port')
} catch(error){manifest.failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error)}
finally{
  try { if(context)await context.close() } finally { if(browser)await browser.close() }
  manifest.cleanup={contextClosed:!!context,browserClosed:!!browser}
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2))
  console.log(JSON.stringify({artifactDirectory:output,states:results.length,errors:errors.length,failure:manifest.failure?.message??null,cleanup:manifest.cleanup}))
}
