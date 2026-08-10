/**
 * workers/render-protocol.ts — The canonical message contract between the
 * main-thread render bridge (engine/, Phase 4.1c) and workers/
 * render.worker.ts. Types only — zero runtime code, safe for both sides to
 * import (same rule as decode-protocol.ts).
 *
 * Division of labor: the MAIN side is the single computer of timestamps.
 * It sends one explicit domain VideoCompositionPlan plus exact
 * source-frame + integer-µs targets. The worker owns Blob-backed demux/decode
 * sources and advances clip-keyed playback lanes. It never re-derives µs
 * targets, so the two sides cannot disagree about rounding.
 *
 * `openAsset` / `renderFrame` are the current contract. The deprecated
 * `configureAsset` / `composite` chunk messages are imported from the named
 * render-legacy-protocol compatibility boundary. Do not combine the two
 * shapes: a Blob is
 * structured-cloned once, while encoded chunk buffers belong only to the
 * legacy path.
 *
 * Ordering contract: `setDoc` must be posted BEFORE any `renderFrame` (or
 * legacy `composite`) whose source table was computed from that doc.
 * A newer render supersedes the older PRESENTATION, which answers
 * `compositeDone` with status 'superseded' and never blits. Normal playback
 * supersession must not cancel the clip's sequential decode lane. A lane ends
 * only when its asset is replaced/released, the worker closes, setDoc
 * invalidates its clip, or target/mode policy identifies a real discontinuity.
 */

import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { AssetId, ClipId, TimelineDoc } from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { PresentationProfile } from '../domain/presentationProfile'
import type {
  LegacyCompositeMessage,
  LegacyConfigureAssetMessage,
} from './render-legacy-protocol'

export type {
  CompositeSourceEntry,
  LegacyCompositeMessage,
  LegacyConfigureAssetMessage,
} from './render-legacy-protocol'

/**
 * `playback` reuses a clip's sequential lane across render request IDs.
 * `seek` uses a request-scoped one-shot cursor that closes after completion or
 * cancellation; it never closes another cursor merely because presentation
 * was superseded.
 */
export type RenderMode = 'playback' | 'seek'

/** Actual session capabilities of the preview worker's compositor context. */
export interface RenderWorkerCapabilities {
  readonly canvasFilter: boolean
}

/**
 * Opt-in, point-in-time worker health evidence for the local performance lab.
 * Byte fields are explicitly classified so callers never confuse document,
 * decoded-media, and derived-cache costs. Streaming bitmap bytes are a
 * width x height x 4 estimate; retained still-image bytes use the worker's
 * exact decoded-byte ledger.
 */
export interface RenderWorkerRuntimeTelemetrySnapshot {
  readonly enabled: boolean
  readonly active: {
    readonly videoSources: number
    readonly videoDecoders: number
    readonly pendingBitmapCopies: number
    readonly pendingStaticImageOpens: number
  }
  readonly queues: {
    readonly renderDepth: number
    readonly renderMaxDepth: number
    readonly decodeDepth: number
    readonly decodeMaxDepth: number
  }
  readonly caches: {
    readonly hits: number
    readonly misses: number
  }
  readonly decodedMedia: {
    readonly retainedStaticImages: number
    readonly retainedStaticImageBytes: number
  }
  readonly derivedCaches: {
    readonly streamingFrameBitmaps: number
    readonly estimatedStreamingFrameBytes: number
    readonly scratchSurfaceBytes: number
    readonly transitionSurfaceBytes: number
  }
  readonly closes: {
    readonly decodedVideoFrames: number
    readonly streamingBitmaps: number
    readonly staticImageSources: number
  }
}

/**
 * One clip-keyed source request for the streaming render path. There are no
 * encoded chunks: the worker pulls from its Blob-backed source instead.
 *
 * `clipId` is the stable lane identity, not an asset/frame-derived key. Two
 * clips may show unrelated positions from the same asset and therefore need two
 * independent sequential decoders. `sourceFrame` remains the exact integer
 * key requested by compositeFrame; native timestamps are precomputed by the
 * main thread and stay integer microseconds across this boundary.
 */
interface StreamingCompositeSourceEntryBase {
  clipId: ClipId
  assetId: AssetId
  /** Document-rate source frame from the explicit composition plan. */
  sourceFrame: number
  /** Target presentation timestamp in the asset stream, integer µs. */
  targetTimestampUs: number
}

/** One timed-video request backed by a clip-keyed worker decode lane. */
export interface StreamingVideoSourceEntry
  extends StreamingCompositeSourceEntryBase {
  kind: 'video'
}

/**
 * One frame-zero still request backed by the asset's retained worker source.
 * Literal zeroes make the no-timeline-decoder contract explicit on both sides
 * of the worker boundary.
 */
export interface StreamingImageSourceEntry
  extends StreamingCompositeSourceEntryBase {
  kind: 'image'
  sourceFrame: 0
  targetTimestampUs: 0
}

/** Discriminated render-source request; never infer kind from registry state. */
export type StreamingCompositeSourceEntry =
  | StreamingVideoSourceEntry
  | StreamingImageSourceEntry

