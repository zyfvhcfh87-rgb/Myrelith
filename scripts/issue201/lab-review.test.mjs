import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { webcrypto, createHash } from 'node:crypto'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { assessLabRun, corruptAudioReachedDecode, createLabSampleQueue, declaredLabRequest,
  initializationFailure, LAB_CASE_NAMES, pinnedModelFileLookup, residentCeilingBreached, speechSegments, withinSourceCoverage } from './lab-contract.mjs'
import { modelBundlePayload, modelCachePayload } from './composite-model.mjs'
import { installEncoderFetchPolicy } from './encoder-fetch-policy.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function until(condition) {
  for (let i = 0; i < 1_000; i++) { if (condition()) return; await flush() }
  throw new Error('Deterministic fake-worker state did not arrive')
}

/** Evaluate the actual unmodified controller module with browser resource fakes. */
async function controller(t, terminationFallbackMs = 10_000, runtimeOverrides = {}) {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const file = { path: 'config.json', sourceRepository: 'test/model', sourceRevision: 'a'.repeat(40), upstreamPath: 'config.json', localPath: '.tmp/fake/config.json',
    url: `https://huggingface.co/test/model/resolve/${'a'.repeat(40)}/config.json`, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
  const model = { kind: 'local-composite-v1', id: 'test/model', configurationRevision: 'a'.repeat(40), totalBytes: bytes.length, files: [file], licenseProvenance: { scope: 'synthetic deterministic unit fixture only' } }
  model.bundleId = 'sha256:' + createHash('sha256').update(modelBundlePayload(model)).digest('hex')
  const manifest = { model,
    runtime: { transformerVersion: 'fake', ortVersion: 'fake', ...runtimeOverrides },
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
  let initializeError = null
  let moduleError = null
  const zero = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0 }
  class FakeWorker {
    constructor() { this.alive = true; this.disposeRequests = 0; workers.push(this); live++; peakLive = Math.max(peakLive, live) }
    emit(data) { this.onmessage?.({ data }) }
    terminate() { if (this.alive) { this.alive = false; live-- } }
    acknowledgeDisposal() { this.emit({ type: 'disposed', ledger: zero }) }
    postMessage(message) {
      if (message.type === 'initialize') queueMicrotask(() => {
        if (moduleError) this.onerror?.({ message: moduleError })
        else this.emit(initializeError
          ? { type: 'error', code: 'initialization-failed', phase: 'model-load', message: initializeError, ledger: zero }
          : { type: 'ready', loadMs: 0, ledger: { ...zero, modelOwners: 1 } })
      })
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
  const composite = new SourceTextModule(await readFile(new URL('./composite-model.mjs', import.meta.url), 'utf8'), { context })
  await composite.link(() => { throw new Error('Unexpected composition import') })
  await module.link((specifier) => { assert.equal(specifier, './composite-model.mjs'); return composite })
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
  return { lab, workers, caches, get live() { return live }, get peakLive() { return peakLive },
    set completeJobs(value) { completeJobs = value }, set autoDispose(value) { autoDispose = value },
    set initializeError(value) { initializeError = value }, set moduleError(value) { moduleError = value } }
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

test('pinned model lookup includes the observed local key and rejects other revisions/files/queries', () => {
  const file = { path: 'config.json', url: 'https://huggingface.co/Xenova/whisper-tiny/resolve/pinned/config.json' }
  const lookup = pinnedModelFileLookup({ id: 'Xenova/whisper-tiny', files: [file] }, 'http://127.0.0.1:5201')
  for (const key of [file.url, '/models/Xenova/whisper-tiny/config.json',
    'http://127.0.0.1:5201/models/Xenova/whisper-tiny/config.json', 'Xenova/whisper-tiny/config.json']) {
    assert.equal(lookup.get(key), file)
  }
  for (const key of ['https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json',
    '/models/other/whisper-tiny/config.json', '/models/Xenova/whisper-tiny/config.json?revision=other',
    '/models/Xenova/whisper-tiny/unknown.json']) assert.equal(lookup.get(key), undefined)
})

test('actual controller preserves structured initialization failure and can retry without overlapping owners', async (t) => {
  const h = await controller(t)
  h.initializeError = 'Missing pinned file'
  const error = await h.lab.transcribeFixture('english').then(() => null, (cause) => cause)
  assert.equal(error.code, 'initialization-failed')
  assert.equal(error.phase, 'model-load')
  assert.equal(initializationFailure(h.lab.state().events)?.message, 'Missing pinned file')
  assert.equal(h.lab.state().workerOwners, 0)
  assert.equal(h.live, 0)
  h.initializeError = null
  await h.lab.transcribeFixture('english')
  assert.equal(h.peakLive, 1)
})

test('an unrelated loader error cannot pass corrupt-audio decoding acceptance', () => {
  const state = { workerOwners: 0, events: [{ type: 'error', code: 'initialization-failed' }] }
  assert.equal(corruptAudioReachedDecode({ code: 'initialization-failed', phase: 'model-load' }, state), false)
  assert.equal(corruptAudioReachedDecode({ code: 'transcription-failed', phase: 'decode-setup' }, state), false)
  state.events.push({ type: 'ready', ledger: { modelOwners: 1 } })
  assert.equal(corruptAudioReachedDecode({ code: 'transcription-failed', phase: 'decode-setup' }, state), true)
})

test('worker module startup errors also produce a terminal initialization prerequisite', async (t) => {
  const h = await controller(t)
  h.moduleError = 'Worker module unavailable'
  const error = await h.lab.transcribeFixture('english').then(() => null, (cause) => cause)
  assert.equal(error.code, 'initialization-failed')
  assert.equal(initializationFailure(h.lab.state().events)?.origin, 'parent')
  assert.equal(h.live, 0)
})

test('overall acceptance cannot pass missing, aborted, failed or unexpected planned cases', () => {
  const complete = LAB_CASE_NAMES.map((name) => ({ name, passed: true }))
  assert.equal(assessLabRun(complete, [], null).automatedStatus, 'passed')
  const partial = assessLabRun(complete.slice(0, 8), [], null)
  assert.equal(partial.automatedStatus, 'failed-incomplete')
  assert.equal(partial.missing.length, LAB_CASE_NAMES.length - 8)
  assert.equal(assessLabRun(complete, [], { type: 'model-prerequisite' }).automatedStatus, 'failed-incomplete')
  assert.equal(assessLabRun([{ ...complete[0], passed: false }, ...complete.slice(1)], [], null).automatedStatus, 'failed')
  assert.equal(assessLabRun([...complete, { name: 'unknown-case', passed: true }], [], null).automatedStatus, 'failed')
  assert.equal(assessLabRun(complete, [{ type: 'incomplete-memory-sampling' }], null).automatedStatus, 'failed')
})

test('model cache compatibility includes session settings, runtime bytes and encoder fetch policy', async (t) => {
  const runtime = { artifacts: [{ name: 'runtime.mjs', sha256: 'first' }],
    sessionOptions: { graphOptimizationLevel: 'all', extra: { session: { disable_quant_qdq: '1' } } } }
  const identities = []
  for (const variant of [runtime, { ...runtime, sessionOptions: {} },
    { ...runtime, artifacts: [{ name: 'runtime.mjs', sha256: 'second' }] },
    { ...runtime, encoderFetchPolicy: { fetchNames: ['last_hidden_state'] } }, runtime]) {
    const h = await controller(t, 10_000, variant)
    identities.push((await h.lab.cacheFacts()).model.identity)
  }
  assert.equal(new Set(identities.slice(0, 4)).size, 4)
  assert.equal(identities[0], identities[4])
})

test('actual worker forwards the frozen optimizer setting without mutating its manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../docs/evidence/issue201/replacement-manifest.json', import.meta.url)))
  const expected = { graphOptimizationLevel: 'all', extra: { session: { disable_quant_qdq: '1' } } }
  assert.deepEqual(manifest.runtime.sessionOptions, expected)
  const events = []
  const calls = []
  const env = { backends: { onnx: { wasm: {} } }, version: 'source-only-fake' }
  let disposals = 0
  let closed = false
  const self = { postMessage(event) { events.push(event) }, close() { closed = true } }
  const context = createContext({ self, performance, structuredClone, URL, Response, crypto: webcrypto, TextEncoder, Uint8Array,
    location: { origin: 'http://127.0.0.1:5201', href: 'http://127.0.0.1:5201/model-worker.mjs' },
    caches: { async open() { return { async match() { throw new Error('This test must not load model bytes') } } } },
    async fetch() { throw new Error('This test must not perform network requests') } })
  const runtime = new SyntheticModule(['pipeline', 'env'], function () {
    this.setExport('env', env)
    this.setExport('pipeline', async (task, id, options) => {
      calls.push({ task, id, options: structuredClone({ ...options, progress_callback: undefined }) })
      // ORT appends defaults to nested session options; the evidence manifest stays fixed.
      options.session_options.extra.session.simulated_runtime_default = '1'
      return { model: { sessions: { model: { inputNames: ['input_features'], outputNames: manifest.runtime.encoderFetchPolicy.expectedOutputNames,
        run() { throw new Error('This initialization test must not execute a model') }, release() {} } } },
      async dispose() { disposals++ } }
    })
  }, { context })
  await runtime.link(() => { throw new Error('Unexpected runtime fake import') })
  await runtime.evaluate()
  const contract = new SourceTextModule(await readFile(new URL('./lab-contract.mjs', import.meta.url), 'utf8'), { context })
  await contract.link(() => { throw new Error('Unexpected contract import') })
  await contract.evaluate()
  const policyModule = new SourceTextModule(await readFile(new URL('./encoder-fetch-policy.mjs', import.meta.url), 'utf8'), { context })
  await policyModule.link(() => { throw new Error('Unexpected policy import') })
  await policyModule.evaluate()
  const media = new SyntheticModule(['ALL_FORMATS', 'AudioSampleSink', 'BlobSource', 'Input'], function () {
    this.setExport('ALL_FORMATS', [])
    for (const name of ['AudioSampleSink', 'BlobSource', 'Input']) {
      this.setExport(name, class { constructor() { throw new Error('Initialization must not decode audio') } })
    }
  }, { context })
  const composite = new SourceTextModule(await readFile(new URL('./composite-model.mjs', import.meta.url), 'utf8'), { context })
  await composite.link(() => { throw new Error('Unexpected composition import') })
  const worker = new SourceTextModule(await readFile(new URL('./model-worker.mjs', import.meta.url), 'utf8'), {
    context,
    async importModuleDynamically(specifier) {
      assert.equal(specifier, '/assets/transformers.local.mjs')
      return runtime
    },
  })
  await worker.link((specifier) => {
    if (specifier === './composite-model.mjs') return composite
    if (specifier === './lab-contract.mjs') return contract
    if (specifier === './encoder-fetch-policy.mjs') return policyModule
    assert.equal(specifier, '/assets/mediabunny.mjs')
    return media
  })
  await worker.evaluate()
  await self.onmessage({ data: { type: 'initialize', manifest, modelCache: 'source-test', modelIdentity: createHash('sha256').update(modelCachePayload(manifest)).digest('hex') } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].task, 'automatic-speech-recognition')
  assert.equal(calls[0].id, manifest.model.id)
  assert.deepEqual(calls[0].options.session_options, expected)
  assert.equal(calls[0].options.revision, manifest.model.configurationRevision)
  assert.equal(calls[0].options.device, 'wasm')
  assert.equal(calls[0].options.dtype, 'q8')
  assert.deepEqual(manifest.runtime.sessionOptions, expected)
  assert.deepEqual(events.find((event) => event.type === 'ready').sessionOptions, expected)
  assert.equal(events.some((event) => event.type === 'error'), false)
  await self.onmessage({ data: { type: 'dispose' } })
  assert.equal(disposals, 1)
  assert.equal(closed, true)
  assert.equal(events.at(-1).ledger.modelOwners, 0)
})

