import type {
  LensRemapGateEvidence,
  LensRemapRunEvidence,
  LensRemapWorkerRequest,
  LensRemapWorkerResponse,
} from './lensRemapContract'

const FULL_RUN_TIMEOUT_MS = 180_000
const CANCELLATION_TIMEOUT_MS = 20_000

interface OwnedWorkerResult<T> {
  readonly result: T
  readonly terminated: true
}

function workerFailure(prefix: string, event: ErrorEvent | MessageEvent): Error {
  if (event instanceof ErrorEvent) return new Error(`${prefix}: ${event.message}`)
  return new Error(`${prefix}: worker response could not be deserialized`)
}

function runFullWorker(): Promise<OwnedWorkerResult<LensRemapRunEvidence>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lens-remap.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (result: LensRemapRunEvidence | null, error: unknown | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      if (error !== null) reject(error)
      else resolve({ result: result!, terminated: true })
    }
    const onMessage = (event: MessageEvent<LensRemapWorkerResponse>) => {
      if (event.data.type === 'error') finish(null, new Error(event.data.detail))
      else if (event.data.type === 'result') finish(event.data.evidence, null)
    }
    const onError = (event: ErrorEvent) => finish(null, workerFailure('Lens-remap worker failed', event))
    const onMessageError = (event: MessageEvent) => finish(null, workerFailure('Lens-remap worker failed', event))
    const timeout = setTimeout(() => finish(null, new Error('Lens-remap research exceeded its 180 second deadline')), FULL_RUN_TIMEOUT_MS)
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    try {
      worker.postMessage({ type: 'run' } satisfies LensRemapWorkerRequest)
    } catch (error) {
      finish(null, error)
    }
  })
}

function runCancellationWorker(): Promise<OwnedWorkerResult<'AbortError'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lens-remap.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (result: 'AbortError' | null, error: unknown | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      if (error !== null) reject(error)
      else resolve({ result: result!, terminated: true })
    }
    const onMessage = (event: MessageEvent<LensRemapWorkerResponse>) => {
      if (event.data.type === 'error') finish(null, new Error(event.data.detail))
      else if (event.data.type === 'cancel-ready') {
        try {
          worker.postMessage({ type: 'cancel' } satisfies LensRemapWorkerRequest)
        } catch (error) {
          finish(null, error)
        }
      } else if (event.data.type === 'cancelled') {
        if (event.data.name !== 'AbortError') finish(null, new Error(`Unexpected cancellation error ${event.data.name}`))
        else finish('AbortError', null)
      }
    }
    const onError = (event: ErrorEvent) => finish(null, workerFailure('Lens-remap cancellation worker failed', event))
    const onMessageError = (event: MessageEvent) => finish(null, workerFailure('Lens-remap cancellation worker failed', event))
    const timeout = setTimeout(() => finish(null, new Error('Lens-remap cancellation exceeded its 20 second deadline')), CANCELLATION_TIMEOUT_MS)
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    try {
      worker.postMessage({ type: 'cancel-probe' } satisfies LensRemapWorkerRequest)
    } catch (error) {
      finish(null, error)
    }
  })
}

export async function runLensRemapBrowserGate(): Promise<LensRemapGateEvidence> {
  const full = await runFullWorker()
  const cancellation = await runCancellationWorker()
  if (full.result.decision !== 'go') {
    throw new Error(`Lens-remap gate is no-go: ${full.result.reasons.join(' | ')}`)
  }
  return Object.freeze({
    run: full.result,
    cancellation: Object.freeze({
      name: cancellation.result,
      workersCreated: 1,
      workersTerminated: 1,
      activeWorkers: 0,
    }),
    workerLifecycle: Object.freeze({
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
    }),
  })
}