/**
 * Open (or replace) one worker-owned media source. Blob is structured-
 * cloneable, not Transferable: post this message with an EMPTY transfer list.
 * Replacement closes the old source and all child cursors first. The worker
 * replies `assetConfigured` only after the new source has a decodable track.
 */
export interface OpenAssetMessage {
  type: 'openAsset'
  assetId: AssetId
  /** Bridge-issued identity echoed by the worker's setup reply. */
  setupId: number
  blob: Blob
  /** Immutable import metadata required before a local fallback may run. */
  budget: LocalDecoderBudget
}

/**
 * Open (or replace) one worker-owned static-image source. The Blob is
 * structured-cloned with an empty transfer list. The worker performs the same
 * content inspection and bounded first-frame decode used by import, retains
 * exactly one ImageBitmap or VideoFrame, and replies `assetConfigured` only
 * after that source is ready to draw.
 */
export interface OpenImageMessage {
  type: 'openImage'
  assetId: AssetId
  /** Bridge-issued identity echoed by the worker's setup reply. */
  setupId: number
  blob: Blob
}

/**
 * Render one document frame from worker-owned streaming sources. Mode is
 * message-level so one composite can never mix playback and seek semantics.
 * No buffers are transferred; post with an EMPTY transfer list.
 */
export interface RenderFrameMessage {
  type: 'renderFrame'
  requestId: number
  /** Integer document frame selected from the audio clock or scrub state. */
  frame: number
  /** Exact grouped visual plan computed on the main thread for `frame`. */
  plan: VideoCompositionPlan
  mode: RenderMode
  sources: StreamingCompositeSourceEntry[]
}

/** Messages the main thread sends to the render worker. */
export type ToRenderWorker =
  | {
      /** Hand over the visible drawing surface. Sent once; transferred. */
      type: 'init'
      canvas: OffscreenCanvas
    }
  | {
      /**
       * Replace the timeline snapshot used by subsequent composites. The
       * active presentation profile owns disposable preview-surface sizing.
       * Supersedes any in-flight composite — it was rendering a stale doc.
       */
      type: 'setDoc'
      doc: TimelineDoc
    }
  | {
      /**
       * Resize disposable preview surfaces without changing project-space
       * geometry. A newer profile supersedes any in-flight presentation.
       */
      type: 'setPresentationProfile'
      profile: PresentationProfile
    }
  | OpenAssetMessage
  | OpenImageMessage
  | LegacyConfigureAssetMessage
  | {
      /** Drop an asset's source, child cursors, decoder state, and frame cache. */
      type: 'releaseAsset'
      assetId: AssetId
    }
  | RenderFrameMessage
  | LegacyCompositeMessage
  | {
      /** Enable/reset or disable the otherwise-dormant local counters. */
      type: 'setRuntimeTelemetry'
      enabled: boolean
    }
  | {
      /** Capture gauges and opt-in counters without changing render state. */
      type: 'requestRuntimeTelemetry'
      requestId: number
    }
  | {
      /** Tear down all sources, child cursors, decoders, and caches. */
      type: 'close'
    }

/** Messages the render worker sends back to the main thread. */
export type FromRenderWorker =
  | {
      /** Published once the worker has created its real preview compositor. */
      type: 'rendererCapabilities'
      capabilities: RenderWorkerCapabilities
    }
  | {
      /** The asset's worker source/decoder is ready; renders may reference it. */
      type: 'assetConfigured'
      assetId: AssetId
      /** Exact identity from configureAsset/openAsset/openImage. */
      setupId: number
    }
  | {
      type: 'runtimeTelemetry'
      requestId: number
      snapshot: RenderWorkerRuntimeTelemetrySnapshot
    }
  | {
      /** A render finished (exactly one per renderFrame/legacy composite). */
      type: 'compositeDone'
      requestId: number
      /**
       * 'drawn'      — the frame was composited and blitted to the canvas
       *                (missing lists any clips that had no pixels);
       * 'superseded' — a newer request took over; nothing was blitted.
       */
      status: 'drawn' | 'superseded'
      /** Clips painted, bottom-to-top. Empty when superseded. */
      drawnClipIds: ClipId[]
      /** Active clips whose pixels were unavailable. Empty when superseded. */
      missingClipIds: ClipId[]
      /** Wall-clock decode+composite time in ms (0 when superseded). */
      renderMs: number
    }
  | {
      /**
       * Something failed. requestId ties it to a render (which then gets NO
       * compositeDone); assetId ties it to one asset source/decoder.
       */
      type: 'error'
       requestId?: number
       assetId?: AssetId
       /** Present only for a configure/open setup failure. */
       setupId?: number
       /** Present only when worker source setup identified a media boundary. */
       mediaFailure?: {
         trackKind: 'video' | null
         reason: MediaRuntimeFailure['reason']
       }
       message: string
    }
  | {
      /**
       * All worker-owned sources have completed cleanup. The bridge may now
       * terminate the worker realm without racing resource disposal.
       */
      type: 'closed'
    }
