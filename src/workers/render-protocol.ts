/**
 * workers/render-protocol.ts — The canonical message contract between the
 * main-thread render bridge (engine/, Phase 4.1c) and workers/
 * render.worker.ts. Types only — zero runtime code, safe for both sides to
 * import (same rule as decode-protocol.ts).
 *
 * Division of labor: the MAIN side is the single computer of timestamps.
 * It runs domain.visibleVideoLayersAtFrame over the doc and sends exact
 * source-frame + integer-µs targets. The worker owns Blob-backed demux/decode
 * sources and advances clip-keyed playback lanes. It never re-derives µs
 * targets, so the two sides cannot disagree about rounding.
 *
 * Streaming migration: `openAsset` / `renderFrame` are the replacement
 * contract. The deprecated `configureAsset` / `composite` chunk contract
 * remains temporarily so the worker can migrate before the bridge starts
 * sending the new messages. Do not combine the two shapes: a Blob is
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
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { ChunkPayload } from './decode-protocol'

/**
 * `playback` reuses a clip's sequential lane across render request IDs.
 * `seek` uses a request-scoped one-shot cursor that closes after completion or
 * cancellation; it never closes another cursor merely because presentation
 * was superseded.
 */
export type RenderMode = 'playback' | 'seek'

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
export interface StreamingCompositeSourceEntry {
  clipId: ClipId
  assetId: AssetId
  /** Document-rate source frame from domain.visibleVideoLayersAtFrame(). */
  sourceFrame: number
  /** Target presentation timestamp in the asset stream, integer µs. */
  targetTimestampUs: number
}

/**
 * Open (or replace) one worker-owned media source. Blob is structured-
 * cloneable, not Transferable: post this message with an EMPTY transfer list.
 * Replacement closes the old source and all child cursors first. The worker
 * replies `assetConfigured` only after the new source has a decodable track.
 */
export interface OpenAssetMessage {
  type: 'openAsset'
  assetId: AssetId
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
  mode: RenderMode
  sources: StreamingCompositeSourceEntry[]
}

/**
 * Everything the worker needs to produce pixels for ONE (asset, sourceFrame)
 * pair used by the composite. `sourceFrame` is in DOCUMENT-rate frames (the
 * value compositeFrame's FrameSource asks for — exact integer key);
 * `targetTimestampUs`/`toleranceUs` are in the asset's native timebase,
 * precomputed by the bridge.
 *
 * @deprecated Temporary keyframe-batch contract. Use
 * {@link StreamingCompositeSourceEntry} through {@link RenderFrameMessage}.
 */
export interface CompositeSourceEntry {
  assetId: AssetId
  /** Document-rate source frame from domain.visibleVideoLayersAtFrame(). */
  sourceFrame: number
  /** Target presentation timestamp in the ASSET's stream, integer µs. */
  targetTimestampUs: number
  /** Half a frame duration at the asset's rate, integer µs. */
  toleranceUs: number
  /**
   * Keyframe-first decode batch covering the target. May be empty when the
   * bridge could not supply chunks — the worker then serves the entry from
   * its cache or reports the clip missing. Buffers are TRANSFERRED.
   */
  chunks: ChunkPayload[]
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
       * Replace the timeline snapshot used by subsequent composites (also
       * sizes the canvases to doc.width × doc.height). Supersedes any
       * in-flight composite — it was rendering a stale doc.
       */
      type: 'setDoc'
      doc: TimelineDoc
    }
  | OpenAssetMessage
  | OpenImageMessage
  | {
      /**
       * Create (or replace) the decoder + frame cache for one asset. A
       * replacement closes the old decoder and clears the old cache — the
       * cached frames belong to the old stream.
       *
       * @deprecated Legacy WebCodecs chunk path. Use `openAsset`.
       */
      type: 'configureAsset'
      assetId: AssetId
      config: VideoDecoderConfig
    }
  | {
      /** Drop an asset's source, child cursors, decoder state, and frame cache. */
      type: 'releaseAsset'
      assetId: AssetId
    }
  | RenderFrameMessage
  | {
      /**
       * Composite document frame `frame` onto the canvas using `sources`
       * for pixels. Latest-wins: a newer composite (or setDoc/
       * configureAsset) supersedes an in-flight one, which then resolves
       * 'superseded' without blitting. Every composite gets EXACTLY ONE
       * compositeDone (or error) reply, matched by requestId.
       *
       * @deprecated Legacy keyframe-batch path. Use `renderFrame`.
       */
      type: 'composite'
      requestId: number
      frame: number
      sources: CompositeSourceEntry[]
    }
  | {
      /** Tear down all sources, child cursors, decoders, and caches. */
      type: 'close'
    }

/** Messages the render worker sends back to the main thread. */
export type FromRenderWorker =
  | {
      /** The asset's worker source/decoder is ready; renders may reference it. */
      type: 'assetConfigured'
      assetId: AssetId
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
