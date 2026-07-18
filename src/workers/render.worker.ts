/**
 * workers/render.worker.ts — The compositing worker. Phase 4.1b.
 *
 * Runs pipeline/render.compositeFrame off the main thread. The streaming
 * path owns one Blob-backed source per asset and one sequential cursor per
 * visible clip; the deprecated path still accepts keyframe chunk batches
 * until the bridge migration lands. Both inherit the hard-won ownership
 * rules from the decode worker (Phase 2.2/2.5):
 * - every VideoFrame closes the moment its bitmap copy exists;
 * - caches hold decoder-independent ImageBitmaps, never VideoFrames;
 * - backpressure: decodeQueueSize < QUEUE_HIGH_WATER, park on dequeue;
 * - reset() UNCONFIGURES a decoder — reconfigure after every reset;
 * - latest-wins PRESENTATION: stale composites never touch the screen;
 *   normal playback supersession keeps useful sequential decode work alive.
 *
 * On top of those, three render-specific rules:
 * - DOUBLE BUFFERING: compositeFrame draws onto a worker-private scratch
 *   canvas; only the newest composite blits scratch → visible canvas.
 *   A superseded composite can never flash a torn/stale frame.
 * - SEQUENTIAL composites, serialized per-asset batches: two clips may
 *   need the SAME asset at different frames in one composite (the
 *   render.ts contract) — the per-asset chain decodes them one after the
 *   other while different assets run concurrently.
 * - LOANS: a bitmap handed to the compositor is take()n out of its cache
 *   so a later decode batch in the same composite cannot evict-and-close
 *   it mid-draw; after the composite it is re-put (or closed, if the
 *   asset was reconfigured meanwhile — epoch mismatch).
 *
 * Layering: workers/ → domain/, engine/frame-cache, decode-protocol
 * (types), pipeline/render (sanctioned: pure compositing core, imports
 * domain/ only). Logic lives in createRenderWorkerCore() with injected
 * browser deps; the real wiring at the bottom only runs in a worker scope.
 */

import { FrameRingBuffer } from '../engine/frame-cache'
import type { AssetId, ClipId, TimelineDoc } from '../domain/schema'
import { visibleVideoLayersAtFrame } from '../domain/selectors'
import type { Composite2D, FrameSource } from '../pipeline/render'
import { compositeFrame } from '../pipeline/render'
import type { ChunkPayload } from './decode-protocol'
import type {
  BitmapLike,
  DecodableFrame,
  VideoDecoderLike,
} from './decode.worker'
import type {
  CompositeSourceEntry,
  FromRenderWorker,
  RenderFrameMessage,
  StreamingCompositeSourceEntry,
  ToRenderWorker,
} from './render-protocol'
import {
  WorkerVideoSourceOpenError,
  openWorkerVideoSource,
} from './video-source'
import type {
  DecodedVideoFrame,
  VideoFrameCursor,
  WorkerVideoSource,
} from './video-source'

/** Same high-water mark as the decode worker (plan-mandated). */
const QUEUE_HIGH_WATER = 8

/** Ring-buffer capacity PER ASSET (each asset caches independently). */
const CACHE_CAPACITY = 12

/** A larger forward gap is a discontinuity, not useful sequential catch-up. */
const PLAYBACK_RESTART_GAP_US = 1_000_000

/* ------------------------------------------------------------------ */
/* Structural types for injectable browser deps                         */
/* ------------------------------------------------------------------ */

/**
 * The slice of OffscreenCanvas the worker uses. Its 2D context must
 * satisfy pipeline/render's Composite2D — the real
 * OffscreenCanvasRenderingContext2D does.
 */
export interface RenderCanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Composite2D | null
}

/** Everything the core needs from the outside world. */
export interface RenderWorkerEnv {
  post(msg: FromRenderWorker): void
  createDecoder(init: {
    output: (frame: DecodableFrame) => void
    error: (e: { message: string }) => void
  }): VideoDecoderLike
  isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }>
  createChunk(payload: ChunkPayload): unknown
  /** GPU-copy a frame into a decoder-independent bitmap (createImageBitmap). */
  createBitmap(frame: DecodableFrame): Promise<BitmapLike>
  /** Open one worker-owned Mediabunny source for a structured-cloned Blob. */
  openVideoSource(blob: Blob): Promise<WorkerVideoSource>
  /** Normalize orientation and copy a streamed frame. Does not close it. */
  createStreamingBitmap(frame: DecodedVideoFrame): Promise<BitmapLike>
  /** Create the scratch compositing surface (new OffscreenCanvas). */
  createCanvas(width: number, height: number): RenderCanvasLike
  now(): number
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */

/** One asset's decode machinery. Created by configureAsset. */
interface AssetState {
  config: VideoDecoderConfig
  decoder: VideoDecoderLike | null
  /** Decoded frames as ImageBitmaps, keyed by asset timestamp µs. */
  cache: FrameRingBuffer<BitmapLike>
  /** Feed loops parked on backpressure; woken by dequeue and supersession. */
  waiters: Set<() => void>
  /** Serializes decode batches: same-asset entries run one after another. */
  chain: Promise<void>
  /** Bumped when the asset is reconfigured/released: outstanding loans
   * must close their bitmap instead of re-putting it into a new cache. */
  epoch: number
  /** Decoder faulted (or torn down): entries resolve null until reconfigured. */
  dead: boolean
  /** createImageBitmap jobs of the CURRENT batch (one batch at a time per
   * asset, thanks to `chain`); awaited before the post-flush cache probe. */
  batchJobs: Array<Promise<void>>
}