test('encoder fetch adapter preserves receiver, input/result ownership and every decoder output', async () => {
  const { runtime: { encoderFetchPolicy: policy } } = JSON.parse(await readFile(new URL('../../docs/evidence/issue201/replacement-manifest.json', import.meta.url)))
  const hidden = Object.freeze({ type: 'float32', dims: [1, 1500, 384], data: 'same tensor owner' })
  const feed = Object.freeze({ input_features: Object.freeze({ type: 'float32', dims: [1, 80, 3000], data: 'same feature owner' }) })
  let releases = 0
  let requestedBytes = 0
  const calls = []
  const events = []
  const encoder = {
    inputNames: [...policy.inputNames], outputNames: [...policy.expectedOutputNames],
    async run(feeds, fetches = this.outputNames) {
      assert.equal(this, encoder)
      assert.equal(feeds, feed)
      calls.push([...fetches])
      requestedBytes += fetches.filter((name) => name.startsWith('encoder_attentions.')).length * 54_000_000
      return Object.fromEntries(fetches.map((name) => [name, name === 'last_hidden_state' ? hidden : { omitted: false }]))
    },
    async release() { assert.equal(this, encoder); releases++ },
  }
  const decoder = { outputNames: ['logits', 'present.0.decoder.key', 'present.0.encoder.value'],
    async run() { return { logits: 'same logits', 'present.0.decoder.key': 'same cache', 'present.0.encoder.value': 'same encoder cache' } } }
  const sessions = { model: encoder, decoder_model_merged: decoder }
  const decoderRun = decoder.run
  const release = encoder.release
  installEncoderFetchPolicy(sessions.model, policy, (event) => events.push(event))
  for (let i = 0; i < 2; i++) assert.equal((await sessions.model.run(feed)).last_hidden_state, hidden)
  assert.deepEqual(calls, [['last_hidden_state'], ['last_hidden_state']])
  assert.equal(requestedBytes, 0)
  assert.equal(sessions.decoder_model_merged, decoder)
  assert.equal(decoder.run, decoderRun)
  assert.deepEqual(await decoder.run(), { logits: 'same logits', 'present.0.decoder.key': 'same cache', 'present.0.encoder.value': 'same encoder cache' })
  assert.equal(encoder.release, release)
  await encoder.release()
  assert.equal(releases, 1)
  assert.deepEqual(encoder.outputNames, policy.expectedOutputNames)
  assert.deepEqual(events.map((event) => event.type), ['encoder-fetch-start', 'encoder-fetch-complete', 'encoder-fetch-start', 'encoder-fetch-complete'])
  await assert.rejects(encoder.run(feed, ['encoder_attentions.0']), /contract changed/u)
  await assert.rejects(encoder.run({ input_features: { type: 'float32', dims: [2, 80, 3000] } }), /feature matrix/u)
  assert.equal(calls.length, 2)
})

