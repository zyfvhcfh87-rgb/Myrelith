
import type { AssetId, ClipId } from '../../domain/schema';
import type { RenderFrameSource } from '../../pipeline/render';
import { type StaticImageDecodedByteReservation, type StaticImageRenderSource } from '../../pipeline/static-image';
import type { BitmapLike } from '../decode-types';
import type { VideoFrameCursor, WorkerVideoSource } from '../video-source';

export interface OwnedStreamingFrame {
  timestampUs: number
  bitmap: BitmapLike
}

export interface PlaybackLaneState {
  clipId: ClipId
  cursor: VideoFrameCursor
  current: OwnedStreamingFrame | null
  lookahead: OwnedStreamingFrame | null
  lastSourceFrame: number | null
  lastTargetTimestampUs: number | null
  epoch: number
  ended: boolean
  closed: boolean
}

export interface StreamingAssetState {
  source: WorkerVideoSource
  lanes: Map<ClipId, PlaybackLaneState>
  pendingCopies: Set<Promise<OwnedStreamingFrame | null>>
  epoch: number
}

/** One retained static source, shared read-only across every frame request. */
export interface StaticImageAssetState {
  source: StaticImageRenderSource
  decodedBytes: number
  reservation: StaticImageDecodedByteReservation
  loans: number
  retired: boolean
  closed: boolean
  closePromise: Promise<void>
  resolveClosed(): void
  rejectClosed(error: unknown): void
}

export interface PendingStaticImageOpen {
  revision: number
  controller: AbortController
  done: Promise<void>
}

export interface StreamingLoan {
  bitmap: BitmapLike
  settle(): void
}

export interface StaticImageLoan {
  source: RenderFrameSource
  settle(): void
}

export class StaticImageResidentBudgetError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StaticImageResidentBudgetError'
  }
}

export interface ClipDecodeIdentity {
  assetId: AssetId
  sourceStart: number
  sourceDuration: number
  timelineStart: number
  timelineDuration: number
}

export interface PendingPluginEffect {
  readonly generation: number
  readonly workerGeneration: number
  readonly renderRequestId: number
  readonly expectedByteLength: number
  readonly resolve: (result: { readonly status: 'applied'; readonly rgba: Uint8Array<ArrayBuffer> }
    | { readonly status: 'bypassed' }) => void
}
