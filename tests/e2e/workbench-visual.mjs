/** Synthetic offline visual fixture. No user profile or service connection. */
import { chromium } from 'playwright-core'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await readFile(join(root, 'lib/cloud-preview/workbench.js'), 'utf8')
const output = join(root, 'lib/cloud-preview')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
  await context.route('**/*', async route => {
    if (route.request().isNavigationRequest() && route.request().url().startsWith('https://onepass.test/')) await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#fafafa;color:#202124;font-family:system-ui}#root{box-sizing:border-box;width:min(564px,100vw);height:720px;margin:24px auto;background:white;border:1px solid #ddd;border-radius:12px;overflow:hidden;--dsw-font-family:system-ui;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#62666d;--dsw-alias-label-tertiary:#707780;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:white;--dsw-alias-border-l1:#dedfe3;--dsw-alias-border-l2:#dedfe3;--dsw-alias-border-l4:#d0d2d8;--dsw-specific-input-major:#f4f5f7;--dsw-alias-interactive-bg-hover:#f0f1f4;--dsw-alias-state-business-primary:#356dca;--dsw-alias-button-info-fill:#356dca;--dsw-alias-button-info-hover:#285caf;--dsw-alias-label-primary-foreground:white;--dsw-alias-state-success-primary:#279258;--dsw-alias-state-warn-primary:#b97b0e;--dsw-alias-state-error-primary:#bf3d3d}</style><div id="root"></div>' })
    else await route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  async function render(query='') { await page.goto('https://onepass.test/'+query); await page.addScriptTag({ content: bundle }); await page.getByRole('tab', { name: '首页', exact: true }).waitFor() }
  await render()
  await page.getByText('Example account', { exact:true }).first().waitFor()
  await page.screenshot({ path: join(output,'workbench-home.png') })
  await page.getByRole('tab', { name:'密码簿',exact:true }).click()
  await page.screenshot({ path: join(output,'workbench-entries.png') })
  await page.getByRole('button',{name:'命令面板',exact:true}).click()
  await page.getByRole('dialog',{name:'命令面板',exact:true}).waitFor()
  await page.screenshot({ path:join(output,'workbench-commands.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('tab',{name:'云备份',exact:true}).click()
  await page.getByRole('heading',{name:'加密云备份',exact:true}).waitFor()
  await page.screenshot({path:join(output,'workbench-cloud.png')})
  await page.setViewportSize({width:390,height:844})
  const overflow = await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)
  await page.screenshot({path:join(output,'workbench-mobile.png')})
  await render('?first=1')
  await page.getByLabel('主密码',{exact:true}).waitFor()
  await page.screenshot({path:join(output,'workbench-setup.png')})
  await page.close(); await context.close()
  if(errors.length||overflow)throw new Error(JSON.stringify({errors,overflow}))
  console.log(JSON.stringify({rendered:true,network:'blocked',overflow,shots:6}))
}finally{await browser.close()}
