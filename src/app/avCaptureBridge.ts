/** App-side RPC bridge to one camera/screen capture worker. */
import type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'
import type {
  AvCaptureRequest,
  AvCaptureResult,
  AvCaptureWorkerMessage,
} from '../pipeline/avCaptureProtocol'
import type { AvRecorderEnd, AvRecorderProgress } from '../pipeline/avCaptureRecorder'

/** Omit that keeps each union member's own fields. */
type Unsent = AvCaptureRequest extends infer R ? R extends unknown ? Omit<R, 'requestId'> : never : never
type StartRequest = Extract<Unsent, { type: 'start' }>
type ResultOf<T extends AvCaptureResult['type']> = Extract<AvCaptureResult, { type: T }>

export class AvCaptureBridge {
  private worker: Worker | null
  private nextId = 0
  private readonly waiting = new Map<number, { resolve(result: AvCaptureResult): void; reject(cause: Error): void }>()
  private recoveredId: string | null = null
  onProgress: ((progress: AvRecorderProgress) => void) | null = null
  onSelfStop: ((reason: Exclude<AvRecorderEnd, 'stopped'>) => void) | null = null

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('../workers/av-capture.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = ({ data }: MessageEvent<AvCaptureWorkerMessage>) => this.receive(data)
    this.worker.onerror = (event) => {
      event.preventDefault?.()
      this.failAll(new Error('The capture worker stopped unexpectedly'))
    }
  }

  get isClosed(): boolean { return this.worker === null }

  private receive(message: AvCaptureWorkerMessage): void {
    if ('requestId' in message) {
      const pending = this.waiting.get(message.requestId)
      if (!pending) return
      this.waiting.delete(message.requestId)
      if ('error' in message) {
        const error = new Error(message.error.message)
        error.name = message.error.name
        pending.reject(error)
      } else pending.resolve(message.result)
      return
    }
    if (message.type === 'progress') this.onProgress?.(message.progress)
    else if (message.type === 'self-stop') this.onSelfStop?.(message.reason)
  }

  private failAll(cause: Error): void {
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.waiting.values()) pending.reject(cause)
    this.waiting.clear()
  }

  private send<T extends AvCaptureResult['type']>(request: Unsent,
    transfer: Transferable[] = []): Promise<ResultOf<T>> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('The capture worker is closed'))
    const requestId = ++this.nextId
    return new Promise<ResultOf<T>>((resolve, reject) => {
      this.waiting.set(requestId, { resolve: (result) => resolve(result as ResultOf<T>), reject })
      try { worker.postMessage({ ...request, requestId }, transfer) }
      catch (cause) {
        this.waiting.delete(requestId)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  start(request: StartRequest): Promise<ResultOf<'start'>> {
    const transfer: Transferable[] = [request.video as unknown as Transferable]
    if (request.audio) transfer.push(request.audio as unknown as Transferable)
    return this.send<'start'>(request, transfer)
  }

  stop(): Promise<ResultOf<'stop'>> { return this.send<'stop'>({ type: 'stop' }) }
  abort(): Promise<ResultOf<'abort'>> { return this.send<'abort'>({ type: 'abort' }) }
  file(id: string): Promise<ResultOf<'file'>> { return this.send<'file'>({ type: 'file', id }) }

  async discardId(id: string): Promise<void> { await this.send<'discard-id'>({ type: 'discard-id', id }) }

  async list(): Promise<VoiceoverDraftInfo[]> { return (await this.send<'list'>({ type: 'list' })).drafts }

  /** Truncate an interrupted capture to its last complete fragment. */
  async recover(id: string): Promise<{ pcmBytes: number; committedBytes: number; discardedTailBytes: number }> {
    const result = await this.send<'recover'>({ type: 'recover', id })
    this.recoveredId = id
    return { pcmBytes: result.validBytes, committedBytes: result.validBytes, discardedTailBytes: result.discardedBytes }
  }

  /** Recovery-writer shape: the file of the capture last passed to `recover`. */
  async finalize(): Promise<{ file: File; handle: FileSystemFileHandle; pcmBytes: number }> {
    if (!this.recoveredId) throw new Error('Recover a capture before opening it')
    const { file, handle } = await this.file(this.recoveredId)
    return { file, handle, pcmBytes: file.size }
  }

  close(): void {
    this.failAll(new Error('The capture worker was closed'))
  }
}
