import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { webcrypto, createHash } from 'node:crypto'
import { createContext, SourceTextModule } from 'node:vm'
import { createLabSampleQueue, declaredLabRequest, residentCeilingBreached, speechSegments, withinSourceCoverage } from './lab-contract.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function until(condition) {
  for (let i = 0; i < 1_000; i++) { if (condition()) return; await flush() }
  throw new Error('Deterministic fake-worker state did not arrive')
}

/** Evaluate the actual unmodified controller module with browser resource fakes. */
async function controller(t, terminationFallbackMs = 10_000) {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const file = { path: 'config.json', url: 'https://test.invalid/model/config.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
  const manifest = { model: { id: 'test/model', revision: 'frozen', totalBytes: bytes.length, files: [file] },
    runtime: { transformerVersion: 'fake', ortVersion: 'fake' },
    fixtures: [{ name: 'english', durationSeconds: 1 }],
    thresholds: { modelCacheByteLimit: 1_000, terminationFallbackMs, maxWindowWallMs: 10_000 } }
  const data = new Map()
  const caches = {
    async open(name) {
      if (!data.has(name)) data.set(name, new Map())
      const entries = data.get(name)
      return { async match(key) { return entries.get(key)?.clone() },
        async put(key, value) { entries.set(key, value.clone()) }, async delete(key) { return entries.delete(key) } }
    },
    async keys() { return [...data.keys()] }, async delete(name) { return data.delete(name) },
  }
  const workers = []
  let live = 0
  let peakLive = 0
  let completeJobs = true
  let autoDispose = false
  const zero = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0 }
  class FakeWorker {
    constructor() { this.alive = true; this.disposeRequests = 0; workers.push(this); live++; peakLive = Math.max(peakLive, live) }
    emit(data) { this.onmessage?.({ data }) }
    terminate() { if (this.alive) { this.alive = false; live-- } }
    acknowledgeDisposal() { this.emit({ type: 'disposed', ledger: zero }) }
    postMessage(message) {
      if (message.type === 'initialize') queueMicrotask(() => this.emit({ type: 'ready', loadMs: 0 }))
      else if (message.type === 'transcribe') {
        this.emit({ type: 'phase', phase: 'infer' })
        if (completeJobs) queueMicrotask(() => {
          this.emit({ type: 'complete', windows: [], requestId: message.requestId })
          this.emit({ type: 'idle', ledger: { ...zero, modelOwners: 1 } })
        })
      } else if (message.type === 'dispose') {
        this.disposeRequests++
        if (autoDispose) queueMicrotask(() => this.acknowledgeDisposal())
      }
    }
  }
  const context = createContext({ console, performance, crypto: webcrypto, TextEncoder,
    Uint8Array, URL, Response, Blob, File, AbortController, DOMException, setTimeout, clearTimeout,
    location: { origin: 'http://127.0.0.1:5201' }, Worker: FakeWorker, caches,
    navigator: { storage: { async estimate() { return { usage: 0 } } } },
    document: { querySelector() { return { textContent: '' } } },
    async fetch(url) {
      if (url === '/manifest.json') return new Response(JSON.stringify(manifest))
      if (url === '/model/config.json') return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      if (url === '/fixtures/english.wav') return new Response(bytes)
      throw new Error(`Unexpected fake fetch ${url}`)
    } })
  const source = await readFile(new URL('./lab-client.mjs', import.meta.url), 'utf8')
  const module = new SourceTextModule(source, { context, identifier: 'actual-lab-client.mjs' })
  await module.link(() => { throw new Error('Unexpected controller import') })
  await module.evaluate()
  const lab = context.lab
  t.after(async () => {
    autoDispose = true
    const cancelled = lab.cancel('test-shutdown')
    for (const worker of workers) if (worker.alive && worker.disposeRequests) worker.acknowledgeDisposal()
    await cancelled
    assert.equal(live, 0)
  })
  await lab.installModel()
  return { lab, workers, get live() { return live }, get peakLive() { return peakLive },
    set completeJobs(value) { completeJobs = value }, set autoDispose(value) { autoDispose = value } }
}

test('retiring idle owner remains reserved while concurrent requests await one disposal', async (t) => {
  const h = await controller(t)
  await h.lab.transcribeFixture('english')
  const old = h.workers[0]
  const retirement = h.lab.cancel('retire')
  const staleJob = h.lab.transcribeFixture('english').then(() => null, (error) => error.message)
  const staleInstall = h.lab.installModel().then(() => null, (error) => error.message)
  const newestJob = h.lab.transcribeFixture('english')
  await flush()
  assert.equal(h.lab.state().workerOwners, 1)
  assert.equal(h.workers.length, 1)
  assert.equal(old.disposeRequests, 1)
  assert.equal(h.live, 1)
  old.acknowledgeDisposal()
  await retirement
  assert.match(await staleJob, /superseded/u)
  assert.match(await staleInstall, /superseded/u)
  await newestJob
  assert.equal(h.workers.length, 2)
  assert.equal(h.live, 1)
  assert.equal(h.peakLive, 1)
  assert.equal(old.alive, false)
})

