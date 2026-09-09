// Focused acceptance of the built product. No development modules or state injection.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, readdir, rm, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createRuntimeResidentMonitor } from '../whispercpp-lab/resident-monitor.mjs'
import { captureCompleteResident, RSS_INTERVAL_MS } from '../whispercpp/resident-coverage.mjs'
import { createLabSampleQueue } from '../lab-contract.mjs'
import { HOST_LIMITS } from '../whispercpp-lab/host-limits.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workerRoot = path.resolve(root, '../issue201')
const dist = path.join(root, 'dist'), outputRoot = path.join(root, '.tmp/issue201-product')
const hash = value => createHash('sha256').update(value).digest('hex')
const mode = process.argv[2], attempt = process.argv[3] ?? '01'
assert(['--verify-inputs', '--run'].includes(mode) && /^\d{2}$/.test(attempt))
const manifest = JSON.parse(await readFile(path.join(root, 'docs/evidence/issue201/whispercpp-runtime-source/manifest.json')))
const modelInfo = manifest.model.files[0]
const modelPath = path.join(workerRoot, modelInfo.localPath)
const model = await readFile(modelPath)
assert.equal(model.length, 43_537_433)
assert.equal(hash(model), 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca')
const fixturePaths = Object.fromEntries(['english.wav', 'french.wav', 'english-300.wav', 'silence.wav'].map(name => [name, path.join(workerRoot, '.tmp/issue201-speech-lab/fixtures', name)]))
const inputs = []
for (const entry of [...manifest.fixtures.map(f => ({ ...f, name: f.name + '.wav' })), ...manifest.derivatives]) {
  if (!fixturePaths[entry.name]) continue
  const bytes = await readFile(fixturePaths[entry.name])
  assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
  inputs.push({ name: entry.name, bytes: bytes.length, sha256: hash(bytes) })
}
fixturePaths.stereo = path.join(outputRoot, 'english-stereo-48k.wav')
const stereo = await readFile(fixturePaths.stereo)
assert.equal(hash(stereo), '6202eb6dc9c73c7d0d1c655b8841fe9fe4f1b351e342a41451848ba5d6bde5f9')
inputs.push({ name: 'english-stereo-48k.wav', bytes: stereo.length, sha256: hash(stereo) })
const files = new Map()
async function collect(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const location = path.join(folder, entry.name)
    if (entry.isDirectory()) await collect(location)
    else { assert(entry.isFile()); files.set('/' + path.relative(dist, location), await readFile(location)) }
  }
}
await collect(dist)
for (const digest of ['db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7', '2f05c1ba7a828ba93a5ab1c7dd752f0d055360d02aa23edc9b60572424e01ef2']) {
  const found = [...files].find(([name]) => name.startsWith('/speech-runtime/' + digest))
  assert(found); assert.equal(hash(found[1]), digest)
}
assert([...files.keys()].some(name => /^\/assets\/caption-transcription\.worker-.*\.js$/.test(name)))
assert(![...files.keys()].some(name => /lab-client|scripts\/issue201|node_modules/.test(name)))
const checkpoint = { runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), inputs,
  model: { bytes: model.length, sha256: hash(model) }, dist: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })) }
