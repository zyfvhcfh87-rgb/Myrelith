// Separate whisper.cpp laboratory worker. Never imported by production source.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from '/assets/mediabunny.mjs'
import { speechSegments, withinSourceCoverage } from './lab-contract.mjs'
import { verifyCandidate, modelCachePayload, WASM_IDENTITY, GLUE_IDENTITY } from './candidate.mjs'
import { createSpeechWorkerProtocol } from './worker-protocol.mjs'
import { observeModuleFactory } from './observe-module.mjs'

let manifest
let core = null
let coreReply = null
let coreId = 0
let lastHeapBytes = 0
const coreOwner = `lab-${crypto.randomUUID()}`
let active = false
let disposed = false
let messageBusy = false
let inputOwner = null
let phase = 'created'
const ledger = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, acquiredSamples: 0,
  closedSamples: 0, pcmBytes: 0, maxPcmBytes: 0, windows: 0 }
const post = (type, value = {}) => {
  if (type === 'phase') phase = value.phase
  self.postMessage({ type, ...value })
}
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
const updatePcm = bytes => {
  ledger.pcmBytes = bytes
  ledger.maxPcmBytes = Math.max(ledger.maxPcmBytes, bytes)
  if (bytes > manifest.thresholds.maxPcmBytes) throw new Error('PCM work budget exceeded')
}
async function callCore(kind, payload = {}) {
  if (!core) throw new Error('Core is unavailable')
  coreReply = null
  const id = ++coreId
  await core({ v: 1, owner: coreOwner, id, kind, ...payload })
  const result = coreReply
  coreReply = null
  if (!result || result.owner !== coreOwner || result.id !== id || result.v !== 1) throw new Error('Core response identity differs')
  if (result.kind === 'error') throw new Error(`Core ${result.code}; cooperativeZero=${result.cooperativeZero}`)
  const expected = kind === 'load' ? 'ready' : kind === 'run' ? 'result' : 'closed'
  if (result.kind !== expected) throw new Error('Unexpected core response')
  if (result.heapBytes !== undefined) lastHeapBytes = result.heapBytes
  post('core', { kind: result.kind, generatedTokens: result.generatedTokens ?? null,
    heapBytes: result.heapBytes ?? null, cooperativeZero: result.cooperativeZero ?? null })
  return result
}
async function initialize(message) {
  if (manifest || disposed) throw new Error('Worker initialization is single use')
  await verifyCandidate(message.manifest, digest)
  manifest = message.manifest
  const modelIdentity = await digest(new TextEncoder().encode(modelCachePayload(manifest)))
  if (message.modelIdentity !== modelIdentity) throw new Error('Worker model/cache identity differs')
  if (typeof message.modelCache !== 'string' || !/^myrelith-issue201-whispercpp-lab-model-[a-z0-9-]{36}$/.test(message.modelCache)) throw new Error('Unexpected model cache name')
  post('phase', { phase: 'model-cache-read' })
  const file = manifest.model.files[0]
  const cache = await caches.open(message.modelCache)
  const response = await cache.match(file.url)
  if (!response || Number(response.headers.get('content-length')) !== file.bytes
    || response.headers.get('x-sha256') !== file.sha256 || response.headers.get('x-model-bundle') !== manifest.model.bundleId
    || response.headers.get('x-source-revision') !== file.sourceRevision || response.headers.get('x-source-repository') !== file.sourceRepository
    || response.headers.get('x-upstream-path') !== file.upstreamPath) throw new Error('Worker model component provenance differs')
  let modelBytes = null, wasmBytes = null, glueBytes = null
  const started = performance.now()
  try {
    modelBytes = await response.arrayBuffer()
    post('model-read', { file: file.path, bytes: modelBytes.byteLength })
    post('phase', { phase: 'runtime-import' })
    // Server preflight pins these immutable response bytes. Independently hash
    // the glue response before its same-URL module import; the server never
    // reads changing files while serving the run. No blob/eval fallback exists.
    const glueResponse = await fetch('/assets/myrelith-whisper.mjs')
    if (!glueResponse.ok) throw new Error('Generated JS is unavailable')
    glueBytes = await glueResponse.arrayBuffer()
    if (glueBytes.byteLength !== GLUE_IDENTITY.bytes || await digest(glueBytes) !== GLUE_IDENTITY.sha256) throw new Error('Generated JS identity differs')
    glueBytes = null
    const { default: createModule } = await import('/assets/myrelith-whisper.mjs')
    const wasmResponse = await fetch('/assets/myrelith-whisper.wasm')
    if (!wasmResponse.ok) throw new Error('Generated WASM is unavailable')
    wasmBytes = await wasmResponse.arrayBuffer()
    // After reading the two approved runtime URLs, every JS fetch/XHR path rejects.
    // Module import requests are also bounded by the frozen server and runner.
    globalThis.fetch = () => { throw new Error('Inference worker cannot fetch') }
    globalThis.XMLHttpRequest = class { constructor() { throw new Error('Inference worker cannot use XHR') } }
    const observed = observeModuleFactory(createModule)
    core = createSpeechWorkerProtocol({ createModule: observed.createModule, wasmIdentity: WASM_IDENTITY, crypto,
      emit: value => { coreReply = value }, close: () => {} })
    post('phase', { phase: 'model-load' })
    let result
    try { result = await callCore('load', { model: modelBytes, wasm: wasmBytes }) }
    finally { post('native-diagnostics', { detail: observed.snapshot() }) }
    ledger.modelOwners = 1
    post('ready', { loadMs: performance.now() - started, ledger: { ...ledger }, heapBytes: result.heapBytes,
      runtime: manifest.runtime, modelIdentity, bundleId: manifest.model.bundleId,
      configurationRevision: manifest.model.configurationRevision, files: manifest.model.files })
  } finally { modelBytes = null; wasmBytes = null; glueBytes = null }
}