test('active cancellation rejects its promise before replacement and rejects late results', async (t) => {
  const h = await controller(t)
  h.completeJobs = false
  const pending = h.lab.transcribeFixture('english').then(() => null, (error) => error.message)
  await until(() => h.lab.state().phase === 'infer')
  const old = h.workers[0]
  await h.lab.cancel('active-cancel')
  assert.match(await pending, /terminated/u)
  assert.equal(h.live, 0)
  h.completeJobs = true
  await h.lab.transcribeFixture('english')
  old.emit({ type: 'complete', windows: [{ text: 'stale' }] })
  assert.equal(h.peakLive, 1)
  assert.ok(h.lab.state().events.some((event) => event.type === 'late-message-rejected'))
})

test('idle deadline terminates before releasing the retiring reservation', async (t) => {
  const h = await controller(t, 5)
  await h.lab.transcribeFixture('english')
  const pending = h.lab.cancel('deadline')
  assert.equal(h.lab.state().workerOwners, 1)
  const state = await pending
  assert.equal(h.live, 0)
  assert.equal(state.workerOwners, 0)
  assert.equal(state.lastCleanup.mode, 'terminated-deadline')
  assert.equal(state.lastCleanup.cooperativeZero, false)
})

test('timestamps accept the exact source end and retain every overshoot/missing/order failure', () => {
  const result = (timestamps) => ({ text: 'test', chunks: timestamps.map((timestamp) => ({ text: 'test', timestamp })) })
  assert.equal(speechSegments(result([[0, 1]]), 1)[0].timed, true)
  for (const pair of [[0, 1 + Number.EPSILON], [0, 1.001], [0, null], [null, 1], [-0.01, 1], [0.5, 0.5], [0.6, 0.5]]) {
    const chunk = speechSegments(result([pair]), 1)[0]
    assert.equal(chunk.timed, false)
    assert.deepEqual(chunk.timestamp, pair)
  }
  assert.deepEqual(speechSegments(result([[0, 0.5], [0.4, 0.8]]), 1).map((chunk) => chunk.timed), [true, false])
  assert.deepEqual(speechSegments(result([[0, 0.5], [0.5, 1]]), 1).map((chunk) => chunk.timed), [true, true])
  assert.equal(withinSourceCoverage(1, 1), true)
  assert.equal(withinSourceCoverage(1 + Number.EPSILON, 1), false)
  assert.equal(withinSourceCoverage(1, NaN), false)
})

test('result aggregate is bounded before retaining segment copies', () => {
  assert.throws(() => speechSegments({ text: 'test', chunks: Array.from({ length: 6 }, () => ({ text: 'x'.repeat(4_000), timestamp: [0, 1] })) }, 1), /aggregate/u)
})

test('request closure rejects unknown same-origin paths, queries, origins and methods', () => {
  const url = 'http://127.0.0.1:5201/assets/known.mjs'
  const known = new Set([url])
  assert.equal(declaredLabRequest(url, 'GET', known), true)
  assert.equal(declaredLabRequest('http://127.0.0.1:5201/favicon.ico', 'GET', known), true)
  for (const unknown of [`${url}?extra=1`, 'http://127.0.0.1:5201/assets/unknown.mjs', 'http://127.0.0.1:5201/models/optional.json', 'https://external.invalid/asset']) {
    assert.equal(declaredLabRequest(unknown, 'GET', known), false)
  }
  assert.equal(declaredLabRequest(url, 'POST', known), false)
})

test('resident ceiling triggers on the first byte above the frozen incremental allowance', () => {
  assert.equal(residentCeilingBreached(100, 300, 200), false)
  assert.equal(residentCeilingBreached(100, 301, 200), true)
  assert.equal(residentCeilingBreached(null, 301, 200), false)
})

test('overlapping named memory samples each capture a fresh state after the periodic drain', async () => {
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const observed = []
  let state = 'working'
  const queue = createLabSampleQueue(async (label = 'periodic') => {
    observed.push({ label, state })
    if (label === 'periodic') await blocked
  }, () => false)
  const periodic = queue.take()
  await flush()
  const closed = queue.take('closed-english')
  const final = queue.take('final-idle')
  assert.equal(queue.take(), final)
  assert.deepEqual(observed, [{ label: 'periodic', state: 'working' }])
  state = 'disposed'
  release()
  await queue.drain()
  await Promise.all([periodic, closed, final])
  assert.deepEqual(observed, [{ label: 'periodic', state: 'working' },
    { label: 'closed-english', state: 'disposed' }, { label: 'final-idle', state: 'disposed' }])
})

test('a stop during the periodic observation prevents queued named captures', async () => {
  let release
  let stopped = false
  const blocked = new Promise((resolve) => { release = resolve })
  const observed = []
  const queue = createLabSampleQueue(async (label = 'periodic') => { observed.push(label); await blocked }, () => stopped)
  const periodic = queue.take()
  await flush()
  const closed = queue.take('closed-english')
  stopped = true
  release()
  await queue.drain()
  await Promise.all([periodic, closed])
  assert.deepEqual(observed, ['periodic'])
})