const checkpointHash = hash(JSON.stringify(checkpoint))
if (mode === '--verify-inputs') { console.log(JSON.stringify({ checkpointHash, ...checkpoint }, null, 2)); process.exit(0) }
assert.equal(process.env.ISSUE201_PRODUCT_CHECKPOINT, checkpointHash, 'Verify and authorize this exact built-product checkpoint first')
const output = path.join(outputRoot, 'attempt-' + attempt), profile = path.join(output, 'profile')
await mkdir(output, { recursive: true })
await writeFile(path.join(output, 'started.json'), JSON.stringify({ checkpointHash, checkpoint, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
const result = { checkpointHash, cases: [], errors: [], network: [], receipts: [], screenshots: [], release: null }
let context, page, cdp, sampler, queue, stopReason, closing, activeCase = 'setup', runtimeReady = false
const monitor = createRuntimeResidentMonitor(), identities = new Map()
const bounded = async (promise, ms, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const journal = record => appendFile(path.join(output, 'progress.jsonl'), JSON.stringify({ at: Date.now(), case: activeCase, ...record }) + '\n')
function fail(error) {
  if (stopReason) return
  stopReason = error instanceof Error ? error.message : String(error)
  result.errors.push({ case: activeCase, message: stopReason })
  void journal({ failed: stopReason })
  void closeBrowser().catch(() => {})
}
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:5201').pathname
  if (pathname === '/model-fixture') {
    if (request.method !== 'GET' || activeCase !== 'explicit-download') { response.writeHead(403); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': model.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    response.end(model); return
  }
  const key = pathname === '/' ? '/index.html' : pathname.endsWith('/') ? pathname + 'index.html' : pathname
  const bytes = files.get(key)
  if (request.method !== 'GET' || !bytes) { response.writeHead(pathname === '/favicon.ico' ? 204 : 404); response.end(); return }
  const extension = path.extname(key)
  const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.zip': 'application/zip' }[extension] ?? 'application/octet-stream'
  const immutable = key.startsWith('/assets/') || /^\/speech-runtime\/[a-f0-9]{64}\.(mjs|wasm)$/.test(key)
  response.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' })
  response.end(bytes)
})
function parsePs(text, rss = true) {
  return text.trim() ? text.trim().split('\n').map(line => {
    const columns = line.trim().split(/\s+/), offset = rss ? 2 : 1
    return { pid: Number(columns[0]), rss: rss ? Number(columns[1]) * 1024 : null,
      started: columns.slice(offset, offset + 5).join(' '), command: columns.slice(offset + 5).join(' ') }
  }) : []
}
function remaining() {
  const rows = parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8', timeout: 100 }), false)
  return rows.filter(row => identities.get(`${row.pid}:${row.started}`)?.command === row.command || row.command.includes('--user-data-dir=' + profile))
}
async function sample(label = 'periodic') {
  try {
    const receipt = await captureCompleteResident({ now: Date.now,
      getProcessIds: async () => (await bounded(cdp.send('SystemInfo.getProcessInfo'), 80, 'CDP inventory timeout')).processInfo.map(item => item.id),
      readRssBytes: async pids => {
        assert(pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0))
        const rows = parsePs(execFileSync('/bin/ps', ['-o', 'pid=,rss=,lstart=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 100 }))
        for (const row of rows) identities.set(`${row.pid}:${row.started}`, row)
        return rows.map(row => [row.pid, row.rss])
      } })
    const problem = monitor.observe(receipt, label)
    await journal({ memory: monitor.memory.at(-1) })
    if (problem) fail(new Error('Resident bound: ' + JSON.stringify(problem)))
  } catch (error) { fail(error) }
}
async function closeBrowser() {
  if (closing) return closing
  if (!context) return
  closing = (async () => {
    clearInterval(sampler)
    await bounded(queue?.drain() ?? Promise.resolve(), 500, 'Sample drain timeout').catch(error => result.errors.push({ message: error.message }))
    const startedAt = Date.now(), errors = [], signals = []
    try { await bounded(context.close(), 200, 'Browser close exceeded 200 ms') } catch (error) { errors.push(error.message) }
    for (const row of remaining()) {
      if (!remaining().some(current => current.pid === row.pid && current.started === row.started && current.command === row.command)) continue
      try { process.kill(row.pid, 'SIGKILL'); signals.push(row.pid) } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message) }
    }
    const left = remaining(), at = Date.now()
    const receipt = { startedAt, at, elapsedMs: at - startedAt, remaining: left, verifiedAbsent: !left.length, errors, signals, identities: [...identities.values()] }
    result.release = receipt
    if (runtimeReady) { const problem = monitor.close(receipt); if (problem) result.errors.push(problem) }
    if (errors.length || signals.length) result.errors.push({ message: 'Forced or late browser close', errors, signals })
    context = null
    return receipt
  })()
  return closing
}
async function step(name, work, timeout = 30_000) {
  if (stopReason) throw new Error(stopReason)
  activeCase = name
  const startedAt = Date.now()
  await journal({ started: name })
  const details = await bounded(work(), timeout, name + ' deadline')
  if (stopReason) throw new Error(stopReason)
  const receipt = { name, passed: true, elapsedMs: Date.now() - startedAt, details }
  result.cases.push(receipt); await journal(receipt); console.log('PASS', name)
}
const button = name => page.getByRole('button', { name, exact: true })
const speech = () => page.locator('.caption-speech-panel')
const observed = () => page.evaluate(() => window.__speechAcceptance)
async function openSpeech() {
  await button('Captions').click(); await button('Transcribe local audio').click()
  await expect(page.getByRole('heading', { name: 'Transcribe local audio' })).toBeFocused()
}
async function selectSource(name, start, end, language = 'en') {
  await speech().getByLabel('Connected audio source').selectOption({ label: name })
  await page.getByLabel('Source start (seconds)', { exact: true }).fill(String(start))
  await page.getByLabel('Source end (seconds)', { exact: true }).fill(String(end))
  await speech().getByLabel('Language').selectOption(language)
  await page.getByLabel('Insert at timeline frame', { exact: true }).fill('17')
}
async function transcribe() {
  await button('Transcribe selected window').click()
  await expect(button('Apply transcription as one edit')).toBeVisible({ timeout: 180_000 })
  const observation = await observed(), receipt = observation.jobs.at(-1)
  assert.equal(receipt.reply.type, 'complete'); assert.equal(receipt.reply.cooperativeZero, true)
  const ledger = receipt.reply.ledger
  assert.equal(ledger.modelOwners + ledger.inputOwners + ledger.sampleOwners + ledger.pcmBytes, 0)
  assert.equal(ledger.acquiredSamples, ledger.closedSamples); assert(ledger.maxPcmBytes <= 3_840_000)
  assert(receipt.terminated); result.receipts.push(receipt)
  return receipt.reply.transcript
}
async function command(name) {
  await button('Commands').click(); await page.getByRole('searchbox', { name: 'Search commands' }).fill(name); await button(name).click()
}
async function save(name) {
  const pending = page.waitForEvent('download'); await button('Save').click()
  const download = await pending, location = path.join(output, name + '.myrelith')
  await download.saveAs(location)
  const text = await readFile(location, 'utf8')
  assert(!/blob:|retainedCaptionOwners|myrelith-speech-model-v1-/.test(text))
  return { location, file: JSON.parse(text) }
}
async function cacheFacts() {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('myrelith-speech-'))
    const models = []
    for (const name of names.filter(name => name.startsWith('myrelith-speech-model-v1-'))) {
      const cache = await caches.open(name), keys = await cache.keys(), response = await cache.match(keys[0])
      const data = await response.arrayBuffer()
      models.push({ name, bytes: data.byteLength, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join(''), headers: Object.fromEntries(response.headers) })
    }
    return { names, models }
  })
}
const overall = setTimeout(() => fail(new Error('Product acceptance overall deadline')), HOST_LIMITS.overallMs)
try {
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(5201, '127.0.0.1', resolve) }), 1000, 'Product server bind timeout')
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 900 }, timeout: 10_000,
    args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'], acceptDownloads: true })
  page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10_000)
  await context.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) Object.defineProperty(window, name, { configurable: true, value: undefined })
    window.__speechAcceptance = { jobs: [] }
    const RealWorker = window.Worker
    window.Worker = class extends RealWorker {
      constructor(url, options) {
        super(url, options)
        if (!String(url).includes('caption-transcription.worker-')) return
        const row = { phases: [], terminated: false, reply: null }
        window.__speechAcceptance.jobs.push(row)
        this.addEventListener('message', event => {
          if (event.data?.type === 'phase') row.phases.push({ ...event.data, at: performance.now() })
          else row.reply = event.data
        })
        const terminate = this.terminate.bind(this)
        this.terminate = () => { row.terminated = true; terminate() }
      }
    }
  })
  page.on('pageerror', fail)
  page.on('console', entry => { if (entry.type() === 'error') fail(new Error(entry.text().slice(0, 1500))) })
  context.on('request', request => {
    if (result.network.length >= 10_000) { fail(new Error('Network record budget')); return }
    result.network.push({ case: activeCase, method: request.method(), url: request.url() })
    if (!request.url().startsWith('http://127.0.0.1:5201/') && !request.url().startsWith('blob:') && request.url() !== modelInfo.url) fail(new Error('Unexpected external request: ' + request.url()))
    if (request.url() === modelInfo.url && activeCase !== 'explicit-download') fail(new Error('Unexpected model request during ' + activeCase))
  })
  await page.goto('http://127.0.0.1:5201/')
  await button('Start a new project').click(); await page.getByLabel('Project name', { exact: true }).fill('Speech product acceptance'); await button('Create project').click()
  await expect(button('Captions')).toBeVisible()
  cdp = await context.browser().newBrowserCDPSession()
  result.runtime = await cdp.send('Browser.getVersion')
  result.memoryScope = 'Idle loaded editor before opening speech tools or importing fixtures; same 1 GiB delta and 100 ms / 250 ms coverage bounds as the model gate.'
  monitor.begin('loaded-product', Date.now()); runtimeReady = true
  queue = createLabSampleQueue(sample, () => Boolean(stopReason)); await queue.take('idle-editor')
  sampler = setInterval(() => { void queue.take() }, RSS_INTERVAL_MS)

  await step('no-model-lazy-path', async () => {
    await openSpeech(); await expect(button('Transcribe selected window')).toBeDisabled()
    assert.equal((await observed()).jobs.length, 0); assert.equal((await cacheFacts()).models.length, 0)
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  })
  await step('import-connected-audio', async () => {
    await page.getByLabel('Import media', { exact: true }).setInputFiles([fixturePaths.stereo, fixturePaths['english.wav'], fixturePaths['french.wav'], fixturePaths['english-300.wav'], fixturePaths['silence.wav']])
    await openSpeech(); await expect(speech().getByLabel('Connected audio source').locator('option')).toHaveCount(5)
  })
  await step('explicit-download', async () => {
    // Keep the large transfer on HTTP rather than blocking the CDP sampling pipe.
    await page.route(modelInfo.url, route => route.fulfill({ status: 302, headers: { location: 'http://127.0.0.1:5201/model-fixture', 'access-control-allow-origin': '*' }, body: '' }))
    await button('Download and install model').click(); await expect(speech()).toContainText('Speech model installed.', { timeout: 30_000 })
    await page.unroute(modelInfo.url)
    const facts = await cacheFacts(); assert.equal(facts.models.length, 1); assert.equal(facts.models[0].hash, hash(model))
    return { modelDownload: 'Exact requested URL redirected to the already verified local HTTP fixture; no live model-host transfer claimed', ...facts }
  })
  await step('remove-and-local-file-install', async () => {
    await button('Remove local model').click(); await expect(speech()).toContainText('The local speech model was removed.')
    assert.equal((await cacheFacts()).models.length, 0)
    await page.getByLabel('Install selected model file', { exact: true }).setInputFiles(modelPath)
    await expect(speech()).toContainText('Speech model installed.', { timeout: 30_000 })
    const facts = await cacheFacts(); assert.equal(facts.models[0].hash, hash(model)); return facts
  })
  await step('48khz-stereo-nonzero-window-review', async () => {
    await selectSource('english-stereo-48k.wav', 1, 6.855)
    const transcript = await transcribe()
    assert.equal(transcript.sourceSampleRate, 48000); assert.equal(transcript.channels, 2); assert.equal(transcript.sourceStartSample, 48000)
    assert(transcript.windows.some(window => window.timing === 'model' && window.segments.length))
    await page.getByLabel('Text 1', { exact: true }).fill('Reviewed local speech')
    await page.screenshot({ path: path.join(output, 'stereo-review.png') }); result.screenshots.push('stereo-review.png')
    await button('Apply transcription as one edit').click(); await button('Close caption editor').click()
    return { rate: transcript.sourceSampleRate, channels: transcript.channels, sourceStartSample: transcript.sourceStartSample }
  }, 300_000)
  let saved
  await step('atomic-apply-undo-redo-save-open', async () => {
    saved = await save('applied')
    assert(JSON.stringify(saved.file).includes('Reviewed local speech'))
    await command('Undo'); const undone = await save('undone'); assert(!JSON.stringify(undone.file).includes('Reviewed local speech'))
    await command('Redo'); const redone = await save('redone'); assert.deepEqual(redone.file, saved.file)
    page.on('dialog', dialog => void dialog.accept())
    await button('Projects').click(); await button('Open a project').click()
    await page.getByLabel('Choose a Myrelith project file', { exact: true }).setInputFiles(saved.location); await button('Open project').click()
    await expect(button('Captions')).toBeVisible()
    const reopened = await save('reopened'); assert.deepEqual(reopened.file, saved.file)
    await button('Captions').click(); await expect(page.getByRole('listbox', { name: 'Caption cues' })).toContainText('Reviewed local speech')
    await button('Export SRT').click()
    const losses = page.getByRole('checkbox', { name: 'I accept the disclosed download losses' }); if (await losses.count()) await losses.check()
    const pending = page.waitForEvent('download'); await button('Download caption file').click()
    const download = await pending, location = path.join(output, 'transcript.srt'); await download.saveAs(location)
    assert((await readFile(location, 'utf8')).includes('Reviewed local speech'))
    await button('Close caption editor').click()
    // Portable reopening intentionally needs the original media reconnected.
    await page.getByLabel('Import media', { exact: true }).setInputFiles([fixturePaths.stereo, fixturePaths['english.wav'], fixturePaths['french.wav'], fixturePaths['english-300.wav'], fixturePaths['silence.wav']])
    await openSpeech()
  })
  await step('short-untimed-manual-review', async () => {
    await selectSource('english.wav', 0, 1); const transcript = await transcribe()
    assert(transcript.windows.some(window => window.timing === 'unavailable'))
    await expect(button('Apply transcription as one edit')).toBeDisabled()
    await page.getByLabel('Start frame 1', { exact: true }).fill('17'); await page.getByLabel('End frame 1', { exact: true }).fill('47')
    await expect(button('Apply transcription as one edit')).toBeEnabled()
    await page.setViewportSize({ width: 390, height: 844 })
    const box = await speech().boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 390)
    await page.screenshot({ path: path.join(output, 'manual-review-390.png') }); result.screenshots.push('manual-review-390.png')
    await page.keyboard.press('Escape'); await expect(button('Transcribe local audio')).toBeFocused()
    await page.setViewportSize({ width: 1440, height: 900 }); await button('Transcribe local audio').click()
  }, 300_000)
  await step('french-explicit-language', async () => {
    await selectSource('french.wav', 0, 3.754, 'fr'); const transcript = await transcribe()
    assert(transcript.windows.some(window => window.timing === 'unavailable' ? window.text.length : window.segments.length))
    await button('Discard review').click()
  }, 300_000)
  await step('cancel-inference-play-pause-and-retry', async () => {
    await selectSource('english-300.wav', 0, 300)
    await button('Transcribe selected window').click()
    await page.waitForFunction(() => window.__speechAcceptance.jobs.at(-1)?.phases.some(phase => phase.category === 'infer'), null, { timeout: 120_000 })
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    await button('play').click(); await expect(page.locator('.transport-speech-status')).toContainText('waiting for speech cleanup')
    await button('pause').click()
    await page.waitForFunction(() => window.__speechAcceptance.jobs.at(-1)?.terminated, null, { timeout: 120_000 })
    await expect(button('play')).toBeVisible()
    const receipt = (await observed()).jobs.at(-1); assert.equal(receipt.reply.cooperativeZero, true); result.receipts.push(receipt)
    await openSpeech(); await selectSource('english-stereo-48k.wav', 1, 6.855); await transcribe(); await button('Discard review').click()
  }, 300_000)
  await step('300-second-production-window', async () => {
    await selectSource('english-300.wav', 0, 300); const transcript = await transcribe()
    assert.equal(transcript.windows.length, 12); assert.equal(transcript.sourceSampleCount, transcript.sourceSampleRate * 300)
    assert(transcript.windows.some(window => window.timing === 'unavailable'))
    await button('Discard review').click()
    return { windows: transcript.windows.length, timed: transcript.windows.filter(window => window.timing === 'model').length, untimed: transcript.windows.filter(window => window.timing === 'unavailable').length }
  }, 1_800_000)
  await step('warmed-runtime-offline-cached-model', async () => {
    const before = await cacheFacts(); await selectSource('english-stereo-48k.wav', 1, 6.855)
    await context.setOffline(true); await transcribe(); await button('Discard review').click()
    await context.setOffline(false); assert.deepEqual(await cacheFacts(), before)
  }, 300_000)
  await step('app-reload-retains-model-provenance', async () => {
    const before = await cacheFacts()
    await page.reload()
    await button('Start a new project').click(); await page.getByLabel('Project name', { exact: true }).fill('Reloaded speech cache'); await button('Create project').click()
    await openSpeech(); await expect(speech()).toContainText('Installed on this browser origin.')
    assert.deepEqual(await cacheFacts(), before)
    return { appFilesServed: true, modelDownloadedAgain: false }
  })
  await step('remove-model-final-cleanup', async () => {
    await button('Remove local model').click(); await expect(speech()).toContainText('The local speech model was removed.')
    await expect(button('Transcribe selected window')).toBeDisabled(); assert.equal((await cacheFacts()).models.length, 0)
    const observation = await observed(); assert(observation.jobs.every(job => job.terminated && job.reply.cooperativeZero))
    result.finalObservation = observation
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    await queue.take('final-cleanup')
  })
} catch (error) {
  if (!stopReason) {
    try { await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 1000 }) } catch { /* Preserve first failure. */ }
    fail(error)
  }
} finally {
  clearTimeout(overall)
  await closeBrowser().catch(error => result.errors.push({ message: error.message }))
  await bounded(new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }), 500, 'Server close timeout').catch(error => result.errors.push({ message: error.message }))
  if (result.release?.verifiedAbsent) await rm(profile, { recursive: true, force: true })
  result.memory = monitor.snapshot(); result.stopReason = stopReason ?? null
  result.passed = !result.stopReason && result.errors.length === 0 && result.memory.qualified && result.cases.length === 13
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, cases: result.cases.length, stopReason: result.stopReason,
    errors: result.errors.map(error => error.message ?? error.reason), memory: { baseline: result.memory.firstBaseline, peak: result.memory.peak,
      samples: result.memory.samples, maximumActiveEpochGapMs: result.memory.maximumActiveEpochGapMs, qualified: result.memory.qualified }, output }, null, 2))
  process.exitCode = result.passed ? 0 : 1
}
