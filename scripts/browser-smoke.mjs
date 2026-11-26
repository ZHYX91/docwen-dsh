// Optional installed-release UI test. Install Playwright and a Chromium browser in the test environment.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { unzipSync, strFromU8 } from 'fflate'
import { withInstalledHost } from './host-smoke.mjs'

const { chromium } = createRequire(import.meta.url)('playwright')

async function openFixture(page, sessionId) {
  const row = page.locator('[data-row-key="session:' + sessionId + '"]')
  const folded = page.locator('[data-row-key^="workspace:"][aria-expanded="false"]').first()
  await row.or(folded).first().waitFor()
  if (!await row.isVisible() && await folded.isVisible()) await folded.click()
  await row.click()
  await page.getByRole('button', { name: 'Export Word…', exact: true }).waitFor({ state: 'attached' })
}

async function openPanel(page) {
  const toggle = page.locator('[data-session-panel-toggle]:visible')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.getByRole('heading', { name: 'DocWen', exact: true }).waitFor()
  await page.getByLabel('Local files').waitFor({ state: 'visible' })
}

async function runFromButton(page, sessionId, button) {
  const matches = request => {
    const url = new URL(request.url())
    return request.method() === 'POST' && /^\/api\/docwen-dsh(?:\/upload)?$/.test(url.pathname)
      && url.searchParams.get('action') === 'run' && url.searchParams.get('sessionId') === sessionId
  }
  // The UI should dispatch promptly; Core gets its own five-minute task deadline.
  const [, response] = await Promise.all([
    page.waitForRequest(matches),
    page.waitForResponse(response => matches(response.request()), { timeout: 305000 }),
    button.click(),
  ])
  const result = await response.json()
  assert.ok(response.ok(), 'DocWen run returned HTTP ' + response.status() + ': ' + String(result.error ?? '').slice(0, 500))
  assert.match(result.id, /^[a-zA-Z0-9_-]+$/, 'A completed task must return its saved result ID')
  return result.id
}

async function downloadZip(page, link) {
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  assert.equal(await download.failure(), null, 'Browser download failed')
  return unzipSync(new Uint8Array(await readFile(await download.path())))
}

