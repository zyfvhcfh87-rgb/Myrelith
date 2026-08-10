import type { VideoScopeAnalysis } from '../domain/videoScopes'

export interface VideoScopeAnalyzeMessage {
  readonly type: 'analyze'
  readonly requestId: number
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

export type VideoScopeWorkerReply =
  | {
      readonly type: 'analysis'
      readonly requestId: number
      readonly analysis: VideoScopeAnalysis
    }
  | {
      readonly type: 'error'
      readonly requestId: number
      readonly message: string
    }
