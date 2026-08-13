import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'

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
  readonly budget: LocalDecoderBudget
  readonly startTimestampUs: number
  readonly endTimestampUs: number
  readonly samplingIntervalFrames: number
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
