import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import vm from 'node:vm'
import test from 'node:test'
import { verifyCandidate, verifyModelBundle, modelCachePayload, CANDIDATE_MANIFEST_SHA256 } from './candidate.mjs'
import { createRuntimeResidentMonitor } from './resident-monitor.mjs'

const root = new URL('../../../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')
const manifest = JSON.parse(read('docs/evidence/issue201/whispercpp-runtime-source/manifest.json'))
const historical = JSON.parse(read('docs/evidence/issue201/replacement-manifest.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
test('exact candidate identity includes both generated artifacts and all unchanged fixture/acceptance limits', async () => {
  await verifyCandidate(manifest, hash)
  assert.deepEqual(manifest.thresholds, historical.thresholds)
  assert.deepEqual(manifest.fixtures, historical.fixtures)
  assert.deepEqual(manifest.derivatives, historical.derivatives)
  assert.equal(manifest.model.totalBytes, 43_537_433)
  for (const field of ['sha256', 'bytes']) for (const index of [0, 1]) {
    const changed = structuredClone(manifest)
    changed.runtime.artifacts[index][field] = field === 'bytes' ? 1 : '0'.repeat(64)
    await assert.rejects(verifyCandidate(changed, hash), /Unreviewed/)
    assert.notEqual(modelCachePayload(changed), modelCachePayload(manifest))
  }
  const relaxed = structuredClone(manifest); relaxed.thresholds.maxNewTokens++
  await assert.rejects(verifyCandidate(relaxed, hash), /Unreviewed/)
  const changed = structuredClone(manifest.model); changed.files[0].sourceRevision = '0'.repeat(40)
  await assert.rejects(verifyModelBundle(changed, hash), /Malformed|differs/)
  assert.equal(hash(Buffer.from(JSON.stringify(manifest))), CANDIDATE_MANIFEST_SHA256)
})

const sample = (at, bytes = 1000, extra = {}) => ({ startedAt: at - 10, at, beforePids: [1, 2], afterPids: [1, 2], rss: [[1, bytes], [2, 100]], ...extra })
test('continuous epochs retain all samples and distinguish verified browser absence from model work', () => {
  const monitor = createRuntimeResidentMonitor()
  monitor.begin('initial', 0)
  assert.equal(monitor.observe(sample(10), 'baseline'), null)
  assert.equal(monitor.observe(sample(110, 1500)), null)
  assert.equal(monitor.close({ at: 140, elapsedMs: 30, remaining: [], verifiedAbsent: true }), null)
  monitor.begin('reopen', 2000)
  monitor.observe(sample(2010)); monitor.observe(sample(2110, 1400))
  monitor.close({ at: 2140, elapsedMs: 30, remaining: [], verifiedAbsent: true })
  const report = monitor.snapshot()
  assert.equal(report.qualified, true)
  assert.equal(report.maximumActiveEpochGapMs, 100)
  assert.equal(report.firstBaseline, 1100)
  assert.equal(monitor.memory.length, 4)
  assert.equal(report.epochs.length, 2)
})
test('late samples, process churn, missing RSS, ceilings and unverified shutdown remain failures', () => {
  for (const bad of [sample(361), sample(110, 1000, { afterPids: [1, 3] }), sample(110, 1000, { rss: [[1, 1000]] }),
    sample(110, 1_073_742_825), sample(310, 1000, { startedAt: 10 })]) {
    const monitor = createRuntimeResidentMonitor(); monitor.begin('initial', 0); monitor.observe(sample(10))
    assert.ok(monitor.observe(bad)); monitor.observe(sample(410))
    monitor.close({ at: 440, elapsedMs: 30, remaining: [], verifiedAbsent: true })
    assert.equal(monitor.snapshot().qualified, false)
    assert.equal(monitor.memory.length, 3)
  }
  for (const receipt of [{ at: 140, elapsedMs: 30, remaining: [1], verifiedAbsent: false },
    { at: 410, elapsedMs: 300, remaining: [], verifiedAbsent: true }]) {
    const monitor = createRuntimeResidentMonitor(); monitor.begin('initial', 0)
    monitor.observe(sample(10)); monitor.observe(sample(110))
    assert.ok(monitor.close(receipt)); assert.equal(monitor.snapshot().qualified, false)
  }
})
test('reopen cannot reset away the original resident baseline', () => {
  const monitor = createRuntimeResidentMonitor(); monitor.begin('first', 0)
  monitor.observe(sample(10)); monitor.observe(sample(110)); monitor.close({ at: 140, elapsedMs: 30, remaining: [], verifiedAbsent: true })
  monitor.begin('second', 1000)
  assert.equal(monitor.observe(sample(1010, 1_073_742_825)).reason, 'resident-ceiling-original-baseline')
})
test('original bounded native audio preparation is byte-identical in the separate worker', () => {
  const extract = source => source.slice(source.indexOf('/** Fixed-radius windowed sinc'), source.indexOf('async function transcribe(message)'))
  assert.equal(extract(read('scripts/issue201/whispercpp-lab/model-worker.mjs')), extract(read('scripts/issue201/model-worker.mjs')))
})

async function synthetic(context, values) {
  const module = new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context })
  await module.link(() => { throw new Error('Unexpected stub import') }); await module.evaluate()
  return module
}
async function workerHarness({ corruptGlue = false, coreError = false } = {}) {
  const events = [], calls = [], imports = [], fetched = []
  let closed = false, factoryCalls = 0
  const glue = gunzipSync(readFileSync(new URL('docs/evidence/issue201/whispercpp-generated/myrelith-whisper.mjs.gz', root)))
  if (corruptGlue) glue[0] ^= 1
  const wasm = gunzipSync(readFileSync(new URL('docs/evidence/issue201/whispercpp-generated/myrelith-whisper.wasm.gz', root)))
  const fixtureBuffer = buffer => Uint8Array.from(buffer).buffer
  const field = manifest.model.files[0]
  const headers = new Map([['content-length', String(field.bytes)], ['x-sha256', field.sha256], ['x-model-bundle', manifest.model.bundleId],
    ['x-source-revision', field.sourceRevision], ['x-source-repository', field.sourceRepository], ['x-upstream-path', field.upstreamPath]])
  const context = vm.createContext({ crypto: webcrypto, performance, TextEncoder, Uint8Array, Float32Array, Blob,
    WebAssembly: undefined, self: { postMessage: value => events.push(value), close: () => { closed = true } },
    caches: { open: async () => ({ match: async () => ({ headers, arrayBuffer: async () => new ArrayBuffer(16) }) }) },
    fetch: async url => { fetched.push(url); return { ok: true, arrayBuffer: async () => fixtureBuffer(url.endsWith('.mjs') ? glue : wasm) } },
  }, { codeGeneration: { strings: false, wasm: false } })
  const track = { getSampleRate: async () => 16000, getNumberOfChannels: async () => 1,
    canDecode: async () => true, computeDuration: async () => 300 }
  const modules = {
    '/assets/mediabunny.mjs': { ALL_FORMATS: [], BlobSource: class {},
      Input: class { async getPrimaryAudioTrack() { return track } dispose() {} },
      AudioSampleSink: class {
        samples(start, end) { let cursor = start; return { async next() {
          if (cursor >= end) return { done: true }
          const timestamp = cursor, frames = Math.min(16000, Math.round((end - cursor) * 16000)); cursor += frames / 16000
          return { done: false, value: { timestamp, sampleRate: 16000, numberOfChannels: 1, numberOfFrames: frames,
            copyTo: target => target.fill(0.25), close: () => {} } }
        }, async return() { return { done: true } } } }
      } },
    './lab-contract.mjs': await import('../lab-contract.mjs'),
    './candidate.mjs': await import('./candidate.mjs'),
    './worker-protocol.mjs': { createSpeechWorkerProtocol: options => async message => {
      calls.push({ ...message, model: message.model?.byteLength, wasm: message.wasm?.byteLength, pcm: message.pcm?.byteLength })
      let response
      if (message.kind === 'load') response = { kind: 'ready', heapBytes: 67108864 }
      else if (message.kind === 'close') response = { kind: 'closed', cooperativeZero: true }
      else if (coreError) response = { kind: 'error', code: 'inference--91', cooperativeZero: true }
      else response = { kind: 'result', heapBytes: 134217728, generatedTokens: 12,
        segments: [{ text: ' source seam fixture', fromCentiseconds: 0, toCentiseconds: message.pcm.byteLength / 640 }] }
      options.emit({ v: 1, owner: message.owner, id: message.id, ...response })
    } },
  }
  const module = new vm.SourceTextModule(read('scripts/issue201/whispercpp-lab/model-worker.mjs'), { context,
    identifier: 'file:///inert/model-worker.mjs', importModuleDynamically: async specifier => {
      imports.push(specifier)
      assert.equal(specifier, '/assets/myrelith-whisper.mjs')
      return synthetic(context, { default: () => { factoryCalls++; throw new Error('The source probe must not call a factory') } })
    } })
  await module.link(specifier => { assert.ok(modules[specifier], specifier); return synthetic(context, modules[specifier]) })
  await module.evaluate()
  const send = data => context.self.onmessage({ data })
  const initialize = async (value = manifest) => send({ type: 'initialize', manifest: value,
    modelIdentity: hash(Buffer.from(modelCachePayload(value))), modelCache: 'myrelith-issue201-whispercpp-lab-model-00000000-0000-0000-0000-000000000001' })
  return { events, calls, imports, fetched, context, send, initialize, closed: () => closed, factoryCalls: () => factoryCalls }
}
test('worker seam verifies glue before import and sends the exact WASM bytes to the existing core authority', async () => {
  const worker = await workerHarness()
  await worker.initialize()
  assert.ok(worker.events.some(e => e.type === 'ready'))
  assert.equal(worker.calls[0].wasm, manifest.runtime.artifacts[1].bytes)
  assert.deepEqual(worker.imports, ['/assets/myrelith-whisper.mjs'])
  assert.equal(worker.factoryCalls(), 0)
  assert.throws(() => worker.context.fetch('/surprise'), /cannot fetch/)
  await worker.send({ type: 'dispose' })
  assert.equal(worker.closed(), true)
  assert.equal(worker.events.find(e => e.type === 'disposed').ledger.modelOwners, 0)
})
test('worker rejects changed candidate metadata or changed glue before generated module import', async () => {
  const altered = await workerHarness(); const value = structuredClone(manifest); value.runtime.threads = 2
  await altered.initialize(value)
  assert.ok(altered.events.some(e => e.type === 'error' && /Unreviewed/.test(e.message)))
  assert.equal(altered.fetched.length, 0)
  const corrupt = await workerHarness({ corruptGlue: true }); await corrupt.initialize()
  assert.ok(corrupt.events.some(e => e.type === 'error' && /JS identity/.test(e.message)))
  assert.equal(corrupt.imports.length, 0); assert.equal(corrupt.calls.length, 0)
})
test('worker seam keeps twelve bounded windows, charges the C PCM copy, and closes every fake native sample', async () => {
  const worker = await workerHarness(); await worker.initialize()
  await worker.send({ type: 'transcribe', requestId: 1, blob: new Blob(['fixture']), seconds: 300, language: 'english' })
  const complete = worker.events.find(e => e.type === 'complete')
  assert.equal(complete.windows.length, 12)
  const idle = worker.events.find(e => e.type === 'idle')
  assert.equal(idle.ledger.maxPcmBytes, 3_840_000)
  assert.equal(idle.ledger.acquiredSamples, idle.ledger.closedSamples)
  assert.equal(idle.ledger.inputOwners + idle.ledger.sampleOwners + idle.ledger.pcmBytes, 0)
  assert.equal(worker.calls.filter(c => c.kind === 'run').length, 12)
  assert.ok(complete.windows.every(w => w.chunks.every(c => c.timed)))
  assert.equal(worker.factoryCalls(), 0)
})
test('a core work-budget failure discards completion and releases audio owners in finally', async () => {
  const worker = await workerHarness({ coreError: true }); await worker.initialize()
  await worker.send({ type: 'transcribe', requestId: 1, blob: new Blob(['fixture']), seconds: 1, language: 'french' })
  assert.equal(worker.events.some(e => e.type === 'complete'), false)
  const error = worker.events.find(e => e.type === 'error')
  assert.match(error.message, /inference--91/)
  assert.equal(error.ledger.inputOwners + error.ledger.sampleOwners + error.ledger.pcmBytes, 0)
  assert.equal(error.ledger.acquiredSamples, error.ledger.closedSamples)
})

test('all original acceptance case bodies are unchanged except the reviewed browser reopen lifecycle', () => {
  const original = read('scripts/issue201/run-speech-lab.mjs')
  const runner = read('scripts/issue201/whispercpp-lab/run-lab.mjs')
  const start = "  await check('no-model-and-lazy-runtime'", end = "  await takeSample('final-idle')"
  const cases = source => source.slice(source.indexOf(start), source.indexOf(end))
  const oldLifecycle = `    clearInterval(sampler)
    await sampleQueue.drain()
    await context.close()
    context = await chromium.launchPersistentContext(profile, { headless: true,
      args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'], acceptDownloads: false })
    page = context.pages()[0] ?? await context.newPage()
    observePage()
    browserCdp = await context.browser().newBrowserCDPSession()
    await takeSample('reopened-idle')
    sampler = setInterval(() => { void takeSample() }, 250)`
  const newLifecycle = `    await closeOwnedBrowser('planned-offline-reopen')
    if (stopReason) throw new Error('Reopen stopped after a failed browser cleanup receipt')
    await launchBrowser('reopened-browser')`
  assert.ok(cases(original).includes(oldLifecycle))
  assert.equal(cases(runner), cases(original).replace(oldLifecycle, newLifecycle))
})
