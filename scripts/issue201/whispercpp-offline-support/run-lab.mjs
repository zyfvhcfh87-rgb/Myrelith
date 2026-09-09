// Source-reviewed one-attempt runner. Importing this file never grants execution.
import { createHash } from 'node:crypto'
import { appendFile, writeFile, mkdir, rm, lstat, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { prepareRuntimeInputs } from './preflight.mjs'
import { assessReviewWindows } from '../whispercpp-untimed-review/review-acceptance.mjs'
import { createRuntimeResidentMonitor } from '../whispercpp-lab/resident-monitor.mjs'
import { HOST_LIMITS, caseDeadlineMs } from '../whispercpp-lab/host-limits.mjs'
import { captureCompleteResident, RSS_INTERVAL_MS } from '../whispercpp/resident-coverage.mjs'
import { assessLabRun, corruptAudioReachedDecode, createLabSampleQueue, declaredLabRequest } from '../lab-contract.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const labRoot = path.join(root, '.tmp/issue201-whispercpp-lab')
const profile = path.join(labRoot, 'profile-09')
const browserCacheRoot = chromium.executablePath().split('/chromium-')[0]
if (!path.isAbsolute(browserCacheRoot) || browserCacheRoot === chromium.executablePath()) throw new Error('Unreviewed bundled Chromium layout')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (!['--verify-inputs', '--run'].includes(process.argv[2]) || process.argv.length !== 3) throw new Error('Choose --verify-inputs or the separately granted --run')
const inputs = await bounded(prepareRuntimeInputs(root), HOST_LIMITS.inputVerificationMs, 'Runtime input verification timed out')
if (process.argv[2] === '--verify-inputs') {
  process.stdout.write(JSON.stringify({ status: 'runtime-inputs-verified-unexecuted', checkpointSha256: inputs.checkpointSha256,
    manifestSha256: hash(inputs.manifestBytes), assets: inputs.receipts, wasmExecuted: false }, null, 2) + '\n')
  process.exit(0)
}
if (process.env.ISSUE201_EXCLUSIVE_SLOT !== '1' || process.env.ISSUE201_PROTOCOL_SHA256 !== inputs.checkpointSha256) {
  throw new Error('Obtain an explicit exclusive runtime grant for this exact protocol checkpoint before --run')
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
  env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
if (git('status', '--porcelain', '--', 'scripts/issue201', 'docs/evidence/issue201/whispercpp-offline-runtime.json',
  'docs/evidence/issue201/whispercpp-generated')) throw new Error('Commit the exact runtime source and receipts before running')
if (process.platform !== 'darwin') throw new Error('This reviewed ps/process identity adapter is macOS-only')
await bounded(mkdir(labRoot, { recursive: true }), 1000, 'Laboratory output directory creation timed out')
await bounded(writeFile(path.join(labRoot, 'runtime-attempt-09.json'), JSON.stringify({ pid: process.pid,
  startedAt: new Date().toISOString(), checkpointSha256: inputs.checkpointSha256, commit: git('rev-parse', 'HEAD') }, null, 2) + '\n',
{ flag: 'wx', flush: true }), 1000, 'Exclusive attempt marker write timed out')
const manifest = inputs.manifest
const source = { commit: git('rev-parse', 'HEAD'), checkpointSha256: inputs.checkpointSha256,
  manifestSha256: hash(inputs.manifestBytes), model: manifest.model, assets: inputs.receipts,
  files: inputs.checkpoint.sourceFiles, references: inputs.checkpoint.referenceFiles }
const served = inputs.assets
for (const asset of served.values()) asset.gzip = asset.immutable ? gzipSync(asset.bytes, { level: 9 }) : null
const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>Issue 201 whisper.cpp laboratory</title><h1>Issue 201 whisper.cpp laboratory</h1><p id="status">Loading source manifest.</p><script type="module" src="/lab-client.mjs"></script>')
served.set('/', { bytes: html, contentType: 'text/html', immutable: true })
const servedUrls = new Set([...served.keys()].map(entry => `http://127.0.0.1:5201${entry}`))
const results = [], problems = [], network = [], serverRequests = [], browserClosures = [], browserLaunches = []
const monitor = createRuntimeResidentMonitor()
const memory = monitor.memory
const ownedProcesses = new Map()
let context = null, page = null, rawPage = null, browserCdp = null, sampler = null, sampleQueue = null
let runtime = null, stopReason = null, finalCleanup = null, memoryAssessment = null
let shutdownPromise = null, emergencyPromise = null, finalInputVerification = null, profileRemoval = null, profileCreated = false
let currentCase = null, overallTimer = null, serverRelease = null, physicalRelease = null, journalSequence = 0, journalBroken = false, journalOpened = false
let journalTail = Promise.resolve()
let resolveStop
const stopped = new Promise(resolve => { resolveStop = resolve })
function recordStop(problem) { stopReason ??= problem; resolveStop(stopReason) }
const journalPath = path.join(labRoot, 'runtime-partial-09.jsonl')
const expect = (condition, message) => { if (!condition) throw new Error(message) }
function failure(value) {
  problems.push(value)
  recordStop({ ...value, at: value.at ?? Date.now() })
  void journal('failure', { firstFailure: stopReason, problem: value })
  // Never await the current sample queue from inside its own capture callback.
  if (context && !shutdownPromise) void emergencyStop().catch(error => problems.push({ type: 'emergency-cleanup-error', message: error.message }))
}
let modelDownloadsBlocked = false
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:5201')
  if (!declaredLabRequest(url.href, request.method, servedUrls)) {
    failure({ type: 'undeclared-server-request', url: url.href, method: request.method })
    response.writeHead(404); response.end(); return
  }
  if (modelDownloadsBlocked && url.pathname.startsWith('/model/')) {
    failure({ type: 'model-download-during-cache-reuse', url: url.pathname })
    response.writeHead(403); response.end(); return
  }
  if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
  const asset = served.get(url.pathname)
  const compressed = asset.gzip && /gzip/u.test(request.headers['accept-encoding'] ?? '')
  const bytes = compressed ? asset.gzip : asset.bytes
  if (serverRequests.length >= 10_000) { failure({ type: 'server-request-record-budget' }); response.writeHead(503); response.end(); return }
  serverRequests.push({ url: url.pathname, encodedBytes: bytes.length, decodedBytes: asset.bytes.length,
    sha256: asset.sha256 ?? hash(asset.bytes), gzip: Boolean(compressed) })
  response.writeHead(200, { 'content-type': asset.contentType, 'content-length': String(bytes.length),
    'cache-control': asset.immutable ? 'public,max-age=31536000,immutable' : 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'",
    ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) })
  response.end(bytes)
})
async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds)
  })]) } finally { clearTimeout(timer) }
}
function boundedWork(promise, milliseconds, label) {
  return bounded(Promise.race([promise, stopped.then(reason => {
    throw new Error(`Laboratory stopped: ${reason.type}`)
  })]), milliseconds, label)
}
async function journal(type, value) {
  const line = JSON.stringify({ sequence: ++journalSequence, at: Date.now(), type, value }) + '\n'
  if (!journalOpened || journalBroken) { journalBroken = true; process.stdout.write('PARTIAL-EVIDENCE ' + line); return }
  const write = journalTail.then(() => appendFile(journalPath, line, { flag: 'a', flush: true }))
  journalTail = write.catch(() => {})
  try { await bounded(write, HOST_LIMITS.journalMs, 'Partial evidence write timed out') }
  catch (error) {
    journalBroken = true
    const problem = { type: 'partial-evidence-write-failed', message: error.message }
    problems.push(problem); recordStop(problem)
    process.stdout.write('PARTIAL-EVIDENCE ' + line)
    if (context && !shutdownPromise) void emergencyStop().catch(cause => problems.push({ type: 'emergency-cleanup-error', message: cause.message }))
  }
}
function guardedPort(port, methods, label) {
  return new Proxy(port, { get(target, property) {
    const value = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    if (!methods.includes(property)) return value.bind(target)
    return (...args) => {
      if (stopReason) return Promise.reject(new Error('Laboratory already stopped'))
      const remaining = currentCase ? currentCase.deadline - Date.now() : HOST_LIMITS.setupOperationMs
      const explicitWait = property === 'waitForFunction' ? args[2]?.timeout : undefined
      if (explicitWait !== undefined && (!Number.isFinite(explicitWait) || explicitWait <= 0
        || explicitWait > manifest.thresholds.maxWindowWallMs)) return Promise.reject(new Error('Unreviewed explicit phase wait'))
      const requested = property === 'evaluate' && currentCase ? remaining
        : currentCase && explicitWait !== undefined ? explicitWait : HOST_LIMITS.setupOperationMs
      const milliseconds = Math.min(remaining, requested)
      if (milliseconds <= 0) return Promise.reject(new Error(`${label} ${String(property)} deadline expired`))
      return boundedWork(Promise.resolve().then(() => value.apply(target, args)), milliseconds, `${label} ${String(property)} timed out`)
    }
  } })
}
function probePage(fn, milliseconds, label) {
  return bounded(rawPage?.evaluate(fn) ?? Promise.reject(new Error('Browser already closed')), milliseconds, label)
}
function parseProcesses(output, withRss) {
  if (!output.trim()) return []
  return output.trim().split('\n').map(line => {
    const columns = line.trim().split(/\s+/u), offset = withRss ? 2 : 1
    const pid = Number(columns[0]), rss = withRss ? Number(columns[1]) * 1024 : null
    const started = columns.slice(offset, offset + 5).join(' '), command = columns.slice(offset + 5).join(' ')
    if (!Number.isSafeInteger(pid) || pid < 1 || withRss && (!Number.isSafeInteger(rss) || rss < 0)
      || started.length < 20 || !command) throw new Error('Malformed complete ps process row')
    return { pid, rss, started, command }
  })
}
function physicalProcesses() {
  return parseProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8', timeout: 100 }), false)
}
function remainingOwned() {
  return physicalProcesses().filter(row => row.command.startsWith(browserCacheRoot + '/')
      && row.command.split(' ').includes('--user-data-dir=' + profile)
    || ownedProcesses.get(`${row.pid}:${row.started}`)?.command === row.command)
}
async function sampleMemory(label = 'periodic') {
  const startedAt = Date.now()
  const inventories = []
  let observedRss = [], partialPsOutput = null, processReadError = null
  let sample
  try {
    sample = await captureCompleteResident({ now: () => Date.now(),
      getProcessIds: async () => {
        const table = await bounded(browserCdp.send('SystemInfo.getProcessInfo'), 80, 'CDP process inventory timeout')
        const pids = table.processInfo.map(entry => entry.id)
        inventories.push(pids)
        return pids
      },
      readRssBytes: async pids => {
        if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('Invalid Chromium PID inventory')
        let output
        try { output = execFileSync('/bin/ps', ['-o', 'pid=,rss=,lstart=,command=', '-p', pids.join(',')],
          { encoding: 'utf8', timeout: 100 }) }
        catch (error) {
          output = String(error.stdout ?? '')
          partialPsOutput = output; processReadError = { message: error.message, status: error.status ?? null, code: error.code ?? null }
        }
        const rows = parseProcesses(output, true)
        for (const row of rows) ownedProcesses.set(`${row.pid}:${row.started}`, { pid: row.pid, started: row.started, command: row.command })
        observedRss = rows.map(row => [row.pid, row.rss])
        return observedRss
      } })
  } catch (error) { sample = { startedAt, at: Date.now(), beforePids: inventories[0] ?? [], afterPids: inventories[1] ?? [],
    rss: observedRss, error: error.message } }
  if (processReadError) sample = { ...sample, error: sample.error ?? 'Process RSS read failed', processReadError, partialPsOutput }
  const problem = monitor.observe(sample, label)
  const persisted = journal('resident-sample', monitor.memory.at(-1))
  if (problem) failure({ type: 'resident-qualification', ...problem })
  await persisted
}
async function takeSample(label) { return sampleQueue?.take(label) }
async function launchBrowser(label) {
  const startedAt = Date.now()
  shutdownPromise = null
  emergencyPromise = null
  if (stopReason) throw new Error('Laboratory stopped before browser launch')
  await journal('browser-launch-start', { label, startedAt, profile })
  if (stopReason) throw new Error('Laboratory stopped before browser launch')
  const created = await bounded(chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1024, height: 768 },
    timeout: HOST_LIMITS.browserInternalLaunchMs,
    args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'], acceptDownloads: false }),
  HOST_LIMITS.browserLaunchMs, 'Browser launch timed out')
  context = guardedPort(created, ['setOffline', 'newPage'], 'Browser context')
  if (stopReason) throw new Error('Laboratory stopped during browser launch')
  rawPage = context.pages()[0] ?? await context.newPage()
  page = guardedPort(rawPage, ['evaluate', 'goto', 'reload', 'waitForFunction'], 'Page')
  page.on('console', message => { if (message.type() === 'error') failure({ type: 'console', message: message.text().slice(0, 1000) }) })
  page.on('pageerror', error => failure({ type: 'page-error', message: error.message }))
  context.on('request', request => {
    if (network.length >= 10_000) { failure({ type: 'network-record-budget' }); return }
    network.push({ url: request.url(), method: request.method() })
    if (!declaredLabRequest(request.url(), request.method(), servedUrls)) failure({ type: 'undeclared-request', url: request.url(), method: request.method() })
  })
  browserCdp = await bounded(context.browser().newBrowserCDPSession(), 2000, 'Browser CDP session timed out')
  runtime ??= { browserVersion: await bounded(browserCdp.send('Browser.getVersion'), 1000, 'Browser version read timed out'), platform: process.platform,
    architecture: process.arch, nodeVersion: process.version, engine: manifest.runtime,
    bundleId: manifest.model.bundleId, configurationRevision: manifest.model.configurationRevision }
  if (label === 'initial-browser') {
    await page.goto('http://127.0.0.1:5201/')
    await page.waitForFunction(() => Boolean(globalThis.lab))
  }
  const readyAt = Date.now()
  browserLaunches.push({ label, startedAt, readyAt, elapsedMs: readyAt - startedAt,
    scope: 'Browser/bootstrap interval before candidate work; excluded from active-epoch cadence.' })
  await journal('browser-launch-ready', browserLaunches.at(-1))
  monitor.begin(label, readyAt)
  sampleQueue = createLabSampleQueue(sampleMemory, () => Boolean(stopReason))
  await takeSample(label === 'initial-browser' ? 'idle-baseline' : 'reopened-idle')
  if (stopReason) throw new Error('Browser baseline did not qualify')
  sampler = setInterval(() => { void takeSample() }, RSS_INTERVAL_MS)
}
async function closeOwnedBrowser(reason) {
  if (shutdownPromise) return shutdownPromise
  const closing = context
  if (!closing) return null
  shutdownPromise = (async () => {
    if (!stopReason) await takeSample('before-browser-close')
    clearInterval(sampler)
    if (!stopReason) await bounded(sampleQueue?.drain() ?? Promise.resolve(), HOST_LIMITS.sampleDrainMs, 'Sample drain timed out')
    const startedAt = Date.now(), errors = [], signals = []
    void journal('browser-close-start', { reason, startedAt, identities: [...ownedProcesses.values()] })
    try { await bounded(closing.close(), 200, 'Browser close exceeded 200 ms') }
    catch (error) { errors.push(error.message) }
    let remaining = remainingOwned()
    if (remaining.length) {
      // Exact owned PID + process-start + command identities are re-read before
      // each signal; never terminate unrelated browser sessions by name.
      for (const row of remaining) {
        if (Date.now() - startedAt > 1000) { errors.push('Owned signal loop deadline exceeded'); break }
        const current = remainingOwned().find(now => now.pid === row.pid && now.started === row.started && now.command === row.command)
        if (!current) continue
        try { process.kill(row.pid, 'SIGKILL'); signals.push({ ...row, signal: 'SIGKILL' }) }
        catch (error) { if (error.code !== 'ESRCH') errors.push(error.message) }
      }
      try { await bounded(closing.close(), 200, 'Browser close still pending after owned termination') } catch (error) { errors.push(error.message) }
      remaining = remainingOwned()
    }
    const at = Date.now()
    const receipt = { reason, startedAt, at, elapsedMs: at - startedAt, remaining,
      verifiedAbsent: remaining.length === 0, errors, signals, observedIdentities: [...ownedProcesses.values()] }
    browserClosures.push(receipt)
    context = null; page = null; rawPage = null; browserCdp = null
    const problem = monitor.close(receipt)
    if (problem) { problems.push({ type: 'browser-cleanup', ...problem }); recordStop({ type: 'browser-cleanup', ...problem }) }
    if (errors.length || signals.length) {
      const problem = { type: 'browser-forced-or-late-close', receipt }
      problems.push(problem); recordStop(problem)
    }
    await journal('browser-close-receipt', receipt)
    return receipt
  })()
  return shutdownPromise
}
async function emergencyStop() {
  if (emergencyPromise) return emergencyPromise
  emergencyPromise = (async () => {
    if (shutdownPromise) return shutdownPromise
    void journal('emergency-cleanup-start', { stopReason })
    try { await probePage(() => globalThis.lab?.cancel('laboratory-stop'), 100, 'Worker cancel observation timeout') }
    catch (error) { problems.push({ type: 'emergency-cancel-observation', message: error.message }) }
    return closeOwnedBrowser('first-failure')
  })()
  return emergencyPromise
}
async function removeOwnedProfile() {
  if (!profileCreated) return { status: 'not-created', scope: 'No pre-existing profile was adopted or removed.' }
  const remaining = remainingOwned()
  if (remaining.length) return { status: 'retained-live-processes', remaining }
  const info = await lstat(profile).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return { status: 'absent', files: 0, bytes: 0 }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Owned profile root is not a plain directory')
  let files = 0, bytes = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), info = await lstat(target)
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(target)
      else if (info.isFile()) { files++; bytes += info.size }
      // rm removes a symlink itself; it never follows that entry's target.
    }
  }
  await visit(profile)
  await rm(profile, { recursive: true })
  return { status: 'removed-owned-profile', path: profile, files, bytes,
    scope: 'Separate filesystem teardown, not an application Remove-model pass.' }
}
async function forceOwnedAbsence() {
  if (!profileCreated) return { status: 'no-owned-profile-created', verifiedAbsent: true, remaining: [], signals: [] }
  const startedAt = Date.now(), signals = [], errors = []
  let remaining = remainingOwned()
  for (const row of remaining) {
    if (Date.now() - startedAt > 1000) { errors.push('Owned termination deadline exceeded'); break }
    const current = remainingOwned().find(now => now.pid === row.pid && now.started === row.started && now.command === row.command)
    if (!current) continue
    try { process.kill(row.pid, 'SIGKILL'); signals.push({ ...row, signal: 'SIGKILL' }) }
    catch (error) { if (error.code !== 'ESRCH') errors.push(error.message) }
  }
  if (signals.length) await new Promise(resolve => setTimeout(resolve, 25))
  remaining = remainingOwned()
  const at = Date.now(), receipt = { status: remaining.length ? 'owned-processes-remain' : 'verified-absent', reason: 'final-physical-verification',
    startedAt, at, elapsedMs: at - startedAt, remaining, verifiedAbsent: remaining.length === 0, signals, errors }
  const problem = monitor.close(receipt)
  if (problem || signals.length || errors.length) problems.push({ type: 'fallback-physical-cleanup', receipt, problem })
  return receipt
}
async function closeServer() {
  const startedAt = Date.now(), errors = []
  if (!server.listening) return { status: 'not-listening', listening: false, elapsedMs: 0 }
  const completion = new Promise(resolve => server.close(resolve))
  try { await bounded(completion, HOST_LIMITS.serverCloseMs, 'HTTP server close timed out') }
  catch (error) {
    errors.push(error.message)
    server.closeAllConnections(); server.closeIdleConnections()
    try { await bounded(completion, HOST_LIMITS.forcedServerCloseMs, 'HTTP close callback remains unavailable') }
    catch (cause) { errors.push(cause.message) }
  }
  server.unref()
  return { status: server.listening ? 'still-listening' : 'not-listening', listening: server.listening,
    elapsedMs: Date.now() - startedAt, errors }
}

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