/** A bitmap on loan from its cache to the in-flight composite. */
interface Loan {
  state: AssetState
  epoch: number
  key: number
  bitmap: BitmapLike
}

interface OwnedStreamingFrame {
  timestampUs: number
  bitmap: BitmapLike
}

interface PlaybackLaneState {
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

interface StreamingAssetState {
  source: WorkerVideoSource
  lanes: Map<ClipId, PlaybackLaneState>
  pendingCopies: Set<Promise<OwnedStreamingFrame | null>>
  epoch: number
}

interface StreamingLoan {
  bitmap: BitmapLike
  settle(): void
}

interface ClipDecodeIdentity {
  assetId: AssetId
  sourceStart: number
  sourceDuration: number
  timelineStart: number
  timelineDuration: number
}

export function createRenderWorkerCore(env: RenderWorkerEnv): {
  handleMessage(msg: ToRenderWorker): Promise<void>
  revisionEntryCounts(): { assets: number; playbackLanes: number }
} {
  let visible: RenderCanvasLike | null = null
  let visibleCtx: Composite2D | null = null
  let scratch: RenderCanvasLike | null = null
  let scratchCtx: Composite2D | null = null
  let doc: TimelineDoc | null = null
  /** Bumped by every composite/setDoc/configureAsset/releaseAsset/close;
   * stale composites and parked feed loops check it and unwind. */
  let generation = 0
  /** Composites run strictly one at a time (stale ones exit immediately). */
  let compositeChain: Promise<void> = Promise.resolve()
  /** Invalidates asset opens/configures that outlive a worker-wide close. */
  let workerLifecycle = 0
  /** Worker-global tokens prevent ABA when per-key revision entries retire. */
  let revisionToken = 0
  /** Deprecated chunk-backed asset states. */
  const assets = new Map<AssetId, AssetState>()
  /** Blob-backed streaming asset states. */
  const streamingAssets = new Map<AssetId, StreamingAssetState>()
  const assetRevisions = new Map<AssetId, number>()
  /** Only seek cursors are presentation-scoped and cancelled on supersession. */
  const activeSeekCursors = new Set<VideoFrameCursor>()
  /** Latest playback request's active clip lanes; updated at message arrival. */
  let desiredPlaybackLaneKeys = new Set<string>()
  const playbackLaneRevisions = new Map<string, number>()

  function wake(state: AssetState): void {
    const waiters = [...state.waiters]
    state.waiters.clear()
    for (const wakeOne of waiters) wakeOne()
  }

  function waitForWake(state: AssetState): Promise<void> {
    return new Promise((resolve) => state.waiters.add(resolve))
  }

  function nextRevisionToken(): number {
    revisionToken++
    if (!Number.isSafeInteger(revisionToken)) {
      throw new RangeError('Render worker revision token overflow')
    }
    return revisionToken
  }

  function nextAssetRevision(assetId: AssetId): number {
    const revision = nextRevisionToken()
    assetRevisions.set(assetId, revision)
    return revision
  }

  function clearAssetRevision(assetId: AssetId, revision: number): void {
    if (assetRevisions.get(assetId) === revision) {
      assetRevisions.delete(assetId)
    }
  }

  function assetRevisionIsCurrent(
    assetId: AssetId,
    revision: number,
    lifecycle: number,
  ): boolean {
    return assetRevisions.get(assetId) === revision && workerLifecycle === lifecycle
  }

  function cancelActiveSeeks(): void {
    const cursors = [...activeSeekCursors]
    activeSeekCursors.clear()
    for (const cursor of cursors) {
      void cursor.close().catch(() => undefined)
    }
  }

  /** Invalidate presentation work without cancelling persistent playback lanes. */
  function supersede(): number {
    generation++
    for (const state of assets.values()) wake(state)
    cancelActiveSeeks()
    return generation
  }

  /** Size both canvases to the doc; a resize wipes them (next blit repaints). */
  function syncCanvases(): void {
    if (!visible || !doc) return
    if (visible.width !== doc.width || visible.height !== doc.height) {
      visible.width = doc.width
      visible.height = doc.height
    }
    if (!scratch) {
      scratch = env.createCanvas(doc.width, doc.height)
      scratchCtx = scratch.getContext('2d')
      if (!scratchCtx) {
        env.post({ type: 'error', message: 'scratch canvas 2d context unavailable' })
      }
    } else if (scratch.width !== doc.width || scratch.height !== doc.height) {
      scratch.width = doc.width
      scratch.height = doc.height
    }
  }

  /** Cached timestamp within tolerance of the target, or null. */
  function findCachedKey(
    cache: FrameRingBuffer<BitmapLike>,
    targetTimestampUs: number,
    toleranceUs: number,
  ): number | null {
    for (const key of cache.keys()) {
      if (Math.abs(key - targetTimestampUs) <= toleranceUs) return key
    }
    return null
  }

  /** Tear one asset's machinery down (release/replace/close paths). */
  function teardownAsset(state: AssetState): void {
    state.epoch++ // outstanding loans now close instead of re-putting
    state.dead = true
    state.decoder?.close()
    state.decoder = null
    state.cache.clear()
    wake(state)
  }

  function closeOwnedStreamingFrame(frame: OwnedStreamingFrame | null): void {
    frame?.bitmap.close()
  }

  async function disposePlaybackLane(lane: PlaybackLaneState): Promise<void> {
    if (lane.closed) return
    lane.closed = true
    lane.epoch++
    closeOwnedStreamingFrame(lane.current)
    closeOwnedStreamingFrame(lane.lookahead)
    lane.current = null
    lane.lookahead = null
    await lane.cursor.close()
  }

  async function closePlaybackLane(
    state: StreamingAssetState,
    clipId: ClipId,
  ): Promise<void> {
    const lane = state.lanes.get(clipId)
    if (!lane) return
    state.lanes.delete(clipId)
    await disposePlaybackLane(lane)
  }

  async function teardownStreamingAsset(state: StreamingAssetState): Promise<void> {
    state.epoch++
    const lanes = [...state.lanes.values()]
    state.lanes.clear()
    const closeResults = await Promise.allSettled([
      ...lanes.map((lane) => disposePlaybackLane(lane)),
      state.source.close(),
    ])
    while (state.pendingCopies.size > 0) {
      await Promise.allSettled([...state.pendingCopies])
    }
    const errors = closeResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close streaming render asset')
    }
  }

