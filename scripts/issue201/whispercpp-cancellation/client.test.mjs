// Actual controller/candidate modules; cache and workers are inert. Exact model
// bytes are only hashed, never loaded into a generated factory or WASM.
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { modelCachePayload } from '../whispercpp-short-output-run/candidate.mjs'

const root = new URL('../../../', import.meta.url)
const source = name => readFileSync(new URL(name, root), 'utf8')
const manifest = JSON.parse(source('docs/evidence/issue201/whispercpp-short-output-runtime/manifest.json'))
const model = readFileSync(new URL(manifest.model.files[0].localPath, root))
const bytes = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
const hash = value => createHash('sha256').update(value).digest('hex')
async function controller() {
  const timers = new Map(), workers = []
  const file = manifest.model.files[0]
  const modelName = 'myrelith-issue201-whispercpp-lab-model-00000000-0000-0000-0000-000000000001'
  const registry = { name: modelName, bytes: file.bytes, bundleId: manifest.model.bundleId,
    configurationRevision: manifest.model.configurationRevision, identity: hash(modelCachePayload(manifest)) }
  const headers = new Headers({ 'content-length': String(file.bytes), 'x-sha256': file.sha256,
    'x-model-bundle': manifest.model.bundleId, 'x-source-revision': file.sourceRevision,
    'x-source-repository': file.sourceRepository, 'x-upstream-path': file.upstreamPath })
  class Worker {
    constructor() { this.alive = true; this.messages = []; workers.push(this) }
    postMessage(message) { this.messages.push(message) }
    terminate() { this.alive = false }
    emit(data) { this.onmessage?.({ data }) }
  }
  let timerId = 0, now = 0
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array, Headers,
    Response, Blob, URL, performance: { now: () => now }, Worker, AbortController, DOMException,
    setTimeout: (callback, milliseconds) => { timers.set(++timerId, { callback, milliseconds }); return timerId },
    clearTimeout: id => timers.delete(id), location: { origin: 'http://127.0.0.1:5201' },
    document: { querySelector: () => ({ textContent: '' }) },
    navigator: { storage: { estimate: async () => ({ usage: 0 }) } },
    caches: { open: async name => ({ match: async key => name === modelName
      ? key === file.url ? { headers, arrayBuffer: async () => bytes } : undefined
      : new Response(JSON.stringify(registry)) }) },
    fetch: async url => {
      if (url === '/manifest.json') return new Response(JSON.stringify(manifest))
      if (url === '/fixtures/english.wav') return new Response(new Uint8Array([1, 2]))
      throw new Error('Unexpected inert client fetch: ' + url)
    }, WebAssembly: undefined }, { codeGeneration: { strings: false, wasm: false } })
  const candidate = new vm.SourceTextModule(source('scripts/issue201/whispercpp-short-output-run/candidate.mjs'), { context })
  await candidate.link(() => { throw new Error('Unexpected candidate import') })
  const client = new vm.SourceTextModule(source('scripts/issue201/whispercpp-cancellation/lab-client.mjs'), { context })
  await client.link(name => { assert.equal(name, './candidate.mjs'); return candidate })
  await client.evaluate()
  const start = async () => {
    const count = workers.length
    const pending = context.lab.transcribeFixture('english').then(value => ({ value }), error => ({ error }))
    for (let i = 0; i < 1000 && workers.length === count; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(workers.length, count + 1)
    return { pending, worker: workers.at(-1) }
  }
  return { lab: context.lab, timers, workers, start, advance: milliseconds => { now += milliseconds } }
}
const zero = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0, acquiredSamples: 3, closedSamples: 3 }
const acknowledged = worker => worker.emit({ type: 'disposed', cooperativeZero: true, ledger: zero })
const turn = () => new Promise(resolve => setTimeout(resolve, 1))
async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) await turn()
  assert.ok(predicate())
}

