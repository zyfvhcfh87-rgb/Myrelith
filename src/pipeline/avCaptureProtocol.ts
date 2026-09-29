/** Serializable contract between the app camera/screen bridge and its capture worker. */
import type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'
import type { AvEncodingChoice, AvRecorderEnd, AvRecorderProgress, AvRecorderResult } from './avCaptureRecorder'

/** Kept camera/screen originals live here, outside every disposable cache. */
export const AV_CAPTURE_DIRECTORY = 'myrelith-captures-v1'

export type AvCaptureMode = 'camera' | 'screen'

/** Per-track capture-clock facts for the Step 13 evidence (optional). */
export interface AvClockSample {
  readonly count: number
  /** (worker wall clock µs) − (capture timestamp µs): median/min/max. */
  readonly offsetMedianUs: number
  readonly offsetMinUs: number
  readonly offsetMaxUs: number
  readonly firstTimestampUs: number | null
  readonly lastTimestampUs: number | null
  /** Audio only: total frames delivered. */
  readonly frames: number
}

export type AvCaptureRequest = { readonly requestId: number } & (
  /**
   * Chromium cannot transfer a MediaStreamTrack to a worker; the page creates
   * each MediaStreamTrackProcessor and transfers its readable stream. Frames
   * keep their capture timestamps, so delivery delay cannot shift timing. The
   * page keeps the tracks and stops them.
   */
  | { readonly type: 'start'; readonly id: string; readonly mode: AvCaptureMode
    readonly video: ReadableStream<VideoFrame>; readonly audio: ReadableStream<AudioData> | null
    readonly videoSettings: { readonly width: number; readonly height: number }
    readonly audioSettings: { readonly numberOfChannels: number; readonly sampleRate: number } | null
    /** Subtract from video stamps to reach the page timeline audio already uses (µs). */
    readonly videoClockOffsetUs: number
    readonly diagnostics?: boolean }
  | { readonly type: 'stop' | 'abort' | 'list' }
  | { readonly type: 'recover' | 'file' | 'discard-id'; readonly id: string }
)

export type AvCaptureResult =
  | { readonly type: 'start'; readonly encoding: AvEncodingChoice; readonly width: number; readonly height: number }
  | { readonly type: 'stop'; readonly result: AvRecorderResult; readonly clock?: Record<'video' | 'audio', AvClockSample> }
  | { readonly type: 'abort' | 'discard-id' }
  | { readonly type: 'recover'; readonly validBytes: number; readonly fragments: number; readonly discardedBytes: number }
  | { readonly type: 'file'; readonly file: File; readonly handle: FileSystemFileHandle }
  | { readonly type: 'list'; readonly drafts: VoiceoverDraftInfo[] }

export type AvCaptureWorkerMessage =
  | { readonly requestId: number; readonly result: AvCaptureResult }
  | { readonly requestId: number; readonly error: { readonly name: string; readonly message: string } }
  | { readonly type: 'progress'; readonly progress: AvRecorderProgress }
  | { readonly type: 'self-stop'; readonly reason: Exclude<AvRecorderEnd, 'stopped'> }
  /** Diagnostics mode only: clock taps of a take whose stop failed. */
  | { readonly type: 'diagnostic-clock'; readonly clock: Record<'video' | 'audio', AvClockSample>; readonly progress: AvRecorderProgress }
