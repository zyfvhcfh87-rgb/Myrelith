import { audioFingerprintIsValid, type AudioFingerprint, type AudioFingerprintRequest } from '../domain/multicamAlignment'
import type { AudioAlignmentSourceFacts, AudioAlignmentWorkerReply, AudioAlignmentWorkerRequest } from '../pipeline/audioAlignmentProtocol'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'

export interface AudioAlignmentWorkerLike {
  postMessage(message: AudioAlignmentWorkerRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<AudioAlignmentWorkerReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}

/** Each angle owns its worker until cache lookup or decode ends. Termination precedes settlement. */
export function createAudioAlignmentWorker(
  signal: AbortSignal,
  decoderCount: (count: number) => void,
  progress: (fraction: number) => void,
  factory: () => AudioAlignmentWorkerLike = () => new Worker(new URL('../workers/audio-alignment.worker.ts', import.meta.url), { type: 'module' }),
) {
  const worker = factory()
  let closed = false
  let phase: 'idle' | 'opening' | 'ready' | 'decoding' = 'idle'
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { resolve: (value: AudioAlignmentSourceFacts | AudioFingerprint) => void; reject: (cause: unknown) => void } | null = null
  const close = (cause: unknown = new DOMException('Audio alignment cancelled', 'AbortError')) => {
    if (closed) return
    closed = true
    if (timer !== null) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    worker.onmessage = worker.onerror = worker.onmessageerror = null
    try { worker.terminate() } finally { decoderCount(0) }
    const retiring = pending
    pending = null
    retiring?.reject(cause)
  }
  const onAbort = () => close(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  worker.onerror = () => close(new Error('Audio analysis worker failed'))
  worker.onmessageerror = () => close(new Error('Audio analysis worker reply could not be read'))
  worker.onmessage = ({ data }) => {
    if (closed) return
    if (data.type === 'failure') { close(new Error(data.detail)); return }
    if (data.type === 'progress' && phase === 'decoding') {
      try { if (Number.isFinite(data.fraction)) progress(Math.max(0, Math.min(1, data.fraction))) }
      catch (cause) { close(cause) }
      return
    }
    const waiting = pending
    if (!waiting) { close(new Error('Unexpected audio worker reply')); return }
    if (data.type === 'opened' && phase === 'opening') {
      if (timer !== null) clearTimeout(timer)
      pending = null
      phase = 'ready'
      waiting.resolve(data.facts)
    } else if (data.type === 'complete' && phase === 'decoding' && audioFingerprintIsValid(data.fingerprint)) {
      pending = null
      close()
      waiting.resolve(data.fingerprint)
    } else close(new Error('Invalid audio worker result'))
  }
  function call(message: AudioAlignmentWorkerRequest): Promise<AudioAlignmentSourceFacts | AudioFingerprint> {
    if (signal.aborted) close(signal.reason)
    if (closed) return Promise.reject(new DOMException('Audio worker is closed', 'AbortError'))
    return new Promise((resolve, reject) => {
      pending = { resolve, reject }
      timer = setTimeout(() => close(new Error('Audio window analysis exceeded its 30 second deadline')), 30_000)
      try { worker.postMessage(message) } catch (cause) { close(cause) }
    })
  }
  return {
    async open(blob: Blob, sourceId: string, budget: LocalDecoderBudget): Promise<AudioAlignmentSourceFacts> {
      if (phase !== 'idle') throw new Error('Audio source is already open')
      phase = 'opening'
      return await call({ type: 'open', blob, sourceId, budget }) as AudioAlignmentSourceFacts
    },
    async decode(window: AudioFingerprintRequest): Promise<AudioFingerprint> {
      if (phase !== 'ready') throw new Error('Audio source is not ready')
      phase = 'decoding'
      decoderCount(1)
      return await call({ type: 'decode', window }) as AudioFingerprint
    },
    close,
  }
}