overallTimer = setTimeout(() => failure({ type: 'overall-host-deadline', milliseconds: HOST_LIMITS.overallMs }), HOST_LIMITS.overallMs)
try {
  await bounded(writeFile(journalPath, '', { flag: 'wx', flush: true }), HOST_LIMITS.journalMs, 'Exclusive journal creation timed out')
  journalOpened = true
  await journal('run-start', { source, hostLimits: HOST_LIMITS })
  if (stopReason) throw new Error('Could not persist initial source receipt')
  await bounded(mkdir(profile), 1000, 'Owned profile creation timed out')
  profileCreated = true
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(5201, '127.0.0.1', resolve) }),
    1000, 'Owned HTTP server start timed out')
  await launchBrowser('initial-browser')
  async function check(name, action) {
    if (stopReason) throw new Error(`Laboratory stopped: ${stopReason.type}`)
    const requestStart = serverRequests.length, began = Date.now(), milliseconds = caseDeadlineMs(name)
    currentCase = { name, began, deadline: began + milliseconds, milliseconds }
    process.stdout.write(`Starting ${name}\n`)
    await journal('case-start', currentCase)
    try {
      const data = await boundedWork((async () => {
        await page.evaluate(() => globalThis.lab?.resetEvents())
        return action()
      })(), Math.max(1, currentCase.deadline - Date.now()), `Case ${name} exceeded its host deadline`)
      if (stopReason) throw new Error(`Laboratory stopped: ${stopReason.type}`)
      results.push({ name, passed: true, elapsedMs: Date.now() - began, data, serverRequests: serverRequests.slice(requestStart) })
    } catch (error) {
      const failedState = await probePage(() => globalThis.lab?.state(), 100, 'Failed-state observation timeout')
        .catch(cause => ({ inspectionError: cause.message }))
      results.push({ name, passed: false, elapsedMs: Date.now() - began, error: error.message, failedState,
        serverRequests: serverRequests.slice(requestStart) })
      failure({ type: 'case-failure', case: name, message: error.message })
      await bounded(emergencyStop(), 3000, 'Emergency cleanup exceeded its host deadline').catch(cause => problems.push({ type: 'emergency-cleanup-timeout', message: cause.message }))
    } finally { currentCase = null }
    await journal('case-result', results.at(-1))
    process.stdout.write(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`)
    if (stopReason) throw new Error(`Laboratory stopped after ${name}`)
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
      const review = assessReviewWindows(result.windows, fixture?.durationSeconds ?? 1)
      const transcript = result.windows.map((window) => window.text).join(' ')
      const wer = fixture ? wordErrorRate(fixture.transcript, transcript) : null
      if (fixture) expect(wer <= manifest.thresholds[`${name}MaximumWordErrorRate`], `Fixture WER ${wer} exceeds frozen threshold`)
      else expect(transcript.trim() === '' && result.windows.every((window) => window.digitalSilenceSkipped), 'Digital silence was sent to inference or fabricated text')
      if (fixture) expect(review.untimedWindows === 0 && result.windows.every((window) => window.chunks.length > 0 && window.chunks.every((chunk) => chunk.timed)), 'Fixture timestamps were missing, unordered or outside source coverage')
      const cleanup = await page.evaluate(() => lab.cancel('completed-job'))
      expect(cleanup.workerOwners === 0 && cleanup.lastCleanup?.cooperativeZero, 'Idle model did not cooperatively dispose within the frozen deadline')
      await takeSample(`closed-${name}`)
      return { result, review, wordErrorRate: wer, cleanup }
    })
  }
  await check('one-second-speech-window', async () => {
    // Explicitly revised contract: preserve the whole window as untimed text.
    // Historical rejected runs stay frozen; source coverage never becomes cues.
    const before = await page.evaluate(() => lab.state())
    const result = await page.evaluate(() => lab.transcribeFixture('english', { seconds: 1 }))
    const review = assessReviewWindows(result.windows, 1)
    expect(review.untimedWindows === 1 && review.timedCues === 0,
      'Short-source coverage failure did not remain explicit untimed review')
    expect(result.finalLedger.inputOwners === 0 && result.finalLedger.sampleOwners === 0
      && result.finalLedger.pcmBytes === 0
      && result.finalLedger.acquiredSamples === result.finalLedger.closedSamples,
    'Untimed short source retained audio owners')
    const cleanup = await page.evaluate(() => lab.cancel('short-untimed-review-complete'))
    expect(cleanup.generation === before.generation && cleanup.workerOwners === 0
      && cleanup.lastCleanup?.cooperativeZero === true && !cleanup.admissionFailure,
    'Untimed short source changed generation or failed cooperative disposal')
    await takeSample('closed-short-untimed-review')
    return { result, review, cleanup, supportLimit: 'Timing unavailable; explicit manual timing required before Apply' }
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
      const retiring = await page.evaluate(() => {
        globalThis.retirement = lab.cancel('phase-cancel')
        return lab.state()
      })
      const completion = await page.evaluate(() => globalThis.pending)
      const state = await page.evaluate(() => globalThis.retirement)
      expect(retiring.phase === 'disposing' && retiring.workerOwners === 1,
        'Cancellation released admission before its acknowledgement')
      expect(completion.error && state.workerOwners === 0 && state.lastCleanup?.cooperativeZero === true
        && !state.admissionFailure, 'Cancel did not reject and cooperatively retire the active worker')
      return { retiring, state, completion }
    })
  }
  await check('project-replacement', async () => {
    await page.evaluate(() => { globalThis.pending = lab.transcribeFixture('english', { repeatSeconds: 300 }).then((value) => ({ value }), (error) => ({ error: error.message })) })
    await waitForJobPhase('infer')
    const retiring = await page.evaluate(() => {
      globalThis.retirement = lab.replaceProject()
      return lab.state()
    })
    const completion = await page.evaluate(() => globalThis.pending)
    const state = await page.evaluate(() => globalThis.retirement)
    expect(retiring.phase === 'disposing' && retiring.workerOwners === 1,
      'Project replacement released admission before its acknowledgement')
    expect(completion.error && state.workerOwners === 0 && state.lastCleanup?.cooperativeZero === true
      && !state.admissionFailure, 'Project replacement accepted stale output or unacknowledged retirement')
    return { retiring, state, completion }
  })
  await check('300-second-bounded-workload', async () => {
    const result = await page.evaluate(() => lab.transcribeFixture('english', { repeatSeconds: 300 }))
    expect(result.windows.length === 12 && result.finalLedger.maxPcmBytes <= manifest.thresholds.maxPcmBytes, 'Long job breached its bounded window plan')
    const review = assessReviewWindows(result.windows, 300, { requireSpeech: true })
    expect(review.untimedWindows > 0 && result.windows[2].timing === 'unavailable',
      'Known full-window coverage failure did not remain explicit untimed review')
    const cleanup = await page.evaluate(() => lab.cancel('long-job-complete'))
    expect(cleanup.workerOwners === 0 && cleanup.lastCleanup?.cooperativeZero === true
      && !cleanup.admissionFailure, 'Long job did not cooperatively retire its model')
    await takeSample('closed-300-second')
    return { result, review, cleanup }
  })
  await check('offline-loaded-app-and-fresh-worker', async () => {
    await context.setOffline(true)
    try {
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      const review = assessReviewWindows(result.windows, manifest.fixtures.find(fixture => fixture.name === 'english').durationSeconds)
      expect(review.untimedWindows === 0 && review.timedCues > 0, 'Offline fixture lost its validated timed output')
      const cleanup = await page.evaluate(() => lab.cancel('offline-complete'))
      return { result, review, cleanup, cache: await page.evaluate(() => lab.cacheFacts()) }
    } finally { await context.setOffline(false) }
  })
  // Opening the app requires its files to be served; model downloads remain
  // blocked during recovery. Cache Storage provenance and inference are still
  // verified offline after navigation, with a fresh worker on every page.
  modelDownloadsBlocked = true
  await check('offline-page-reload', async () => {
    const before = await page.evaluate(() => lab.cacheFacts())
    expect(before.model?.name && !before.model.error, 'No verified model before reload')
    await context.setOffline(true)
    let offlineNavigation
    try {
      try {
        await page.reload({ waitUntil: 'load' })
        offlineNavigation = { status: 'browser-cache-navigation', supportedGuarantee: false }
      } catch (error) {
        if (!/net::ERR_INTERNET_DISCONNECTED/u.test(error.message)) throw error
        offlineNavigation = { status: 'requires-app-connection', error: error.message }
      }
      await context.setOffline(false)
      await page.goto('http://127.0.0.1:5201/', { waitUntil: 'load' })
      await page.waitForFunction(() => Boolean(globalThis.lab), null, { timeout: 10_000 })
      const after = await page.evaluate(() => lab.cacheFacts())
      expect(JSON.stringify(before.model) === JSON.stringify(after.model), 'Cached model provenance changed across reload')
      await context.setOffline(true)
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      const review = assessReviewWindows(result.windows, manifest.fixtures.find(fixture => fixture.name === 'english').durationSeconds)
      expect(review.untimedWindows === 0 && review.timedCues > 0, 'Reloaded app lost offline timed transcription')
      const cleanup = await page.evaluate(() => lab.cancel('offline-reload-complete'))
      expect(cleanup.workerOwners === 0 && cleanup.lastCleanup?.cooperativeZero === true
        && !cleanup.admissionFailure, 'Reloaded worker failed cooperative disposal')
      return { offlineNavigation, modelDownloadsBlocked, before, after, result, review, cleanup,
        support: 'App connection required to reopen; verified cached model transcribes offline after load' }
    } finally { await context.setOffline(false) }
  })
  await check('offline-persistent-browser-reopen', async () => {
    const before = await page.evaluate(() => lab.cacheFacts())
    expect(before.model?.name && !before.model.error, 'No verified model before browser reopen')
    await closeOwnedBrowser('planned-offline-reopen')
    if (stopReason) throw new Error('Reopen stopped after a failed browser cleanup receipt')
    await launchBrowser('reopened-browser')
    await context.setOffline(true)
    let offlineNavigation
    try {
      try {
        await page.goto('http://127.0.0.1:5201/', { waitUntil: 'load' })
        offlineNavigation = { status: 'browser-cache-navigation', supportedGuarantee: false }
      } catch (error) {
        if (!/net::ERR_INTERNET_DISCONNECTED/u.test(error.message)) throw error
        offlineNavigation = { status: 'requires-app-connection', error: error.message }
      }
      await context.setOffline(false)
      await page.goto('http://127.0.0.1:5201/', { waitUntil: 'load' })
      await page.waitForFunction(() => Boolean(globalThis.lab), null, { timeout: 10_000 })
      const after = await page.evaluate(() => lab.cacheFacts())
      expect(JSON.stringify(before.model) === JSON.stringify(after.model), 'Persistent reopen lost cached model provenance')
      await context.setOffline(true)
      const result = await page.evaluate(() => lab.transcribeFixture('english'))
      const review = assessReviewWindows(result.windows, manifest.fixtures.find(fixture => fixture.name === 'english').durationSeconds)
      expect(review.untimedWindows === 0 && review.timedCues > 0, 'Reopened app lost offline timed transcription')
      const cleanup = await page.evaluate(() => lab.cancel('offline-reopen-complete'))
      expect(cleanup.workerOwners === 0 && cleanup.lastCleanup?.cooperativeZero === true
        && !cleanup.admissionFailure, 'Reopened worker failed cooperative disposal')
      return { offlineNavigation, modelDownloadsBlocked, before, after, result, review, cleanup,
        support: 'App connection required to reopen; verified cached model transcribes offline after load' }
    } finally { await context.setOffline(false) }
  })
  await check('remove-model-and-offline-no-model', async () => {
    await page.evaluate(() => lab.clearModel())
    await context.setOffline(true)
    try {
      const error = await page.evaluate(() => lab.transcribeFixture('english').then(() => null, (cause) => cause.message))
      expect(/No local speech model/u.test(error), 'Offline missing-model behavior was unclear')
      const state = await page.evaluate(() => lab.state())
      const cache = await page.evaluate(() => lab.cacheFacts())
      expect(state.workerOwners === 0 && state.acquisitionOwners === 0 && !state.admissionFailure,
        'Missing model started work or retained ownership')
      expect(/No local speech model/u.test(cache.model?.error ?? '')
        && !cache.cacheNames.some(name => name.startsWith('myrelith-issue201-whispercpp-lab-model-')),
      'Remove-model left a committed model or model bytes in Cache Storage')
      return { error, state, cache, modelDownloadsBlocked }
    } finally { await context.setOffline(false) }
  })
  await takeSample('final-idle')
} catch (error) {
  failure({ type: 'runner-stopped', message: error.message })
 } finally {
  clearTimeout(overallTimer)
  currentCase = null
  if (emergencyPromise) await bounded(emergencyPromise, 3000, 'Emergency cleanup deadline').catch(error => problems.push({ type: 'emergency-cleanup-error', message: error.message }))
  void journal('final-cleanup-start', { stopReason, results, latestSample: memory.at(-1) ?? null })
  if (page && !page.isClosed() && !stopReason) {
    try {
      finalCleanup = await probePage(async () => {
        const state = await lab.clearModel(), cache = await lab.cacheFacts()
        const clean = state.workerOwners === 0 && state.acquisitionOwners === 0
          && cache.model.error === 'No local speech model is installed'
          && cache.cacheNames.every(name => name === 'myrelith-issue201-whispercpp-lab-registry')
        return { status: clean ? 'verified' : 'failed', state, cache }
      }, 1000, 'Final model/cache cleanup timed out')
    } catch (error) { finalCleanup = { status: 'unavailable', reason: error.message } }
  } else finalCleanup = { status: 'unavailable', reason: 'Browser closed after failure; no cooperative model/cache cleanup claim' }
  try { await bounded(closeOwnedBrowser('final-cleanup'), 3000, 'Final browser cleanup deadline') }
  catch (error) { problems.push({ type: 'physical-browser-cleanup-error', message: error.message }) }
  clearInterval(sampler)
  await bounded(sampleQueue?.drain() ?? Promise.resolve(), HOST_LIMITS.sampleDrainMs, 'Final sample drain deadline')
    .catch(error => problems.push({ type: 'sample-drain-error', message: error.message }))
  try { physicalRelease = await forceOwnedAbsence() }
  catch (error) { physicalRelease = { status: 'unverified', verifiedAbsent: false, error: error.message } }
  if (!physicalRelease.verifiedAbsent) problems.push({ type: 'physical-process-release-unverified', ...physicalRelease })
  await journal('physical-release', physicalRelease)
  try { serverRelease = await closeServer() }
  catch (error) { serverRelease = { status: 'unverified', listening: server.listening, error: error.message }; server.unref() }
  if (serverRelease.listening || serverRelease.errors?.length || serverRelease.error) problems.push({ type: 'server-release', ...serverRelease })
  await journal('server-release', serverRelease)
  try { profileRemoval = await bounded(removeOwnedProfile(), HOST_LIMITS.profileCleanupMs, 'Owned profile removal deadline') }
  catch (error) { profileRemoval = { status: 'failed', message: error.message } }
  if (!['removed-owned-profile', 'absent', 'not-created'].includes(profileRemoval.status)) problems.push({ type: 'owned-profile-cleanup-unverified', ...profileRemoval })
  await journal('profile-removal', profileRemoval)
  if (finalCleanup.status !== 'verified') problems.push({ type: 'final-cleanup-unverified', ...finalCleanup })
  memoryAssessment = monitor.snapshot()
  if (!memoryAssessment.qualified) problems.push({ type: 'resident-coverage-unqualified', failures: memoryAssessment.failures })
  try {
    const after = await bounded(prepareRuntimeInputs(root), HOST_LIMITS.inputVerificationMs, 'Final input verification timed out')
    expect(after.checkpointSha256 === source.checkpointSha256, 'Runtime checkpoint changed during qualification')
    expect(hash(after.manifestBytes) === source.manifestSha256, 'Runtime manifest changed during qualification')
    finalInputVerification = { status: 'verified', checkpointSha256: after.checkpointSha256, assets: after.receipts }
  } catch (error) { finalInputVerification = { status: 'failed', message: error.message }; problems.push({ type: 'final-input-drift', ...finalInputVerification }) }
  const acceptance = assessLabRun(results, problems, stopReason)
  const exitCode = acceptance.automatedStatus === 'passed' ? 0 : 1
  process.exitCode = exitCode
  const artifact = { kind: 'issue201-whispercpp-lab-result-v1', recordedAt: new Date().toISOString(), source,
    qualification: 'Isolated exact-candidate laboratory only. No production or broader language/audio/browser qualification.',
    runtime, acceptance, results, problems, stopReason, finalCleanup, finalInputVerification, memoryAssessment,
    memory, browserLaunches, browserClosures, physicalRelease, serverRelease, profileRemoval, network, serverRequests,
    hostLimits: HOST_LIMITS, journal: { path: journalPath, records: journalSequence, broken: journalBroken } }
  const output = path.join(labRoot, 'runtime-results-09.json')
  try { await bounded(writeFile(output, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', flush: true }), HOST_LIMITS.journalMs, 'Final evidence write timed out') }
  catch (error) {
    process.exitCode = 1
    process.stdout.write('FINAL-EVIDENCE-FALLBACK ' + JSON.stringify({ ...artifact, outputError: error.message }) + '\n')
  }
  await journal('run-complete', { output, acceptance, physicalRelease, serverRelease, profileRemoval })
  await bounded(journalTail, HOST_LIMITS.journalMs, 'Journal drain deadline').catch(() => {})
  const summary = JSON.stringify({ output, acceptance, physicalRelease, serverRelease, profileRemoval,
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length }) + '\n'
  await bounded(new Promise(resolve => process.stdout.write(summary, resolve)), 250, 'Summary output flush deadline').catch(() => {})
  // Unresolved browser/FS promises cannot hold this owned runner alive forever.
  // Release is claimed only by the explicit physical and listener receipts.
  process.exit(process.exitCode)
}
