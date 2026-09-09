// Disposable laboratory owner. No production source imports this module.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from '/assets/mediabunny.mjs'
import { pinnedModelFileLookup, speechSegments, withinSourceCoverage } from './lab-contract.mjs'
import { assertReviewedComposite, verifyModelBundle, modelCachePayload } from './composite-model.mjs'
import { installEncoderFetchPolicy } from './encoder-fetch-policy.mjs'

let manifest
let transcriber
let active = false
let disposed = false
let inputOwner = null
let phase = 'created'
const ledger = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, acquiredSamples: 0,
  closedSamples: 0, pcmBytes: 0, maxPcmBytes: 0, windows: 0 }
const post = (type, value = {}) => {
  if (type === 'phase') phase = value.phase
  self.postMessage({ type, ...value })
}
const updatePcm = (bytes) => {
  ledger.pcmBytes = bytes
  ledger.maxPcmBytes = Math.max(ledger.maxPcmBytes, bytes)
  if (bytes > manifest.thresholds.maxPcmBytes) throw new Error('PCM work budget exceeded')
}

async function initialize(message) {
  if (manifest || disposed) throw new Error('Worker initialization is single use')
  manifest = message.manifest
  assertReviewedComposite(manifest)
  const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
  await verifyModelBundle(manifest.model, digest)
  const modelIdentity = await digest(new TextEncoder().encode(modelCachePayload(manifest)))
  if (message.modelIdentity !== modelIdentity) throw new Error('Worker model/cache identity differs')
  const cache = await caches.open(message.modelCache)
  const files = pinnedModelFileLookup(manifest.model, location.origin)
  const runtimeUrls = new Set(manifest.runtime.artifacts.map((asset) => `${location.origin}/assets/${asset.name}`))
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (request, options) => {
    const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url, location.href).href
    post('fetch', { url })
    if (runtimeUrls.has(url)) return nativeFetch(request, options)
    // Known optional model probes are explicit misses, never network discovery.
    if (url.startsWith(`${location.origin}/models/${manifest.model.id}/`) && !files.has(url)) {
      post('optional-miss', { url })
      return new Response(null, { status: 404 })
    }
    throw new Error(`Worker network boundary denied ${url}`)
  }
  post('phase', { phase: 'runtime-import' })
  const { pipeline, env } = await import('/assets/transformers.local.mjs')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useFS = false
  env.useFSCache = false
  env.useBrowserCache = false
  env.useCustomCache = true
  env.useWasmCache = false
  env.customCache = {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url
      const file = files.get(key)
      post('model-read', { key, file: file?.path ?? null })
      if (!file) return undefined
      const response = await cache.match(file.url)
      if (!response) throw new Error(`Verified model cache missing ${file.path}`)
      if (Number(response.headers.get('content-length')) !== file.bytes || response.headers.get('x-sha256') !== file.sha256
        || response.headers.get('x-model-bundle') !== manifest.model.bundleId || response.headers.get('x-source-revision') !== file.sourceRevision
        || response.headers.get('x-source-repository') !== file.sourceRepository || response.headers.get('x-upstream-path') !== file.upstreamPath) throw new Error('Worker model component provenance differs')
      return response
    },
    async put() { throw new Error('The inference worker cannot write model caches') },
  }
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${location.origin}/assets/ort-wasm-simd-threaded.mjs`,
    wasm: `${location.origin}/assets/ort-wasm-simd-threaded.wasm`,
  }
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false
  post('phase', { phase: 'model-load' })
  const started = performance.now()
  transcriber = await pipeline('automatic-speech-recognition', manifest.model.id, {
    revision: manifest.model.configurationRevision, device: 'wasm', dtype: 'q8', local_files_only: true,
    session_options: structuredClone(manifest.runtime.sessionOptions),
    progress_callback: (progress) => post('progress', { status: progress.status, file: progress.file ?? null }),
  })
  ledger.modelOwners = 1
  installEncoderFetchPolicy(transcriber.model?.sessions?.model, manifest.runtime.encoderFetchPolicy,
    (event) => { const { type, ...detail } = event; post(type, detail) })
  post('ready', { loadMs: performance.now() - started, ledger: { ...ledger }, version: env.version,
    sessionOptions: manifest.runtime.sessionOptions, encoderFetchPolicy: manifest.runtime.encoderFetchPolicy,
    modelIdentity, bundleId: manifest.model.bundleId, configurationRevision: manifest.model.configurationRevision, files: manifest.model.files })
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
  if (!transcriber || active || disposed) throw new Error('Worker not available for a job')
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
      post('phase', { phase: 'infer', start, end, ledger: { ...ledger } })
      const began = performance.now()
      const result = zero ? { text: '', chunks: [] } : await transcriber(audio, {
        language: message.language, task: 'transcribe', return_timestamps: true,
        max_new_tokens: manifest.thresholds.maxNewTokens, do_sample: false,
      })
      const elapsed = performance.now() - began
      if (elapsed > manifest.thresholds.maxWindowWallMs) throw new Error('Inference window exceeded its wall-time ceiling')
      const chunks = speechSegments(result, end - start)
      windows.push({ start, end, elapsedMs: elapsed, text: result.text, chunks, digitalSilenceSkipped: zero })
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
  try {
    if (data.type === 'initialize') await initialize(data)
    else if (data.type === 'transcribe') await transcribe(data)
    else if (data.type === 'dispose') {
      if (active) throw new Error('Active jobs must be terminated by the parent owner')
      disposed = true
      inputOwner?.dispose()
      inputOwner = null
      if (transcriber) await transcriber.dispose()
      transcriber = null
      ledger.modelOwners = 0
      post('disposed', { ledger: { ...ledger } })
      self.close()
    } else throw new Error('Unknown laboratory message')
  } catch (error) {
    post('error', { code: data.type === 'initialize' ? 'initialization-failed'
      : data.type === 'transcribe' ? 'transcription-failed' : 'disposal-failed', phase,
    message: error instanceof Error ? error.message : String(error), ledger: { ...ledger } })
  }
}
