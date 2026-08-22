
import { type VideoScopeAnalysis } from '../../domain/videoScopes';
import type { VideoScopeAnalyzeMessage, VideoScopeWorkerReply } from '../video-scopes-protocol';

interface RetiringVideoScopeWorker {
  readonly completion: Promise<void>
  readonly resolve: () => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export function createVideoScopeAnalyzer(): {
  analyze(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis>
  release(): Promise<void>
} {
  let worker: Worker | null = null
  let requestId = 0
  const retiring = new Map<Worker, RetiringVideoScopeWorker>()
  const terminated = new WeakSet<Worker>()
  const pending = new Map<number, {
    worker: Worker
    resolve(analysis: VideoScopeAnalysis): void
    reject(error: Error): void
  }>()

  const rejectPending = (message: string): void => {
    for (const request of pending.values()) request.reject(new Error(message))
    pending.clear()
  }
  const rejectWorkerPending = (ownedWorker: Worker, message: string): void => {
    for (const [id, request] of pending) {
      if (request.worker !== ownedWorker) continue
      request.reject(new Error(message))
      pending.delete(id)
    }
  }
  const terminateWorker = (ownedWorker: Worker): void => {
    if (terminated.has(ownedWorker)) return
    terminated.add(ownedWorker)
    ownedWorker.terminate()
  }
  const finishRetiringWorker = (ownedWorker: Worker): boolean => {
    const retirement = retiring.get(ownedWorker)
    if (!retirement) return false
    clearTimeout(retirement.timeout)
    retiring.delete(ownedWorker)
    try {
      terminateWorker(ownedWorker)
    } finally {
      retirement.resolve()
    }
    return true
  }
  const failOwnedWorker = (ownedWorker: Worker, message: string): void => {
    rejectWorkerPending(ownedWorker, message)
    if (worker === ownedWorker) worker = null
    if (!finishRetiringWorker(ownedWorker)) terminateWorker(ownedWorker)
  }
  const startRetiringWorker = (ownedWorker: Worker): void => {
    if (retiring.has(ownedWorker) || terminated.has(ownedWorker)) return
    let resolve = (): void => undefined
    const completion = new Promise<void>((done) => {
      resolve = done
    })
    const timeout = setTimeout(() => {
      finishRetiringWorker(ownedWorker)
    }, 250)
    retiring.set(ownedWorker, { completion, resolve, timeout })
    try {
      ownedWorker.postMessage({ type: 'release' })
    } catch {
      finishRetiringWorker(ownedWorker)
    }
  }
  const ensureWorker = (): Worker => {
    if (worker) return worker
    const created = new Worker(new URL('../video-scopes.worker.ts', import.meta.url), {
      type: 'module',
      name: 'myrelith-video-scopes',
    })
    worker = created
    created.onmessage = (event: MessageEvent<VideoScopeWorkerReply>) => {
      const message = event.data
      if (message.type === 'released') {
        finishRetiringWorker(created)
        return
      }
      const request = pending.get(message.requestId)
      if (!request || request.worker !== created) return
      pending.delete(message.requestId)
      if (message.type === 'analysis') request.resolve(message.analysis)
      else request.reject(new Error(message.message))
    }
    created.onerror = (event) => {
      event.preventDefault()
      failOwnedWorker(created, event.message || 'Video scope analysis worker failed')
    }
    created.onmessageerror = () => {
      failOwnedWorker(created, 'Video scope analysis worker message failed')
    }
    return created
  }
  const release = (): Promise<void> => {
    const ownedWorker = worker
    worker = null
    rejectPending('Video scope analysis was released')
    if (ownedWorker) startRetiringWorker(ownedWorker)
    return Promise.all(
      [...retiring.values()].map((retirement) => retirement.completion),
    ).then(() => undefined)
  }
  return {
    analyze: (rgba, width, height) => {
      requestId++
      if (!Number.isSafeInteger(requestId)) {
        void release()
        requestId = 1
      }
      const id = requestId
      const copy = new Uint8ClampedArray(rgba)
      const message: VideoScopeAnalyzeMessage = {
        type: 'analyze',
        requestId: id,
        rgba: copy,
        width,
        height,
      }
      return new Promise<VideoScopeAnalysis>((resolve, reject) => {
        let ownedWorker: Worker
        try {
          ownedWorker = ensureWorker()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        pending.set(id, { worker: ownedWorker, resolve, reject })
        try {
          ownedWorker.postMessage(message, [copy.buffer])
        } catch (error) {
          failOwnedWorker(
            ownedWorker,
            error instanceof Error
              ? error.message
              : 'Video scope analysis send failed',
          )
        }
      })
    },
    release,
  }
}
