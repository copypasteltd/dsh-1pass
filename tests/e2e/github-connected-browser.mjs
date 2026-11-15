/** QA only: real browser clicks -> actual controller -> temporary bare Git; no external server/profile. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createFixture, syntheticPassword } from '../../lib/github-connected-qa/github-connected-host.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'lib/github-connected-qa')
await mkdir(output, { recursive: true })
const bundle = await readFile(join(output, 'github-connected-ui.js'), 'utf8')
const manifest = { protocol: 'actual-CloudSyncPanel-binding-controller-configstore-local-bare-Git', generatedAt: new Date().toISOString(), scope: 'Standalone synthetic headless Chrome; not a live GitHub authentication or production GUI proof.', bundleSha256: createHash('sha256').update(bundle).digest('hex'), actions: [], network: [], pageErrors: [], results: {}, cleanup: {} }
let fixture, browser, context, page
const nativeFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('External HTTP is forbidden in connected browser QA') }
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}body{font-family:system-ui,sans-serif;color:#202124;background:#fafafa;--dsw-font-family:system-ui,sans-serif;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#62666d;--dsw-alias-label-tertiary:#707780;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-specific-input-major:#f4f5f7;--dsw-alias-border-l1:#dedfe3;--dsw-alias-border-l2:#d0d2d8;--dsw-alias-interactive-bg-hover:#f0f1f4;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-business-primary:#4d7ee8;--dsw-alias-button-info-fill:#356dca;--dsw-alias-button-info-hover:#285caf;--dsw-alias-state-success-primary:#237d4e;--dsw-alias-state-warn-primary:#996409;--dsw-alias-state-error-primary:#bf3d3d;--dsw-alias-bg-mask-1:rgba(0,0,0,.45);--dsw-radius-xs:4px;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px}#root{width:564px;height:900px;margin:auto;position:relative;overflow:hidden}</style><div id="root"></div></html>'
try {
  fixture = await createFixture()
  console.log('QA_HOST_FIXTURE_READY')
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  context = await browser.newContext({ viewport: { width: 760, height: 940 }, reducedMotion: 'reduce', serviceWorkers: 'block', locale: 'en-US' })
  await context.route('**/*', async route => {
    const request = route.request()
    if (request.isNavigationRequest() && request.url() === 'https://github-connected.invalid/') { manifest.network.push({ kind: 'in-memory-document' }); return route.fulfill({ contentType: 'text/html', body: html }) }
    manifest.network.push({ kind: 'blocked', url: request.url() }); return route.abort()
  })
  page = await context.newPage()
  page.on('pageerror', error => manifest.pageErrors.push(error.message))
  await page.exposeBinding('__githubConnectedHost', async (_source, action, payload) => {
    const item = { action, status: 'pending' }; manifest.actions.push(item)
    try { const result = await fixture.call(action, payload); item.status = 'complete'; return result }
    catch (error) { item.status = 'failed'; item.error = error.message; throw error }
  })
  await page.goto('https://github-connected.invalid/')
  await page.addScriptTag({ content: bundle })
  await page.waitForFunction(() => window.__githubConnectedQA)
  const labels = await page.evaluate(() => window.__githubConnectedQA.labels)
  await page.getByText(labels['history.empty'], { exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: labels['channel.open'], exact: true }).first().click()
  const config = page.getByRole('dialog')
  await config.waitFor()
  await config.getByRole('textbox', { name: labels['config.repoUrl'], exact: true }).fill(fixture.remote)
  assert.equal(await config.getByRole('textbox', { name: labels['config.gitSubdir'], exact: true }).inputValue(), '')
  await config.getByRole('button', { name: labels['common.close'], exact: true }).first().click()
  await config.waitFor({ state: 'hidden', timeout: 15000 })
  const push = page.getByRole('button', { name: 'Push to remote', exact: true })
  await push.waitFor()
  assert.equal(await push.isDisabled(), true, 'First-use push must explain the missing encryption password')
  const blocked = page.locator('[data-push-blocked]')
  await blocked.waitFor({ timeout: 10000 })
  manifest.results.firstUse = { disabled: true, reason: await blocked.innerText(), emptySubdir: true }
  await push.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, '01-missing-password.png'), animations: 'disabled' })
  await page.getByLabel(labels['mode.password'], { exact: true }).fill(syntheticPassword)
  await page.getByLabel(labels['mode.passwordConfirm'], { exact: true }).fill(syntheticPassword)
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Push to remote' && !button.disabled), null, { timeout: 15000 })
  await push.click()
  const preview = page.getByRole('dialog', { name: labels['syncflow.pushPreviewTitle'], exact: true })
  await preview.waitFor({ timeout: 30000 })
  manifest.results.preview = await fixture.inspect()
  assert.equal(manifest.results.preview.snapshotCount, 0, 'Preview must not write the remote')
  await page.screenshot({ path: join(output, '02-push-preview.png'), animations: 'disabled' })
  await preview.getByRole('button', { name: labels['syncflow.pushConfirm'], exact: true }).click()
  await page.waitForFunction(() => window.__githubConnectedQA.calls.some(call => call.action === 'push' && call.status === 'complete'), null, { timeout: 30000 })
  manifest.results.confirmed = await fixture.inspect()
  assert.equal(manifest.results.confirmed.snapshotCount, 1)
  assert.equal(manifest.results.confirmed.savedBlankSubdir, true)
  manifest.results.secondDevice = await fixture.verifySecondDevice()
  await page.screenshot({ path: join(output, '03-confirmed-push.png'), animations: 'disabled' })
  assert.deepEqual(manifest.actions.filter(action => action.action === 'pushPreview' || action.action === 'push').map(action => action.action), ['pushPreview', 'push'])
  assert.equal(manifest.pageErrors.length, 0)
  assert.equal(manifest.network.filter(item => item.kind === 'blocked').length, 0)
  manifest.results.pass = true
  console.log('QA_REAL_CLICK_PUSH_AND_SECOND_DEVICE_PASS')
} catch (error) {
  manifest.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error)
  if (page) { await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {}); await writeFile(join(output, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable')) }
} finally {
  try { if (context) { await context.close(); manifest.cleanup.contextClosed = true } } finally { if (browser) { await browser.close(); manifest.cleanup.browserClosed = true } }
  if (fixture) { manifest.commands = fixture.commands; await fixture.dispose(); manifest.cleanup.temporaryFixtureRemoved = true }
  globalThis.fetch = nativeFetch
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ pass: manifest.results.pass ?? false, failure: manifest.failure?.message ?? null, cleanup: manifest.cleanup, output }))
}
