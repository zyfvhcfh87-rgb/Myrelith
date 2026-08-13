import { WorkerVideoSourceOpenError, openWorkerVideoSource } from './video-source'
import {
  decodeMotionAnalysisWindows,
  extractMotionAnalysisGrayFrame,
} from '../pipeline/motionAnalysisDecode'
import {
  type MotionAnalysisWorkerCompleteReply,
  type MotionAnalysisWorkerContinueMessage,
  type MotionAnalysisWorkerFailureCode,
  type MotionAnalysisWorkerFailureReply,
  type MotionAnalysisWorkerMessage,
  type MotionAnalysisWorkerProgressReply,
  type MotionAnalysisWorkerRunMessage,
  type MotionAnalysisWorkerWindowReply,
  type MotionAnalysisGrayFrame,
  motionAnalysisSourceOpenFailureCode,
} from '../pipeline/motionAnalysisProtocol'

interface PendingWindow {
  readonly windowIndex: number
  readonly resolve: () => void
}

let activeRequestId: number | null = null
let pendingWindow: PendingWindow | null = null

function safeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`)
  }
}

function validateRun(message: MotionAnalysisWorkerRunMessage): void {
  safeInteger(message.requestId, 'requestId')
  safeInteger(message.videoStreamIndex, 'videoStreamIndex')
  if (message.videoStreamIndex !== 0) {
    throw new RangeError('Only primary video stream index 0 is supported')
  }
  safeInteger(message.startTimestampUs, 'startTimestampUs')
  safeInteger(message.endTimestampUs, 'endTimestampUs')
  safeInteger(message.samplingIntervalFrames, 'samplingIntervalFrames', 1)
  if (message.endTimestampUs <= message.startTimestampUs) {
    throw new RangeError('Analysis source range must be non-empty')
  }
  if (!(message.blob instanceof Blob) || message.blob.size <= 0) {
    throw new TypeError('Analysis source must be a non-empty Blob')
  }
}

function waitForContinue(windowIndex: number): Promise<void> {
  if (pendingWindow) throw new Error('Only one analysis window may be in flight')
  return new Promise((resolve) => {
    pendingWindow = { windowIndex, resolve: () => {
      pendingWindow = null
      resolve()
    } }
  })
}

async function sendWindow(
  requestId: number,
  windowIndex: number,
  sampleOffset: number,
  frames: MotionAnalysisGrayFrame[],
  bytes: number,
): Promise<void> {
  const reply: MotionAnalysisWorkerWindowReply = {
    type: 'window',
    requestId,
    windowIndex,
    sampleOffset,
    frames,
    retainedBytes: bytes,
  }
  const transfer = frames.map((frame) => frame.pixels.buffer)
  const continued = waitForContinue(windowIndex)
  self.postMessage(reply, { transfer })
  await continued
}

function failureCode(cause: unknown): MotionAnalysisWorkerFailureCode {
  if (cause instanceof WorkerVideoSourceOpenError) {
    return motionAnalysisSourceOpenFailureCode(cause.failure.reason)
  }
  if (cause instanceof RangeError) return 'resource-limit'
  if (cause instanceof DOMException || cause instanceof Error) return 'decode-readback'
  return 'unexpected'
}

function detail(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause)
  return value.slice(0, 2_048)
}

async function run(message: MotionAnalysisWorkerRunMessage): Promise<void> {
  validateRun(message)
  const source = await openWorkerVideoSource(message.blob, {
    sourceId: message.sourceId,
    budget: message.budget,
  })
  const completion = await decodeMotionAnalysisWindows({
    source,
    startTimestampUs: message.startTimestampUs,
    endTimestampUs: message.endTimestampUs,
    samplingIntervalFrames: message.samplingIntervalFrames,
    extractGrayFrame: extractMotionAnalysisGrayFrame,
    sendWindow: (window) => sendWindow(
      message.requestId,
      window.windowIndex,
      window.sampleOffset,
      [...window.frames],
      window.retainedBytes,
    ),
    reportProgress: (decodedFrameCount, sampledFrameCount, progress) => {
      const reply: MotionAnalysisWorkerProgressReply = {
        type: 'progress',
        requestId: message.requestId,
        decodedFrameCount,
        sampledFrameCount,
        progress,
      }
      self.postMessage(reply)
    },
  })
  const complete: MotionAnalysisWorkerCompleteReply = {
    type: 'complete',
    requestId: message.requestId,
    ...completion,
  }
  self.postMessage(complete)
}

function isMessage(value: unknown): value is MotionAnalysisWorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; requestId?: unknown }
  return (candidate.type === 'probe' || candidate.type === 'run' || candidate.type === 'continue')
    && Number.isSafeInteger(candidate.requestId)
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data
  if (!isMessage(message)) return
  if (message.type === 'probe') {
    self.postMessage({ type: 'ready', requestId: message.requestId })
    return
  }
  if (message.type === 'continue') {
    const continued = message as MotionAnalysisWorkerContinueMessage
    if (
      continued.requestId === activeRequestId
      && continued.windowIndex === pendingWindow?.windowIndex
    ) pendingWindow.resolve()
    return
  }
  if (activeRequestId !== null) {
    const busy: MotionAnalysisWorkerFailureReply = {
      type: 'failure',
      requestId: message.requestId,
      code: 'resource-limit',
      detail: 'The analysis worker already owns an active request',
    }
    self.postMessage(busy)
    return
  }
  activeRequestId = message.requestId
  void run(message).catch((cause) => {
    const failure: MotionAnalysisWorkerFailureReply = {
      type: 'failure',
      requestId: message.requestId,
      code: failureCode(cause),
      detail: detail(cause),
    }
    self.postMessage(failure)
  }).finally(() => {
    activeRequestId = null
    pendingWindow = null
  })
})
