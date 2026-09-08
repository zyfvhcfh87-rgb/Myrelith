// Requires an explicit exclusive slot. Serves only the frozen laboratory tree.
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { assessLabRun, corruptAudioReachedDecode, createLabSampleQueue, declaredLabRequest, initializationFailure, residentCeilingBreached } from './lab-contract.mjs'

if (process.env.ISSUE201_EXCLUSIVE_SLOT !== '1') throw new Error('Obtain the orchestrator exclusive slot before running inference; then set ISSUE201_EXCLUSIVE_SLOT=1')
const root = fileURLToPath(new URL('../../', import.meta.url))
const labRoot = path.join(root, '.tmp/issue201-speech-lab')
const evidence = path.join(root, 'docs/evidence/issue201')
const manifestBytes = await readFile(path.join(evidence, 'replacement-manifest.json'))
const manifest = JSON.parse(manifestBytes)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
if (git('status', '--porcelain', '--', 'scripts/issue201', 'docs/evidence/issue201/replacement-manifest.json')) throw new Error('Commit the harness and frozen replacement manifest before timing')
const source = { commit: git('rev-parse', 'HEAD'), manifestSha256: hash(manifestBytes), files: {} }
for (const filename of ['prepare-speech-lab.mjs', 'run-speech-lab.mjs', 'lab-client.mjs', 'model-worker.mjs', 'lab-contract.mjs']) {
  source.files[filename] = hash(await readFile(path.join(root, 'scripts/issue201', filename)))
}
if (Object.keys(manifest.runtime.advisories).length) throw new Error('Replacement runtime has unresolved advisory entries')

