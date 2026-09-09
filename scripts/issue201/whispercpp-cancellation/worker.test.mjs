// Execute the actual worker with inert decoder/core dependencies. No factory or
// WASM is executed; the existing frozen assets are read only as input bytes.
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import vm from 'node:vm'
import test from 'node:test'
import * as candidate from '../whispercpp-short-output-run/candidate.mjs'
import * as contract from '../lab-contract.mjs'
import * as observer from '../whispercpp-diagnostic/observe-module.mjs'

const root = new URL('../../../', import.meta.url)
const read = path => readFileSync(new URL(path, root))
const manifest = JSON.parse(read('docs/evidence/issue201/whispercpp-short-output-runtime/manifest.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setTimeout(resolve, 1))
async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) await turn()
  assert.ok(predicate())
}
async function harness({ cancelAtPhase, loadGate, runGate, coreError, closeAcknowledged = true } = {}) {
  const events = [], calls = []
  let closed = false, inputsClosed = 0, samplesClosed = 0, iteratorReturns = 0, context
  const file = manifest.model.files[0]
  const headers = new Headers({ 'content-length': String(file.bytes), 'x-sha256': file.sha256,
    'x-model-bundle': manifest.model.bundleId, 'x-source-revision': file.sourceRevision,
    'x-source-repository': file.sourceRepository, 'x-upstream-path': file.upstreamPath })
  const track = { getSampleRate: async () => 16000, getNumberOfChannels: async () => 1,
    canDecode: async () => true, computeDuration: async () => 300 }
  context = vm.createContext({ crypto: webcrypto, performance, setTimeout, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, Float32Array, Blob, WebAssembly: undefined,
    self: { postMessage: event => {
      events.push(event)
      if (event.type === 'phase' && event.phase === cancelAtPhase) void context.self.onmessage({ data: { type: 'cancel' } })
    }, close: () => { closed = true } },
    caches: { open: async () => ({ match: async () => ({ headers, arrayBuffer: async () => new ArrayBuffer(16) }) }) },
    fetch: async url => {
      const asset = manifest.runtime.artifacts.find(item => '/assets/' + item.name === url)
      assert.ok(asset)
      const bytes = gunzipSync(read(asset.packedPath))
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
    },
  }, { codeGeneration: { strings: false, wasm: false } })
  async function synthetic(values) {
    const module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
    await module.link(() => { throw new Error('Unexpected stub import') }); await module.evaluate(); return module
  }
  const modules = {
    '/assets/mediabunny.mjs': { ALL_FORMATS: [], BlobSource: class {},
      Input: class { async getPrimaryAudioTrack() { return track } dispose() { inputsClosed++ } },
      AudioSampleSink: class {
        samples(start, end) {
          let cursor = start
          return { async next() {
            if (cursor >= end) return { done: true }
            const timestamp = cursor, frames = Math.min(16000, Math.round((end - cursor) * 16000))
            cursor += frames / 16000
            return { done: false, value: { timestamp, sampleRate: 16000, numberOfChannels: 1, numberOfFrames: frames,
              copyTo: target => target.fill(0.25), close: () => { samplesClosed++ } } }
          }, async return() { iteratorReturns++; return { done: true } } }
        }
      } },
    './candidate.mjs': candidate, './lab-contract.mjs': contract, './observe-module.mjs': observer,
    './worker-protocol.mjs': { createSpeechWorkerProtocol: options => async message => {
      calls.push(message.kind)
      let response
      if (message.kind === 'load') { await loadGate?.promise; response = { kind: 'ready', heapBytes: 67108864 } }
      else if (message.kind === 'close') response = { kind: 'closed', cooperativeZero: closeAcknowledged }
      else {
        await runGate?.promise
        response = coreError ? { kind: 'error', ...coreError } : { kind: 'result', heapBytes: 134217728,
          generatedTokens: 12, segments: [{ text: ' bounded source', fromCentiseconds: 0,
            toCentiseconds: message.pcm.byteLength / 640 }] }
      }
      options.emit({ v: 1, owner: message.owner, id: message.id, ...response })
    } },
  }
  const module = new vm.SourceTextModule(read('scripts/issue201/whispercpp-cancellation/model-worker.mjs').toString(), {
    context, identifier: 'file:///inert/model-worker.mjs', importModuleDynamically: async specifier => {
      assert.equal(specifier, '/assets/myrelith-whisper.mjs')
      return synthetic({ default: () => { throw new Error('Generated factory must never run in this test') } })
    },
  })
  await module.link(specifier => { assert.ok(modules[specifier], specifier); return synthetic(modules[specifier]) })
  await module.evaluate()
  const send = data => context.self.onmessage({ data })
  return { events, calls, send,
    initialize: () => send({ type: 'initialize', manifest, modelIdentity: hash(candidate.modelCachePayload(manifest)),
      modelCache: 'myrelith-issue201-whispercpp-lab-model-00000000-0000-0000-0000-000000000001' }),
    transcribe: (seconds = 300) => send({ type: 'transcribe', requestId: 1, blob: new Blob(['source']), seconds, language: 'english' }),
    facts: () => ({ closed, inputsClosed, samplesClosed, iteratorReturns }),
  }
}
function assertDisposed(h) {
  const disposed = h.events.filter(event => event.type === 'disposed')
  assert.equal(disposed.length, 1)
  assert.equal(disposed[0].cooperativeZero, true)
  const ledger = disposed[0].ledger
  assert.equal(ledger.modelOwners + ledger.inputOwners + ledger.sampleOwners + ledger.pcmBytes, 0)
  assert.equal(ledger.acquiredSamples, ledger.closedSamples)
  assert.equal(h.facts().closed, true)
  assert.equal(h.events.some(event => event.type === 'window' || event.type === 'complete'), false)
}

