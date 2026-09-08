import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { platform, release, arch, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { dirtyFingerprint, assertSourceIdentityUnchanged, chromiumDeviceMetadata, sampleChromiumProcessMemory } from '../performance/run-benchmark.mjs'
import { createEvidenceStore } from './evidenceStore.mjs'
import { bounded, closeOwnedResources, runCommand } from './runnerLifecycle.mjs'
export { bounded } from './runnerLifecycle.mjs'

const SETUP_TIMEOUT_MS = 30_000
const setup = (operation, label) => bounded(Promise.resolve().then(operation), SETUP_TIMEOUT_MS, label)

export function parseOptions(args) {
  const options = { port: 5198, segment: null, expectedSha: null, output: null }
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1]
    if (value === undefined) throw new Error(`Missing value for ${args[index]}`)
    if (args[index] === '--expected-sha') options.expectedSha = value
    else if (args[index] === '--segment') options.segment = value
    else if (args[index] === '--output') options.output = value
    else if (args[index] === '--port') options.port = Number(value)
    else throw new Error(`Unknown option ${args[index]}`)
  }
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha ?? '')) throw new Error('--expected-sha must pin a full commit SHA')
  if (!['raster', 'export'].includes(options.segment)) throw new Error('--segment must be raster or export')
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Invalid strict port')
  return options
}

async function sourceIdentity(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim()
  return { commit, ...await setup(() => dirtyFingerprint(root, commit), 'Source fingerprint') }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === 'ESRCH') return false; throw cause }
}
async function portIsOpen(port) {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let done = false
    const finish = (value) => { if (!done) { done = true; socket.destroy(); accept(value) } }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(true))
  })
}
function processDescendants(rootPid) {
  if (platform() === 'win32') return { status: 'unavailable', reason: 'Host descendant command is not implemented for Windows.' }
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return match ? { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] } : null
    }).filter(Boolean)
    const owned = new Set([rootPid])
    for (let changed = true; changed;) { changed = false; for (const row of rows) if (owned.has(row.parentPid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true } }
    return { status: 'measured', processes: rows.filter((row) => owned.has(row.pid)) }
  } catch (cause) { return { status: 'unavailable', reason: cause.message } }
}