test('prompt cancellation holds admission and ignores late output until the old owner acknowledges disposal', async () => {
  const h = await controller(), first = await h.start()
  first.worker.emit({ type: 'phase', phase: 'infer' })
  h.advance(4500)
  const drained = h.lab.cancel('user')
  assert.match((await first.pending).error.message, /cancelled/)
  assert.equal(h.lab.state().phase, 'disposing')
  assert.equal(h.lab.state().workerOwners, 1)
  assert.equal(first.worker.alive, true)
  assert.equal([...h.timers.values()][0].milliseconds, 115600)
  const retry = h.lab.transcribeFixture('english').then(value => ({ value }), error => ({ error }))
  await turn()
  assert.equal(h.workers.length, 1)
  first.worker.emit({ type: 'ready' })
  first.worker.emit({ type: 'complete', windows: [{ text: 'discard me' }] })
  assert.equal(first.worker.messages.some(message => message.type === 'transcribe'), false)
  acknowledged(first.worker)
  await drained
  await until(() => h.workers.length === 2)
  assert.equal(first.worker.alive, false)
  assert.equal(h.lab.state().lastCleanup.cooperativeZero, true)
  first.worker.onerror({ message: 'old trap' })
  acknowledged(first.worker)
  assert.equal(h.workers[1].alive, true)
  const final = h.lab.cancel('finish')
  acknowledged(h.workers[1]); await final; await retry
  assert.equal(h.timers.size, 0)
})

test('queued retries and project replacement cannot create a worker ahead of stale-owner cleanup', async () => {
  const h = await controller(), first = await h.start()
  const second = h.lab.transcribeFixture('english').catch(error => error)
  await turn()
  const third = h.lab.transcribeFixture('english').catch(error => error)
  const replaced = h.lab.replaceProject()
  await turn()
  assert.equal(h.workers.length, 1)
  assert.equal(h.lab.state().generation, 2)
  assert.equal(h.lab.state().workerOwners, 1)
  acknowledged(first.worker)
  await replaced; await first.pending
  assert.match((await second).message, /superseded/)
  assert.match((await third).message, /superseded/)
  assert.equal(h.workers.length, 1)
  const fresh = await h.start(), drain = h.lab.cancel('finish')
  acknowledged(fresh.worker); await drain; await fresh.pending
})

test('a disposal timeout fails admission closed and a late acknowledgement cannot reopen it', async () => {
  const h = await controller(), job = await h.start()
  const drain = h.lab.cancel('user')
  await job.pending
  const deadline = [...h.timers.values()].find(timer => timer.milliseconds === 120100)
  assert.ok(deadline); deadline.callback(); await drain
  assert.equal(job.worker.alive, false)
  assert.equal(h.lab.state().phase, 'unavailable')
  assert.equal(h.lab.state().lastCleanup.cooperativeZero, false)
  acknowledged(job.worker)
  await assert.rejects(h.lab.transcribeFixture('english'), /Reload/)
  await assert.rejects(h.lab.installModel(), /Reload/)
  assert.equal(h.workers.length, 1)
})

test('a trap during retirement fails closed immediately instead of waiting for the native deadline', async () => {
  const h = await controller(), job = await h.start()
  const drain = h.lab.cancel('user'); await job.pending
  job.worker.onerror({ message: 'native trap' }); await drain
  assert.equal(h.timers.size, 0)
  assert.equal(h.lab.state().lastCleanup.cooperativeZero, false)
  await assert.rejects(h.lab.transcribeFixture('english'), /Reload/)
})

test('idle disposal retains the original 100ms bound and validates every ownership field', async () => {
  for (const counts of [{ acquiredSamples: 3, closedSamples: 2 }, {},
    { acquiredSamples: -1, closedSamples: -1 }, { acquiredSamples: 0.5, closedSamples: 0.5 }]) {
    const h = await controller(), job = await h.start()
    job.worker.emit({ type: 'complete', windows: [] })
    job.worker.emit({ type: 'idle', ledger: { ...zero, modelOwners: 1 } })
    await job.pending
    const drain = h.lab.cancel('idle')
    assert.equal([...h.timers.values()][0].milliseconds, 100)
    job.worker.emit({ type: 'disposed', cooperativeZero: true,
      ledger: { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0, ...counts } })
    await drain
    assert.equal(h.lab.state().lastCleanup.cooperativeZero, false)
    await assert.rejects(h.lab.transcribeFixture('english'), /Reload/)
  }
})

test('acknowledged terminal errors allow retry; unacknowledged startup errors do not', async () => {
  const h = await controller(), first = await h.start()
  first.worker.emit({ type: 'error', code: 'transcription-failed', phase: 'infer',
    message: 'Core inference--944; cooperativeZero=true', cooperativeZero: true, ledger: zero })
  assert.match((await first.pending).error.message, /--944/)
  assert.equal(h.lab.state().lastCleanup.mode, 'cooperative-error')
  const next = await h.start()
  const startup = [...h.timers.values()].find(timer => timer.milliseconds === 120000)
  startup.callback(); await next.pending
  await assert.rejects(h.lab.transcribeFixture('english'), /Reload/)
  assert.equal(h.workers.length, 2)
})
