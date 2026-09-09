// Actual controller/candidate modules; cache and workers are inert. Exact model
// bytes are only hashed, never loaded into a generated factory or WASM.
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { modelCachePayload } from './candidate.mjs'

const root = new URL('../../../', import.meta.url)
const source = name => readFileSync(new URL(name, root), 'utf8')
const manifest = JSON.parse(source('docs/evidence/issue201/whispercpp-diagnostic-runtime-source/manifest.json'))
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
  let timerId = 0
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array, Headers,
    Response, Blob, URL, performance, Worker, AbortController, DOMException,
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
  const candidate = new vm.SourceTextModule(source('scripts/issue201/whispercpp-diagnostic-run/candidate.mjs'), { context })
  await candidate.link(() => { throw new Error('Unexpected candidate import') })
  const client = new vm.SourceTextModule(source('scripts/issue201/whispercpp-diagnostic-run/lab-client.mjs'), { context })
  await client.link(name => { assert.equal(name, './candidate.mjs'); return candidate })
  await client.evaluate()
  const start = async () => {
    const count = workers.length
    const pending = context.lab.transcribeFixture('english').then(value => ({ value }), error => ({ error }))
    for (let i = 0; i < 1000 && workers.length === count; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(workers.length, count + 1)
    return { pending, worker: workers.at(-1) }
  }
  return { lab: context.lab, timers, workers, start }
}
test('actual client bounds a worker with no first reply and records forced cleanup without cooperative claims', async () => {
  const h = await controller(), job = await h.start()
  const startup = [...h.timers.values()].find(timer => timer.milliseconds === 120000)
  assert.ok(startup)
  startup.callback()
  assert.match((await job.pending).error.message, /startup deadline/)
  assert.equal(job.worker.alive, false)
  assert.equal(h.lab.state().workerOwners, 0)
  assert.equal(h.lab.state().lastCleanup.mode, 'terminated-error')
  assert.equal(h.lab.state().lastCleanup.cooperativeZero, false)
  assert.equal(h.timers.size, 0)
})
test('an old client error or deadline cannot terminate the replacement worker or publish late output', async () => {
  const h = await controller(), first = await h.start()
  const staleDeadline = [...h.timers.values()].find(timer => timer.milliseconds === 120000)
  await h.lab.cancel('replace')
  assert.match((await first.pending).error.message, /terminated/)
  const second = await h.start()
  first.worker.onerror({ message: 'late error' }); staleDeadline.callback()
  first.worker.emit({ type: 'complete', windows: [{ text: 'late' }] })
  assert.equal(second.worker.alive, true)
  assert.equal(h.lab.state().workerOwners, 1)
  assert.ok(h.lab.state().events.some(event => event.type === 'late-message-rejected'))
  await h.lab.cancel('finish')
  assert.match((await second.pending).error.message, /terminated/)
  assert.equal(h.timers.size, 0)
})
test('model and inference phase guards retain 120s and preparation retains 10s', async () => {
  const h = await controller(), job = await h.start()
  for (const [phase, milliseconds] of [['model-load', 120000], ['prepare', 10000], ['infer', 120000]]) {
    job.worker.emit({ type: 'phase', phase })
    assert.deepEqual([...h.timers.values()].map(timer => timer.milliseconds).sort((a, b) => a - b), [milliseconds, 2000000])
  }
  await h.lab.cancel('finish'); await job.pending
  assert.equal(h.timers.size, 0)
})
