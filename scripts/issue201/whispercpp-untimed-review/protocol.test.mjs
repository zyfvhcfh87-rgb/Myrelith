// Actual protocol source with inert module/model-format dependencies. No model,
// generated factory, native code, or WASM executes in these contract tests.
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const model = new Uint8Array(16).fill(3), wasm = new Uint8Array([1, 2, 3, 4])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const context = vm.createContext({ Object, ArrayBuffer, Uint8Array, Float32Array, TextDecoder, performance,
  WebAssembly: undefined }, { codeGeneration: { strings: false, wasm: false } })
const source = new vm.SourceTextModule(readFileSync(new URL('worker-protocol.mjs', import.meta.url), 'utf8'), { context })
await source.link(async specifier => {
  assert.equal(specifier, './model-format.mjs')
  return new vm.SyntheticModule(['MODEL_BYTES', 'MODEL_SHA256', 'inspectTinyQ8'], function () {
    this.setExport('MODEL_BYTES', model.length)
    this.setExport('MODEL_SHA256', sha(model))
    this.setExport('inspectTinyQ8', bytes => assert.equal(bytes.byteLength, model.length))
  }, { context })
})
await source.evaluate()
const { readSpeechOutput, createSpeechWorkerProtocol } = source.namespace

function outputModule(rows = [{ text: ' first', from: 0, to: 50 }, { text: ' second', from: 50, to: 100 }]) {
  const HEAPU8 = new Uint8Array(100000), pointers = []
  let cursor = 64004
  for (const row of rows) {
    pointers.push(cursor)
    const bytes = new TextEncoder().encode(row.text)
    HEAPU8.set(bytes, cursor); cursor += bytes.length + 1
  }
  return { HEAPU8, _speech_segment_count: () => rows.length,
    _speech_segment_t0: i => rows[i].from, _speech_segment_t1: i => rows[i].to,
    _speech_segment_text: i => pointers[i] }
}
const unavailableModule = rows => outputModule((rows ?? [{ text: ' first' }, { text: ' second' }])
  .map(row => ({ ...row, from: -1, to: -1 })))
const plain = value => JSON.parse(JSON.stringify(value))

test('timed output preserves exact endpoints; untimed output preserves whole-window text and contains no segment endpoints', () => {
  assert.deepEqual(plain(readSpeechOutput(outputModule(), 16000, 0)), { timing: 'model', segments: [
    { text: ' first', fromCentiseconds: 0, toCentiseconds: 50 },
    { text: ' second', fromCentiseconds: 50, toCentiseconds: 100 },
  ] })
  assert.deepEqual(plain(readSpeechOutput(unavailableModule(), 16000, 1)),
    { timing: 'unavailable', reason: 'timestamp-coverage', text: ' first second' })
  assert.deepEqual(plain(readSpeechOutput(outputModule([]), 16000, 0)), { timing: 'model', segments: [] })
})
test('explicit status is required; timed overhang never silently changes to untimed and untimed getters must withhold endpoints', () => {
  for (const status of [-944, -943, -91, 2, undefined, '1', NaN]) {
    assert.throws(() => readSpeechOutput(unavailableModule(), 16000, status))
  }
  for (const [from, to] of [[-1, 100], [0, 0], [0, 101], [0.5, 100], [0, NaN]]) {
    assert.throws(() => readSpeechOutput(outputModule([{ text: ' invalid time', from, to }]), 16000, 0))
  }
  assert.throws(() => readSpeechOutput(outputModule(), 16000, 1), /untimed-endpoints/)
  assert.throws(() => readSpeechOutput(unavailableModule([]), 16000, 1), /segment-count/)
  assert.throws(() => readSpeechOutput(outputModule([
    { text: ' first', from: 0, to: 60 }, { text: ' second', from: 50, to: 100 },
  ]), 16000, 0), /segment-time/)
})
test('untimed fallback cannot hide malformed later text, count, UTF8, pointers or aggregate budgets', () => {
  for (const text of ['', ' ', 'x'.repeat(4001)]) {
    assert.throws(() => readSpeechOutput(unavailableModule([{ text: ' valid first' }, { text }]), 16000, 1))
  }
  for (const count of [-1, 1001, 0.5, NaN]) {
    const m = unavailableModule(); m._speech_segment_count = () => count
    assert.throws(() => readSpeechOutput(m, 16000, 1), /segment-count/)
  }
  for (const pointer of [0, -1, 0.5, 100000]) {
    const m = unavailableModule(), first = m._speech_segment_text
    m._speech_segment_text = i => i === 1 ? pointer : first(i)
    assert.throws(() => readSpeechOutput(m, 16000, 1), /segment-pointer/)
  }
  const bad = unavailableModule(); bad.HEAPU8[bad._speech_segment_text(1)] = 0xff
  assert.throws(() => readSpeechOutput(bad, 16000, 1))
  const unterminated = unavailableModule(); unterminated.HEAPU8.fill(1, unterminated._speech_segment_text(1))
  assert.throws(() => readSpeechOutput(unterminated, 16000, 1), /segment-bytes/)
  assert.throws(() => readSpeechOutput(unavailableModule(Array.from({ length: 6 }, () => ({ text: 'x'.repeat(4000) }))), 16000, 1), /segment-text/)
})

