import { MediaJobExecutionError, type MediaJobContext } from './mediaJobScheduler'
import { MAX_ANALYSIS_SAMPLES } from '../domain/analysisCache'
import {
  MOTION_ANALYSIS_MAX_HEIGHT,
  MOTION_ANALYSIS_MAX_RETAINED_BYTES,
  MOTION_ANALYSIS_MAX_WIDTH,
  MOTION_ANALYSIS_MAX_WINDOW_FRAMES,
  MOTION_ANALYSIS_WINDOW_OVERLAP,
  type MotionAnalysisGrayFrame,
  type MotionAnalysisWorkerCompleteReply,
  type MotionAnalysisWorkerContinueMessage,
  type MotionAnalysisWorkerProbeMessage,
  type MotionAnalysisWorkerReply,
  type MotionAnalysisWorkerRunMessage,
  type MotionAnalysisWorkerWindowReply,
} from '../pipeline/motionAnalysisProtocol'

const MOTION_ANALYSIS_TRANSPORT_WINDOW_FRAMES = MOTION_ANALYSIS_MAX_WINDOW_FRAMES
  - MOTION_ANALYSIS_WINDOW_OVERLAP

export interface MotionAnalysisWorkerLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<MotionAnalysisWorkerReply>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void, options?: AddEventListenerOptions): void
  addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void, options?: AddEventListenerOptions): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<MotionAnalysisWorkerReply>) => void): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message:
    | MotionAnalysisWorkerProbeMessage
    | MotionAnalysisWorkerRunMessage
    | MotionAnalysisWorkerContinueMessage
  ): void
  terminate(): void
}

export interface MotionAnalysisWorkerRunResult extends MotionAnalysisWorkerCompleteReply {}

export type MotionAnalysisWindowConsumer = (
  window: MotionAnalysisWorkerWindowReply,
  signal: AbortSignal,
) => Promise<void>

export interface MotionAnalysisWorkerDiagnostics {
  readonly workersCreated: number
  readonly workersTerminated: number
  readonly activeWorkers: number
  readonly maxActiveWorkers: number
}

const diagnostics = {
  workersCreated: 0,
  workersTerminated: 0,
  activeWorkers: 0,
  maxActiveWorkers: 0,
}

function createWorker(): MotionAnalysisWorkerLike {
  return new Worker(
    new URL('../workers/motion-analysis.worker.ts', import.meta.url),
    { type: 'module' },
  ) as MotionAnalysisWorkerLike
}

export function probeMotionAnalysisWorker(
  signal?: AbortSignal,
  workerFactory: () => MotionAnalysisWorkerLike = createWorker,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(abortError())
  let worker: MotionAnalysisWorkerLike
  try {
    worker = workerFactory()
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const requestId = 0
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      action()
    }
    const onAbort = () => finish(() => reject(abortError()))
    const onMessage = (event: MessageEvent<MotionAnalysisWorkerReply>) => {
      if (event.data.type === 'ready' && event.data.requestId === requestId) {
        finish(() => resolve(true))
      }
    }
    const onError = (event: ErrorEvent) => {
      event.preventDefault()
      finish(() => resolve(false))
    }
    const onMessageError = () => finish(() => resolve(false))
    const timeout = setTimeout(() => finish(() => resolve(false)), 5_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError, { once: true })
    worker.addEventListener('messageerror', onMessageError, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      worker.postMessage({ type: 'probe', requestId })
    } catch {
      finish(() => resolve(false))
    }
  })
}

function abortError(): DOMException {
  return new DOMException('Motion analysis was cancelled', 'AbortError')
}