/** Fixed-radius windowed sinc; a bounded window, no full-source PCM retention. */
function resampleMono(input, rate) {
  if (rate === 16_000) return input
  const output = new Float32Array(Math.ceil(input.length * 16_000 / rate))
  updatePcm(input.byteLength + output.byteLength)
  const radius = 16
  const cutoff = Math.min(1, 16_000 / rate)
  for (let index = 0; index < output.length; index++) {
    const sourcePosition = index * rate / 16_000
    const start = Math.max(0, Math.floor(sourcePosition) - radius + 1)
    const end = Math.min(input.length - 1, Math.floor(sourcePosition) + radius)
    let value = 0
    let weight = 0
    for (let source = start; source <= end; source++) {
      const offset = source - sourcePosition
      const x = Math.PI * offset * cutoff
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x
      const coefficient = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * offset / radius))
      value += input[source] * coefficient
      weight += coefficient
    }
    output[index] = weight === 0 ? 0 : value / weight
  }
  return output
}

async function prepareWindow(track, start, end) {
  const rate = await track.getSampleRate()
  const channels = await track.getNumberOfChannels()
  // This model lab qualifies the pinned mono 8/16 kHz fixtures only. Broader
  // production audio configurations must pass the later decoder adapter gate.
  if (![8_000, 16_000].includes(rate) || channels !== 1 || end - start > 30) throw new Error('Unsupported laboratory audio profile')
  const first = Math.round(start * rate)
  const last = Math.round(end * rate)
  const raw = new Float32Array(last - first)
  updatePcm(raw.byteLength)
  let cursor = first
  const iterator = new AudioSampleSink(track).samples(first / rate, last / rate)
  try {
    while (cursor < last) {
      const result = await iterator.next()
      if (result.done) break
      const sample = result.value
      ledger.sampleOwners++
      ledger.acquiredSamples++
      try {
        const samplePosition = sample.timestamp * rate
        const sampleStart = Math.round(samplePosition)
        if (sample.sampleRate !== rate || sample.numberOfChannels !== 1 || sample.numberOfFrames > rate
          || Math.abs(samplePosition - sampleStart) > 0.25 || sampleStart > cursor) throw new Error('Unsupported native audio block/timestamp')
        const count = Math.min(last, sampleStart + sample.numberOfFrames) - cursor
        if (count > 0) {
          sample.copyTo(raw.subarray(cursor - first, cursor - first + count), {
            format: 'f32-planar', planeIndex: 0, frameOffset: cursor - sampleStart, frameCount: count,
          })
          cursor += count
        }
      } finally {
        sample.close()
        ledger.sampleOwners--
        ledger.closedSamples++
      }
    }
  } finally { await iterator.return() }
  if (cursor !== last || raw.some((sample) => !Number.isFinite(sample))) throw new Error('Incomplete/non-finite audio source window')
  return resampleMono(raw, rate)
}

