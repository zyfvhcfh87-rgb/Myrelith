// Execute the real runner control flow against inert server/browser/process/FS
// ports. No WebAssembly API, generated factory or actual process exists here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import vm from 'node:vm'
import test from 'node:test'
import * as contract from '../lab-contract.mjs'
import * as coverage from '../whispercpp/resident-coverage.mjs'
import * as monitor from '../whispercpp-lab/resident-monitor.mjs'
import * as hostLimits from '../whispercpp-lab/host-limits.mjs'

const root = new URL('../../../', import.meta.url)
const source = readFileSync(new URL('scripts/issue201/whispercpp-diagnostic-run/run-lab.mjs', root), 'utf8')
const manifestBytes = readFileSync(new URL('docs/evidence/issue201/whispercpp-diagnostic-runtime-source/manifest.json', root))
const manifest = JSON.parse(manifestBytes)
async function runInert({ allowed = true, churn = false, profileExists = false, stall = null, writes = new Map() } = {}) {
  let alive = false, launches = 0, closes = 0, inventories = 0, removes = 0, kills = 0
  const stdout = [], requests = [], errors = [], timers = new Set(), intervals = new Set()
  const never = () => new Promise(() => {})
  const checkpointSha256 = 'c'.repeat(64)
  const profile = '/repo/.tmp/issue201-whispercpp-lab/profile-02'
  const command = `/cache/chromium_headless_shell-1234/chrome --user-data-dir=${profile}`
  const prepared = () => ({ manifest, manifestBytes, checkpointSha256, assets: new Map(), receipts: [],
    checkpoint: { sourceFiles: [], referenceFiles: [], records: [] } })
  const state = () => ({ events: [], workerOwners: 0, acquisitionOwners: 0 })
  const page = {
    on() {}, async goto() {}, async waitForFunction() {}, isClosed: () => !alive,
    async evaluate(fn) {
      const text = fn.toString(); requests.push(text)
      if (text.includes('resetEvents')) return
      if (text.includes('transcribeFixture')) return ['page-operation', 'overall-work'].includes(stall) ? never() : 'deliberate no-model mismatch'
      if (text.includes('cancel') || text.includes('state')) return state()
      throw new Error('Unexpected inert page evaluation: ' + text)
    },
  }
  const browserCdp = { async send(method) {
    if (method === 'Browser.getVersion') return stall === 'setup-cdp' ? never() : { product: 'INERT-NOT-A-BROWSER' }
    inventories++
    if (stall === 'sample-after-cdp' && inventories % 2 === 0) return never()
    return { processInfo: [{ id: churn && inventories % 2 === 0 ? 22 : 21 }] }
  } }
  const contextPort = { pages: () => [page], on() {}, browser: () => ({ newBrowserCDPSession: async () => browserCdp }),
    async close() { closes++; if (stall === 'browser-close') return never(); alive = false } }
  const fs = {
    async readFile() { throw new Error('Unexpected runtime read outside the inert preflight') },
    async writeFile(file, bytes, options) {
      if (options?.flag === 'wx' && writes.has(file)) { const error = new Error('EEXIST'); error.code = 'EEXIST'; throw error }
      writes.set(file, String(bytes))
    },
    async appendFile(file, bytes, options) {
      assert.equal(options.flush, true)
      if (stall === 'journal-write') return never()
      writes.set(file, (writes.get(file) ?? '') + String(bytes))
    },
    async mkdir(directory) { if (directory === profile && profileExists) throw new Error('EEXIST existing profile') },
    async lstat() { return { isDirectory: () => true, isSymbolicLink: () => false } },
    async readdir() { return [] }, async rm() { removes++ },
  }
  let listening = false
  const server = { once() {}, listen(_port, _host, callback) { listening = true; callback() },
    get listening() { return listening }, close(callback) { listening = false; if (stall !== 'server-close') callback() },
    closeAllConnections() {}, closeIdleConnections() {}, unref() {} }
  const execFileSync = (file, args) => {
    if (file === 'git') return args[0] === 'status' ? '' : 'f'.repeat(40)
    assert.equal(file, '/bin/ps')
    if (!alive) return ''
    const rss = args.includes('pid=,rss=,lstart=,command=')
    return `21 ${rss ? '1000 ' : ''}Tue Sep 8 19:00:00 2026 ${command}\n`
  }
  const processPort = { argv: ['node', 'run-lab.mjs', '--run'], env: { ISSUE201_EXCLUSIVE_SLOT: allowed ? '1' : '0', ISSUE201_PROTOCOL_SHA256: checkpointSha256 },
    pid: 10, platform: 'darwin', arch: 'arm64', version: 'inert', stdout: { write: (value, callback) => { stdout.push(value); callback?.() } },
    kill(pid) { assert.equal(pid, 21); kills++; alive = false }, exit(code) { processPort.exitCode = code } }
  const modules = {
    'node:crypto': { createHash }, 'node:fs/promises': fs, 'node:http': { createServer: () => server },
    'node:child_process': { execFileSync }, 'node:zlib': { gzipSync }, 'node:url': { fileURLToPath }, 'node:path': { default: path },
    '@playwright/test': { chromium: { executablePath: () => '/cache/chromium-1234/chrome',
      async launchPersistentContext() { launches++; alive = true; return contextPort } } },
    './preflight.mjs': { prepareRuntimeInputs: async () => prepared() },
    '../whispercpp-lab/resident-monitor.mjs': monitor, '../whispercpp-lab/host-limits.mjs': stall === 'overall-work'
      ? { ...hostLimits, HOST_LIMITS: { ...hostLimits.HOST_LIMITS, overallMs: 5000 } } : hostLimits, '../whispercpp/resident-coverage.mjs': coverage, '../lab-contract.mjs': contract,
  }
  const scale = milliseconds => stall ? Math.max(1, milliseconds / 1000) : milliseconds
  const context = vm.createContext({ Buffer, URL, process: processPort, Date,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, scale(ms)); timers.add(timer); return timer }, clearTimeout,
    setInterval: (fn, ms) => { const timer = setInterval(fn, scale(ms)); intervals.add(timer); return timer }, clearInterval,
    WebAssembly: undefined, console: { log() {}, error: (...args) => errors.push(args) } }, { codeGeneration: { strings: false, wasm: false } })
  const module = new vm.SourceTextModule(source, { context, identifier: 'file:///repo/scripts/issue201/whispercpp-diagnostic-run/run-lab.mjs',
    initializeImportMeta: meta => { meta.url = 'file:///repo/scripts/issue201/whispercpp-diagnostic-run/run-lab.mjs' } })
  await module.link(async specifier => {
    const values = modules[specifier]; assert.ok(values, specifier)
    const stub = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
    await stub.link(() => { throw new Error('Unexpected nested import') }); await stub.evaluate(); return stub
  })
  let error = null
  try { await module.evaluate() } catch (cause) { error = cause }
  finally { for (const timer of timers) clearTimeout(timer); for (const timer of intervals) clearInterval(timer) }
  return { error, writes, stdout, launches, closes, removes, kills, alive, requests, exitCode: processPort.exitCode,
    result: writes.has('/repo/.tmp/issue201-whispercpp-lab/runtime-results-02.json')
      ? JSON.parse(writes.get('/repo/.tmp/issue201-whispercpp-lab/runtime-results-02.json')) : null }
}
test('the real runner refuses an absent exclusive grant before server, browser or attempt writes', async () => {
  const run = await runInert({ allowed: false })
  assert.match(run.error.message, /exclusive runtime grant/)
  assert.equal(run.launches, 0); assert.equal(run.writes.size, 0)
})
test('the real runner stops on its first failed case and retains raw process samples and owned cleanup', async () => {
  const run = await runInert()
  assert.equal(run.error, null)
  assert.equal(run.result.results.length, 1)
  assert.equal(run.result.results[0].name, contract.LAB_CASE_NAMES[0])
  assert.equal(run.result.results[0].passed, false)
  assert.deepEqual(run.result.acceptance.missing, contract.LAB_CASE_NAMES.slice(1))
  assert.deepEqual(run.result.memory[0].beforePids, [21])
  assert.deepEqual(run.result.memory[0].afterPids, [21])
  assert.deepEqual(run.result.memory[0].rss, [[21, 1_024_000]])
  assert.equal(run.result.browserClosures[0].verifiedAbsent, true)
  assert.equal(run.result.profileRemoval.status, 'removed-owned-profile')
  assert.equal(run.closes, 1); assert.equal(run.removes, 1); assert.equal(run.alive, false); assert.equal(run.kills, 0)
  assert.equal(run.exitCode, 1)
})
test('process churn stops before any acceptance case without discarding the incomplete raw observation', async () => {
  const run = await runInert({ churn: true })
  assert.equal(run.error, null)
  assert.equal(run.result.results.length, 0)
  assert.equal(run.result.acceptance.missing.length, 23)
  assert.deepEqual(run.result.memory[0].beforePids, [21])
  assert.deepEqual(run.result.memory[0].afterPids, [22])
  assert.equal(run.result.memory[0].complete, false)
  assert.equal(run.result.stopReason.reason, 'incomplete-process-coverage')
  assert.equal(run.alive, false)
})
test('an already existing profile is not adopted or removed after mkdir rejects', async () => {
  const run = await runInert({ profileExists: true })
  assert.equal(run.launches, 0); assert.equal(run.removes, 0)
  assert.equal(run.result.profileRemoval.status, 'not-created')
})
test('the attempt marker prevents a second run after an earlier failure', async () => {
  const first = await runInert(), again = await runInert({ writes: first.writes })
  assert.match(again.error.message, /EEXIST/)
  assert.equal(again.launches, 0)
  assert.equal(again.writes.get('/repo/.tmp/issue201-whispercpp-lab/runtime-results-02.json'),
    first.writes.get('/repo/.tmp/issue201-whispercpp-lab/runtime-results-02.json'))
})
for (const stall of ['page-operation', 'setup-cdp', 'browser-close', 'server-close']) {
  test(`actual runner reaches final evidence and bounded release when ${stall} never settles`, async () => {
    const run = await runInert({ stall })
    assert.equal(run.error, null)
    assert.equal(run.alive, false)
    assert.equal(run.result.physicalRelease.verifiedAbsent, true)
    assert.equal(run.result.serverRelease.listening, false)
    assert.equal(run.exitCode, 1)
    const partial = run.writes.get('/repo/.tmp/issue201-whispercpp-lab/runtime-partial-02.jsonl').trim().split('\n').map(JSON.parse)
    assert.equal(partial[0].type, 'run-start')
    assert.ok(partial.some(row => row.type === 'failure'))
    assert.ok(partial.some(row => row.type === 'physical-release'))
    assert.ok(partial.some(row => row.type === 'server-release'))
    assert.equal(partial.at(-1).type, 'run-complete')
    if (stall !== 'setup-cdp') {
      assert.ok(partial.some(row => row.type === 'resident-sample'))
      assert.ok(partial.findIndex(row => row.type === 'resident-sample') < partial.findIndex(row => row.type === 'browser-close-start'))
    }
    if (stall === 'page-operation') assert.match(run.result.results[0].error, /deadline|timed out/)
    if (stall === 'browser-close') assert.equal(run.kills, 1)
    if (stall === 'server-close') assert.ok(run.result.serverRelease.errors.length)
  })
}
test('the actual guarded proxy preserves explicit 120s phase waits within the case deadline', async () => {
  const definitions = source.slice(source.indexOf('async function bounded('), source.indexOf('async function journal('))
    + source.slice(source.indexOf('function guardedPort('), source.indexOf('function probePage('))
  for (const [caseRemaining, options, expected] of [[180000, { timeout: 120000 }, 120000],
    [60000, { timeout: 120000 }, 60000], [180000, undefined, 10000], [null, { timeout: 120000 }, 10000]]) {
    const timers = []
    const context = vm.createContext({ HOST_LIMITS: hostLimits.HOST_LIMITS, manifest, stopReason: null, stopped: new Promise(() => {}),
      currentCase: caseRemaining === null ? null : { deadline: caseRemaining }, Date: { now: () => 0 },
      setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length }, clearTimeout() {},
      WebAssembly: undefined }, { codeGeneration: { strings: false, wasm: false } })
    const module = new vm.SourceTextModule(definitions + '\nexport { guardedPort };', { context })
    await module.link(() => { throw new Error('Unexpected proxy source import') }); await module.evaluate()
    const guarded = module.namespace.guardedPort({ waitForFunction: () => new Promise(() => {}) }, ['waitForFunction'], 'Page')
    const pending = guarded.waitForFunction(() => {}, 'infer', options)
    assert.equal(timers[0].milliseconds, expected)
    timers[0].callback()
    await assert.rejects(pending, /timed out/)
  }
})
test('an after-inventory timeout retains the actual before inventory and RSS rows in partial evidence', async () => {
  const run = await runInert({ stall: 'sample-after-cdp' })
  assert.equal(run.error, null)
  assert.equal(run.result.results.length, 0)
  const sample = run.result.memory[0]
  assert.deepEqual(sample.beforePids, [21]); assert.deepEqual(sample.afterPids, [])
  assert.deepEqual(sample.rss, [[21, 1_024_000]])
  assert.match(sample.error, /inventory timeout/)
  assert.equal(sample.complete, false)
  const partial = run.writes.get('/repo/.tmp/issue201-whispercpp-lab/runtime-partial-02.jsonl').trim().split('\n').map(JSON.parse)
  assert.deepEqual(partial.find(row => row.type === 'resident-sample').value.rss, sample.rss)
})

