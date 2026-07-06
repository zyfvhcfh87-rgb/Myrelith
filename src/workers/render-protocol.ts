/**
 * workers/render-protocol.ts — The canonical message contract between the
 * main-thread render bridge (engine/, Phase 4.1c) and workers/
 * render.worker.ts. Types only — zero runtime code, safe for both sides to
 * import (same rule as decode-protocol.ts).
 *
 * Division of labor: the MAIN side is the single computer of timestamps.
 * It runs the domain selectors (activeClipAt/clipSourceFrame) over the doc,
 * rescales to each asset's native rate, fetches the chunk batch per asset,
 * and ships everything in one `composite` message. The worker never
 * re-derives µs targets — it matches `sourceFrame` keys exactly and trusts
 * `targetTimestampUs`/`toleranceUs`, so the two sides can never disagree
 * about rounding.
 *
 * Ordering contract: `setDoc` must be posted BEFORE any `composite` whose
 * source table was computed from that doc (postMessage preserves order, so
 * the bridge just sends doc updates as they happen). A composite that
 * arrives while an older one is still decoding supersedes it: the older
 * request unwinds early and answers `compositeDone` with
 * status 'superseded', never blitting to the visible canvas.
 */

import type { AssetId, ClipId, TimelineDoc } from '../domain/schema'
import type { ChunkPayload } from './decode-protocol'

/**
 * Everything the worker needs to produce pixels for ONE (asset, sourceFrame)
 * pair used by the composite. `sourceFrame` is in DOCUMENT-rate frames (the
 * value compositeFrame's FrameSource asks for — exact integer key);
 * `targetTimestampUs`/`toleranceUs` are in the asset's native timebase,
 * precomputed by the bridge.
 */
export interface CompositeSourceEntry {
  assetId: AssetId
  /** Document-rate source frame, as produced by domain clipSourceFrame(). */
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
  | {
      /**
       * Create (or replace) the decoder + frame cache for one asset. A
       * replacement closes the old decoder and clears the old cache — the
       * cached frames belong to the old stream.
       */
      type: 'configureAsset'
      assetId: AssetId
      config: VideoDecoderConfig
    }
  | {
      /** Drop an asset's decoder + cache (asset removed from the pool). */
      type: 'releaseAsset'
      assetId: AssetId
    }
  | {
      /**
       * Composite document frame `frame` onto the canvas using `sources`
       * for pixels. Latest-wins: a newer composite (or setDoc/
       * configureAsset) supersedes an in-flight one, which then resolves
       * 'superseded' without blitting. Every composite gets EXACTLY ONE
       * compositeDone (or error) reply, matched by requestId.
       */
      type: 'composite'
      requestId: number
      frame: number
      sources: CompositeSourceEntry[]
    }
  | {
      /** Tear down all decoders and caches (worker itself stays alive). */
      type: 'close'
    }

/** Messages the render worker sends back to the main thread. */
export type FromRenderWorker =
  | {
      /** The asset's decoder is configured; composites may reference it. */
      type: 'assetConfigured'
      assetId: AssetId
    }
  | {
      /** A composite finished (exactly one per composite request). */
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
       * Something failed. requestId ties it to a composite (which then gets
       * NO compositeDone); assetId ties it to one asset's decoder.
       */
      type: 'error'
      requestId?: number
      assetId?: AssetId
      message: string
    }
