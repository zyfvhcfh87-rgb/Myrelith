/** Owns one recording worker and the only outstanding PCM transfer ledger. */
import { VOICEOVER_WAV_LIMITS, type VoiceoverDraftProgress, type VoiceoverDraftRecovery } from '../pipeline/voiceoverWavDraft'
import type { VoiceoverWavReply, VoiceoverWavRequest, VoiceoverWavResult } from '../pipeline/voiceoverWavProtocol'

export interface VoiceoverWavWorkerLike {
  postMessage(message: VoiceoverWavRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<VoiceoverWavReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}

type Command = VoiceoverWavRequest['type']
type RequestInput =
  | { type: 'create' | 'recover'; id: string }
  | { type: 'append'; buffer: ArrayBuffer }
  | { type: 'stop' | 'release' | 'finalize' | 'discard' }
type Pending = {
  type: Command
  bytes: number
  resolve(result: VoiceoverWavResult): void
  reject(cause: Error): void
}

export class VoiceoverWavBridge {
  private readonly worker: VoiceoverWavWorkerLike
  private readonly pending = new Map<number, Pending>()
  private readonly appends = new Set<Promise<VoiceoverDraftProgress>>()
  private nextId = 1
  private outstanding = 0
  private appendFailure: unknown = null
  private stoppedProgress: VoiceoverDraftProgress | null = null
  private phase: 'idle' | 'opening' | 'writing' | 'stopping' | 'faulted' | 'stopped' | 'discarded' | 'closed' = 'idle'

  constructor(createWorker: () => VoiceoverWavWorkerLike = () => new Worker(
    new URL('../workers/voiceover-wav.worker.ts', import.meta.url), { type: 'module' },
  )) {
    this.worker = createWorker()
    this.worker.onmessage = ({ data }) => {
      const item = this.pending.get(data?.requestId)
      if (!item) { this.fail(new Error('Recording worker returned an unexpected reply')); return }
      if (!('error' in data) && (!('result' in data) || data.result.type !== item.type)) {
        this.fail(new Error('Recording worker returned the wrong result'))
        return
      }
      this.pending.delete(data.requestId)
      this.outstanding -= item.bytes
      if ('error' in data) {
        const error = new Error(data.error.message)
        error.name = data.error.name
        item.reject(error)
      } else item.resolve(data.result)
    }
    this.worker.onerror = () => this.fail(new Error('Recording worker failed'))
    this.worker.onmessageerror = () => this.fail(new Error('Recording worker reply could not be read'))
  }

  get inFlightBytes(): number { return this.outstanding }
  get isClosed(): boolean { return this.phase === 'closed' }

  private fail(cause: Error): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.worker.terminate()
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null
    for (const item of this.pending.values()) item.reject(cause)
    this.pending.clear()
    this.outstanding = 0
  }

  close(): void { this.fail(new Error('Recording worker closed; draft may be recovered')) }

  private markFaulted(): void { if (this.phase !== 'closed') this.phase = 'faulted' }