const served = new Map()
const add = async (url, filePath, contentType, immutable, expectedHash = null) => {
  const bytes = await readFile(filePath)
  if (expectedHash && hash(bytes) !== expectedHash) throw new Error(`Frozen asset differs: ${url}`)
  served.set(url, { bytes, gzip: immutable ? gzipSync(bytes, { level: 9 }) : null, contentType, immutable })
}
for (const artifact of manifest.runtime.artifacts) await add(`/assets/${artifact.name}`, path.join(labRoot, 'assets', artifact.name), artifact.name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', true, artifact.sha256)
for (const file of manifest.model.files) await add(`/model/${file.path}`, path.join(root, '.tmp/issue201-package-probe/model', file.path), 'application/octet-stream', false, file.sha256)
for (const fixture of manifest.fixtures) await add(`/fixtures/${fixture.name}.wav`, path.join(labRoot, 'fixtures', `${fixture.name}.wav`), 'audio/wav', true, fixture.sha256)
for (const fixture of manifest.derivatives) await add(`/fixtures/${fixture.name}`, path.join(labRoot, 'fixtures', fixture.name), 'audio/wav', true, fixture.sha256)
for (const filename of ['lab-client.mjs', 'model-worker.mjs', 'lab-contract.mjs']) await add(`/${filename}`, path.join(root, 'scripts/issue201', filename), 'text/javascript', true)
served.set('/manifest.json', { bytes: manifestBytes, contentType: 'application/json', immutable: true })
const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>Issue 201 speech laboratory</title><h1>Issue 201 speech laboratory</h1><p id="status">Loading source manifest.</p><script type="module" src="/lab-client.mjs"></script>')
served.set('/', { bytes: html, contentType: 'text/html', immutable: true })
const servedUrls = new Set([...served.keys()].map((entry) => `http://127.0.0.1:5201${entry}`))
const serverRequests = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:5201')
  if (!declaredLabRequest(url.href, request.method, servedUrls)) { response.writeHead(404); response.end(); return }
  if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
  const asset = served.get(url.pathname)
  if (!asset) { response.writeHead(404); response.end(); return }
  const compressed = asset.gzip && /gzip/u.test(request.headers['accept-encoding'] ?? '')
  const bytes = compressed ? asset.gzip : asset.bytes
  serverRequests.push({ url: url.pathname, encodedBytes: bytes.length, decodedBytes: asset.bytes.length, gzip: Boolean(compressed) })
  response.writeHead(200, { 'content-type': asset.contentType, 'content-length': String(bytes.length),
    'cache-control': asset.immutable ? 'public,max-age=31536000,immutable' : 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'",
    ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) })
  response.end(bytes)
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5201, '127.0.0.1', resolve) })
const profile = path.join(labRoot, `profile-${Date.now()}`)
await mkdir(profile, { recursive: true })
const results = []
const problems = []
const memory = []
const network = []
let context
let sampler
let sampling = false
let sampleQueue = null
let runtime = null
let memoryAssessment = null
let baselineMemory = null
let stopReason = null
let finalCleanup = null
const expect = (condition, message) => { if (!condition) throw new Error(message) }
const words = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/u).filter(Boolean)
function wordErrorRate(expected, actual) {
  const a = words(expected); const b = words(actual)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    previous = row
  }
  return previous[b.length] / Math.max(1, a.length)
}
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1024, height: 768 },
    args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'], acceptDownloads: false })
  let page = context.pages()[0] ?? await context.newPage()
  function observePage() {
    page.on('console', (message) => { if (message.type() === 'error') problems.push({ type: 'console', message: message.text().slice(0, 1_000) }) })
    page.on('pageerror', (error) => problems.push({ type: 'page-error', message: error.message }))
    context.on('request', (request) => {
      const url = request.url()
      network.push({ url, method: request.method() })
      if (!declaredLabRequest(url, request.method(), servedUrls)) problems.push({ type: 'undeclared-request', url, method: request.method() })
    })
  }
  observePage()
  let browserCdp = await context.browser().newBrowserCDPSession()
  runtime = { browserVersion: await browserCdp.send('Browser.getVersion'), platform: process.platform,
    architecture: process.arch, nodeVersion: process.version, threads: manifest.runtime.threads, device: manifest.runtime.device }
  async function sampleMemory(label = 'periodic') {
    if (sampling) return
    sampling = true
    try {
      const table = await browserCdp.send('SystemInfo.getProcessInfo')
      const pids = table.processInfo.map((entry) => entry.id)
      const output = execFileSync('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' })
      const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/u).map(Number))
      const complete = pids.every((pid) => rows.some(([id, rss]) => id === pid && Number.isFinite(rss)))
      memory.push({ at: Date.now(), label, complete, bytes: complete ? rows.reduce((sum, [, rss]) => sum + rss * 1024, 0) : null,
        processes: table.processInfo.map((entry) => ({ id: entry.id, type: entry.type })), rss: rows })
      const snapshot = memory.at(-1)
      if (label === 'idle-baseline' && complete) baselineMemory = snapshot.bytes
      if (!stopReason && complete && residentCeilingBreached(baselineMemory, snapshot.bytes, manifest.thresholds.maxIncrementalResidentBytes)) {
        stopReason = { type: 'resident-ceiling', at: Date.now(), baseline: baselineMemory, sample: snapshot.bytes,
          incremental: snapshot.bytes - baselineMemory, action: 'cancel job then close browser; no further cases' }
        problems.push(stopReason)
        clearInterval(sampler)
        await Promise.race([page.evaluate(() => globalThis.lab?.cancel('resident-ceiling')).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100))])
        await context.close().catch(() => {})
        stopReason.browserClosedAt = Date.now()
      }
    } catch (error) { memory.push({ at: Date.now(), label, complete: false, error: error.message }) }
    finally { sampling = false }
  }
  sampleQueue = createLabSampleQueue(sampleMemory, () => Boolean(stopReason))
  const takeSample = sampleQueue.take
  await page.goto('http://127.0.0.1:5201/')
  await page.waitForFunction(() => Boolean(globalThis.lab))
  await takeSample('idle-baseline')
  sampler = setInterval(() => { void takeSample() }, 250)
  async function check(name, action) {
    if (stopReason) throw new Error(`Laboratory stopped: ${stopReason.type}`)
    await page.evaluate(() => globalThis.lab?.resetEvents())
    process.stdout.write(`Starting ${name}\n`)
    const requestStart = serverRequests.length
    const began = Date.now()
    try {
      const data = await action()
      if (stopReason) throw new Error(`Laboratory stopped: ${stopReason.type}`)
      results.push({ name, passed: true, elapsedMs: Date.now() - began, data, serverRequests: serverRequests.slice(requestStart) })
    } catch (error) {
      const failedState = await page.evaluate(() => globalThis.lab?.state()).catch((cause) => ({ inspectionError: cause.message }))
      results.push({ name, passed: false, elapsedMs: Date.now() - began, error: error.message, failedState, serverRequests: serverRequests.slice(requestStart) })
      const prerequisite = initializationFailure(failedState?.events ?? [])
      if (prerequisite && !stopReason) {
        stopReason = { type: 'model-prerequisite', case: name, at: Date.now(), prerequisite }
        problems.push(stopReason)
      }
      await page.evaluate(() => globalThis.lab?.cancel('test-failed')).catch(() => {})
    }
    process.stdout.write(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`)
  }
  async function waitForJobPhase(expected) {
    await page.waitForFunction((phase) => {
      const state = lab.state()
      return state.phase === phase || state.events.some((event) => event.type === 'error' || event.type === 'complete')
    }, expected, { timeout: 120_000, polling: 10 })
    const state = await page.evaluate(() => lab.state())
    expect(state.phase === expected, `Job finished or failed before cancellation could observe ${expected}`)
  }
  await check('no-model-and-lazy-runtime', async () => {
    const failure = await page.evaluate(() => lab.transcribeFixture('english').then(() => null, (error) => error.message))
    expect(/No local speech model/u.test(failure), 'No-model status did not reject before worker creation')
    expect(!network.some(({ url }) => url.includes('/assets/') || url.includes('/model/')), 'Runtime/model requested before acquisition')
    return page.evaluate(() => lab.state())
  })
  await check('cancel-acquisition', async () => {
    await page.evaluate(() => { globalThis.pending = lab.installModel({ delayMs: 100 }).then((value) => ({ value }), (error) => ({ error: error.message })) })
    await page.waitForFunction(() => lab.state().phase === 'acquisition')
    const state = await page.evaluate(() => lab.cancel('acquisition-test'))
    const completion = await page.evaluate(() => globalThis.pending)
    expect(completion.error && state.acquisitionOwners === 0, 'Acquisition did not cancel/drain')
    return { state, completion, cache: await page.evaluate(() => lab.cacheFacts()) }
  })
  await check('verified-model-install', () => page.evaluate(() => lab.installModel()))
  for (const pauseAt of ['cache-write', 'cache-commit']) {
    await check(`cancel-${pauseAt}-restores-committed-model`, async () => {
      const before = await page.evaluate(() => lab.cacheFacts())
      await page.evaluate((stage) => { globalThis.pending = lab.installModel({ pauseAt: stage, pauseMs: 250 }).then((value) => ({ value }), (error) => ({ error: error.message })) }, pauseAt)
      await page.waitForFunction((stage) => lab.state().phase === `${stage}-pause`, pauseAt, { polling: 10 })
      const state = await page.evaluate(() => lab.cancel('cache-race'))
      const completion = await page.evaluate(() => globalThis.pending)
      const after = await page.evaluate(() => lab.cacheFacts())
      expect(completion.error && !state.acquisitionOwners && before.model.name === after.model.name
        && before.cacheNames.length === after.cacheNames.length, 'Cache cancellation did not restore the prior complete model/remove staging')
      return { before, state, completion, after }
    })
  }
  await check('corrupt-cache-rejected-before-inference', async () => {
    const outcome = await page.evaluate(async () => {
      const facts = await lab.cacheFacts()
      const cache = await caches.open(facts.model.name)
      const file = lab.manifest.model.files[0]
      const original = await cache.match(file.url)
      const bytes = new Uint8Array(await original.clone().arrayBuffer())
      bytes[0] ^= 1
      await cache.put(file.url, new Response(bytes, { headers: original.headers }))
      try { return { error: await lab.transcribeFixture('english').then(() => null, (error) => error.message), state: lab.state() } }
      finally { await cache.put(file.url, original) }
    })
    expect(/digest mismatch/u.test(outcome.error) && outcome.state.workerOwners === 0, 'Corrupt cache reached a worker')
    return outcome
  })
  await check('selected-local-files-install', () => page.evaluate(async () => {
    const facts = await lab.cacheFacts()
    const cache = await caches.open(facts.model.name)
    const localFiles = []
    for (const file of lab.manifest.model.files) localFiles.push({ path: file.path,
      file: new File([await (await cache.match(file.url)).blob()], file.path.split('/').at(-1)) })
    return lab.installModel({ localFiles })
  }))
  await check('capacity-rejection-preserves-model', async () => {
    const before = await page.evaluate(() => lab.cacheFacts())
    const error = await page.evaluate(() => lab.installModel({ byteLimit: 1 }).then(() => null, (cause) => cause.message))
    const after = await page.evaluate(() => lab.cacheFacts())
    expect(error && before.model.name === after.model.name, 'Capacity rejection changed the committed cache')
    return { error, before, after }
  })
  for (const name of ['english', 'english', 'french', 'silence']) {
    await check(`transcribe-${name}-${results.length}`, async () => {
      const result = await page.evaluate((fixture) => lab.transcribeFixture(fixture), name)
      expect(result.finalLedger.inputOwners === 0 && result.finalLedger.sampleOwners === 0 && result.finalLedger.pcmBytes === 0, 'Audio owners remain after job')
      expect(result.finalLedger.acquiredSamples === result.finalLedger.closedSamples, 'Decoded samples were not all closed')
      const fixture = manifest.fixtures.find((item) => item.name === name)
      const transcript = result.windows.map((window) => window.text).join(' ')
      const wer = fixture ? wordErrorRate(fixture.transcript, transcript) : null
      if (fixture) expect(wer <= manifest.thresholds[`${name}MaximumWordErrorRate`], `Fixture WER ${wer} exceeds frozen threshold`)
      else expect(transcript.trim() === '' && result.windows.every((window) => window.digitalSilenceSkipped), 'Digital silence was sent to inference or fabricated text')
      if (fixture) expect(result.windows.every((window) => window.chunks.length > 0 && window.chunks.every((chunk) => chunk.timed)), 'Fixture timestamps were missing, unordered or outside source coverage')
      const cleanup = await page.evaluate(() => lab.cancel('completed-job'))
      expect(cleanup.workerOwners === 0 && cleanup.lastCleanup?.cooperativeZero, 'Idle model did not cooperatively dispose within the frozen deadline')
      await takeSample(`closed-${name}`)
      return { result, wordErrorRate: wer, cleanup }
    })
  }
  await check('one-second-speech-window', async () => {
    const result = await page.evaluate(() => lab.transcribeFixture('english', { seconds: 1 }))
    expect(result.windows.length === 1 && result.windows[0].end === 1, 'Minimum window differs')
    return { result, cleanup: await page.evaluate(() => lab.cancel('minimum-window')) }
  })
  await check('corrupt-audio-rejection', async () => {
    const error = await page.evaluate(() => lab.transcribeFixture('corrupt').then(() => null,
      (cause) => ({ message: cause.message, code: cause.code, phase: cause.phase })))
    const state = await page.evaluate(() => lab.state())
    expect(corruptAudioReachedDecode(error, state),
      'Corrupt audio did not reach initialized-model decode rejection')
    return { error, state }
  })
  for (const phase of ['model-load', 'prepare', 'infer']) {
    await check(`cancel-${phase}`, async () => {
      await page.evaluate(() => { globalThis.pending = lab.transcribeFixture('english', { repeatSeconds: 300 }).then((value) => ({ value }), (error) => ({ error: error.message })) })
      await waitForJobPhase(phase)
      const state = await page.evaluate(() => lab.cancel('phase-cancel'))
      const completion = await page.evaluate(() => globalThis.pending)
      expect(completion.error && state.workerOwners === 0, 'Cancel did not reject/terminate the active worker')
      return { state, completion }
    })
  }
  await check('project-replacement', async () => {
    await page.evaluate(() => { globalThis.pending = lab.transcribeFixture('english', { repeatSeconds: 300 }).then((value) => ({ value }), (error) => ({ error: error.message })) })
    await waitForJobPhase('infer')
    const state = await page.evaluate(() => lab.replaceProject())
    const completion = await page.evaluate(() => globalThis.pending)
    expect(completion.error && state.workerOwners === 0, 'Project replacement accepted a stale result')
    return { state, completion }
  })
  await check('300-second-bounded-workload', async () => {
    const result = await page.evaluate(() => lab.transcribeFixture('english', { repeatSeconds: 300 }))
    expect(result.windows.length === 12 && result.finalLedger.maxPcmBytes <= manifest.thresholds.maxPcmBytes, 'Long job breached its bounded window plan')
    const cleanup = await page.evaluate(() => lab.cancel('long-job-complete'))
    await takeSample('closed-300-second')
    return { result, cleanup }
  })
  await check('offline-loaded-app-and-fresh-worker', async () => {
    await context.setOffline(true)
    try {
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      const cleanup = await page.evaluate(() => lab.cancel('offline-complete'))
      return { result, cleanup, cache: await page.evaluate(() => lab.cacheFacts()) }
    } finally { await context.setOffline(false) }
  })
  await check('offline-page-reload', async () => {
    await context.setOffline(true)
    try {
      await page.reload({ waitUntil: 'load' })
      await page.waitForFunction(() => Boolean(globalThis.lab), null, { timeout: 10_000 })
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      return { result, cleanup: await page.evaluate(() => lab.cancel('offline-reload-complete')) }
    } finally {
      await context.setOffline(false)
      if (!await page.evaluate(() => Boolean(globalThis.lab)).catch(() => false)) { await page.goto('http://127.0.0.1:5201/'); await page.waitForFunction(() => Boolean(globalThis.lab)) }
    }
  })
  await check('offline-persistent-browser-reopen', async () => {
    clearInterval(sampler)
    await sampleQueue.drain()
    await context.close()
    context = await chromium.launchPersistentContext(profile, { headless: true,
      args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'], acceptDownloads: false })
    page = context.pages()[0] ?? await context.newPage()
    observePage()
    browserCdp = await context.browser().newBrowserCDPSession()
    await takeSample('reopened-idle')
    sampler = setInterval(() => { void takeSample() }, 250)
    await context.setOffline(true)
    try {
      await page.goto('http://127.0.0.1:5201/')
      await page.waitForFunction(() => Boolean(globalThis.lab), null, { timeout: 10_000 })
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      return { result, cleanup: await page.evaluate(() => lab.cancel('offline-reopen-complete')) }
    } finally {
      await context.setOffline(false)
      if (!await page.evaluate(() => Boolean(globalThis.lab)).catch(() => false)) { await page.goto('http://127.0.0.1:5201/'); await page.waitForFunction(() => Boolean(globalThis.lab)) }
    }
  })
  await check('remove-model-and-offline-no-model', async () => {
    await page.evaluate(() => lab.clearModel())
    await context.setOffline(true)
    try {
      const error = await page.evaluate(() => lab.transcribeFixture('english').then(() => null, (cause) => cause.message))
      expect(/No local speech model/u.test(error), 'Offline missing-model behavior was unclear')
      return { error, state: await page.evaluate(() => lab.state()) }
    } finally { await context.setOffline(false) }
  })
  await takeSample('final-idle')
  const baseline = memory.find((entry) => entry.label === 'idle-baseline' && entry.complete)?.bytes
  const peak = Math.max(...memory.filter((entry) => entry.complete).map((entry) => entry.bytes))
  expect(Number.isFinite(baseline), 'Complete process baseline memory unavailable')
  memoryAssessment = { baseline, peak, incrementalPeak: peak - baseline,
    completeSamples: memory.filter((entry) => entry.complete).length,
    incompleteSamples: memory.filter((entry) => !entry.complete).length,
    closedSnapshots: memory.filter((entry) => entry.label.startsWith('closed-') || entry.label === 'final-idle'),
    maximumSampleGapMs: Math.max(0, ...memory.slice(1).map((entry, index) => entry.at - memory[index].at)),
    residualGrowthVerdict: 'Requires review of retained complete samples and repeated-job closed snapshots; no automatic allocator/leak equivalence.' }
  if (memoryAssessment.incompleteSamples) problems.push({ type: 'incomplete-memory-sampling', count: memoryAssessment.incompleteSamples })
  if (peak - baseline > manifest.thresholds.maxIncrementalResidentBytes) problems.push({ type: 'resident-ceiling', baseline, peak, delta: peak - baseline })
  for (const [filename, digest] of Object.entries(source.files)) expect(hash(await readFile(path.join(root, 'scripts/issue201', filename))) === digest, 'Laboratory source changed during qualification')
} finally {
  clearInterval(sampler)
  await sampleQueue?.drain()
  const page = context?.pages()[0]
  if (page && !page.isClosed()) {
    let timer
    try {
      finalCleanup = await Promise.race([
        page.evaluate(async () => {
          const state = await lab.clearModel()
          const cache = await lab.cacheFacts()
          const clean = state.workerOwners === 0 && state.acquisitionOwners === 0
            && cache.model.error === 'No local speech model is installed'
            && cache.cacheNames.every((name) => name === 'myrelith-issue201-lab-registry')
          return { status: clean ? 'verified' : 'failed', state, cache }
        }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timed-out' }), 1_000) }),
      ])
    } catch (error) { finalCleanup = { status: 'unavailable', reason: error.message } }
    finally { clearTimeout(timer) }
  } else finalCleanup = { status: 'unavailable', reason: 'Browser already closed; no cooperative cache-cleanup claim' }
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
  if (finalCleanup.status !== 'verified') problems.push({ type: 'final-cleanup-unverified', ...finalCleanup })
  const acceptance = assessLabRun(results, problems, stopReason)
  if (acceptance.automatedStatus !== 'passed') process.exitCode = 1
  const artifact = { kind: 'issue201-speech-lab-result-v1', recordedAt: new Date().toISOString(), source,
    qualification: 'Isolated laboratory only; production editor integration and broader audio/browser/language configurations are not qualified.',
    runtime, acceptance, results, problems, stopReason, finalCleanup, memoryAssessment, memory, network, serverRequests }
  await writeFile(path.join(labRoot, 'results.json'), `${JSON.stringify(artifact, null, 2)}\n`)
  process.stdout.write(JSON.stringify({ output: path.join(labRoot, 'results.json'), acceptance, passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length, problems: problems.length }) + '\n')
}
if (results.some((result) => !result.passed) || problems.length) process.exitCode = 1