export async function run(options) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  if (platform() === 'darwin' && process.env.DEVELOPER_DIR !== '/Library/Developer/CommandLineTools') throw new Error('Set DEVELOPER_DIR to CommandLineTools; this runner never changes developer selection or accepts a license.')
  const initial = await sourceIdentity(root)
  if (initial.commit !== options.expectedSha || initial.dirty) throw new Error('The reviewed source SHA must match a clean worktree')
  if (await portIsOpen(options.port)) throw new Error('The strict port is already occupied')
  await mkdir(join(root, '.tmp'), { recursive: true })
  const directory = options.output ? resolve(options.output) : join(root, '.tmp', `issue198-${initial.commit.slice(0, 7)}-${options.segment}-${Date.now()}`)
  if (!directory.startsWith(join(root, '.tmp') + '/')) throw new Error('Evidence output must be a fresh directory under this worktree .tmp')
  const store = await createEvidenceStore(directory), problems = [], capturedPids = new Set()
  let vite, browserServer, browser, cdp, context, awake, nativeTimer, memoryPending = Promise.resolve(), signalCleanup = Promise.resolve(), failure
  let memoryIndex = 0, nativeBusy = false, stopping = false, measuredMemorySamples = 0, unavailableMemorySamples = 0
  const origin = `http://127.0.0.1:${options.port}`
  const onSignal = () => {
    if (stopping) return
    stopping = true
    signalCleanup = bounded(Promise.resolve().then(() => browserServer?.kill()), 10_000, 'Interrupted browser force close')
      .catch((cause) => { problems.push({ kind: 'signal-cleanup', message: cause.message }) })
  }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  const record = (value) => store.record(value)
  async function sampleMemory(label) {
    const result = await bounded(sampleChromiumProcessMemory(cdp, memoryIndex++), 10_000, 'Native process sampling')
      .catch((cause) => ({ status: 'unavailable', reason: cause.message }))
    if (result.status === 'measured') for (const entry of result.sample.processes) capturedPids.add(entry.pid)
    if (result.status === 'measured') measuredMemorySamples++; else unavailableMemorySamples++
    await record({ kind: 'native-memory-sample', label, result,
      interpretation: 'Sampled process footprint; not exact allocation peak, JS-only memory, or the 256 MiB logical render allowance.' })
  }
  try {
    if (platform() === 'darwin') {
      awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      await bounded(once(awake, 'spawn'), SETUP_TIMEOUT_MS, 'Scoped awake spawn'); capturedPids.add(awake.pid)
    }
    await record({ kind: 'run-start', options, source: initial, runnerPid: process.pid, awakePid: awake?.pid ?? null,
      host: { node: process.version, platform: platform(), release: release(), arch: arch(), cpus: cpus(), totalMemoryBytes: totalmem() } })
    vite = await setup(() => createServer({ root, server: { host: '127.0.0.1', port: options.port, strictPort: true }, logLevel: 'warn' }), 'Vite creation')
    await setup(() => vite.listen(), 'Vite listen')
    const launch = { headless: true, args: ['--mute-audio', '--enable-precise-memory-info'], timeout: 30_000 }
    browserServer = await chromium.launchServer(launch)
    capturedPids.add(browserServer.process().pid)
    browser = await setup(() => chromium.connect(browserServer.wsEndpoint(), { timeout: SETUP_TIMEOUT_MS }), 'Chromium connect')
    cdp = await setup(() => browser.newBrowserCDPSession(), 'Browser CDP session')
    context = await setup(() => browser.newContext({ viewport: { width: 1440, height: 1000 } }), 'Browser context')
    context.setDefaultTimeout(SETUP_TIMEOUT_MS)
    context.setDefaultNavigationTimeout(SETUP_TIMEOUT_MS)
    const page = await setup(() => context.newPage(), 'Browser page')
    page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push({ kind: message.type(), message: message.text() }) })
    page.on('pageerror', (error) => problems.push({ kind: 'pageerror', message: error.message }))
    function checkCaller(caller) { if (caller.page !== page || caller.frame !== page.mainFrame() || !caller.frame.url().startsWith(origin + '/')) throw new Error('Evidence binding caller is not the owned page') }
    await setup(() => page.exposeBinding('__issue198Record', async (caller, value) => { checkCaller(caller); await record({ ...value, source: 'browser' }) }), 'Record binding')
    await setup(() => page.exposeBinding('__issue198Binary', async (caller, part) => { checkCaller(caller); await store.binary(part) }), 'Binary binding')
    await setup(() => page.goto(origin + (options.segment === 'raster' ? '/scripts/issue198/mask-performance-gate.html' : '/'), { waitUntil: 'domcontentloaded' }), 'Initial navigation')
    await record({ kind: 'browser-provenance', version: browser.version(), launch, viewport: page.viewportSize(), gpu: await bounded(chromiumDeviceMetadata(cdp), 10_000, 'GPU provenance')
      .catch((cause) => ({ status: 'unavailable', reason: cause.message })),
      browser: await setup(() => page.evaluate(() => {
        const samples = []; let previous = performance.now()
        for (let index = 0; index < 10_000; index++) { const now = performance.now(); if (now > previous) samples.push(now - previous); previous = now }
        return { userAgent: navigator.userAgent, timeOrigin: performance.timeOrigin, crossOriginIsolated,
          timerPositiveDeltas: samples, timerMinimumMs: samples.length ? Math.min(...samples) : null }
      }), 'Browser timer provenance') })
    const owned = processDescendants(browserServer.process().pid)
    if (owned.status === 'measured') for (const entry of owned.processes) capturedPids.add(entry.pid)
    await record({ kind: 'process-start', owned })
    await sampleMemory('baseline')
    nativeTimer = setInterval(() => {
      if (nativeBusy || stopping) return
      nativeBusy = true
      memoryPending = sampleMemory('periodic').catch((cause) => { problems.push({ kind: 'memory-recorder', message: cause.message }) }).finally(() => { nativeBusy = false })
    }, 1000)
    const check = async () => {
      if (stopping) throw new Error('Run interrupted')
      if (problems.length) throw new Error(`Browser or evidence problem: ${JSON.stringify(problems)}`)
      assertSourceIdentityUnchanged(initial, await sourceIdentity(root))
    }
    if (options.segment === 'raster') {
      const cells = await setup(() => page.evaluate(async () => (await import('/scripts/issue198/maskPerformanceGate.ts')).cells), 'Raster cell enumeration')
      if (cells.length !== 180 || new Set(cells.map((cell) => JSON.stringify(cell))).size !== 180) throw new Error('Raster cell count/identity changed')
      for (const [index, cell] of cells.entries()) {
        await check(); await record({ kind: 'cell-dispatched', index, cell })
        await bounded(page.evaluate(async (cell) => {
          const gate = await import('/scripts/issue198/maskPerformanceGate.ts'), io = await import('/scripts/issue198/browserIO.ts')
          await gate.measureCell(cell, io.recordEvidence)
        }, cell), 90_000, `Raster cell ${index}`)
      }
      await record({ kind: 'held-selection-dispatched', warmups: 1000, measuredCalls: 5000 })
      await bounded(page.evaluate(async () => {
        const gate = await import('/scripts/issue198/maskPerformanceGate.ts'), io = await import('/scripts/issue198/browserIO.ts')
        await gate.measureHeldSelection(io.recordEvidence)
      }), 30_000, 'Held resolver measurement')
    } else {
      await setup(() => page.getByRole('button', { name: 'Start a new project' }).click(), 'New project action')
      await setup(() => page.getByLabel('Project name').fill('Issue198 resource export'), 'Project name action')
      await setup(() => page.getByLabel('Resolution').selectOption('720'), 'Resolution action')
      await setup(() => page.getByRole('button', { name: 'Create project', exact: true }).click(), 'Create project action')
      await setup(() => page.getByRole('button', { name: 'Commands' }).waitFor(), 'Project ready')
      const fixture = await bounded(page.evaluateHandle(async () => {
        const gate = await import('/scripts/issue198/exportResourceGate.ts'), io = await import('/scripts/issue198/browserIO.ts')
        return gate.prepareExportFixture(io.recordEvidence, io.persistBinary)
      }), 120_000, 'Export fixture preparation')
      try {
        for (let index = 0; index < 3; index++) for (const mode of ['complete', 'cancel', 'retry']) {
          await check(); await sampleMemory(`export-${index}-${mode}-before`)
          await bounded(page.evaluate(async ({ index, mode, fixture }) => {
            const gate = await import('/scripts/issue198/exportResourceGate.ts'), io = await import('/scripts/issue198/browserIO.ts')
            await gate.measureExportAttempt(index, mode, fixture, io.recordEvidence, io.persistBinary)
          }, { index, mode, fixture }), 150_000, `Export ${index} ${mode}`)
          await sampleMemory(`export-${index}-${mode}-settled`)
        }
      } finally {
        await bounded(fixture.dispose(), 10_000, 'Export fixture handle release')
          .catch((cause) => { problems.push({ kind: 'fixture-release', message: cause.message }) })
      }
    }
    await check(); await sampleMemory('segment-complete')
    await record({ kind: 'segment-complete', segment: options.segment, source: await sourceIdentity(root), problems })
  } catch (cause) {
    failure = cause
    await record({ kind: 'run-failed', error: cause?.stack ?? String(cause), problems })
  } finally {
    stopping = true; clearInterval(nativeTimer)
    await signalCleanup
    await bounded(memoryPending, 15_000, 'Memory sampling teardown').catch((cause) => { failure ??= cause })
    if (browserServer) {
      const owned = processDescendants(browserServer.process().pid)
      if (owned.status === 'measured') for (const entry of owned.processes) capturedPids.add(entry.pid)
      await record({ kind: 'process-before-close', owned })
    }
    const { cleanup, failure: cleanupFailure } = await closeOwnedResources([
      { name: 'context', close: () => context?.close() },
      { name: 'browser', close: () => browser?.close() },
      { name: 'browser-server', close: () => browserServer?.close(), force: () => browserServer?.kill() },
      { name: 'vite', close: () => vite?.close() },
    ])
    failure ??= cleanupFailure
    if (awake && awake.exitCode === null && awake.signalCode === null) {
      const exited = once(awake, 'exit'); awake.kill('SIGTERM')
      await bounded(exited, 5000, 'Scoped awake release').catch((cause) => { failure ??= cause })
    }
    const deadline = Date.now() + 5000
    let alive = [...capturedPids].filter(isAlive)
    while (alive.length && Date.now() < deadline) { await new Promise((accept) => setTimeout(accept, 100)); alive = [...capturedPids].filter(isAlive) }
    const portOpen = await portIsOpen(options.port)
    if (alive.length || portOpen) failure ??= new Error(`Teardown incomplete: PIDs ${alive}, portOpen=${portOpen}`)
    if (problems.length) failure ??= new Error(`Late browser/evidence problems: ${JSON.stringify(problems)}`)
    try { assertSourceIdentityUnchanged(initial, await sourceIdentity(root)) } catch (cause) { failure ??= cause }
    await record({ kind: 'run-teardown', cleanup, capturedPids: [...capturedPids], alivePids: alive, portOpen,
      problems, error: failure?.stack ?? null, nativeMemory: { measuredMemorySamples, unavailableMemorySamples,
        status: unavailableMemorySamples ? 'incomplete' : 'sampled', exactAllocationPeakProven: false },
      runnerPid: process.pid, runnerExitMustBeVerifiedByParent: true, outcome: failure ? 'failed' : 'segment-complete' })
    await store.close()
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
  }
  process.stdout.write(`Evidence: ${directory}\n`)
  if (failure) throw failure
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runCommand(() => run(parseOptions(process.argv.slice(2))))
}