  async function removeStreamingAsset(assetId: AssetId): Promise<void> {
    const state = streamingAssets.get(assetId)
    if (!state) return
    streamingAssets.delete(assetId)
    await teardownStreamingAsset(state)
  }

  function collectClipDecodeIdentities(
    value: TimelineDoc | null,
  ): Map<ClipId, ClipDecodeIdentity> {
    const identities = new Map<ClipId, ClipDecodeIdentity>()
    if (!value) return identities
    for (const track of value.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of track.clips) {
        identities.set(clip.id, {
          assetId: clip.assetId,
          sourceStart: clip.sourceRange.startFrame,
          sourceDuration: clip.sourceRange.durationFrames,
          timelineStart: clip.timelineRange.startFrame,
          timelineDuration: clip.timelineRange.durationFrames,
        })
      }
    }
    return identities
  }

  function sameClipDecodeIdentity(
    left: ClipDecodeIdentity | undefined,
    right: ClipDecodeIdentity | undefined,
  ): boolean {
    return (
      left !== undefined
      && right !== undefined
      && left.assetId === right.assetId
      && left.sourceStart === right.sourceStart
      && left.sourceDuration === right.sourceDuration
      && left.timelineStart === right.timelineStart
      && left.timelineDuration === right.timelineDuration
    )
  }

  function invalidatePlaybackPolicyForDoc(
    previousDoc: TimelineDoc | null,
    nextDoc: TimelineDoc,
  ): void {
    if (!previousDoc) return
    const previous = collectClipDecodeIdentities(previousDoc)
    const next = collectClipDecodeIdentities(nextDoc)
    const frameRateChanged = (
      previousDoc.frameRate.num !== nextDoc.frameRate.num
      || previousDoc.frameRate.den !== nextDoc.frameRate.den
    )
    for (const [clipId, identity] of previous) {
      const key = playbackLaneKey(identity.assetId, clipId)
      if (
        desiredPlaybackLaneKeys.has(key)
        && (frameRateChanged || !sameClipDecodeIdentity(identity, next.get(clipId)))
      ) {
        const revision = bumpPlaybackLaneRevision(key)
        desiredPlaybackLaneKeys.delete(key)
        clearPlaybackLaneRevision(key, revision)
      }
    }
  }

  async function prunePlaybackLanes(
    previousDoc: TimelineDoc | null,
    nextDoc: TimelineDoc,
  ): Promise<void> {
    const previous = collectClipDecodeIdentities(previousDoc)
    const next = collectClipDecodeIdentities(nextDoc)
    const frameRateChanged = previousDoc !== null && (
      previousDoc.frameRate.num !== nextDoc.frameRate.num
      || previousDoc.frameRate.den !== nextDoc.frameRate.den
    )

    const closes: Promise<void>[] = []
    for (const [assetId, state] of streamingAssets) {
      for (const clipId of state.lanes.keys()) {
        const compatible = (
          !frameRateChanged
          && sameClipDecodeIdentity(previous.get(clipId), next.get(clipId))
          && next.get(clipId)?.assetId === assetId
        )
        if (!compatible) {
          desiredPlaybackLaneKeys.delete(playbackLaneKey(assetId, clipId))
          closes.push(closePlaybackLane(state, clipId))
        }
      }
    }
    const results = await Promise.allSettled(closes)
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to prune streaming playback lanes')
    }
  }

  async function copyDecodedFrame(
    state: StreamingAssetState,
    decoded: DecodedVideoFrame,
  ): Promise<OwnedStreamingFrame> {
    const job = (async (): Promise<OwnedStreamingFrame> => {
      try {
        return {
          timestampUs: decoded.timestampUs,
          bitmap: await env.createStreamingBitmap(decoded),
        }
      } finally {
        decoded.frame.close()
      }
    })()
    state.pendingCopies.add(job)
    try {
      return await job
    } finally {
      state.pendingCopies.delete(job)
    }
  }

  function closeDecodedFrame(frame: DecodedVideoFrame | null): void {
    frame?.frame.close()
  }

  function playbackLaneKey(assetId: AssetId, clipId: ClipId): string {
    return `${assetId}\u0000${clipId}`
  }

  function bumpPlaybackLaneRevision(key: string): number {
    const revision = nextRevisionToken()
    playbackLaneRevisions.set(key, revision)
    return revision
  }

  function clearPlaybackLaneRevision(key: string, revision: number): void {
    if (playbackLaneRevisions.get(key) === revision) {
      playbackLaneRevisions.delete(key)
    }
  }

  function sameLaneKeySet(left: Set<string>, right: Set<string>): boolean {
    if (left.size !== right.size) return false
    for (const key of left) {
      if (!right.has(key)) return false
    }
    return true
  }

  function playbackPolicyAllows(
    entry: StreamingCompositeSourceEntry,
    revision: number,
  ): boolean {
    const key = playbackLaneKey(entry.assetId, entry.clipId)
    return (
      (playbackLaneRevisions.get(key) ?? 0) === revision
      && desiredPlaybackLaneKeys.has(key)
    )
  }

  function applyPlaybackPolicy(
    msg: RenderFrameMessage,
  ): Promise<unknown[]> {
    const nextKeys = msg.mode === 'playback'
      ? new Set(msg.sources.map((entry) => playbackLaneKey(entry.assetId, entry.clipId)))
      : new Set<string>()
    const retiredRevisions = new Map<string, number>()
    if (!sameLaneKeySet(desiredPlaybackLaneKeys, nextKeys)) {
      const changedKeys = new Set([...desiredPlaybackLaneKeys, ...nextKeys])
      for (const key of changedKeys) {
        if (desiredPlaybackLaneKeys.has(key) !== nextKeys.has(key)) {
          const revision = bumpPlaybackLaneRevision(key)
          if (!nextKeys.has(key)) retiredRevisions.set(key, revision)
        }
      }
    }
    desiredPlaybackLaneKeys = nextKeys
    for (const [key, revision] of retiredRevisions) {
      clearPlaybackLaneRevision(key, revision)
    }

    const closes: Promise<void>[] = []
    for (const [assetId, state] of streamingAssets) {
      for (const clipId of state.lanes.keys()) {
        if (!nextKeys.has(playbackLaneKey(assetId, clipId))) {
          closes.push(closePlaybackLane(state, clipId))
        }
      }
    }
    return Promise.allSettled(closes).then((results) =>
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    )
  }

  function streamingStateIsCurrent(
    assetId: AssetId,
    state: StreamingAssetState,
  ): boolean {
    return streamingAssets.get(assetId) === state
  }

  function playbackLaneIsCurrent(
    entry: StreamingCompositeSourceEntry,
    state: StreamingAssetState,
    lane: PlaybackLaneState,
  ): boolean {
    return (
      streamingStateIsCurrent(entry.assetId, state)
      && state.lanes.get(entry.clipId) === lane
      && !lane.closed
    )
  }

  function shouldRestartPlaybackLane(
    lane: PlaybackLaneState,
    entry: StreamingCompositeSourceEntry,
  ): boolean {
    if (lane.lastSourceFrame === null || lane.lastTargetTimestampUs === null) {
      return false
    }
    return (
      entry.sourceFrame < lane.lastSourceFrame
      || entry.targetTimestampUs < lane.lastTargetTimestampUs
      || entry.targetTimestampUs - lane.lastTargetTimestampUs > PLAYBACK_RESTART_GAP_US
    )
  }

  function createPlaybackLane(
    state: StreamingAssetState,
    entry: StreamingCompositeSourceEntry,
  ): PlaybackLaneState {
    const lane: PlaybackLaneState = {
      clipId: entry.clipId,
      cursor: state.source.openPlaybackLane({
        startTimestampUs: entry.targetTimestampUs,
      }),
      current: null,
      lookahead: null,
      lastSourceFrame: null,
      lastTargetTimestampUs: null,
      epoch: 0,
      ended: false,
      closed: false,
    }
    state.lanes.set(entry.clipId, lane)
    return lane
  }

  async function resolvePlaybackEntry(
    state: StreamingAssetState,
    entry: StreamingCompositeSourceEntry,
    loans: StreamingLoan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    const key = playbackLaneKey(entry.assetId, entry.clipId)
    const policyRevision = playbackLaneRevisions.get(key) ?? 0
    if (!playbackPolicyAllows(entry, policyRevision)) return null
    try {
      let lane = state.lanes.get(entry.clipId)
      if (lane && shouldRestartPlaybackLane(lane, entry)) {
        await closePlaybackLane(state, entry.clipId)
        lane = undefined
      }
      if (
        !streamingStateIsCurrent(entry.assetId, state)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      lane ??= createPlaybackLane(state, entry)

      let candidate: DecodedVideoFrame | null = null
      let pendingFuture: DecodedVideoFrame | null = null
      try {
        while (
          playbackLaneIsCurrent(entry, state, lane)
          && playbackPolicyAllows(entry, policyRevision)
        ) {
          const lookahead = lane.lookahead
          if (lookahead) {
            if (lookahead.timestampUs > entry.targetTimestampUs) break
            closeOwnedStreamingFrame(lane.current)
            lane.current = lookahead
            lane.lookahead = null
            continue
          }
          if (lane.ended) break

          const decoded = await lane.cursor.next()
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            closeDecodedFrame(decoded)
            try {
              await closePlaybackLane(state, entry.clipId)
            } catch {
              // Intentional invalidation is already taking ownership down.
            }
            return null
          }
          if (!decoded) {
            lane.ended = true
            break
          }
          if (decoded.timestampUs <= entry.targetTimestampUs) {
            closeDecodedFrame(candidate)
            candidate = decoded
            continue
          }
          pendingFuture = decoded

          if (candidate) {
            const selected = candidate
            candidate = null
            const current = await copyDecodedFrame(state, selected)
            if (
              !playbackLaneIsCurrent(entry, state, lane)
              || !playbackPolicyAllows(entry, policyRevision)
            ) {
              current.bitmap.close()
              closeDecodedFrame(pendingFuture)
              pendingFuture = null
              return null
            }
            closeOwnedStreamingFrame(lane.current)
            lane.current = current
          }

          const selectedFuture = pendingFuture
          pendingFuture = null
          const future = await copyDecodedFrame(state, selectedFuture)
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            future.bitmap.close()
            return null
          }
          lane.lookahead = future
          break
        }

        if (candidate) {
          const selected = candidate
          candidate = null
          const current = await copyDecodedFrame(state, selected)
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            current.bitmap.close()
            return null
          }
          closeOwnedStreamingFrame(lane.current)
          lane.current = current
        }
      } finally {
        closeDecodedFrame(candidate)
        closeDecodedFrame(pendingFuture)
      }

      if (
        !playbackLaneIsCurrent(entry, state, lane)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      lane.lastSourceFrame = entry.sourceFrame
      lane.lastTargetTimestampUs = entry.targetTimestampUs
      const current = lane.current
      if (!current) return null

      const assetEpoch = state.epoch
      const laneEpoch = lane.epoch
      lane.current = null
      loans.push({
        bitmap: current.bitmap,
        settle: () => {
          if (
            streamingStateIsCurrent(entry.assetId, state)
            && state.epoch === assetEpoch
            && state.lanes.get(entry.clipId) === lane
            && lane.epoch === laneEpoch
            && !lane.closed
            && lane.current === null
            && playbackPolicyAllows(entry, policyRevision)
          ) {
            lane.current = current
          } else {
            current.bitmap.close()
          }
        },
      })
      return current.bitmap
    } catch (error) {
      try {
        await closePlaybackLane(state, entry.clipId)
      } catch {
        // The original decode/copy error is the useful one to report.
      }
      if (
        !streamingStateIsCurrent(entry.assetId, state)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: `streaming playback failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return null
    }
  }

  async function resolveSeekEntry(
    state: StreamingAssetState,
    entry: StreamingCompositeSourceEntry,
    myGen: number,
    loans: StreamingLoan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    let cursor: VideoFrameCursor | null = null
    try {
      // A scrub is an intentional mode discontinuity for this clip.
      await closePlaybackLane(state, entry.clipId)
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        return null
      }

      cursor = state.source.openSeekLane(entry.targetTimestampUs)
      activeSeekCursors.add(cursor)
      const decoded = await cursor.next()
      if (!decoded) return null
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        closeDecodedFrame(decoded)
        return null
      }
      const frame = await copyDecodedFrame(state, decoded)
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        frame.bitmap.close()
        return null
      }

      loans.push({
        bitmap: frame.bitmap,
        settle: () => frame.bitmap.close(),
      })
      return frame.bitmap
    } catch (error) {
      if (generation === myGen && streamingStateIsCurrent(entry.assetId, state)) {
        env.post({
          type: 'error',
          requestId,
          assetId: entry.assetId,
          message: `streaming seek failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      return null
    } finally {
      if (cursor) {
        activeSeekCursors.delete(cursor)
        try {
          await cursor.close()
        } catch {
          // A source replacement/cancellation may already be closing it.
        }
      }
    }
  }

  /**
   * Produce the bitmap for one composite source entry. Runs on the asset's
   * chain (never concurrently with another batch for the same asset).
   * Order: cache probe → decode the provided batch → probe again. A found
   * bitmap is take()n out of the cache and recorded as a loan.
   */
  async function resolveEntry(
    state: AssetState,
    entry: CompositeSourceEntry,
    myGen: number,
    loans: Loan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    if (generation !== myGen) return null
    if (state.dead) return null
    const decoder = state.decoder
    if (!decoder) return null

    const cachedKey = findCachedKey(state.cache, entry.targetTimestampUs, entry.toleranceUs)
    if (cachedKey !== null) {
      const bitmap = state.cache.take(cachedKey) as BitmapLike
      loans.push({ state, epoch: state.epoch, key: cachedKey, bitmap })
      return bitmap
    }

    if (entry.chunks.length === 0) return null // cold cache, no chunks: miss
    if (entry.chunks[0].type !== 'key') {
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: 'composite batch must start with a keyframe chunk',
      })
      return null
    }

    try {
      // reset() unconfigures (spec) — reconfigure before decoding.
      decoder.reset()
      decoder.configure(state.config)

      for (const chunk of entry.chunks) {
        while (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) {
          // Check BEFORE parking: a supersession that fired while this loop
          // was feeding (not parked) already spent its wake — parking after
          // it would wait for a dequeue that a stale batch may never get.
          if (generation !== myGen || state.dead) return null
          await waitForWake(state)
          if (generation !== myGen || state.dead) return null
        }
        if (generation !== myGen || state.dead) return null
        decoder.decode(env.createChunk(chunk))
      }
      try {
        await decoder.flush()
      } catch {
        // flush() rejects when superseded mid-flush or on decoder trouble;
        // the generation check and final probe below decide what remains.
      }
    } catch (e) {
      if (
        generation === myGen
        && !state.dead
        && assets.get(entry.assetId) === state
      ) {
        env.post({
          type: 'error',
          requestId,
          assetId: entry.assetId,
          message: `decode failed: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
      return null
    }

    // Outputs are emitted by now; wait for their bitmap copies to land.
    await Promise.allSettled(state.batchJobs.splice(0))
    if (generation !== myGen) return null

    const key = findCachedKey(state.cache, entry.targetTimestampUs, entry.toleranceUs)
    if (key === null) return null // target not in the batch / tolerance
    const bitmap = state.cache.take(key) as BitmapLike
    loans.push({ state, epoch: state.epoch, key, bitmap })
    return bitmap
  }

  async function configureAssetAtRevision(
    msg: Extract<ToRenderWorker, { type: 'configureAsset' }>,
    revision: number,
    lifecycle: number,
  ): Promise<void> {
    supersede() // in-flight composites may reference the machinery we replace
    const existing = assets.get(msg.assetId)
    if (existing) {
      teardownAsset(existing)
      assets.delete(msg.assetId)
    }
    try {
      await removeStreamingAsset(msg.assetId)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return

    let support: { supported?: boolean }
    try {
      support = await env.isConfigSupported(msg.config)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
    if (!support.supported) {
      env.post({
        type: 'error',
        assetId: msg.assetId,
        message: `codec not supported by this browser: ${msg.config.codec}`,
      })
      return
    }

    const state: AssetState = {
      config: msg.config,
      decoder: null,
      cache: new FrameRingBuffer<BitmapLike>(CACHE_CAPACITY),
      waiters: new Set(),
      chain: Promise.resolve(),
      epoch: 0,
      dead: false,
      batchJobs: [],
    }
    state.decoder = env.createDecoder({
      // The cache path from the decode worker: GPU-copy to a bitmap, then
      // close the VideoFrame at the first possible moment — it owns a
      // hardware decoder output buffer (the Phase 2.5 crawl bug).
      output: (frame) => {
        const timestampUs = frame.timestamp
        const epoch = state.epoch
        const job = env
          .createBitmap(frame)
          .then((bitmap) => {
            if (
              state.dead
              || state.epoch !== epoch
              || assets.get(msg.assetId) !== state
            ) {
              bitmap.close()
              return
            }
            try {
              state.cache.put(timestampUs, bitmap)
            } catch {
              bitmap.close() // cache refused it (aliased key): do not leak
            }
          })
          .catch(() => undefined) // bitmap creation failed: nothing to cache
          .finally(() => frame.close())
        state.batchJobs.push(job)
      },
      error: (e) => {
        if (state.dead || assets.get(msg.assetId) !== state) return
        state.dead = true
        wake(state)
        env.post({
          type: 'error',
          assetId: msg.assetId,
          message: `decoder: ${e.message}`,
        })
      },
    })
    state.decoder.ondequeue = () => wake(state)
    state.decoder.configure(msg.config)
    assets.set(msg.assetId, state)
    env.post({ type: 'assetConfigured', assetId: msg.assetId })
  }

  async function handleConfigureAsset(
    msg: Extract<ToRenderWorker, { type: 'configureAsset' }>,
  ): Promise<void> {
    const revision = nextAssetRevision(msg.assetId)
    const lifecycle = workerLifecycle
    try {
      await configureAssetAtRevision(msg, revision, lifecycle)
    } finally {
      clearAssetRevision(msg.assetId, revision)
    }
  }

  async function openAssetAtRevision(
    msg: Extract<ToRenderWorker, { type: 'openAsset' }>,
    revision: number,
    lifecycle: number,
  ): Promise<void> {
    supersede()

    const legacy = assets.get(msg.assetId)
    if (legacy) {
      teardownAsset(legacy)
      assets.delete(msg.assetId)
    }
    try {
      await removeStreamingAsset(msg.assetId)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return

    let source: WorkerVideoSource
    try {
      source = await env.openVideoSource(msg.blob)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) {
      try {
        await source.close()
      } catch {
        // This open lost its revision; never reject the newer asset waiter.
      }
      return
    }

    streamingAssets.set(msg.assetId, {
      source,
      lanes: new Map(),
      pendingCopies: new Set(),
      epoch: 0,
    })
    env.post({ type: 'assetConfigured', assetId: msg.assetId })
  }

  async function handleOpenAsset(
    msg: Extract<ToRenderWorker, { type: 'openAsset' }>,
  ): Promise<void> {
    const revision = nextAssetRevision(msg.assetId)
    const lifecycle = workerLifecycle
    try {
      await openAssetAtRevision(msg, revision, lifecycle)
    } finally {
      clearAssetRevision(msg.assetId, revision)
    }
  }

  async function handleReleaseAsset(assetId: AssetId): Promise<void> {
    const revision = nextAssetRevision(assetId)
    const lifecycle = workerLifecycle
    try {
      supersede()
      const state = assets.get(assetId)
      if (state) {
        teardownAsset(state)
        assets.delete(assetId)
      }
      try {
        await removeStreamingAsset(assetId)
      } catch (error) {
        if (!assetRevisionIsCurrent(assetId, revision, lifecycle)) {
          // This cleanup belonged to a source that a newer open already
          // replaced. Keep the diagnostic global so it cannot reject or
          // disconnect that newer asset generation.
          if (workerLifecycle === lifecycle) {
            env.post({
              type: 'error',
              message:
                `stale release cleanup failed for asset ${assetId}: `
                + (error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error)),
            })
          }
          return
        }
        throw error
      }
    } finally {
      clearAssetRevision(assetId, revision)
    }
  }

  function handleComposite(
    msg: Extract<ToRenderWorker, { type: 'composite' }>,
  ): Promise<void> {
    // Supersede AT ARRIVAL: older in-flight/queued composites unwind now.
    const myGen = supersede()

    const run = async (): Promise<void> => {
      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      if (!visibleCtx || !scratch || !scratchCtx || !doc) {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: 'composite before init/setDoc',
        })
        return
      }
      const startedAt = env.now()

      // Source table: exact (assetId, sourceFrame) keys, memoized so two
      // clips sharing an entry share one decode and ONE loan.
      const table = new Map<string, CompositeSourceEntry>()
      for (const entry of msg.sources) {
        table.set(`${entry.assetId}@${entry.sourceFrame}`, entry)
      }
      const memo = new Map<string, Promise<BitmapLike | null>>()
      const loans: Loan[] = []
      const source: FrameSource = {
        getFrame: (assetId, sourceFrame) => {
          const key = `${assetId}@${sourceFrame}`
          const memoized = memo.get(key)
          if (memoized) return memoized
          const entry = table.get(key)
          const state = entry ? assets.get(entry.assetId) : undefined
          let promise: Promise<BitmapLike | null>
          if (!entry || !state) {
            promise = Promise.resolve(null)
          } else {
            promise = state.chain.then(() =>
              resolveEntry(state, entry, myGen, loans, msg.requestId),
            )
            state.chain = promise.then(
              () => undefined,
              () => undefined,
            )
          }
          memo.set(key, promise)
          return promise
        },
      }

      const target = scratchCtx
      let result
      try {
        result = await compositeFrame(doc, msg.frame, target, source)
      } finally {
        // Return every loan: ownership back to the cache — unless the
        // asset was reconfigured/released meanwhile (epoch mismatch), in
        // which case the bitmap belongs to a dead stream and closes here.
        for (const loan of loans) {
          if (loan.state.epoch === loan.epoch) {
            loan.state.cache.put(loan.key, loan.bitmap)
          } else {
            loan.bitmap.close()
          }
        }
      }

      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      // Atomic present: the only write the visible canvas ever sees.
      // (At runtime `scratch` is an OffscreenCanvas — a valid drawImage
      // source; the structural Composite2D signature says ImageBitmap.)
      visibleCtx.drawImage(scratch as unknown as ImageBitmap, 0, 0)
      env.post({
        type: 'compositeDone',
        requestId: msg.requestId,
        status: 'drawn',
        drawnClipIds: result.drawn,
        missingClipIds: result.missing,
        renderMs: env.now() - startedAt,
      })
    }

    // Strictly sequential; a failure posts an error and keeps the chain.
    compositeChain = compositeChain.then(() =>
      run().catch((e) => {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: `composite failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        })
      }),
    )
    return compositeChain
  }

  function handleRenderFrame(msg: RenderFrameMessage): Promise<void> {
    // A newer request supersedes only visible presentation. Playback lanes
    // keep decoding on the serialized chain and can serve the newer request.
    const myGen = supersede()
    // Mode changes and cuts retire obsolete playback cursors immediately, so
    // a parked old decode cannot hold the latest seek behind compositeChain.
    const retirement = applyPlaybackPolicy(msg)

    const run = async (): Promise<void> => {
      const retirementErrors = await retirement
      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      if (retirementErrors.length > 0) {
        throw new AggregateError(
          retirementErrors,
          'Failed to retire obsolete playback lanes',
        )
      }
      if (!visibleCtx || !scratch || !scratchCtx || !doc) {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: 'renderFrame before init/setDoc',
        })
        return
      }

      const startedAt = env.now()
      const renderDoc = doc
      const entriesByClip = new Map<ClipId, StreamingCompositeSourceEntry>()
      for (const entry of msg.sources) entriesByClip.set(entry.clipId, entry)

      // FrameSource does not carry clipId yet. Rebuild its call order from the
      // canonical selector and queue clip-keyed entries under the exact
      // (assetId, sourceFrame) keys compositeFrame will request.
      const queues = new Map<string, Array<StreamingCompositeSourceEntry | null>>()
      for (const layer of visibleVideoLayersAtFrame(renderDoc, msg.frame)) {
        const entry = entriesByClip.get(layer.clip.id)
        const key = `${layer.clip.assetId}@${layer.sourceFrame}`
        const queue = queues.get(key) ?? []
        queue.push(
          entry
          && entry.assetId === layer.clip.assetId
          && entry.sourceFrame === layer.sourceFrame
            ? entry
            : null,
        )
        queues.set(key, queue)
      }

      const memo = new Map<ClipId, Promise<BitmapLike | null>>()
      const loans: StreamingLoan[] = []
      const source: FrameSource = {
        getFrame: (assetId, sourceFrame) => {
          const queue = queues.get(`${assetId}@${sourceFrame}`)
          const entry = queue?.shift()
          if (!entry) return Promise.resolve(null)
          const memoized = memo.get(entry.clipId)
          if (memoized) return memoized
          const state = streamingAssets.get(entry.assetId)
          const promise = !state
            ? Promise.resolve(null)
            : msg.mode === 'playback'
              ? resolvePlaybackEntry(state, entry, loans, msg.requestId)
              : resolveSeekEntry(state, entry, myGen, loans, msg.requestId)
          memo.set(entry.clipId, promise)
          return promise
        },
      }

      let result
      try {
        result = await compositeFrame(renderDoc, msg.frame, scratchCtx, source)
      } finally {
        for (const loan of loans) loan.settle()
      }

      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      visibleCtx.drawImage(scratch as unknown as ImageBitmap, 0, 0)
      env.post({
        type: 'compositeDone',
        requestId: msg.requestId,
        status: 'drawn',
        drawnClipIds: result.drawn,
        missingClipIds: result.missing,
        renderMs: env.now() - startedAt,
      })
    }

    compositeChain = compositeChain.then(() =>
      run().catch((error) => {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: `renderFrame failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        })
      }),
    )
    return compositeChain
  }

  function postSuperseded(requestId: number): void {
    env.post({
      type: 'compositeDone',
      requestId,
      status: 'superseded',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 0,
    })
  }

  async function dispatch(msg: ToRenderWorker): Promise<void> {
    switch (msg.type) {
      case 'init': {
        visible = msg.canvas
        visibleCtx = visible.getContext('2d')
        if (!visibleCtx) {
          env.post({ type: 'error', message: 'OffscreenCanvas 2d context unavailable' })
        }
        syncCanvases()
        break
      }
      case 'setDoc': {
        const previousDoc = doc
        invalidatePlaybackPolicyForDoc(previousDoc, msg.doc)
        supersede() // an in-flight composite is rendering a stale doc
        doc = msg.doc
        syncCanvases()
        await prunePlaybackLanes(previousDoc, msg.doc)
        break
      }
      case 'openAsset':
        await handleOpenAsset(msg)
        break
      case 'configureAsset':
        await handleConfigureAsset(msg)
        break
      case 'releaseAsset':
        await handleReleaseAsset(msg.assetId)
        break
      case 'renderFrame':
        await handleRenderFrame(msg)
        break
      case 'composite':
        await handleComposite(msg)
        break
      case 'close': {
        workerLifecycle++
        supersede()
        assetRevisions.clear()
        desiredPlaybackLaneKeys.clear()
        playbackLaneRevisions.clear()
        for (const state of assets.values()) teardownAsset(state)
        assets.clear()
        const streaming = [...streamingAssets.values()]
        streamingAssets.clear()
        const results = await Promise.allSettled(
          streaming.map((state) => teardownStreamingAsset(state)),
        )
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Failed to close render worker')
        }
        break
      }
    }
  }

  async function handleMessage(msg: ToRenderWorker): Promise<void> {
    try {
      await dispatch(msg)
    } catch (e) {
      // Uncaught async exceptions in a worker are silent to the page —
      // never let one vanish (same rule as the decode worker).
      env.post({
        type: 'error',
        requestId:
          msg.type === 'composite' || msg.type === 'renderFrame'
            ? msg.requestId
            : undefined,
        assetId:
          msg.type === 'configureAsset'
          || msg.type === 'openAsset'
          || msg.type === 'releaseAsset'
            ? msg.assetId
            : undefined,
        ...(msg.type === 'openAsset' && e instanceof WorkerVideoSourceOpenError
          ? { mediaFailure: e.failure }
          : {}),
        message: `worker ${msg.type} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      })
    }
  }

  return {
    handleMessage,
    revisionEntryCounts: () => ({
      assets: assetRevisions.size,
      playbackLanes: playbackLaneRevisions.size,
    }),
  }
}