test('cancellation at model-load before core creation proves zero without calling the empty core close path', async () => {
  const h = await harness({ cancelAtPhase: 'model-load' })
  await h.initialize(); assertDisposed(h)
  assert.deepEqual(h.calls, [])
  assert.equal(h.events.some(event => event.type === 'ready'), false)
})
test('cancellation during model initialization waits for load, closes once and never advertises ready', async () => {
  const loadGate = deferred(), h = await harness({ loadGate })
  const pending = h.initialize(); await until(() => h.calls.includes('load'))
  await h.send({ type: 'cancel' })
  assert.equal(h.facts().closed, false)
  assert.deepEqual(h.calls, ['load'])
  loadGate.resolve(); await pending; assertDisposed(h)
  assert.deepEqual(h.calls, ['load', 'close'])
  assert.equal(h.events.some(event => event.type === 'ready'), false)
})
test('cancellation during a borrowed inference window drains it without publishing output or starting the next window', async () => {
  const runGate = deferred(), h = await harness({ runGate })
  await h.initialize()
  const pending = h.transcribe(); await until(() => h.calls.includes('run'))
  await h.send({ type: 'cancel' }); await h.send({ type: 'cancel' })
  assert.equal(h.calls.includes('close'), false)
  assert.equal(h.facts().closed, false)
  runGate.resolve(); await pending; assertDisposed(h)
  assert.deepEqual(h.calls, ['load', 'run', 'close'])
  assert.equal(h.facts().inputsClosed, 1)
  assert.equal(h.facts().iteratorReturns, 1)
  assert.equal(h.facts().samplesClosed, 30)
})
test('preparation cancellation closes its input and model without entering inference', async () => {
  const h = await harness({ cancelAtPhase: 'prepare' }); await h.initialize(); await h.transcribe()
  assertDisposed(h); assert.deepEqual(h.calls, ['load', 'close'])
  assert.equal(h.facts().inputsClosed, 1)
})
test('uncancelled work retains twelve bounded windows and normal idle disposal', async () => {
  const h = await harness(); await h.initialize(); await h.transcribe()
  const result = h.events.find(event => event.type === 'complete')
  assert.equal(result.windows.length, 12)
  assert.equal(result.ledger.maxPcmBytes, 3840000)
  assert.equal(h.calls.filter(kind => kind === 'run').length, 12)
  await h.send({ type: 'dispose' })
  const disposal = h.events.find(event => event.type === 'disposed')
  assert.equal(disposal.cooperativeZero, true)
  assert.equal(disposal.ledger.acquiredSamples, disposal.ledger.closedSamples)
  assert.equal(h.facts().inputsClosed, 1)
})
test('a terminal native coverage rejection preserves its exact error and acknowledged ownership', async () => {
  const h = await harness({ coreError: { code: 'inference--944', cooperativeZero: true } })
  await h.initialize(); await h.transcribe(1)
  const error = h.events.find(event => event.type === 'error')
  assert.equal(error.message, 'Core inference--944; cooperativeZero=true')
  assert.equal(error.cooperativeZero, true)
  assert.equal(error.ledger.modelOwners + error.ledger.inputOwners + error.ledger.pcmBytes, 0)
  assert.equal(h.events.some(event => event.type === 'complete'), false)
  assert.deepEqual(h.calls, ['load', 'run']) // Already-ended core is not closed twice.
})
test('failed native cleanup is never converted into an acknowledged disposal', async () => {
  const runGate = deferred(), h = await harness({ runGate, closeAcknowledged: false })
  await h.initialize(); const pending = h.transcribe()
  await until(() => h.calls.includes('run')); await h.send({ type: 'cancel' }); runGate.resolve(); await pending
  const disposal = h.events.find(event => event.type === 'disposed')
  assert.equal(disposal.cooperativeZero, false)
  assert.equal(disposal.ledger.modelOwners, 1)
  assert.equal(h.facts().closed, true)
})
