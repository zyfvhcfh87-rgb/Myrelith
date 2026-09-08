import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { platform } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirtyFingerprint, assertSourceIdentityUnchanged, chromiumDeviceMetadata } from '../performance/run-benchmark.mjs'
import { createEvidenceStore } from './evidenceStore.mjs'
import { bounded, closeOwnedResources, runCommand } from './runnerLifecycle.mjs'
import { diagnosticEvidence, runWithDiagnosticEvidence } from './diagnosticEvidence.mjs'

export const DIAGNOSTIC_INPUTS = [
  { name: 'source.mp4', bytes: 1_069_647, sha256: '55a7094a0d645e5ec67c7d266890d9c6c8500a125f3454408bdd467ef8ed6264' },
  { name: 'export-complete-0.mp4', bytes: 2_103_209, sha256: 'f31104bd0a9d26d8ae1285bd15798b625281f8222268c79a34d006481eba0f2c' },
]
export function diagnosticOptions(args) {
  const options = { expectedSha: null, output: null }
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--expected-sha') options.expectedSha = args[i + 1]
    else if (args[i] === '--output') options.output = args[i + 1]
    else throw new Error(`Unknown diagnostic option ${args[i]}`)
    if (!args[i + 1]) throw new Error('Diagnostic option value missing')
  }
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha ?? '')) throw new Error('Pin the reviewed full diagnostic SHA')
  return options
}
export function verifyDiagnosticInput(bytes, expected) {
  const actual = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Immutable diagnostic input changed: ${expected.name}`)
  return actual
}
export async function readDiagnosticInput(path, expected) {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size !== expected.bytes) throw new Error(`Immutable diagnostic input size changed: ${expected.name}`)
    const bytes = Buffer.alloc(expected.bytes)
    let offset = 0
    while (offset < bytes.byteLength) {
      const part = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (!part.bytesRead) throw new Error('Immutable diagnostic input became truncated')
      offset += part.bytesRead
    }
    if ((await handle.stat()).size !== expected.bytes) throw new Error('Immutable diagnostic input changed while reading')
    verifyDiagnosticInput(bytes, expected)
    return bytes
  } finally { await handle.close() }
}
async function identity(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim()
  return { commit, ...await bounded(dirtyFingerprint(root, commit), 30_000, 'Diagnostic source identity') }
}
function descendants() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return m ? { pid: Number(m[1]), parentPid: Number(m[2]), command: m[3] } : null
  }).filter(Boolean)
  const pids = new Set([process.pid])
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (pids.has(row.parentPid) && !pids.has(row.pid)) { pids.add(row.pid); changed = true } }
  return rows.filter((row) => pids.has(row.pid) && row.pid !== process.pid)
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === 'ESRCH') return false; throw cause } }
function portOpen() {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port: 5198 })
    let done = false
    const finish = (value) => { if (!done) { done = true; socket.destroy(); accept(value) } }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(true))
  })
}

export async function runDiagnostic(options) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), origin = 'http://127.0.0.1:5198'
  if (platform() !== 'darwin' || process.env.DEVELOPER_DIR !== '/Library/Developer/CommandLineTools') throw new Error('This owned diagnostic requires the reviewed Mac/CommandLineTools environment')
  const initial = await identity(root)
  if (initial.commit !== options.expectedSha || initial.dirty) throw new Error('Diagnostic source must match the reviewed clean SHA')
  if (await portOpen()) throw new Error('Strict diagnostic port5198 is occupied')
  const files = new Map()
  for (const expected of DIAGNOSTIC_INPUTS) {
    const bytes = await bounded(readDiagnosticInput(join(root, '.tmp/issue198-8129d4e-export-attempt1', expected.name), expected), 5000, 'Pinned diagnostic input')
    files.set(expected.name, bytes)
  }
  const directory = resolve(options.output ?? join(root, '.tmp', `issue198-${initial.commit.slice(0, 7)}-diagnostic-${Date.now()}`))
  if (!directory.startsWith(join(root, '.tmp') + '/')) throw new Error('Diagnostic evidence must be a fresh owned .tmp directory')
  const store = await bounded(createEvidenceStore(directory), 5000, 'Diagnostic evidence directory'), pids = new Set(), problems = []
  const evidence = diagnosticEvidence(store, { directory })
  let vite, server, browser, context, awake, failure, signalCleanup = Promise.resolve(), stopping = false, records = 0, servedMediaRequests = 0
  // Reserve three records for failure, teardown and evidence closure even after a producer hits its limit.
  const record = async (value) => { if (++records > 253) throw new Error('Diagnostic producer record count exceeds253'); await evidence.record(value) }
  const step = (operation, label) => bounded(Promise.resolve().then(() => { if (stopping) throw new Error('Diagnostic interrupted'); return operation() }), 30_000, label)
  const onSignal = () => {
    if (stopping) return
    stopping = true
    signalCleanup = bounded(Promise.resolve().then(() => server?.kill()), 10_000, 'Diagnostic interrupt force close')
      .catch((cause) => { problems.push({ kind: 'signal-cleanup', error: cause.message }) })
  }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  const captureOwned = async (kind) => {
    const processes = descendants()
    for (const entry of processes) pids.add(entry.pid)
    await record({ kind, processes })
  }
  const completion = await runWithDiagnosticEvidence(evidence, async () => {
    awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    await bounded(once(awake, 'spawn'), 5000, 'Diagnostic awake spawn'); pids.add(awake.pid)
    await record({ kind: 'diagnostic-run-start', source: initial, immutableInputs: DIAGNOSTIC_INPUTS,
      runnerPid: process.pid, awakePid: awake.pid, command: process.argv, strictPort: 5198,
      limits: { records: 256, recordBytes: 2 * 1024 * 1024, inputRequests: 2, hostDiagnosticMs: 120_000,
        setupStepMs: 30_000, ownerCloseMs: 10_000, forcedCloseMs: 10_000,
        durableWriteMs: 5000, evidenceCloseMs: 10_000, stdoutReceiptMs: 1000,
        timingScope: '120s bounds diagnostic evaluation only; setup and teardown have separate deadlines.' }, node: process.version })
    vite = await step(() => createServer({ root, server: { host: '127.0.0.1', port: 5198, strictPort: true }, logLevel: 'warn' }), 'Diagnostic Vite creation')
    vite.middlewares.use((req, res, next) => {
      const prefix = '/__issue198_diagnostic/'
      if (!req.url?.startsWith(prefix)) return next()
      const bytes = files.get(req.url.slice(prefix.length))
      if (req.method !== 'GET' || !bytes || ++servedMediaRequests > 2) { res.statusCode = 400; res.end('Invalid immutable input request'); return }
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', bytes.byteLength); res.setHeader('Cache-Control', 'no-store'); res.end(bytes)
    })
    await step(() => vite.listen(), 'Diagnostic Vite listen')
    const launch = { headless: true, args: ['--mute-audio'], timeout: 30_000 }
    server = await chromium.launchServer(launch); pids.add(server.process().pid)
    browser = await step(() => chromium.connect(server.wsEndpoint(), { timeout: 30_000 }), 'Diagnostic Chromium connect')
    context = await step(() => browser.newContext(), 'Diagnostic context')
    context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000)
    const page = await step(() => context.newPage(), 'Diagnostic page')
    page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) { problems.push({ kind: message.type(), message: message.text() }); onSignal() } })
    page.on('pageerror', (error) => { problems.push({ kind: 'pageerror', message: error.message }); onSignal() })
    await step(() => page.exposeBinding('__issue198DiagnosticRecord', async (caller, value) => {
      if (caller.page !== page || caller.frame !== page.mainFrame() || !caller.frame.url().startsWith(origin + '/')) throw new Error('Diagnostic record caller differs')
      await record({ ...value, source: 'browser' })
    }), 'Diagnostic evidence binding')
    await step(() => page.goto(origin + '/scripts/issue198/mask-performance-gate.html', { waitUntil: 'domcontentloaded' }), 'Diagnostic navigation')
    const cdp = await step(() => browser.newBrowserCDPSession(), 'Diagnostic CDP')
    await record({ kind: 'diagnostic-provenance', version: browser.version(), launch,
      gpu: await bounded(chromiumDeviceMetadata(cdp), 10_000, 'Diagnostic GPU provenance').catch((cause) => ({ status: 'unavailable', reason: cause.message })) })
    await captureOwned('diagnostic-process-start')
    assertSourceIdentityUnchanged(initial, await identity(root))
    if (problems.length) throw new Error(`Diagnostic browser problems: ${JSON.stringify(problems)}`)
    await bounded(page.evaluate(async () => {
      const { runPixelDiagnostic } = await import('/scripts/issue198/exportPixelDiagnostic.ts')
      await runPixelDiagnostic(async (value) => {
        await globalThis.__issue198DiagnosticRecord({ browserTimeMs: performance.now(), ...value })
      })
    }), 120_000, 'Immutable export pixel diagnostic')
    if (servedMediaRequests !== 2 || stopping || problems.length) throw new Error(`Diagnostic request/console/interruption failure: ${JSON.stringify(problems)}`)
    assertSourceIdentityUnchanged(initial, await identity(root))
    await record({ kind: 'diagnostic-run-observed', source: await identity(root), servedMediaRequests,
      interpretation: 'Diagnostic collection only. Frozen export remains failed until a separately reviewed fix and qualification.' })
  }, async (priorFailure) => {
    failure = priorFailure
    stopping = true; await signalCleanup
    await captureOwned('diagnostic-process-before-close').catch((cause) => { failure ??= cause })
    const result = await closeOwnedResources([
      { name: 'context', close: () => context?.close() }, { name: 'browser', close: () => browser?.close() },
      { name: 'browser-server', close: () => server?.close(), force: () => server?.kill() }, { name: 'vite', close: () => vite?.close() },
    ])
    failure ??= result.failure
    if (awake && awake.exitCode === null && awake.signalCode === null) {
      const exited = once(awake, 'exit'); awake.kill('SIGTERM')
      await bounded(exited, 5000, 'Diagnostic awake release').catch((cause) => { failure ??= cause })
    }
    const deadline = Date.now() + 5000
    let alivePids = [...pids].filter(alive)
    while (alivePids.length && Date.now() < deadline) { await new Promise((accept) => setTimeout(accept, 100)); alivePids = [...pids].filter(alive) }
    const occupied = await portOpen()
    if (alivePids.length || occupied || problems.length) failure ??= new Error('Diagnostic physical or console cleanup failure')
    try { assertSourceIdentityUnchanged(initial, await identity(root)) } catch (cause) { failure ??= cause }
    return { failure, cleanup: result.cleanup, runnerPid: process.pid, capturedPids: [...pids], alivePids,
      portOpen: occupied, problems, servedMediaRequests, parentMustVerifyRunnerAndPhysicalRelease: true }
  })
  failure = completion.failure
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
  process.stdout.write(`Diagnostic evidence: ${directory}\n`)
  if (failure) throw failure
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await runCommand(() => runDiagnostic(diagnosticOptions(process.argv.slice(2))))