  private send(request: RequestInput, bytes = 0): Promise<VoiceoverWavResult> {
    if (this.phase === 'closed') return Promise.reject(new Error('Recording worker is closed'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { type: request.type, bytes, resolve, reject })
      this.outstanding += bytes
      try {
        const message = { ...request, requestId } as VoiceoverWavRequest
        this.worker.postMessage(message, request.type === 'append' ? [request.buffer] : [])
      } catch (cause) {
        this.pending.delete(requestId)
        this.outstanding -= bytes
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  async create(id: string): Promise<VoiceoverDraftProgress> {
    if (this.phase !== 'idle') throw new Error('Recording worker is already in use')
    this.phase = 'opening'
    try {
      const result = await this.send({ type: 'create', id })
      if (result.type !== 'create') throw new Error('Invalid create result')
      this.phase = 'writing'
      return result.progress
    } catch (cause) { this.markFaulted(); throw cause }
  }

  append(buffer: ArrayBuffer): Promise<VoiceoverDraftProgress> {
    if (this.phase !== 'writing') throw new Error('Recording draft is not writable')
    if (buffer.byteLength < 2 || buffer.byteLength > VOICEOVER_WAV_LIMITS.batchBytes || buffer.byteLength % 2) {
      throw new RangeError('Recording batch must contain 1–8192 PCM16 samples')
    }
    if (this.outstanding + buffer.byteLength > VOICEOVER_WAV_LIMITS.inFlightBytes) {
      const error = new Error('Recording transfer limit exceeded')
      error.name = 'BackpressureOverrun'
      this.markFaulted()
      throw error
    }
    const sent = this.send({ type: 'append', buffer }, buffer.byteLength).then((result) => {
      if (result.type !== 'append') throw new Error('Invalid append result')
      return result.progress
    })
    const tracked = sent.catch((cause: unknown) => {
      this.appendFailure ??= cause
      this.markFaulted()
      throw cause
    })
    this.appends.add(tracked)
    void tracked.then(() => this.appends.delete(tracked), () => this.appends.delete(tracked))
    return tracked
  }

  private async drain(): Promise<void> {
    await Promise.allSettled(this.appends)
    if (this.appendFailure) throw this.appendFailure
  }

  async stop(): Promise<VoiceoverDraftProgress> {
    if (this.phase !== 'writing') throw new Error('Recording draft is not writable')
    this.phase = 'stopping'
    try {
      await this.drain()
      const result = await this.send({ type: 'stop' })
      if (result.type !== 'stop') throw new Error('Invalid stop result')
      this.phase = 'stopped'
      this.stoppedProgress = result.progress
      return result.progress
    } catch (cause) { this.markFaulted(); throw cause }
  }

  async release(): Promise<VoiceoverDraftProgress> {
    // A capture graph may detect a sample-count error after the writer has
    // already checkpointed successfully. That draft is already released.
    if (this.phase === 'stopped' && this.stoppedProgress) return this.stoppedProgress
    if (this.phase !== 'writing' && this.phase !== 'faulted') throw new Error('Recording draft cannot be released now')
    this.phase = 'stopping'
    try {
      if (this.appends.size) await Promise.allSettled(this.appends)
      const result = await this.send({ type: 'release' })
      if (result.type !== 'release') throw new Error('Invalid release result')
      this.phase = 'faulted'
      return result.progress
    } catch (cause) { this.markFaulted(); throw cause }
  }

  async recover(id: string): Promise<VoiceoverDraftRecovery> {
    if (this.phase !== 'idle') throw new Error('Recording worker is already in use')
    this.phase = 'opening'
    try {
      const result = await this.send({ type: 'recover', id })
      if (result.type !== 'recover') throw new Error('Invalid recovery result')
      this.phase = 'stopped'
      this.stoppedProgress = result.progress
      return result.progress
    } catch (cause) { this.markFaulted(); throw cause }
  }

  async finalize(): Promise<{ file: File; handle: FileSystemFileHandle; pcmBytes: number }> {
    if (this.phase !== 'stopped') throw new Error('Recording draft is not stopped')
    const result = await this.send({ type: 'finalize' })
    if (result.type !== 'finalize') throw new Error('Invalid finalization result')
    return { file: result.file, handle: result.handle, pcmBytes: result.pcmBytes }
  }

  async discard(): Promise<void> {
    if (this.phase === 'discarded') return
    if (this.phase !== 'writing' && this.phase !== 'stopped' && this.phase !== 'faulted') {
      throw new Error('No recording draft to discard')
    }
    this.phase = 'stopping'
    try {
      if (this.appends.size) await Promise.allSettled(this.appends)
      const result = await this.send({ type: 'discard' })
      if (result.type !== 'discard') throw new Error('Invalid discard result')
      this.phase = 'discarded'
    } catch (cause) { this.markFaulted(); throw cause }
  }
}
