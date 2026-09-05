import type { AudioFingerprint, AudioFingerprintRequest } from '../domain/multicamAlignment'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'

export interface AudioAlignmentSourceFacts {
  readonly audioStreamIndex: number
  readonly audioTrackId: string
  readonly inputSampleRate: number
  readonly channels: number
  readonly firstTimestamp: number
  readonly endTimestamp: number
  /** Canonical config, decoder implementation, browser version and timestamp policy. */
  readonly decodePolicy: string
}

export type AudioAlignmentWorkerRequest =
  | { readonly type: 'open'; readonly blob: Blob; readonly sourceId: string; readonly budget: LocalDecoderBudget }
  | { readonly type: 'decode'; readonly window: AudioFingerprintRequest }

export type AudioAlignmentWorkerReply =
  | { readonly type: 'opened'; readonly facts: AudioAlignmentSourceFacts }
  | { readonly type: 'progress'; readonly fraction: number }
  | { readonly type: 'complete'; readonly fingerprint: AudioFingerprint }
  | { readonly type: 'failure'; readonly detail: string }
