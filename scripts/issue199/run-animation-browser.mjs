// Sequential production observation. Stop on the first product failure.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { performance } from 'node:perf_hooks'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const productSource = 'b33b7531027979b8886f5db979d57cd96b96175d'
const url = 'http://127.0.0.1:5199'
const out = `/private/tmp/issue199-gate3-browser/${new Date().toISOString().replaceAll(':', '-')}`
mkdirSync(out, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixtureRoot = join(root, 'scripts/issue199/fixtures')
const fixtureManifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'))
const report = { format: 'issue199-animation-observation-v1', startedAt: new Date().toISOString(), url, productSource, harnessHead: git('rev-parse', 'HEAD'), runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))), fixtures: fixtureManifest,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() }, browserPath: 'Browser plugin not available; approved regular Playwright with muted headless Chromium', steps: [], observations: [], problems: [], requests: [], screenshots: [], pending: ['native key/handle drag and all cancellation causes', 'sibling preview restoration', 'cross-owner mapping/history/save/reopen', 'large-document40/512/256 bounds and raw cold/warm timings', 'remaining protocol cases'], cleanup: {} }
const persist = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n')
const listening = () => new Promise((resolve) => { const socket = createConnection({ host: '127.0.0.1', port: 5199 }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) })
let server, browser, page, context, currentStep = 'preflight', sourceFiles, serverLog = ''
function pinSource() {
  assert.equal(git('status', '--porcelain'), '', 'Run requires a clean committed harness and source')
  assert.equal(git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json'), '', 'Product source differs from accepted Gate3')
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/issue199/observation-source-hashes.json'), 'utf8'))
  assert.equal(manifest.productSource, productSource, 'Harness and observation source manifest disagree')
  for (const [path, expected] of Object.entries(manifest.sha256)) assert.equal(hash(readFileSync(join(root, path))), expected, path)
  sourceFiles = manifest.sha256
  for (const [path, facts] of Object.entries(fixtureManifest.files)) assert.equal(hash(readFileSync(join(fixtureRoot, path))), facts.sha256, path)
  report.sourceHashes = sourceFiles
}
async function settled() { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function state() {
  return page.evaluate(() => {
    const d = window.__animationQA.document.getState(), t = window.__animationQA.transport.getState()
    return { project: d.project, past: d.past.length, future: d.future.length, selectedClipIds: t.selectedClipIds, focusedLane: t.animationFocusedLane, selectedKeys: t.animationSelection, keyFocus: t.animationFocus, playhead: t.playheadFrame, zoom: t.zoom, origin: t.timelineOriginFrame, range: t.animationVisibleRange, animationOpen: t.animationWorkspaceOpen, preview: t.animationPreview, effectPreviewOwner: t.effectDocumentPreview?.owner ?? null, status: t.animationStatus, active: { tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 120), testId: document.activeElement?.getAttribute('data-testid') } }
  })
}
async function shot(label) { const path = join(out, `${label}.png`); await page.screenshot({ path, fullPage: false }); report.screenshots.push(path) }
async function step(name, action) {
  currentStep = name; const start = performance.now()
  try { const detail = await action(); assert.deepEqual(report.problems, [], 'Console or page problems fail observable acceptance'); report.steps.push({ name, status: 'passed', elapsedMs: performance.now() - start, detail }); persist(); console.log(`PASS ${name}`) }
  catch (error) { report.steps.push({ name, status: 'failed', elapsedMs: performance.now() - start, error: error.stack }); throw error }
}
async function bridge() {
  // Discover exported Zustand stores from modules the production app already
  // requested. No source/dev import, code replacement or instrumentation build.
  const loaded = [...new Set(report.requests.filter((request) => /\/(?:documentStore|index|animationWorkspaceController)-[^/]+\.js$/.test(request)))]
  const found = await page.evaluate(async (urls) => {
    const result = {}
    for (const url of urls) for (const value of Object.values(await import(url))) {
      if (typeof value === 'function' && typeof value.getState === 'function') {
        const state = value.getState()
        if (state?.project && state?.doc && Array.isArray(state?.past)) result.document = value
        if (typeof state?.zoom === 'number' && typeof state?.setAnimationSelection === 'function') result.transport = value
        if (typeof state?.timelineHeight === 'number' && typeof state?.applyPreset === 'function') result.workspace = value
      }
      if (value && typeof value === 'object' && typeof value.begin === 'function' && typeof value.copy === 'function' && typeof value.getClipboard === 'function') result.animation = value
    }
    window.__animationQA = result
    return Object.keys(result)
  }, loaded)
  assert.ok(found.includes('document') && found.includes('transport'), `Production store exports unavailable: ${found}`)
  return { importedAlreadyLoadedModules: loaded, stores: found }
}
try {
  pinSource(); assert.equal(await listening(), false, 'Port5199 already occupied; do not reuse or stop another listener')
  const build = execFileSync('npm', ['run', 'build'], { cwd: root, env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(out, 'build.log'), build)
  report.buildHashes = Object.fromEntries(readdirSync(join(root, 'dist/assets')).map((name) => [`assets/${name}`, hash(readFileSync(join(root, 'dist/assets', name)))]))
  server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  report.serverPid = server.pid; server.stdout.on('data', (data) => { serverLog += data }); server.stderr.on('data', (data) => { serverLog += data })
  for (let attempt = 0; attempt < 50 && !(await listening()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(await listening(), 'Private production preview did not start')
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
  report.chromium = { version: browser.version(), executablePath: chromium.executablePath(), args: ['--mute-audio'] }
  const browserSession = await browser.newBrowserCDPSession()
  try { report.chromium.systemInfo = await browserSession.send('SystemInfo.getInfo'); report.chromium.processes = await browserSession.send('SystemInfo.getProcessInfo') } catch (error) { report.chromium.systemInfoUnavailable = String(error) }
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  page = await context.newPage(); page.setDefaultTimeout(10000)
  page.on('request', (request) => report.requests.push(request.url()))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) report.problems.push({ step: currentStep, type: message.type(), text: message.text() }) })
  page.on('pageerror', (error) => report.problems.push({ step: currentStep, type: 'pageerror', text: error.stack }))
  page.on('dialog', (dialog) => dialog.accept())
  await step('production launcher and portable fixture entry', async () => {
    await page.goto(url); await expect(page).toHaveTitle(/Myrelith/i); assert.equal(new URL(page.url()).origin, url)
    await expect(page.getByRole('button', { name: 'Open a project', exact: true })).toBeVisible()
    assert.equal(report.requests.some((request) => /AnimationWorkspace-/.test(request)), false)
    await page.getByRole('button', { name: 'Open a project', exact: true }).click()
    await page.locator('input[type="file"][accept=".myrelith,.webcut"]').setInputFiles(join(fixtureRoot, 'mixed.myrelith'))
    await page.getByRole('button', { name: 'Open with 2 offline', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Animation', exact: true })).toBeVisible(); await settled()
    assert.equal(report.requests.some((request) => /AnimationWorkspace-/.test(request)), false, 'Workspace requested before first open')
    return await bridge()
  })
  await step('1440x900 first-use lazy dock and layout', async () => {
    await page.getByTestId('clip-root-text').click(); report.timelineBefore = await state()
    const started = performance.now(); await page.getByRole('button', { name: 'Animation', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Animation workspace', exact: true })).toBeVisible(); await settled()
    report.observations.push({ name: 'cold first-open wall time, includes automation', milliseconds: performance.now() - started })
    assert.ok(report.requests.some((request) => /AnimationWorkspace-[^/]+\.js/.test(request)), 'Lazy workspace request absent')
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, rows: document.querySelectorAll('[data-animation-lane]').length, glyphs: document.querySelectorAll('[data-animation-glyph]').length, grid: document.querySelector('.animation-grid')?.getBoundingClientRect().toJSON() }))
    assert.ok(layout.width <= layout.viewport + 1, 'Document horizontally overflows at desktop width'); assert.ok(layout.rows <= 40 && layout.glyphs <= 512)
    await shot('desktop-sheet'); return layout
  })
  await step('720x900 responsive dock remains reachable', async () => {
    await page.setViewportSize({ width: 720, height: 900 }); await settled()
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, grid: document.querySelector('.animation-grid')?.getBoundingClientRect().toJSON(), controls: document.querySelector('.animation-key-controls')?.getBoundingClientRect().toJSON() }))
    assert.ok(layout.width <= layout.viewport + 1, 'Document horizontally overflows at720px')
    assert.ok(layout.grid.width > 0 && layout.grid.height > 0 && layout.controls.right <= 721, 'Animation controls clipped at720px')
    await page.getByRole('button', { name: 'Map paste…', exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Back to Timeline', exact: true }).scrollIntoViewIfNeeded()
    await shot('compact-sheet'); await page.setViewportSize({ width: 1440, height: 900 }); await settled(); return layout
  })
  await step('native input and IME contain destructive global shortcuts', async () => {
    const before = await state(), input = page.getByRole('textbox', { name: 'Filter animation lanes' })
    await input.fill('Native curve title'); await input.press('ControlOrMeta+A'); await input.press('Backspace')
    await input.fill('opacity'); await input.press('Delete'); await input.press('ControlOrMeta+Z')
    const cdp = await context.newCDPSession(page)
    await input.focus(); await cdp.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 }); await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await cdp.detach()
    assert.deepEqual((await state()).project, before.project, 'Native input/IME modified the document')
    await input.fill('Native curve title'); return { past: (await state()).past }
  })
  await step('both Bézier handles preserve exact document and history for center and off-center no-motion clicks', async () => {
    const grid = page.getByRole('grid', { name: 'Animation keys' }); await grid.focus(); await grid.press('Home')
    await page.getByRole('button', { name: 'Curve', exact: true }).click(); await page.getByRole('button', { name: 'Fit keys', exact: true }).click(); await settled()
    await shot('curve-before-click'); report.noMotionHandles = []
    for (const which of ['1', '2']) for (const offset of [0, 2, -2]) {
      currentStep = `native no-motion Bézier handle${which}, hit offset${offset}`
      const handle = page.getByRole('button', { name: `Drag Bézier handle ${which}; numeric alternatives in key controls`, exact: true })
      await expect(handle).toBeVisible()
      const box = await handle.boundingBox(); assert.ok(box)
      const point = { x: box.x + box.width / 2 + offset, y: box.y + box.height / 2 + offset }
      const before = await state(); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up(); await settled()
      const after = await state(); report.noMotionHandles.push({ handle: which, offset, point, box, before, after })
      await shot(`curve-handle-${which}-offset-${offset}`)
      assert.equal(after.past, before.past, 'A no-motion Bézier click added an undo entry')
      assert.equal(after.future, before.future, 'A no-motion Bézier click changed redo')
      assert.deepEqual(after.project, before.project, 'A no-motion Bézier click changed authored easing')
      assert.deepEqual(report.problems, [], 'Console or page problems fail observable acceptance')
      persist()
    }
    return { cases: report.noMotionHandles.map(({ handle, offset, before }) => ({ handle, offset, history: before.past })) }
  })
  await step('Animation back to Timeline preserves selection, shared viewport and usable focus', async () => {
    const before = await state(); await page.getByRole('button', { name: 'Back to Timeline', exact: true }).click(); await settled()
    await expect(page.locator('.timeline-scroll-host')).toBeVisible(); const after = await state()
    assert.deepEqual(after.selectedClipIds, before.selectedClipIds)
    assert.equal(after.zoom, before.zoom); assert.equal(after.origin, before.origin, 'Closing Animation changed the shared integer origin')
    assert.ok(Number.isSafeInteger(after.origin) && after.origin >= 0)
    assert.ok(!['BODY', 'HTML'].includes(after.active.tag), 'Closing Animation lost focus to the document body')
    await shot('timeline-return'); return { before: { zoom: before.zoom, origin: before.origin }, after: { zoom: after.zoom, origin: after.origin, active: after.active } }
  })
  report.status = 'preflight-passed'; report.note = 'Early production checkpoints passed. Remaining approved protocol still requires bounded continuation harness; no overall observable acceptance.'
  writeFileSync(join(out, 'server.log'), serverLog)
} catch (error) {
  report.status = 'failed'; report.failure = { step: currentStep, error: error.stack }
  if (page) {
    try { await shot('failure'); writeFileSync(join(out, 'failure-dom.txt'), await page.locator('body').innerText()); report.failure.state = await state() } catch (captureError) { report.failure.captureError = String(captureError) }
  }
  process.exitCode = 1; console.error(`STOP ${currentStep}: ${error.message}`)
} finally {
  try { if (context) await context.tracing.stop({ path: join(out, 'trace.zip') }) } catch (error) { report.cleanup.traceError = String(error) }
  try { await browser?.close(); report.cleanup.browserClosed = true } catch (error) { report.cleanup.browserError = String(error) }
  if (server) { server.kill('SIGTERM'); await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 3000) } }); report.cleanup.serverExitCode = server.exitCode; report.cleanup.serverSignal = server.signalCode }
  report.cleanup.port5199Listening = await listening()
  report.cleanup.productSourceStillAccepted = git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json') === ''
  if (report.status === 'preflight-passed' && report.problems.length) {
    report.status = 'failed'; report.failure = { step: 'final console/page acceptance', error: 'Recorded console or page problems prevent acceptance', problems: report.problems }; process.exitCode = 1
  }
  writeFileSync(join(out, 'server.log'), serverLog)
  report.finishedAt = new Date().toISOString(); persist(); console.log(`Evidence: ${out}`)
}
