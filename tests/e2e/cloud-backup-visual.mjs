/** Offline visual verification of the cloud panel; does not run DSH or any cloud API. */
import { chromium } from 'playwright-core'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await readFile(join(root, 'lib/cloud-preview/cloud.js'), 'utf8')
const output = join(root, 'lib/cloud-preview')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // All navigation is fulfilled in-memory; all other network requests are blocked.
  await context.route('**/*', async route => {
    if (route.request().isNavigationRequest() && route.request().url().startsWith('https://cloud-backup.test/')) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:#f5f6f8;color:#1f2328}body{margin:0;padding:32px;font-family:system-ui,sans-serif}#root{max-width:1100px;margin:auto}</style><div id="root"></div>' })
    } else await route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('https://cloud-backup.test/?lang=zh')
  await page.addScriptTag({ content: bundle })
  await page.getByRole('heading', { name: '加密云备份', exact: true }).waitFor()
  await page.getByLabel('GitHub 所有者').waitFor().catch(async () => { await page.locator('input[value="example"]').waitFor() })
  await page.screenshot({ path: join(output, 'cloud-backup-desktop.png'), fullPage: true })
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addStyleTag({ content: 'body{padding:12px}' })
  await page.screenshot({ path: join(output, 'cloud-backup-mobile.png'), fullPage: true })
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  await page.addStyleTag({ content: ':root{--dsw-alias-label-primary:#f0f3f7;--dsw-alias-label-secondary:#b6c0cf;--dsw-alias-label-tertiary:#a3adbb;--dsw-alias-background-primary:#171c25;--dsw-alias-background-secondary:#212935;--dsw-alias-border-l2:#455166}html{background:#171c25;color:#f0f3f7}' })
  await page.screenshot({ path: join(output, 'cloud-backup-dark.png'), fullPage: true })
  await page.close()
  await context.close()
  if (errors.length || desktopOverflow || mobileOverflow) throw new Error(JSON.stringify({ errors, desktopOverflow, mobileOverflow }))
  console.log(JSON.stringify({ rendered: true, network: 'blocked/in-memory only', desktopOverflow, mobileOverflow, screenshots: ['cloud-backup-desktop.png', 'cloud-backup-mobile.png', 'cloud-backup-dark.png'] }))
} finally { await browser.close() }
