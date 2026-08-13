import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { MAX_ANALYSIS_SAMPLES } from '../domain/analysisCache'

/** Shared serializable contract between the app bridge and analysis worker. */

export const MOTION_ANALYSIS_MAX_WIDTH = 320
export const MOTION_ANALYSIS_MAX_HEIGHT = 180
export const MOTION_ANALYSIS_MAX_WINDOW_FRAMES = 300
export const MOTION_ANALYSIS_WINDOW_OVERLAP = 2
export const MOTION_ANALYSIS_MAX_RETAINED_BYTES = 32 * 1024 * 1024

export interface MotionAnalysisWorkerRunMessage {
  readonly type: 'run'
  readonly requestId: number
  readonly blob: Blob
  readonly sourceId: string
  readonly videoStreamIndex: number
  readonly budget: LocalDecoderBudget
  readonly startTimestampUs: number
  readonly endTimestampUs: number
  readonly samplingIntervalFrames: number
  readonly sampleTimestampsUs?: readonly number[]
}

function assertSafeInteger(value: number, label: string, minimum?: number): void {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    const range = minimum === undefined ? '' : ` >= ${minimum}`
    throw new TypeError(`${label} must be a safe integer${range}`)
  }
}

export function validateMotionAnalysisWorkerRunMessage(
  message: MotionAnalysisWorkerRunMessage,
): void {
  assertSafeInteger(message.requestId, 'requestId', 0)
  assertSafeInteger(message.videoStreamIndex, 'videoStreamIndex', 0)
  if (message.videoStreamIndex !== 0) {
    throw new RangeError('Only primary video stream index 0 is supported')
  }
  assertSafeInteger(message.startTimestampUs, 'startTimestampUs')
  assertSafeInteger(message.endTimestampUs, 'endTimestampUs')
  assertSafeInteger(message.samplingIntervalFrames, 'samplingIntervalFrames', 1)
  if (message.endTimestampUs <= message.startTimestampUs) {
    throw new RangeError('Analysis source range must be non-empty')
  }
  if (!(message.blob instanceof Blob) || message.blob.size <= 0) {
    throw new TypeError('Analysis source must be a non-empty Blob')
  }
  if (message.sampleTimestampsUs !== undefined) {
    if (
      message.sampleTimestampsUs.length < 1
      || message.sampleTimestampsUs.length > MAX_ANALYSIS_SAMPLES
      || message.samplingIntervalFrames !== 1
    ) throw new RangeError('Sparse analysis timestamps exceed the reviewed sample envelope')
    let direction = 0
    for (let index = 0; index < message.sampleTimestampsUs.length; index++) {
      const timestampUs = message.sampleTimestampsUs[index]!
      assertSafeInteger(timestampUs, `sampleTimestampsUs[${index}]`)
      const delta = index === 0
        ? 0
        : timestampUs - message.sampleTimestampsUs[index - 1]!
      if (
        timestampUs < message.startTimestampUs
        || timestampUs >= message.endTimestampUs
        || (index > 0 && (
          delta === 0
          || (direction !== 0 && Math.sign(delta) !== direction)
        ))
      ) throw new RangeError('Sparse analysis timestamps must be strictly monotonic within the source range')
      if (index > 0) direction ||= Math.sign(delta)
    }
  }
}

export interface MotionAnalysisWorkerProbeMessage {
  readonly type: 'probe'
  readonly requestId: number
}

export interface MotionAnalysisWorkerContinueMessage {
  readonly type: 'continue'
  readonly requestId: number
  readonly windowIndex: number
}

export type MotionAnalysisWorkerMessage =
  | MotionAnalysisWorkerProbeMessage
  | MotionAnalysisWorkerRunMessage
  | MotionAnalysisWorkerContinueMessage

export interface MotionAnalysisWorkerReadyReply {
  readonly type: 'ready'
  readonly requestId: number
}

export interface MotionAnalysisGrayFrame {
  readonly timestampUs: number
  readonly width: number
  readonly height: number
  /** Tight owned grayscale plane: byteOffset=0 and byteLength=buffer.byteLength. */
  readonly pixels: Uint8Array<ArrayBuffer>
}

export interface MotionAnalysisWorkerWindowReply {
  readonly type: 'window'
  readonly requestId: number
  readonly windowIndex: number
  readonly sampleOffset: number
  readonly frames: readonly MotionAnalysisGrayFrame[]
  readonly retainedBytes: number
}

export interface MotionAnalysisWorkerProgressReply {
  readonly type: 'progress'
  readonly requestId: number
  readonly decodedFrameCount: number
  readonly sampledFrameCount: number
  readonly progress: number
}

export interface MotionAnalysisWorkerCompleteReply {
  readonly type: 'complete'
  readonly requestId: number
  readonly decodedFrameCount: number
  readonly sampledFrameCount: number
  readonly windowCount: number
  readonly maxRetainedFrames: number
  readonly maxRetainedBytes: number
}

export type MotionAnalysisWorkerFailureCode =
  | 'unsupported-codec'
  | 'resource-limit'
  | 'resource-unavailable'
  | 'decode-readback'
  | 'unexpected'

export function motionAnalysisSourceOpenFailureCode(
  reason: 'unsupported-codec' | 'resource-limit' | 'decode-failed' | 'resource-unavailable',
): MotionAnalysisWorkerFailureCode {
  if (reason === 'unsupported-codec') return 'unsupported-codec'
  if (reason === 'resource-limit') return 'resource-limit'
  if (reason === 'resource-unavailable') return 'resource-unavailable'
  return 'decode-readback'
}

export interface MotionAnalysisWorkerFailureReply {
  readonly type: 'failure'
  readonly requestId: number
  readonly code: MotionAnalysisWorkerFailureCode
  readonly detail: string
}

export type MotionAnalysisWorkerReply =
  | MotionAnalysisWorkerReadyReply
  | MotionAnalysisWorkerWindowReply
  | MotionAnalysisWorkerProgressReply
  | MotionAnalysisWorkerCompleteReply
  | MotionAnalysisWorkerFailureReply