test('encoder fetch adapter rejects changed IO/policies and propagates runtime failures without fallback', async () => {
  const { runtime: { encoderFetchPolicy: policy } } = JSON.parse(await readFile(new URL('../../docs/evidence/issue201/replacement-manifest.json', import.meta.url)))
  const make = () => ({ inputNames: [...policy.inputNames], outputNames: [...policy.expectedOutputNames], async run() { return { last_hidden_state: {} } }, release() {} })
  for (const session of [null, { ...make(), outputNames: ['last_hidden_state', 'encoder_attentions.0', 'encoder_attentions.1', 'encoder_attentions.2', 'encoder_attentions.3'] }, { ...make(), inputNames: ['wrong'] }]) {
    assert.throws(() => installEncoderFetchPolicy(session, policy), /interface changed/u)
  }
  assert.throws(() => installEncoderFetchPolicy(make(), { ...policy, fetchNames: ['last_hidden_state', 'encoder_attentions.0'] }), /Unrecognized/u)
  const error = new Error('Native run failed')
  let calls = 0
  const session = { ...make(), async run() { calls++; throw error } }
  installEncoderFetchPolicy(session, policy)
  const feeds = { input_features: { type: 'float32', dims: [1, 80, 3000] } }
  await assert.rejects(session.run(feeds), (cause) => cause === error)
  assert.equal(calls, 1)
  const unexpected = { ...make(), async run() { return { last_hidden_state: {}, 'encoder_attentions.0': {} } } }
  installEncoderFetchPolicy(unexpected, policy)
  await assert.rejects(unexpected.run(feeds), /unexpected outputs/u)
})


