/** Cooperative worker bridge. A failed cleanup never releases scheduler admission. */
import { validateSpeechTranscript, type SpeechTranscript } from '../domain/speechTranscript'
import { SPEECH_PHASE_BUDGET_MS, speechLedgerIsZero, type SpeechRequest, type SpeechWorkerReply } from '../pipeline/speechProtocol'
export type SpeechWorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export class SpeechWorkerJob {
  private readonly worker: SpeechWorkerPort
  private readonly answer = deferred<SpeechTranscript>()
  private readonly cleanup = deferred<void>()
  private readonly release = deferred<void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadlineAt = performance.now() + SPEECH_PHASE_BUDGET_MS.setup
  private retiring = false
  private ended = false
  private readonly request: SpeechRequest
  readonly result = this.answer.promise
  /** Intentionally remains pending after unacknowledged cleanup, retaining the lease. */
  readonly retired = this.release.promise
  constructor(request: SpeechRequest, phase: (message: string, progress: number) => void,
    failure: (message: string) => void,
    createWorker: () => SpeechWorkerPort = () => new Worker(new URL('../workers/caption-transcription.worker.ts', import.meta.url), { type: 'module' })) {
    this.request = request
    this.worker = createWorker()
    void this.cleanup.promise.catch(() => undefined)
    const finish = (error: Error | null, data?: SpeechWorkerReply) => {
      if (this.ended) return
      this.ended = true
      if (this.timer) clearTimeout(this.timer)
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null
      this.worker.terminate()
      const acknowledged = data && 'ledger' in data && data.cooperativeZero === true && speechLedgerIsZero(data.ledger)
      if (!acknowledged) {
        const message = 'Speech cleanup was not acknowledged. Reload the app before starting more speech, playback or export.'
        this.answer.reject(error ?? new Error(message)); this.cleanup.reject(new Error(message)); failure(message)
        return
      }
      this.release.resolve(); this.cleanup.resolve()
      if (error || this.retiring || data.type !== 'complete') this.answer.reject(error ?? new Error('Speech cancelled'))
      else {
        try {
          validateSpeechTranscript(data.transcript)
          const rate = data.transcript.sourceSampleRate
          if (data.transcript.sourceStartSample !== Math.round(request.startMicroseconds * rate / 1_000_000)
            || data.transcript.sourceStartSample + data.transcript.sourceSampleCount !== Math.round(request.endMicroseconds * rate / 1_000_000)) throw new Error('Speech result differs from the requested source window')
          this.answer.resolve(data.transcript)
        } catch (cause) { this.answer.reject(cause) }
      }
    }
    const arm = (duration: number) => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        if (this.retiring) finish(new Error('Speech cleanup exceeded its deadline'))
        else { this.answer.reject(new Error('Speech phase exceeded its bounded deadline')); void this.cancel().catch(() => undefined) }
      }, duration)
    }
    this.arm = arm
    this.worker.onmessage = ({ data }: MessageEvent<SpeechWorkerReply>) => {
      if (!data || data.requestId !== this.request.requestId) { finish(new Error('Speech response identity differs')); return }
      if (data.type === 'phase') {
        if (this.retiring) return
        if (!Object.hasOwn(SPEECH_PHASE_BUDGET_MS, data.category) || typeof data.phase !== 'string' || data.phase.length > 100 || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1) { finish(new Error('Malformed speech progress')); return }
        this.deadlineAt = performance.now() + SPEECH_PHASE_BUDGET_MS[data.category]
        arm(SPEECH_PHASE_BUDGET_MS[data.category])
        phase(data.phase, data.progress)
      } else if (data.type === 'error') finish(new Error(data.message), data)
      else if (data.type === 'complete' || data.type === 'disposed') finish(null, data)
      else finish(new Error('Unknown speech response'))
    }
    this.worker.onerror = () => finish(new Error('The speech worker failed'))
    this.worker.onmessageerror = () => finish(new Error('The speech worker returned unreadable data'))
    arm(SPEECH_PHASE_BUDGET_MS.setup)
    try { this.worker.postMessage(request) } catch (cause) { finish(cause instanceof Error ? cause : new Error('Speech worker startup failed')) }
  }
  private readonly arm: (duration: number) => void
  cancel(): Promise<void> {
    if (!this.ended && !this.retiring) {
      this.retiring = true
      this.answer.reject(new Error('Speech cancelled'))
      this.arm(Math.max(0, this.deadlineAt - performance.now()) + 100)
      try { this.worker.postMessage({ type: 'cancel' }) } catch { /* Existing deadline reports an unacknowledged owner. */ }
    }
    return this.cleanup.promise
  }
}
