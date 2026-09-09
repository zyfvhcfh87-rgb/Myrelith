/** Dedicated cooperative speech owner. No model, PCM or decoder enters app state. */
import { createSpeechWorkerProtocol, type CoreReply } from '../codecs/speech/worker-protocol.mjs'
import { hashSpeechBytes, readSpeechModel, readBoundedSpeechResponse } from '../codecs/speech/modelCache'
import { SPEECH_GLUE, SPEECH_WASM } from '../domain/speechModel'
import { SPEECH_AUDIO } from '../domain/speechAudio'
import { validateSpeechTranscript, type SpeechTranscript, type SpeechWindow } from '../domain/speechTranscript'
import { openSpeechAudioSource } from '../pipeline/speechAudioDecode'
import { speechLedgerIsZero, type SpeechLedger, type SpeechPhase, type SpeechRequest, type SpeechWorkerReply, type SpeechWorkerRequest } from '../pipeline/speechProtocol'

const scope = self as unknown as { onmessage: ((event: MessageEvent<SpeechWorkerRequest>) => void) | null; postMessage(value: SpeechWorkerReply): void; close(): void }
let busy = false, cancelled = false, requestId = '', coreId = 0, coreZero = true
let core: ReturnType<typeof createSpeechWorkerProtocol> | null = null
let reply: CoreReply | null = null
let audio: Awaited<ReturnType<typeof openSpeechAudioSource>> | null = null
const ledger: SpeechLedger = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, acquiredSamples: 0, closedSamples: 0, pcmBytes: 0, maxPcmBytes: 0, windows: 0 }
const phase = (name: string, progress: number, category: SpeechPhase = 'setup') => scope.postMessage({ type: 'phase', requestId, phase: name, category, progress })
async function cancellationPoint() {
  await new Promise(resolve => setTimeout(resolve, 0))
  if (cancelled) throw new Error('Speech cancelled')
}
function pcm(bytes: number) {
  ledger.pcmBytes = bytes; ledger.maxPcmBytes = Math.max(ledger.maxPcmBytes, bytes)
  if (bytes > SPEECH_AUDIO.maxPcmBytes) throw new Error('Speech PCM budget exceeded')
}
async function call(kind: 'load' | 'run' | 'close', payload: object = {}): Promise<CoreReply> {
  if (!core) throw new Error('Speech native core is unavailable')
  reply = null
  const id = ++coreId
  await core({ v: 1, owner: requestId, id, kind, ...payload })
  const result = reply as CoreReply | null
  reply = null
  if (!result || result.v !== 1 || result.owner !== requestId || result.id !== id) throw new Error('Speech core response identity differs')
  if (result.kind === 'error') {
    coreZero = result.cooperativeZero === true
    if (coreZero) ledger.modelOwners = 0
    core = null
    throw new Error(`Speech runtime: ${result.code}`)
  }
  if (result.kind !== (kind === 'load' ? 'ready' : kind === 'run' ? 'result' : 'closed')) throw new Error('Unexpected speech core response')
  return result
}
async function dispose(): Promise<boolean> {
  try { audio?.close(); audio = null } catch { /* Retain nonzero input ledger. */ }
  pcm(0)
  try { if (core) coreZero = (await call('close')).cooperativeZero === true } catch { /* No forged acknowledgement. */ }
  core = null
  if (coreZero) ledger.modelOwners = 0
  return coreZero && speechLedgerIsZero(ledger)
}
async function run(data: SpeechRequest): Promise<SpeechTranscript> {
  if (typeof data.requestId !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(data.requestId)
    || !(data.blob instanceof Blob) || !['en', 'fr'].includes(data.language)
    || !Number.isSafeInteger(data.startMicroseconds) || data.startMicroseconds < 0
    || !Number.isSafeInteger(data.endMicroseconds) || data.endMicroseconds > 86_400_000_000
    || data.endMicroseconds - data.startMicroseconds < 1_000_000 || data.endMicroseconds - data.startMicroseconds > 300_000_000) throw new Error('Invalid bounded speech request')
  requestId = data.requestId
  phase('Reading installed model', 0)
  let model: ArrayBuffer | null = await readSpeechModel(data.modelCache)
  let wasm: ArrayBuffer | null = null
  try {
    await cancellationPoint()
    phase('Loading local runtime', 0)
    const base = new URL(`${import.meta.env.BASE_URL}speech-runtime/`, self.location.origin)
    const glueUrl = new URL(`${SPEECH_GLUE.sha256}.mjs`, base)
    const response = await fetch(glueUrl)
    if (!response.ok) throw new Error('The local speech runtime is unavailable. Reopen the app with an app connection.')
    const glue = await readBoundedSpeechResponse(response, SPEECH_GLUE.bytes)
    if (glue.byteLength !== SPEECH_GLUE.bytes || await hashSpeechBytes(glue) !== SPEECH_GLUE.sha256) throw new Error('Speech runtime JavaScript integrity differs')
    const module: { default: (options: object) => Promise<unknown> } = await import(/* @vite-ignore */ glueUrl.href)
    const wasmResponse = await fetch(new URL(`${SPEECH_WASM.sha256}.wasm`, base))
    if (!wasmResponse.ok) throw new Error('The local speech WASM is unavailable')
    wasm = await readBoundedSpeechResponse(wasmResponse, SPEECH_WASM.bytes)
    await cancellationPoint()
    phase('Loading speech model', 0, 'load')
    core = createSpeechWorkerProtocol({ createModule: module.default, wasmIdentity: SPEECH_WASM, crypto,
      emit: value => { reply = value }, close: () => {} })
    coreZero = false
    await call('load', { model, wasm })
    ledger.modelOwners = 1
    await cancellationPoint()
  } finally { model = null; wasm = null }
  phase('Opening source audio', 0)
  audio = await openSpeechAudioSource(data.blob, data.sourceId, data.budget, ledger)
  await cancellationPoint()
  const first = Math.round(data.startMicroseconds * audio.rate / 1_000_000)
  const last = Math.round(data.endMicroseconds * audio.rate / 1_000_000)
  const result: SpeechTranscript = { sourceSampleRate: audio.rate, channels: audio.channels,
    sourceStartSample: first, sourceSampleCount: last - first, windows: [] }
  for (let start = first; start < last; start += audio.rate * 25) {
    const end = Math.min(last, start + audio.rate * 30)
    phase(`Preparing audio window ${result.windows.length + 1}`, (start - first) / (last - first), 'prepare')
    let prepared: Float32Array<ArrayBuffer> | null = await audio.prepare(start, end - start, cancellationPoint)
    const silence = prepared.every(value => value === 0)
    pcm(prepared.byteLength * (silence ? 1 : 2))
    await cancellationPoint()
    phase(`Transcribing window ${result.windows.length + 1}`, (start - first) / (last - first), 'infer')
    const output = silence ? null : await call('run', { pcm: prepared.buffer, language: data.language })
    await cancellationPoint()
    const coverage = { sourceStartSample: start, sourceSampleCount: end - start }
    let window: SpeechWindow
    if (!output) window = { ...coverage, timing: 'model', segments: [] }
    else if (output.timing === 'unavailable' && output.reason === 'timestamp-coverage' && typeof output.text === 'string') {
      window = { ...coverage, timing: 'unavailable', reason: output.reason, text: output.text }
    } else if (output.timing === 'model' && Array.isArray(output.segments)) {
      window = { ...coverage, timing: 'model', segments: output.segments }
    } else throw new Error('Malformed native speech output')
    result.windows.push(window); ledger.windows++
    prepared = null; pcm(0)
    if (end === last) break
  }
  validateSpeechTranscript(result)
  return result
}
scope.onmessage = ({ data }) => {
  if (data?.type === 'cancel') { cancelled = true; return }
  if (busy) { cancelled = true; return }
  busy = true
  void (async () => {
    try {
      if (data?.type !== 'transcribe') throw new Error('Unknown speech request')
      const transcript = await run(data)
      await cancellationPoint()
      phase('Closing speech resources', 1, 'close')
      const cooperativeZero = await dispose()
      if (!cooperativeZero) throw new Error('Speech cleanup was not acknowledged')
      if (cancelled) scope.postMessage({ type: 'disposed', requestId, ledger: { ...ledger }, cooperativeZero })
      else scope.postMessage({ type: 'complete', requestId, transcript, ledger: { ...ledger }, cooperativeZero })
    } catch (cause) {
      const cooperativeZero = await dispose()
      if (cancelled) scope.postMessage({ type: 'disposed', requestId, ledger: { ...ledger }, cooperativeZero })
      else scope.postMessage({ type: 'error', requestId, message: cause instanceof Error ? cause.message : 'Speech failed', ledger: { ...ledger }, cooperativeZero })
    } finally { scope.close() }
  })()
}