test('actual controller rejects changed cache source headers before creating an inference owner', async (t) => {
  for (const header of ['x-model-bundle', 'x-source-revision', 'x-source-repository', 'x-upstream-path']) {
    const h = await controller(t)
    const installed = (await h.lab.cacheFacts()).model
    const cache = await h.caches.open(installed.name)
    const file = h.lab.manifest.model.files[0]
    const original = await cache.match(file.url)
    const headers = new Headers(original.headers)
    headers.set(header, 'different-source')
    await cache.put(file.url, new Response(await original.arrayBuffer(), { headers }))
    await assert.rejects(h.lab.transcribeFixture('english'), /cache is incomplete/u)
    assert.equal(h.workers.length, 0)
  }
})

test('actual controller registry requires the explicit bundle and configuration revision', async (t) => {
  const h = await controller(t)
  const registry = await h.caches.open('myrelith-issue201-lab-registry')
  const key = 'http://127.0.0.1:5201/model-registry'
  const original = await (await registry.match(key)).json()
  for (const patch of [{ bundleId: 'wrong-bundle' }, { configurationRevision: 'wrong-revision' }, { identity: 'wrong-runtime' }]) {
    await registry.put(key, new Response(JSON.stringify({ ...original, ...patch })))
    await assert.rejects(h.lab.transcribeFixture('english'), /registry provenance mismatch/u)
    assert.equal(h.workers.length, 0)
  }
})