test('the overall host deadline interrupts a still-pending case before its own deadline', async () => {
  const run = await runInert({ stall: 'overall-work' })
  assert.equal(run.error, null)
  assert.equal(run.result.stopReason.type, 'overall-host-deadline')
  assert.equal(run.result.results.length, 1)
  assert.match(run.result.results[0].error, /Laboratory stopped: overall-host-deadline/)
  assert.equal(run.result.physicalRelease.verifiedAbsent, true)
  assert.equal(run.result.serverRelease.listening, false)
  assert.equal(run.exitCode, 1)
})
test('a stuck partial-evidence write prevents launch and emits bounded fallback evidence', async () => {
  const run = await runInert({ stall: 'journal-write' })
  assert.equal(run.error, null)
  assert.equal(run.launches, 0)
  assert.equal(run.result.stopReason.type, 'partial-evidence-write-failed')
  assert.equal(run.result.journal.broken, true)
  assert.ok(run.stdout.some(line => line.startsWith('PARTIAL-EVIDENCE ')))
  assert.equal(run.result.serverRelease.listening, false)
  assert.equal(run.exitCode, 1)
})

test('attempt02 preserves the existing attempt01 marker, partial journal and final evidence', async () => {
  const original = new Map(['runtime-attempt-01.json', 'runtime-partial-01.jsonl', 'runtime-results-01.json']
    .map(name => ['/repo/.tmp/issue201-whispercpp-lab/' + name, 'original immutable run01 ' + name]))
  const run = await runInert({ writes: new Map(original) })
  assert.equal(run.error, null)
  for (const [path, content] of original) assert.equal(run.writes.get(path), content)
  assert.ok(run.writes.has('/repo/.tmp/issue201-whispercpp-lab/runtime-attempt-02.json'))
  assert.ok(run.writes.has('/repo/.tmp/issue201-whispercpp-lab/runtime-results-02.json'))
})