/* ------------------------------------------------------------------ */
/* Real worker wiring (skipped in tests / main thread)                  */
/* ------------------------------------------------------------------ */

export async function createOrientedStreamingBitmap(
  decoded: DecodedVideoFrame,
): Promise<BitmapLike> {
  if (decoded.rotation === 0) {
    return createImageBitmap(decoded.frame as unknown as ImageBitmapSource)
  }

  const outputWidth = decoded.displayWidth
  const outputHeight = decoded.displayHeight
  const sourceWidth = decoded.rotation === 180 ? outputWidth : outputHeight
  const sourceHeight = decoded.rotation === 180 ? outputHeight : outputWidth
  const canvas = new OffscreenCanvas(outputWidth, outputHeight)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('orientation canvas 2d context unavailable')

  context.save()
  try {
    if (decoded.rotation === 90) {
      context.translate(outputWidth, 0)
      context.rotate(Math.PI / 2)
    } else if (decoded.rotation === 180) {
      context.translate(outputWidth, outputHeight)
      context.rotate(Math.PI)
    } else {
      context.translate(0, outputHeight)
      context.rotate(-Math.PI / 2)
    }
    context.drawImage(
      decoded.frame as unknown as CanvasImageSource,
      0,
      0,
      sourceWidth,
      sourceHeight,
    )
  } finally {
    context.restore()
  }
  return canvas.transferToImageBitmap()
}

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const core = createRenderWorkerCore({
    post: (msg) => self.postMessage(msg),
    createDecoder: (init) =>
      new VideoDecoder({
        output: (frame) => init.output(frame),
        error: (e) => init.error(e),
      }) as unknown as VideoDecoderLike,
    isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
    createChunk: (p) =>
      new EncodedVideoChunk({
        type: p.type,
        timestamp: p.timestampUs,
        duration: p.durationUs,
        data: p.data,
      }),
    createBitmap: (frame) =>
      createImageBitmap(frame as unknown as ImageBitmapSource),
    openVideoSource: (blob) => openWorkerVideoSource(blob),
    createStreamingBitmap: createOrientedStreamingBitmap,
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    now: () => performance.now(),
  })

  self.addEventListener('message', (event: MessageEvent<ToRenderWorker>) => {
    void core.handleMessage(event.data)
  })
}