function harness({ status = 1, module: overrides = {}, now = () => 0 } = {}) {
  const events = [], m = unavailableModule()
  let owned = 0, loads = 0, closes = 0, factories = 0
  Object.assign(m, { _speech_model_alloc: () => 4, _speech_load: () => { loads++; owned = 1; return 0 },
    _speech_pcm_alloc: () => 4, _speech_run: () => status, _speech_tokens: () => 448,
    _speech_owned: () => owned, _speech_close: () => { closes++; owned = 0; return 0 } }, overrides)
  const receive = createSpeechWorkerProtocol({ createModule: async () => { factories++; return m },
    wasmIdentity: { bytes: wasm.length, sha256: sha(wasm), fileName: 'myrelith-whisper.wasm' },
    crypto: webcrypto, emit: event => events.push(event), close: () => {}, now })
  return { m, events, receive,
    load: () => receive({ v: 1, owner: 'owner', id: 1, kind: 'load', model: model.slice().buffer, wasm: wasm.slice().buffer }),
    run: (id = 2) => receive({ v: 1, owner: 'owner', id, kind: 'run', pcm: new Float32Array(16000).buffer, language: 'en' }),
    facts: () => ({ owned, loads, closes, factories }) }
}
test('untimed result retains the same ready model, later timed output works and all twelve windows remain bounded', async () => {
  const h = harness(); await h.load(); await h.run()
  assert.equal(h.events.at(-1).kind, 'result'); assert.equal(h.events.at(-1).timing, 'unavailable')
  assert.equal('segments' in h.events.at(-1), false)
  h.m._speech_run = () => 0; h.m._speech_segment_t0 = i => i * 50; h.m._speech_segment_t1 = i => (i + 1) * 50
  for (let id = 3; id <= 13; id++) await h.run(id)
  assert.equal(h.events.filter(event => event.kind === 'result').length, 12)
  assert.equal(h.events.at(-1).timing, 'model')
  assert.deepEqual(h.facts(), { owned: 1, loads: 1, closes: 0, factories: 1 })
  await h.run(14)
  assert.equal(h.events.at(-1).code, 'window-count'); assert.equal(h.events.at(-1).cooperativeZero, true)
  assert.equal(h.facts().closes, 1)
})
test('untimed status does not excuse malformed native data, token/resource errors, traps or deadline failure', async () => {
  for (const module of [
    { _speech_run: () => -944 }, { _speech_run: () => -942 }, { _speech_run: () => -946 },
    { _speech_run: () => -91 }, { _speech_run: () => { throw Error('native trap') } },
    { _speech_tokens: () => 449 }, { _speech_tokens: () => -1 }, { _speech_owned: () => 2 },
    { _speech_segment_count: () => 1001 }, { _speech_segment_t1: () => 100 },
    { _speech_segment_text: () => 0 },
  ]) {
    const h = harness(); await h.load()
    assert.equal(h.events.at(-1).kind, 'ready')
    Object.assign(h.m, module); await h.run()
    assert.equal(h.events.some(event => event.kind === 'result'), false)
    assert.equal(h.events.at(-1).kind, 'error'); assert.equal(h.facts().closes, 1)
  }
  let time = 0
  const h = harness({ now: () => time, module: { _speech_run: () => { time = 120000; return 1 } } })
  await h.load(); await h.run()
  assert.equal(h.events.at(-1).code, 'window-deadline'); assert.equal(h.events.at(-1).cooperativeZero, true)
})
test('explicit close after untimed output acknowledges zero and late requests cannot revive it', async () => {
  const h = harness(); await h.load(); await h.run()
  await h.receive({ v: 1, owner: 'owner', id: 3, kind: 'close' })
  const eventCount = h.events.length
  assert.equal(h.events.at(-1).cooperativeZero, true)
  await h.run(4); assert.equal(h.events.length, eventCount)
  assert.deepEqual(h.facts(), { owned: 0, loads: 1, closes: 1, factories: 1 })
})
