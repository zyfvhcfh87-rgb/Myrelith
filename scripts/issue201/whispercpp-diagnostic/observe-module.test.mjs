import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import test from 'node:test'
import { createSpeechWorkerProtocol } from '../whispercpp/worker-protocol.mjs'
import { observeModuleFactory, DIAGNOSTIC_LIMITS } from './observe-module.mjs'

const model = readFileSync('.tmp/issue201-whispercpp-preparation/ggml-tiny-q8_0.bin')
const modelBuffer = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
const wasm = new Uint8Array([1, 2, 3, 4]) // Inert protocol input; no WASM API exists in this test.
const hash = value => createHash('sha256').update(value).digest('hex')
function fakeModule() {
  let owned = 0
  const module = { HEAPU8: new Uint8Array(64 * 1024 * 1024),
    _speech_model_alloc() { assert.equal(this, module); return 4 },
    _speech_load() { assert.equal(this, module); owned = 1; return 0 },
    _speech_close() { assert.equal(this, module); owned = 0; return 0 },
    _speech_owned: () => owned }
  return module
}
async function protocol(factory) {
  const diagnostics = observeModuleFactory(factory), replies = []
  const receive = createSpeechWorkerProtocol({ createModule: diagnostics.createModule,
    wasmIdentity: { fileName: 'myrelith-whisper.wasm', bytes: wasm.length, sha256: hash(wasm) }, crypto: webcrypto,
    emit: value => replies.push(value), close() {} })
  await receive({ v: 1, owner: 'inert', id: 1, kind: 'load', model: modelBuffer, wasm: wasm.buffer })
  return { diagnostics, replies, receive }
}
test('factory abort context and the original exception survive the actual protocol message-only reduction', async () => {
  const original = new Error('Aborted()'); let aborts = 0, callbackValue
  const h = await protocol(async options => {
    // The actual core supplies the old callbacks. A second observer checks that
    // forwarding preserves the exact abort argument without extra native calls.
    const originalAbort = options.onAbort
    options.onAbort = value => { aborts++; callbackValue = value; originalAbort(value) }
    options.printErr('ggml.c:123: fatal diagnostic')
    options.onAbort('')
    throw original
  })
  assert.equal(aborts, 1); assert.equal(callbackValue, '')
  assert.equal(h.replies[0].code, original.message)
  assert.equal(h.replies[0].cooperativeZero, false)
  const rows = h.diagnostics.snapshot().records
  assert.ok(rows.some(row => row.kind === 'stderr' && row.text.includes('fatal diagnostic')))
  assert.ok(rows.some(row => row.kind === 'abort' && row.phase === 'factory' && row.text === ''))
  assert.ok(rows.some(row => row.kind === 'exception' && row.text === original.stack))
})
for (const name of ['_speech_model_alloc', '_speech_load']) {
  test(`actual protocol diagnostics identify an abort in ${name} and retain the cleanup attempt`, async () => {
    const original = new Error('inert abort at ' + name)
    const h = await protocol(async () => { const module = fakeModule(); module[name] = () => { throw original }; return module })
    assert.equal(h.replies[0].code, original.message)
    assert.ok(h.diagnostics.snapshot().records.some(row => row.kind === 'exception' && row.phase === name && row.text === original.stack))
    assert.ok(h.diagnostics.snapshot().records.some(row => row.kind === 'enter' && row.phase === '_speech_close'))
  })
}
test('successful control flow retains module identity, live heap views, arguments, return values and callback forwarding', async () => {
  const module = fakeModule(), view = module.HEAPU8, wasmBinary = new Uint8Array([8]), errors = [], aborts = []
  let optionsReceived
  const h = observeModuleFactory(async options => { optionsReceived = options; return module })
  const locateFile = () => 'urn:inert'
  const returned = await h.createModule({ wasmBinary, locateFile, printErr: value => errors.push(value), onAbort: value => aborts.push(value) })
  assert.equal(returned, module); assert.equal(returned.HEAPU8, view)
  assert.equal(optionsReceived.wasmBinary, wasmBinary); assert.equal(optionsReceived.locateFile, locateFile)
  optionsReceived.printErr('message'); optionsReceived.onAbort('')
  assert.deepEqual(errors, ['message']); assert.deepEqual(aborts, [''])
  assert.equal(module._speech_model_alloc(43537433), 4)
  assert.equal(module._speech_load(), 0); assert.equal(module._speech_owned(), 1)
  module.HEAPU8 = new Uint8Array(4); assert.equal(returned.HEAPU8.byteLength, 4)
  assert.equal(module._speech_close(), 0); assert.equal(module._speech_owned(), 0)
  await assert.rejects(h.createModule({}), /single use/)
})
test('diagnostics remain bounded, retain the latest fatal tail and never stringify arbitrary objects', async () => {
  const h = observeModuleFactory(async options => {
    for (let i = 0; i < 100; i++) options.printErr('x'.repeat(5000))
    options.printErr({ toString() { throw new Error('Must not stringify') } })
    options.printErr('latest fatal detail')
    return fakeModule()
  })
  await h.createModule({})
  const snap = h.snapshot()
  assert.ok(snap.records.length <= DIAGNOSTIC_LIMITS.records)
  assert.ok(snap.characters <= DIAGNOSTIC_LIMITS.characters)
  assert.ok(snap.records.every(row => row.text.length <= DIAGNOSTIC_LIMITS.perRecordCharacters))
  assert.equal(snap.truncatedRecords, 100); assert.ok(snap.omittedRecords > 0)
  assert.ok(snap.records.some(row => row.text === 'latest fatal detail'))
  snap.records.length = 0; assert.ok(h.snapshot().records.length > 0)
})