async function checkBrowser(host) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }),
    ...(process.env.CHROMIUM_ARGS_JSON && { args: JSON.parse(process.env.CHROMIUM_ARGS_JSON) }) })
  let step = 'connecting to the installed DSH'
  let page
  try {
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
    page.setDefaultTimeout(30000)
    const notice = page.getByRole('button', { name: 'Continue', exact: true })
    await page.addLocatorHandler(notice, () => notice.click())
    const later = page.getByRole('button', { name: 'Configure later', exact: true })
    await page.addLocatorHandler(later, () => later.click())
    const signIn = page.getByRole('dialog').filter({ has: page.getByText('Get started', { exact: true }) })
    await page.addLocatorHandler(signIn, () => signIn.getByRole('button', { name: 'Close', exact: true }).click())
    await page.goto(host.entryUrl)
    await openFixture(page, host.sessionId)
    step = 'exporting the historical reply with a discovered template'
    const action = page.getByRole('button', { name: 'Export Word…', exact: true })
    await action.click()
    const dialog = page.getByRole('dialog', { name: 'Export reply to Word' })
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.ok(await action.evaluate(element => document.activeElement === element), 'Escape must return focus to the reply action')
    await action.click()
    await dialog.getByText('Source Markdown and referenced images', { exact: true }).click()
    assert.match(await dialog.locator('pre').innerText(), /historic reply/i)
    await dialog.getByLabel('Template', { exact: true }).selectOption({ index: 1 })
    const exportId = await runFromButton(page, host.sessionId, dialog.getByRole('button', { name: 'Export Word', exact: true }))
    const exported = dialog.locator('[role=status] a[download][href*="resultId=' + exportId + '"]').filter({ hasText: /\.docx$/i })
    const docx = await downloadZip(page, exported)
    assert.equal(Object.keys(docx).filter(p => p.startsWith('word/media/')).length, 2)
    assert.match(strFromU8(docx['word/document.xml']), /historic reply/i)
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('Browser: historical reply and two images exported through a discovered template.')

    step = 'executing /docwen without a model'
    const editor = page.locator('[contenteditable=true][role=textbox]:visible')
    await editor.fill('/docwen help')
    await editor.press('End')
    await editor.press('Enter')
    await page.getByText(/discover operations, options and templates/).first().waitFor({ state: 'visible' })
    console.log('Browser: /docwen help returned the command help in the conversation.')

    step = 'importing DOCX from the session panel'
    await openPanel(page)
    await page.getByLabel('Local files').setInputFiles(host.docxPath)
    await page.getByRole('combobox', { name: /^Operation/ }).selectOption('convert.docx.to_markdown')
    const importId = await runFromButton(page, host.sessionId, page.getByRole('button', { name: 'Run', exact: true }))
    const primary = page.locator(':scope > a[download][href*="resultId=' + importId + '"]').filter({ hasText: /\.md$/i })
    const result = page.locator('li').filter({ has: primary }).first()
    await result.getByRole('button', { name: 'Open result' }).click()
    const archive = await downloadZip(page, result.getByRole('link', { name: /Download all files/ }))
    const mdPath = Object.keys(archive).find(p => /\.md$/i.test(p))
    assert.ok(mdPath, 'Bundle is missing the Markdown')
    const markdown = strFromU8(archive[mdPath])
    const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1])
    assert.equal(new Set(images).size, 2, 'Both explicit image references must survive the round trip')
    const base = mdPath.split('/').slice(0, -1)
    for (const ref of images) assert.ok(archive[[...base, decodeURIComponent(ref)].join('/')], 'Missing bundled image: ' + ref)
    console.log('Browser: DOCX import and ZIP download contain Markdown and both referenced images.')

    step = 'reopening the session and selecting a single section'
    await page.reload()
    await openFixture(page, host.sessionId)
    await openPanel(page)
    await result.getByRole('button', { name: 'Open result' }).click()
    const sections = result.getByRole('combobox', { name: /^Section/ })
    const chosen = sections.locator('option').filter({ hasText: /Follow-up/i }).first()
    await sections.selectOption(await chosen.getAttribute('value'))
    const preview = result.locator('pre')
    assert.match(await preview.textContent(), /second section/i)
    assert.doesNotMatch(await preview.textContent(), /historic reply/i)
    assert.doesNotMatch(await editor.innerText(), /second section/i)
    await result.getByRole('button', { name: 'Add section to draft' }).click()
    await result.getByText('Added to the conversation draft.').waitFor()
    assert.match(await editor.innerText(), /second section/i)
    assert.doesNotMatch(await editor.innerText(), /historic reply/i)
    const history = await host.rpc('session/events', { request: { address: { kind: 'session', sessionId: host.sessionId }, maxMessages: 40 } })
    assert.equal(history.hasMore, false)
    const events = history.records.map(record => record.event)
    const invocation = events.find(event => event.type === 'command/run' && event.data.name === 'docwen')
    assert.ok(invocation, 'No native /docwen command was recorded')
    assert.ok(events.some(event => event.type === 'command/done' && event.data.commandId === invocation.data.commandId && event.data.kind === 'success'))
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1, 'The fixture must remain the only model turn')
    console.log('Browser: saved result reopened; only the selected section was added to the draft; no further turn started.')
  } catch (error) {
    const alerts = page ? await page.locator('[role=alert]:visible').allTextContents().catch(() => []) : []
    if (alerts.length) console.error('Visible DSH errors:', alerts.join(' / ').slice(0, 500))
    throw new Error('Browser acceptance failed while ' + step + ': ' + String(error?.message ?? error)
      .replace(/((?:token|key|ticket|code)=)[^\s&#]+/gi, '$1[redacted]'))
  } finally { await browser.close() }
}

await withInstalledHost({}, checkBrowser)
