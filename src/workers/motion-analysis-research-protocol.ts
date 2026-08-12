import type {
  MotionAnalysisResearchEvidence,
  MotionResearchProgress,
} from '../domain/motionAnalysisResearch'

export interface MotionResearchRunMessage {
  readonly type: 'run'
  readonly requestId: number
}

export interface MotionResearchProbeMessage {
  readonly type: 'probe'
  readonly requestId: number
}

export type MotionResearchWorkerMessage =
  | MotionResearchProbeMessage
  | MotionResearchRunMessage

export interface MotionResearchReadyReply {
  readonly type: 'ready'
  readonly requestId: number
}

export type MotionResearchRunReply =
  | {
      readonly type: 'progress'
      readonly requestId: number
      readonly progress: MotionResearchProgress
    }
  | {
      readonly type: 'result'
      readonly requestId: number
      readonly evidence: MotionAnalysisResearchEvidence
    }
  | {
      readonly type: 'error'
      readonly requestId: number
      readonly code: 'quality-fixture-failed' | 'unexpected'
      readonly message: string
    }

export type MotionResearchWorkerReply =
  | MotionResearchReadyReply
  | MotionResearchRunReply