async function transcribe(message) {
  if (!core || active || disposed) throw new Error('Worker not available for a job')
  if (!(message.blob instanceof Blob) || message.blob.size > 20_000_000
    || !Number.isFinite(message.seconds) || message.seconds < 1 || message.seconds > 300
    || !['english', 'french'].includes(message.language)) throw new Error('Invalid bounded laboratory request')
  active = true
  post('phase', { phase: 'decode-setup' })
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(message.blob) })
  inputOwner = input
  ledger.inputOwners = 1
  const windows = []
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) throw new Error('Fixture audio cannot decode')
    const coverage = await track.computeDuration()
    if (!withinSourceCoverage(message.seconds, coverage)) throw new Error('Requested window exceeds fixture coverage')
    for (let start = 0; start < message.seconds; start += 25) {
      const end = Math.min(message.seconds, start + 30)
      post('phase', { phase: 'prepare', start, end })
      let audio = await prepareWindow(track, start, end)
      const zero = audio.every((sample) => sample === 0)
      // The returned audio window plus the C-owned PCM copy are both charged.
      updatePcm(zero ? audio.byteLength : audio.byteLength * 2)
      post('phase', { phase: 'infer', start, end, ledger: { ...ledger } })
      const began = performance.now()
      const output = zero ? null : await callCore('run', { pcm: audio.buffer,
        language: message.language === 'english' ? 'en' : 'fr' })
      const result = output ? { text: output.segments.map(segment => segment.text).join(''),
        chunks: output.segments.map(segment => ({ text: segment.text,
          timestamp: [segment.fromCentiseconds / 100, segment.toCentiseconds / 100] })) } : { text: '', chunks: [] }
      const generatedTokens = output?.generatedTokens ?? 0
      const elapsed = performance.now() - began
      if (elapsed > manifest.thresholds.maxWindowWallMs) throw new Error('Inference window exceeded its wall-time ceiling')
      const chunks = speechSegments(result, end - start)
      windows.push({ start, end, elapsedMs: elapsed, text: result.text, chunks, digitalSilenceSkipped: zero, generatedTokens, heapBytes: output?.heapBytes ?? lastHeapBytes })
      ledger.windows++
      audio = null
      updatePcm(0)
      post('window', { index: windows.length - 1, detail: windows.at(-1), ledger: { ...ledger } })
      if (end === message.seconds) break
    }
    post('complete', { requestId: message.requestId, windows, ledger: { ...ledger } })
  } finally {
    input.dispose()
    inputOwner = null
    ledger.inputOwners = 0
    updatePcm(0)
    active = false
    post('idle', { ledger: { ...ledger } })
  }
}

self.onmessage = async ({ data }) => {
  if (messageBusy) { post('error', { code: 'overlapping-message', phase, message: 'Overlapping laboratory request', ledger: { ...ledger } }); return }
  messageBusy = true
  try {
    if (data.type === 'initialize') await initialize(data)
    else if (data.type === 'transcribe') await transcribe(data)
    else if (data.type === 'dispose') {
      if (active) throw new Error('Active jobs must be terminated by the parent owner')
      disposed = true
      inputOwner?.dispose()
      inputOwner = null
      const result = await callCore('close')
      if (!result.cooperativeZero) throw new Error('Native cleanup did not reach zero owned resources')
      core = null
      ledger.modelOwners = 0
      post('disposed', { ledger: { ...ledger }, cooperativeZero: true })
      self.close()
    } else throw new Error('Unknown laboratory message')
  } catch (error) {
    post('error', { code: data.type === 'initialize' ? 'initialization-failed'
      : data.type === 'transcribe' ? 'transcription-failed' : 'disposal-failed', phase,
      message: error instanceof Error ? error.message : String(error), ledger: { ...ledger } })
  } finally { messageBusy = false }
}