function validateFrame(frame: MotionAnalysisGrayFrame): void {
  if (
    !Number.isSafeInteger(frame.timestampUs)
    || !Number.isSafeInteger(frame.width)
    || !Number.isSafeInteger(frame.height)
    || frame.width <= 0
    || frame.height <= 0
    || frame.width > MOTION_ANALYSIS_MAX_WIDTH
    || frame.height > MOTION_ANALYSIS_MAX_HEIGHT
    || frame.pixels.byteOffset !== 0
    || frame.pixels.byteLength !== frame.pixels.buffer.byteLength
    || frame.pixels.byteLength !== frame.width * frame.height
  ) throw new MediaJobExecutionError('resource-limit', 'Analysis worker returned an invalid grayscale frame')
}

function validateWindow(window: MotionAnalysisWorkerWindowReply): void {
  if (
    !Number.isSafeInteger(window.windowIndex)
    || window.windowIndex < 0
    || !Number.isSafeInteger(window.sampleOffset)
    || window.sampleOffset < 0
    || window.frames.length <= 0
    || window.frames.length > MOTION_ANALYSIS_MAX_WINDOW_FRAMES
    || !Number.isSafeInteger(window.retainedBytes)
    || window.retainedBytes <= 0
    || window.retainedBytes > MOTION_ANALYSIS_MAX_RETAINED_BYTES
  ) throw new MediaJobExecutionError('resource-limit', 'Analysis worker exceeded the reviewed window envelope')
  let retainedBytes = 0
  for (const frame of window.frames) {
    validateFrame(frame)
    retainedBytes += frame.pixels.byteLength
  }
  if (retainedBytes !== window.retainedBytes) {
    throw new MediaJobExecutionError('resource-limit', 'Analysis worker reported inconsistent retained bytes')
  }
}

function releaseIdentifiableWindowBuffers(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const frames = (value as { readonly frames?: unknown }).frames
  if (!Array.isArray(frames)) return
  const buffers: ArrayBuffer[] = []
  const seen = new Set<ArrayBuffer>()
  for (const candidate of frames) {
    if (!candidate || typeof candidate !== 'object') continue
    const pixels = (candidate as { readonly pixels?: unknown }).pixels
    if (!ArrayBuffer.isView(pixels)) continue
    const buffer = pixels.buffer
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0 || seen.has(buffer)) continue
    seen.add(buffer)
    buffers.push(buffer)
  }
  if (buffers.length > 0) structuredClone(null, { transfer: buffers })
}

function releaseWindow(window: MotionAnalysisWorkerWindowReply): void {
  releaseIdentifiableWindowBuffers(window)
}

