// One explicitly selected continuation per granted slot. Never auto-continue
// the already accepted early runner. No source/dev imports in the browser.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { chromium, expect } from '@playwright/test'
import { continuationProductSource, prepareAnimationContinuation, runAnimationGestures, runAnimationEditing, runAnimationPortableRoundTrip, runAnimationLargeDocuments } from './continuation/observations.mjs'
import { serializeCanonicalSnapshot } from './continuation/portable.mjs'
import { ownedProcessRows, parseProcessRows, sameProcessIdentity } from './continuation/process-identities.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--segment' && ['gestures', 'editing', 'large'].includes(args[1]), 'Select exactly one reviewed/granted segment: --segment gestures|editing|large')
const segment = args[1], root = fileURLToPath(new URL('../..', import.meta.url)), productSource = continuationProductSource
const out = `/private/tmp/issue199-continuation/${new Date().toISOString().replaceAll(':', '-')}-${segment}`
const profile = join(out, 'chromium-profile'), fixtureRoot = join(root, 'scripts/issue199/fixtures'), url = 'http://127.0.0.1:5199'
mkdirSync(out, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(readFileSync(join(root, 'scripts/issue199/continuation/checkpoint-hashes.json'), 'utf8'))
const supplemental = { ...JSON.parse(readFileSync(join(fixtureRoot, 'continuation/supplemental-manifest.json'), 'utf8')), directory: join(fixtureRoot, 'continuation') }
const report = { format: 'issue199-continuation-v1', segment, status: 'preflight', startedAt: new Date().toISOString(), productSource, harnessHead: git('rev-parse', 'HEAD'), manifest,
  url, profile, runtime: { node: process.version, architecture: process.arch, platform: process.platform, macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() },
  steps: [], observations: [], problems: [], requests: [], dialogs: [], screenshots: [], processSamples: [], cleanup: {},
  qualification: 'Only this selected segment. No automatic whole Gate3, OS save-picker, instrumented index count, hardware GPU, media pixel/PCM or export acceptance.' }
const persist = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n')
const listening = () => new Promise((resolve) => { const socket = createConnection({ host: '127.0.0.1', port: 5199 }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let server, context, browser, page, browserSession, serverLog = '', currentStep = 'preflight'
const knownProcesses = []
function pinSource() {
  assert.equal(git('status', '--porcelain'), '', 'Require a clean committed harness, fixtures and product')
  assert.equal(manifest.productSource, productSource)
  assert.equal(git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json'), '')
  for (const [path, expected] of Object.entries(manifest.sha256)) assert.equal(hash(readFileSync(join(root, path))), expected, path)
  const source = JSON.parse(readFileSync(join(root, 'scripts/issue199/observation-source-hashes.json'), 'utf8'))
  assert.equal(source.productSource, productSource)
  for (const [path, expected] of Object.entries(source.sha256)) assert.equal(hash(readFileSync(join(root, path))), expected, path)
  report.sourceHashes = source.sha256
}
function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr || 'Cannot inspect owned process identities')
  return parseProcessRows(result.stdout)
}
async function sampleProcesses(label) {
  let cdp
  if (browserSession) try { cdp = await browserSession.send('SystemInfo.getProcessInfo') } catch (error) { cdp = { unavailable: String(error) } }
  const rows = ownedProcessRows(processRows(), profile, knownProcesses)
  for (const row of rows) if (!knownProcesses.some((known) => sameProcessIdentity(known, row))) knownProcesses.push(row)
  report.processSamples.push({ label, at: new Date().toISOString(), cdp, owned: rows }); return rows
}
async function settled() { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function shot(label) { const path = join(out, `${label}.png`); await page.screenshot({ path, fullPage: false }); report.screenshots.push(path) }
async function state() {
  return page.evaluate(() => {
    const q = window.__animationQA
    if (!q?.document || !q?.transport) return { phase: 'before production bridge' }
    const d = q.document.getState(), t = q.transport.getState()
    return { project: d.project, past: d.past.length, future: d.future.length, selectedClipIds: t.selectedClipIds, selectedKeys: t.animationSelection, focus: t.animationFocus, focusedLane: t.animationFocusedLane, zoom: t.zoom, origin: t.timelineOriginFrame, status: t.animationStatus, preview: !!t.animationPreview, effectOwner: t.effectDocumentPreview?.owner ?? null, active: { tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label') } }
  })
}
async function bridge() {
  const loaded = [...new Set(report.requests.filter((request) => /\/(?:mediaStore|documentStore|index|animationWorkspaceController)-[^/]+\.js$/.test(request)))]
  const found = await page.evaluate(async (urls) => {
    const result = {}
    for (const url of urls) for (const value of Object.values(await import(url))) {
      if (typeof value === 'function' && typeof value.getState === 'function') {
        const state = value.getState()
        if (state?.project && state?.doc && Array.isArray(state?.past)) result.document = value
        if (typeof state?.zoom === 'number' && typeof state?.setAnimationSelection === 'function') result.transport = value
        if (state?.descriptors instanceof Map && state?.assets instanceof Map && Array.isArray(state?.collections)) result.media = value
      }
      if (value && typeof value === 'object' && typeof value.begin === 'function' && typeof value.copy === 'function' && typeof value.getClipboard === 'function') result.animation = value
    }
    window.__animationQA ??= {}
    Object.assign(window.__animationQA, result)
    delete window.__animationQA.checkpoints; delete window.__animationQA.nativePointer
    return Object.keys(result)
  }, loaded)
  assert.ok(['document', 'transport', 'animation'].every((key) => found.includes(key)), `Production exports unavailable: ${found}`)
  report.observations.push({ name: 'Already-requested production modules', loaded, stores: found })
}
async function step(name, action) {
  currentStep = name; console.log(`START ${name}`); await sampleProcesses(`before ${name}`)
  const started = performance.now()
  try {
    const detail = await action(); await settled()
    const artifact = `step-${String(report.steps.length + 1).padStart(2, '0')}`
    await shot(artifact)
    writeFileSync(join(out, `${artifact}-dom.txt`), await page.locator('body').innerText())
    await sampleProcesses(`after ${name}`)
    assert.deepEqual(report.problems, [], 'Console/page problems fail this segment')
    report.steps.push({ name, status: 'passed', elapsedMs: performance.now() - started, detail, dom: `${artifact}-dom.txt` }); persist(); console.log(`PASS ${name}`)
  } catch (error) { report.steps.push({ name, status: 'failed', error: error.stack, elapsedMs: performance.now() - started }); persist(); throw error }
}
try {
  pinSource(); assert.equal(await listening(), false, 'Port5199 is occupied; never reuse or stop its listener')
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } })
  writeFileSync(join(out, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`); assert.equal(build.status, 0, 'Production build failed')
  report.buildHashes = Object.fromEntries(readdirSync(join(root, 'dist/assets')).map((name) => [`assets/${name}`, hash(readFileSync(join(root, 'dist/assets', name)))]))
  server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  report.serverPid = server.pid; server.stdout.on('data', (chunk) => { serverLog += chunk }); server.stderr.on('data', (chunk) => { serverLog += chunk })
  for (let i = 0; i < 50 && !(await listening()); i++) await delay(100)
  assert.ok(await listening(), 'Private preview failed to start')
  const serverIdentity = processRows().find((row) => row.pid === server.pid); assert.ok(serverIdentity); knownProcesses.push(serverIdentity)
  context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--mute-audio'], viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  browser = context.browser(); assert.ok(browser, 'Persistent context has no inspectable Chromium browser')
  report.chromium = { version: browser.version(), executablePath: chromium.executablePath(), args: ['--mute-audio'], privateProfile: profile }
  browserSession = await browser.newBrowserCDPSession()
  try { report.chromium.systemInfo = await browserSession.send('SystemInfo.getInfo') } catch (error) { report.chromium.systemInfoUnavailable = String(error) }
  await sampleProcesses('launched'); await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10000)
  page.on('request', (request) => report.requests.push(request.url()))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) report.problems.push({ step: currentStep, type: message.type(), text: message.text() }) })
  page.on('pageerror', (error) => report.problems.push({ step: currentStep, type: 'pageerror', text: error.stack }))
  page.on('dialog', async (dialog) => {
    report.dialogs.push({ step: currentStep, type: dialog.type(), message: dialog.message() })
    if (dialog.type() === 'confirm' && dialog.message() === 'This project has unsaved changes. Leave them behind and return to Projects?') await dialog.accept()
    else { report.problems.push({ step: currentStep, type: 'unexpected-dialog', text: dialog.message() }); await dialog.dismiss() }
  })
  await step('production launcher identity', async () => { await page.goto(url); await expect(page).toHaveTitle(/Myrelith/i); assert.equal(new URL(page.url()).origin, url); await expect(page.getByRole('button', { name: 'Open a project', exact: true })).toBeVisible() })
  const h = { page, context, step, state, settled, shot, bridge, report, out, fixtureRoot }
  if (segment !== 'large') await step('canonical mixed fixture and native selection', () => prepareAnimationContinuation(h))
  if (segment === 'gestures') await runAnimationGestures(h)
  if (segment === 'editing') { await runAnimationEditing(h); await runAnimationPortableRoundTrip(h, (snapshot) => serializeCanonicalSnapshot(root, productSource, snapshot)) }
  if (segment === 'large') await runAnimationLargeDocuments(h, supplemental)
  report.status = 'segment-passed'
} catch (error) {
  report.status = 'failed'; report.failure = { step: currentStep, error: error.stack }; process.exitCode = 1
  if (page) try { await shot('failure'); writeFileSync(join(out, 'failure-dom.txt'), await page.locator('body').innerText()); report.failure.state = await state() } catch (captureError) { report.failure.captureError = String(captureError) }
  console.error(`STOP ${currentStep}: ${error.message}`)
} finally { await finishRun() }

async function finishRun() {
  if (context) {
    try { await sampleProcesses('before closing'); await context.tracing.stop({ path: join(out, 'trace.zip') }) } catch (error) { report.cleanup.captureError = String(error) }
    try { await context.close(); report.cleanup.contextClosed = true } catch (error) { report.cleanup.contextError = String(error); try { await browser?.close() } catch (cause) { report.cleanup.browserError = String(cause) } }
  }
  browserSession = null
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]) }
  try {
    // A shutdown fallback can signal only a current, previously observed exact
    // identity from this private profile/tree. PID reuse cannot become a target.
    let remaining = await sampleProcesses('after close')
    report.cleanup.signals = []
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const identity of remaining) {
        assert.ok(![1, process.pid, process.ppid].includes(identity.pid), 'Refuse to signal a host/runner process')
        const live = processRows().find((row) => sameProcessIdentity(row, identity))
        if (live) { try { process.kill(live.pid, signal); report.cleanup.signals.push({ signal, identity: live }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
      }
      for (let i = 0; i < 20 && remaining.length; i++) { await delay(100); remaining = ownedProcessRows(processRows(), profile, knownProcesses) }
      if (!remaining.length) break
    }
    report.cleanup.remainingOwned = await sampleProcesses('final release')
    report.cleanup.port5199Listening = await listening()
    report.cleanup.released = report.cleanup.remainingOwned.length === 0 && !report.cleanup.port5199Listening
    report.cleanup.checkedAt = new Date().toISOString(); report.cleanup.serverExitCode = server?.exitCode ?? null
    pinSource()
    if (!report.cleanup.released || report.problems.length) throw new Error('Owned cleanup or console/page acceptance failed')
  } catch (error) { report.cleanup.error = String(error); if (report.status === 'segment-passed') report.failure = { step: 'final cleanup/console/source acceptance', error: error.stack }; report.status = 'failed'; process.exitCode = 1 }
  writeFileSync(join(out, 'server.log'), serverLog); report.finishedAt = new Date().toISOString(); persist(); console.log(`Evidence: ${out}`)
}