function validCount(value: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function validateProgress(
  reply: Extract<MotionAnalysisWorkerReply, { type: 'progress' }>,
): void {
  if (
    !validCount(reply.decodedFrameCount)
    || !validCount(reply.sampledFrameCount, MAX_ANALYSIS_SAMPLES)
    || reply.sampledFrameCount > reply.decodedFrameCount
    || !Number.isFinite(reply.progress)
    || reply.progress < 0
    || reply.progress > 1
  ) throw new MediaJobExecutionError(
    'resource-limit',
    'Motion-analysis worker returned invalid progress facts',
  )
}

function validateCompletion(
  reply: MotionAnalysisWorkerCompleteReply,
  observed: {
    readonly windowCount: number
    readonly sampleCount: number
    readonly maxWindowFrames: number
    readonly maxWindowBytes: number
  },
): void {
  if (
    !validCount(reply.decodedFrameCount)
    || !validCount(reply.sampledFrameCount, MAX_ANALYSIS_SAMPLES)
    || reply.sampledFrameCount > reply.decodedFrameCount
    || !validCount(reply.windowCount, MAX_ANALYSIS_SAMPLES)
    || reply.windowCount !== observed.windowCount
    || reply.sampledFrameCount !== observed.sampleCount
    || !validCount(reply.maxRetainedFrames, MOTION_ANALYSIS_MAX_WINDOW_FRAMES)
    || !validCount(reply.maxRetainedBytes, MOTION_ANALYSIS_MAX_RETAINED_BYTES)
    || reply.maxRetainedFrames < observed.maxWindowFrames
    || reply.maxRetainedBytes < observed.maxWindowBytes
    || (reply.windowCount === 0) !== (reply.sampledFrameCount === 0)
  ) throw new MediaJobExecutionError(
    'resource-limit',
    'Motion-analysis worker returned invalid completion facts',
  )
}

function failure(reply: Extract<MotionAnalysisWorkerReply, { type: 'failure' }>): MediaJobExecutionError {
  const code = reply.code === 'unsupported-codec'
    ? 'unsupported-codec'
    : reply.code === 'resource-limit'
      ? 'resource-limit'
      : reply.code === 'resource-unavailable'
        ? 'resource-unavailable'
      : reply.code === 'decode-readback'
        ? 'decode-failed'
        : 'unexpected'
  return new MediaJobExecutionError(code, reply.detail)
}

export function getMotionAnalysisWorkerDiagnostics(): MotionAnalysisWorkerDiagnostics {
  return { ...diagnostics }
}

export function resetMotionAnalysisWorkerDiagnostics(): void {
  diagnostics.workersCreated = 0
  diagnostics.workersTerminated = 0
  diagnostics.activeWorkers = 0
  diagnostics.maxActiveWorkers = 0
}

export function runMotionAnalysisWorker(
  message: MotionAnalysisWorkerRunMessage,
  consumeWindow: MotionAnalysisWindowConsumer,
  context: MediaJobContext,
  workerFactory: () => MotionAnalysisWorkerLike = createWorker,
): Promise<MotionAnalysisWorkerRunResult> {
  if (context.signal.aborted) return Promise.reject(abortError())
  let worker: MotionAnalysisWorkerLike
  try {
    worker = workerFactory()
  } catch (cause) {
    return Promise.reject(new MediaJobExecutionError(
      'resource-unavailable',
      'The motion-analysis worker could not be created',
      cause,
    ))
  }
  diagnostics.workersCreated++
  diagnostics.activeWorkers++
  diagnostics.maxActiveWorkers = Math.max(diagnostics.maxActiveWorkers, diagnostics.activeWorkers)
  context.setActiveDecoderCount(1)

  return new Promise((resolve, reject) => {
    let settled = false
    let consuming = false
    let workerStopped = false
    let pendingTerminal: (() => void) | null = null
    let expectedWindowIndex = 0
    let expectedSampleOffset = 0
    let previousWindowLength = 0
    let observedSampleCount = 0
    let observedMaxWindowFrames = 0
    let observedMaxWindowBytes = 0
    const stopWorker = () => {
      if (workerStopped) return
      workerStopped = true
      context.signal.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      diagnostics.workersTerminated++
      diagnostics.activeWorkers--
      context.setActiveDecoderCount(0)
    }
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      pendingTerminal = null
      stopWorker()
      action()
    }
    const finish = (action: () => void) => {
      if (settled || pendingTerminal) return
      if (consuming) {
        pendingTerminal = action
        stopWorker()
        return
      }
      settle(action)
    }
    const settlePendingTerminal = (): boolean => {
      if (!pendingTerminal) return false
      const action = pendingTerminal
      pendingTerminal = null
      settle(action)
      return true
    }
    const onAbort = () => finish(() => reject(abortError()))
    const onError = (event: ErrorEvent) => {
      event.preventDefault()
      finish(() => reject(new MediaJobExecutionError(
        'decode-failed',
        event.message || 'Motion-analysis worker failed',
      )))
    }
    const onMessageError = () => finish(() => reject(new MediaJobExecutionError(
      'unexpected',
      'Motion-analysis worker response could not be deserialized',
    )))
    const continueAfterWindow = async (window: MotionAnalysisWorkerWindowReply) => {
      let consumerFailed = false
      let consumerFailure: unknown
      try {
        await consumeWindow(window, context.signal)
      } catch (cause) {
        consumerFailed = true
        consumerFailure = cause
      }
      let releaseFailure: unknown
      try {
        releaseWindow(window)
      } catch (cause) {
        releaseFailure = cause
      }
      consuming = false
      if (settlePendingTerminal()) return
      if (releaseFailure !== undefined) {
        finish(() => reject(new MediaJobExecutionError(
          'resource-unavailable',
          'Motion-analysis window ownership could not be released',
          releaseFailure,
        )))
        return
      }
      if (consumerFailed) {
        finish(() => reject(consumerFailure))
        return
      }
      if (context.signal.aborted) {
        finish(() => reject(abortError()))
        return
      }
      expectedWindowIndex++
      const next: MotionAnalysisWorkerContinueMessage = {
        type: 'continue',
        requestId: message.requestId,
        windowIndex: window.windowIndex,
      }
      try {
        worker.postMessage(next)
      } catch (cause) {
        finish(() => reject(cause))
      }
    }
    const onMessage = (event: MessageEvent<MotionAnalysisWorkerReply>) => {
      const reply = event.data
      if (reply.requestId !== message.requestId || settled) return
      if (reply.type === 'progress') {
        try {
          validateProgress(reply)
          context.reportProgress(reply.progress)
        } catch (cause) {
          finish(() => reject(cause))
        }
        return
      }
      if (reply.type === 'failure') {
        finish(() => reject(failure(reply)))
        return
      }
      if (reply.type === 'window') {
        try {
          if (
            consuming
            || reply.windowIndex !== expectedWindowIndex
            || reply.sampleOffset !== expectedSampleOffset
            || (
              reply.windowIndex > 0
              && previousWindowLength !== MOTION_ANALYSIS_TRANSPORT_WINDOW_FRAMES
            )
          ) {
            throw new MediaJobExecutionError('unexpected', 'Motion-analysis window order is invalid')
          }
          validateWindow(reply)
          observedSampleCount = reply.sampleOffset + reply.frames.length
          if (!validCount(observedSampleCount, MAX_ANALYSIS_SAMPLES)) {
            throw new MediaJobExecutionError(
              'resource-limit',
              'Motion-analysis worker exceeded the sample-count limit',
            )
          }
          previousWindowLength = reply.frames.length
          expectedSampleOffset = observedSampleCount - Math.min(
            MOTION_ANALYSIS_WINDOW_OVERLAP,
            reply.frames.length,
          )
          observedMaxWindowFrames = Math.max(observedMaxWindowFrames, reply.frames.length)
          observedMaxWindowBytes = Math.max(observedMaxWindowBytes, reply.retainedBytes)
          consuming = true
          void continueAfterWindow(reply)
        } catch (cause) {
          try {
            releaseIdentifiableWindowBuffers(reply)
          } catch (releaseCause) {
            finish(() => reject(new MediaJobExecutionError(
              'resource-unavailable',
              'Rejected motion-analysis window ownership could not be released',
              releaseCause,
            )))
            return
          }
          finish(() => reject(cause))
        }
        return
      }
      if (consuming) {
        finish(() => reject(new MediaJobExecutionError(
          'unexpected',
          'Motion-analysis worker completed before its window was consumed',
        )))
        return
      }
      if (reply.type !== 'complete') {
        finish(() => reject(new MediaJobExecutionError(
          'unexpected',
          'Motion-analysis worker returned an unexpected readiness reply',
        )))
        return
      }
      try {
        validateCompletion(reply, {
          windowCount: expectedWindowIndex,
          sampleCount: observedSampleCount,
          maxWindowFrames: observedMaxWindowFrames,
          maxWindowBytes: observedMaxWindowBytes,
        })
      } catch (cause) {
        finish(() => reject(cause))
        return
      }
      finish(() => resolve(reply))
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError, { once: true })
    worker.addEventListener('messageerror', onMessageError, { once: true })
    if (context.signal.aborted) {
      onAbort()
      return
    }
    try {
      worker.postMessage(message)
    } catch (cause) {
      finish(() => reject(cause))
    }
  })
}
