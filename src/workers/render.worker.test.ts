/**
 * workers/render.worker.test.ts — Phase 4.1b.
 *
 * Drives the render worker core with fake decoders/canvases and asserts
 * the properties multi-track preview depends on:
 *   1. one decoder per asset; per-asset batches are serialized, assets
 *      run independently; every VideoFrame closes on every path;
 *   2. double buffering: only the newest composite blits to the visible
 *      canvas — superseded composites answer 'superseded' and never blit;
 *   3. loans: a bitmap being composited cannot be evicted-and-closed by a
 *      later batch in the same composite (the PiP case), and returns to
 *      its cache afterwards;
 *   4. failures stay contained: bad batches, dead decoders and missing
 *      assets turn into missingClipIds, never crashes.
 *
 * Fakes model REAL WebCodecs semantics (queue growth, reset-unconfigures,
 * flush-emits, closed-bitmap draws throw) — see HANDOFF.md lessons.
 */

import { describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import type { Composite2D } from '../pipeline/render'
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
  RenderMode,
  StreamingCompositeSourceEntry,
  ToRenderWorker,
} from './render-protocol'
import type { RenderCanvasLike, RenderWorkerEnv } from './render.worker'
import {
  createOrientedStreamingBitmap,
  createRenderWorkerCore,
} from './render.worker'
import type {
  DecodedVideoFrame,
  PlaybackLaneOptions,
  VideoFrameCursor,
  WorkerVideoSource,
} from './video-source'

/* ------------------------------------------------------------------ */
/* Timebase: 10 fps doc + assets → one frame = 100_000 µs exactly       */
/* ------------------------------------------------------------------ */

const FRAME_US = 100_000
const TOL_US = FRAME_US / 2

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

interface TrackedFrame extends DecodableFrame {
  closed: boolean
}

interface TrackedBitmap extends BitmapLike {
  sourceTimestamp: number
  closed: boolean
  closeCount: number
}

interface TrackedStreamingFrame {
  closeCount: number
  close(): void
}

interface FakeOptions {
  supported?: boolean
  /** Drain one queue slot per microtask after each decode, like a live decoder. */
  autoDrain?: boolean
  /** decode() of the chunk at this timestamp fires the error callback. */
  errorOnUs?: number
  /** Streaming bitmap normalization rejects at this source timestamp. */
  streamBitmapErrorOnUs?: number
  /** Holds streaming bitmap normalization for teardown-race tests. */
  streamBitmapGate?: Promise<void>
  /** Holds Blob-source opening for revision-race tests. */
  openSourceGate?: Promise<void>
}

/** Same real-semantics fake as decode.worker.test.ts, plus an error hook. */
class FakeDecoder implements VideoDecoderLike {
  decodeQueueSize = 0
  ondequeue: (() => void) | null = null
  decoded: ChunkPayload[] = []
  resetCount = 0
  configureCount = 0
  isClosed = false
  private isConfigured = false
  private pending: ChunkPayload[] = []

  private readonly output: (frame: DecodableFrame) => void
  private readonly errorCb: (e: { message: string }) => void
  private readonly opts: FakeOptions
  private readonly frames: TrackedFrame[]

  constructor(
    output: (frame: DecodableFrame) => void,
    errorCb: (e: { message: string }) => void,
    opts: FakeOptions,
    frames: TrackedFrame[],
  ) {
    this.output = output
    this.errorCb = errorCb
    this.opts = opts
    this.frames = frames
  }

  configure(): void {
    this.configureCount++
    this.isConfigured = true
  }

  decode(chunk: unknown): void {
    if (this.isClosed || !this.isConfigured) {
      throw new DOMException(
        "Cannot call 'decode' on an unconfigured codec.",
        'InvalidStateError',
      )
    }
    const payload = chunk as ChunkPayload
    if (this.opts.errorOnUs === payload.timestampUs) {
      this.isClosed = true // a faulted decoder is closed, like Chrome
      this.errorCb({ message: 'hardware decode fault' })
      return
    }
    this.decoded.push(payload)
    this.pending.push(payload)
    this.decodeQueueSize++
    if (this.opts.autoDrain) queueMicrotask(() => this.drain(1))
  }

  drain(count: number): void {
    this.decodeQueueSize = Math.max(0, this.decodeQueueSize - count)
    this.ondequeue?.()
  }

  async flush(): Promise<void> {
    this.decodeQueueSize = 0
    for (const payload of this.pending.splice(0)) {
      const frame: TrackedFrame = {
        timestamp: payload.timestampUs,
        displayWidth: 320,
        displayHeight: 180,
        closed: false,
        close() {
          frame.closed = true
        },
      }
      this.frames.push(frame)
      this.output(frame)
    }
  }

  reset(): void {
    this.resetCount++
    this.decodeQueueSize = 0
    this.pending = []
    this.isConfigured = false // per spec: reset() unconfigures the codec
  }

  close(): void {
    this.isClosed = true
  }
}

class FakeStreamCursor implements VideoFrameCursor {
  nextCount = 0
  closeCount = 0
  private readonly parkWhenEmpty: boolean
  private queue: DecodedVideoFrame[]
  private pendingResolve: ((frame: DecodedVideoFrame | null) => void) | null = null
  private closed = false

  constructor(frames: DecodedVideoFrame[] = [], parkWhenEmpty = false) {
    this.queue = [...frames]
    this.parkWhenEmpty = parkWhenEmpty
  }

  next(): Promise<DecodedVideoFrame | null> {
    this.nextCount++
    if (this.closed) return Promise.resolve(null)
    const frame = this.queue.shift()
    if (frame) return Promise.resolve(frame)
    if (!this.parkWhenEmpty) return Promise.resolve(null)
    if (this.pendingResolve) {
      return Promise.reject(new Error('fake cursor already has a pending next'))
    }
    return new Promise((resolve) => {
      this.pendingResolve = resolve
    })
  }

  push(frame: DecodedVideoFrame): void {
    if (this.closed) {
      frame.frame.close()
      return
    }
    const resolve = this.pendingResolve
    if (resolve) {
      this.pendingResolve = null
      resolve(frame)
    } else {
      this.queue.push(frame)
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.closeCount++
    for (const frame of this.queue.splice(0)) frame.frame.close()
    const resolve = this.pendingResolve
    this.pendingResolve = null
    resolve?.(null)
    return Promise.resolve()
  }
}

class FakeVideoSource implements WorkerVideoSource {
  playbackOptions: PlaybackLaneOptions[] = []
  seekTargets: number[] = []
  playbackCursors: FakeStreamCursor[] = []
  seekCursors: FakeStreamCursor[] = []
  closeCount = 0
  private playbackQueue: FakeStreamCursor[] = []
  private seekQueue: FakeStreamCursor[] = []
  private closed = false

  queuePlayback(cursor: FakeStreamCursor): void {
    this.playbackQueue.push(cursor)
  }

  queueSeek(cursor: FakeStreamCursor): void {
    this.seekQueue.push(cursor)
  }

  openPlaybackLane(options: PlaybackLaneOptions): VideoFrameCursor {
    if (this.closed) throw new Error('fake source is closed')
    const cursor = this.playbackQueue.shift() ?? new FakeStreamCursor()
    this.playbackOptions.push(options)
    this.playbackCursors.push(cursor)
    return cursor
  }

  openSeekLane(targetTimestampUs: number): VideoFrameCursor {
    if (this.closed) throw new Error('fake source is closed')
    const cursor = this.seekQueue.shift() ?? new FakeStreamCursor()
    this.seekTargets.push(targetTimestampUs)
    this.seekCursors.push(cursor)
    return cursor
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closeCount++
    await Promise.all([
      ...this.playbackCursors.map((cursor) => cursor.close()),
      ...this.seekCursors.map((cursor) => cursor.close()),
    ])
  }
}

interface CtxOp {
  surface: 'visible' | 'scratch'
  name: string
  args: unknown[]
}

interface FakeSurface {
  canvas: RenderCanvasLike
  raw: { width: number; height: number }
}

/** A canvas whose 2D ctx logs ops; drawing a closed bitmap THROWS (real). */
function makeSurface(surface: CtxOp['surface'], log: CtxOp[]): FakeSurface {
  let alpha = 1
  let fill: Composite2D['fillStyle'] = ''
  const ctx: Composite2D = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v) {
      alpha = v
      log.push({ surface, name: 'alpha', args: [v] })
    },
    get fillStyle() {
      return fill
    },
    set fillStyle(v) {
      fill = v
      log.push({ surface, name: 'fillStyle', args: [v] })
    },
    save: () => log.push({ surface, name: 'save', args: [] }),
    restore: () => log.push({ surface, name: 'restore', args: [] }),
    translate: (x, y) => log.push({ surface, name: 'translate', args: [x, y] }),
    rotate: (a) => log.push({ surface, name: 'rotate', args: [a] }),
    scale: (x, y) => log.push({ surface, name: 'scale', args: [x, y] }),
    fillRect: (x, y, w, h) => log.push({ surface, name: 'fillRect', args: [x, y, w, h] }),
    drawImage: (image, dx, dy) => {
      if ((image as Partial<TrackedBitmap>).closed === true) {
        throw new DOMException('bitmap was closed', 'InvalidStateError')
      }
      log.push({ surface, name: 'drawImage', args: [image, dx, dy] })
    },
  }
  const raw = { width: 0, height: 0 }
  const canvas: RenderCanvasLike = {
    get width() {
      return raw.width
    },
    set width(v) {
      raw.width = v
    },
    get height() {
      return raw.height
    },
    set height(v) {
      raw.height = v
    },
    getContext: () => ctx,
  }
  return { canvas, raw }
}

interface Harness {
  core: ReturnType<typeof createRenderWorkerCore>
  posts: FromRenderWorker[]
  frames: TrackedFrame[]
  streamingFrames: TrackedStreamingFrame[]
  bitmaps: TrackedBitmap[]
  streamingBitmaps: TrackedBitmap[]
  normalizations: Array<Omit<DecodedVideoFrame, 'frame'>>
  sourcesToOpen: FakeVideoSource[]
  openedBlobs: Blob[]
  decoders: FakeDecoder[]
  ops: CtxOp[]
  visible: FakeSurface
  scratch: () => FakeSurface | null
  blits: () => CtxOp[]
  scratchDraws: () => CtxOp[]
}

function makeHarness(opts: FakeOptions = {}): Harness {
  const posts: FromRenderWorker[] = []
  const frames: TrackedFrame[] = []
  const streamingFrames: TrackedStreamingFrame[] = []
  const bitmaps: TrackedBitmap[] = []
  const streamingBitmaps: TrackedBitmap[] = []
  const normalizations: Array<Omit<DecodedVideoFrame, 'frame'>> = []
  const sourcesToOpen: FakeVideoSource[] = []
  const openedBlobs: Blob[] = []
  const decoders: FakeDecoder[] = []
  const ops: CtxOp[] = []
  const visible = makeSurface('visible', ops)
  let scratch: FakeSurface | null = null

  const env: RenderWorkerEnv = {
    post: (msg) => posts.push(msg),
    createDecoder: (init) => {
      const decoder = new FakeDecoder(init.output, init.error, opts, frames)
      decoders.push(decoder)
      return decoder
    },
    isConfigSupported: async () => ({ supported: opts.supported ?? true }),
    createChunk: (payload) => payload,
    createBitmap: async (frame) => {
      const bitmap: TrackedBitmap = {
        width: frame.displayWidth,
        height: frame.displayHeight,
        sourceTimestamp: frame.timestamp,
        closed: false,
        closeCount: 0,
        close() {
          bitmap.closeCount++
          bitmap.closed = true
        },
      }
      bitmaps.push(bitmap)
      return bitmap
    },
    openVideoSource: async (blob) => {
      openedBlobs.push(blob)
      await opts.openSourceGate
      const source = sourcesToOpen.shift()
      if (!source) throw new Error('test did not queue a streaming source')
      return source
    },
    createStreamingBitmap: async (decoded) => {
      await opts.streamBitmapGate
      normalizations.push({
        timestampUs: decoded.timestampUs,
        durationUs: decoded.durationUs,
        rotation: decoded.rotation,
        displayWidth: decoded.displayWidth,
        displayHeight: decoded.displayHeight,
      })
      if (opts.streamBitmapErrorOnUs === decoded.timestampUs) {
        throw new Error('streaming bitmap copy failed')
      }
      const bitmap: TrackedBitmap = {
        width: decoded.displayWidth,
        height: decoded.displayHeight,
        sourceTimestamp: decoded.timestampUs,
        closed: false,
        closeCount: 0,
        close() {
          bitmap.closeCount++
          bitmap.closed = true
        },
      }
      bitmaps.push(bitmap)
      streamingBitmaps.push(bitmap)
      return bitmap
    },
    createCanvas: (width, height) => {
      scratch = makeSurface('scratch', ops)
      scratch.canvas.width = width
      scratch.canvas.height = height
      return scratch.canvas
    },
    now: () => 0,
  }

  return {
    core: createRenderWorkerCore(env),
    posts,
    frames,
    streamingFrames,
    bitmaps,
    streamingBitmaps,
    normalizations,
    sourcesToOpen,
    openedBlobs,
    decoders,
    ops,
    visible,
    scratch: () => scratch,
    blits: () => ops.filter((op) => op.surface === 'visible' && op.name === 'drawImage'),
    scratchDraws: () =>
      ops.filter((op) => op.surface === 'scratch' && op.name === 'drawImage'),
  }
}

/* ------------------------------------------------------------------ */
/* Doc + message builders                                               */
/* ------------------------------------------------------------------ */

function makeClip(
  id: string,
  assetId: string,
  tlStart: number,
  duration: number,
  sourceStart = 0,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[]): Track {
  return { id, kind: 'video', name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 10, den: 1 },
    width: 320,
    height: 180,
    audioSampleRate: 48000,
    tracks,
  }
}

function chunkAt(frame: number, type: 'key' | 'delta'): ChunkPayload {
  return { type, timestampUs: frame * FRAME_US, durationUs: FRAME_US, data: new ArrayBuffer(4) }
}

/** An n-chunk GOP starting at `startFrame`: one keyframe, then deltas. */
function gop(startFrame: number, n: number): ChunkPayload[] {
  return Array.from({ length: n }, (_, i) =>
    chunkAt(startFrame + i, i === 0 ? 'key' : 'delta'),
  )
}

/** Entry the way the 4.1c bridge will build it (assets conformed, 10 fps). */
function entry(
  assetId: string,
  sourceFrame: number,
  chunks: ChunkPayload[] = [],
): CompositeSourceEntry {
  return {
    assetId,
    sourceFrame,
    targetTimestampUs: sourceFrame * FRAME_US,
    toleranceUs: TOL_US,
    chunks,
  }
}

function streamDecoded(
  harness: Harness,
  timestampUs: number,
  rotation: DecodedVideoFrame['rotation'] = 0,
  displayWidth = 320,
  displayHeight = 180,
): DecodedVideoFrame {
  const frame: TrackedStreamingFrame = {
    closeCount: 0,
    close() {
      frame.closeCount++
    },
  }
  harness.streamingFrames.push(frame)
  return {
    timestampUs,
    durationUs: FRAME_US,
    rotation,
    displayWidth,
    displayHeight,
    frame,
  }
}

function streamEntry(
  clipId: string,
  assetId: string,
  sourceFrame: number,
  targetTimestampUs = sourceFrame * FRAME_US,
): StreamingCompositeSourceEntry {
  return { clipId, assetId, sourceFrame, targetTimestampUs }
}

const initMsg = (h: Harness): ToRenderWorker => ({
  type: 'init',
  canvas: h.visible.canvas as unknown as OffscreenCanvas,
})

const docMsg = (doc: TimelineDoc): ToRenderWorker => ({ type: 'setDoc', doc })

const cfgMsg = (assetId: string): ToRenderWorker => ({
  type: 'configureAsset',
  assetId,
  config: { codec: 'avc1.640028' },
})

const openMsg = (assetId: string, blob = new Blob(['video'])): ToRenderWorker => ({
  type: 'openAsset',
  assetId,
  blob,
})

function compMsg(
  requestId: number,
  frame: number,
  sources: CompositeSourceEntry[],
): ToRenderWorker {
  return { type: 'composite', requestId, frame, sources }
}

function renderMsg(
  requestId: number,
  frame: number,
  mode: RenderMode,
  sources: StreamingCompositeSourceEntry[],
): RenderFrameMessage {
  return { type: 'renderFrame', requestId, frame, mode, sources }
}

async function setup(h: Harness, doc: TimelineDoc, assetIds: string[]): Promise<void> {
  await h.core.handleMessage(initMsg(h))
  await h.core.handleMessage(docMsg(doc))
  for (const assetId of assetIds) await h.core.handleMessage(cfgMsg(assetId))
}

async function setupStreaming(
  h: Harness,
  doc: TimelineDoc,
  assetsToOpen: Array<[string, FakeVideoSource]>,
): Promise<void> {
  await h.core.handleMessage(initMsg(h))
  await h.core.handleMessage(docMsg(doc))
  for (const [assetId, source] of assetsToOpen) {
    h.sourcesToOpen.push(source)
    await h.core.handleMessage(openMsg(assetId))
  }
}

const microtasks = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function doneFor(h: Harness, requestId: number) {
  const replies = h.posts.filter(
    (p) => p.type === 'compositeDone' && p.requestId === requestId,
  )
  expect(replies).toHaveLength(1) // exactly one reply per composite
  return replies[0] as Extract<FromRenderWorker, { type: 'compositeDone' }>
}

/** Two stacked one-clip tracks on assets A (bottom) and B (top). */
const twoTrackDoc = () =>
  makeDoc([
    makeTrack('V1', [makeClip('a', 'A', 0, 10)]),
    makeTrack('V2', [makeClip('b', 'B', 0, 10)]),
  ])

/* ------------------------------------------------------------------ */
/* Happy path                                                           */
/* ------------------------------------------------------------------ */

describe('composite happy path', () => {
  test('two assets decode in their own decoders, draw bottom-to-top, blit once', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A', 'B'])
    expect(h.posts.filter((p) => p.type === 'assetConfigured')).toHaveLength(2)
    // Canvases adopted the doc size.
    expect(h.visible.raw).toEqual({ width: 320, height: 180 })
    expect(h.scratch()?.raw).toEqual({ width: 320, height: 180 })

    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['a', 'b'],
      missingClipIds: [],
    })

    // One decoder per asset, each fed its own batch.
    expect(h.decoders).toHaveLength(2)
    expect(h.decoders[0].decoded).toHaveLength(5)
    expect(h.decoders[1].decoded).toHaveLength(5)

    // Compositing happened on the SCRATCH surface, newest-frame blit on the
    // visible one — and strictly after the clips were drawn.
    const draws = h.scratchDraws()
    expect(draws).toHaveLength(2)
    expect((draws[0].args[0] as TrackedBitmap).sourceTimestamp).toBe(2 * FRAME_US)
    expect((draws[1].args[0] as TrackedBitmap).sourceTimestamp).toBe(2 * FRAME_US)
    const blits = h.blits()
    expect(blits).toHaveLength(1)
    expect(blits[0].args[0]).toBe(h.scratch()?.canvas) // scratch → visible
    expect(h.ops.indexOf(blits[0])).toBeGreaterThan(h.ops.indexOf(draws[1]))

    // Every VideoFrame closed; pixels live on as cached bitmaps.
    expect(h.frames).toHaveLength(10)
    expect(h.frames.every((f) => f.closed)).toBe(true)
    expect(h.bitmaps.filter((b) => !b.closed)).toHaveLength(10)

    // close() proves the caches (and returned loans) own every bitmap.
    await h.core.handleMessage({ type: 'close' })
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)
  })

  test('a repeat composite is served from the caches: zero new decodes', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A', 'B'])
    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )

    // Same frame again — this time WITHOUT chunks (bridge cold-path spare).
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2), entry('B', 2)]))

    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a', 'b'] })
    expect(h.decoders[0].decoded).toHaveLength(5) // unchanged
    expect(h.decoders[1].decoded).toHaveLength(5)
    expect(h.blits()).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ */
/* Latest-wins + double buffering                                       */
/* ------------------------------------------------------------------ */

describe('supersession', () => {
  test('a newer composite supersedes a parked one; only the newest blits', async () => {
    const h = makeHarness() // no autoDrain: request 1 parks on backpressure
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])]), ['A'])

    const first = h.core.handleMessage(compMsg(1, 11, [entry('A', 11, gop(0, 12))]))
    await microtasks()
    expect(h.decoders[0].decoded).toHaveLength(8) // parked at the high-water mark

    const second = h.core.handleMessage(compMsg(2, 5, [entry('A', 5, gop(4, 3))]))
    await Promise.all([first, second])

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a'] })

    // Request 1 never reached the visible canvas.
    expect(h.blits()).toHaveLength(1)
    // Fed: 8 of request 1's chunks, then (after a reset) request 2's 3.
    expect(h.decoders[0].decoded.map((c) => c.timestampUs)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => i * FRAME_US),
      4 * FRAME_US,
      5 * FRAME_US,
      6 * FRAME_US,
    ])
    await microtasks()
    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('setDoc supersedes an in-flight composite (it rendered a stale doc)', async () => {
    const h = makeHarness()
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setup(h, doc, ['A'])

    const inflight = h.core.handleMessage(compMsg(1, 11, [entry('A', 11, gop(0, 12))]))
    await microtasks()
    await h.core.handleMessage(docMsg(doc))
    await inflight

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(h.blits()).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Loans + per-asset serialization (the PiP case)                       */
/* ------------------------------------------------------------------ */

describe('same-asset entries in one composite', () => {
  test('batches run sequentially; the first bitmap survives the second batch flooding the cache', async () => {
    const h = makeHarness({ autoDrain: true })
    // Two clips of the SAME asset at different source offsets (PiP).
    const doc = makeDoc([
      makeTrack('V1', [makeClip('x', 'A', 0, 10, 0)]),
      makeTrack('V2', [makeClip('y', 'A', 0, 10, 20)]),
    ])
    await setup(h, doc, ['A'])

    // Frame 0 → x needs source frame 0, y needs source frame 20.
    // y's 13-chunk batch overflows the 12-slot cache — without the loan,
    // x's bitmap would be evicted+closed mid-composite and drawImage would
    // throw (the fake models that).
    await h.core.handleMessage(
      compMsg(1, 0, [entry('A', 0, gop(0, 2)), entry('A', 20, gop(8, 13))]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['x', 'y'],
      missingClipIds: [],
    })
    // One decoder; strictly sequential batches (x's fully before y's).
    expect(h.decoders).toHaveLength(1)
    expect(h.decoders[0].decoded.map((c) => c.timestampUs)).toEqual([
      0,
      FRAME_US,
      ...Array.from({ length: 13 }, (_, i) => (8 + i) * FRAME_US),
    ])
    const drawnTs = h.scratchDraws().map((op) => (op.args[0] as TrackedBitmap).sourceTimestamp)
    expect(drawnTs).toEqual([0, 20 * FRAME_US])

    // The loan went back into the cache: repeating frame 0 with NO chunks
    // still draws x from cache (no new decodes for source frame 0).
    const fedBefore = h.decoders[0].decoded.length
    await h.core.handleMessage(
      compMsg(2, 0, [entry('A', 0), entry('A', 20)]),
    )
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['x', 'y'] })
    expect(h.decoders[0].decoded).toHaveLength(fedBefore)

    // Teardown still owns every bitmap exactly once.
    await h.core.handleMessage({ type: 'close' })
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Failure containment                                                  */
/* ------------------------------------------------------------------ */

describe('failure containment', () => {
  test('one missing shared transition key reports both render layers', async () => {
    const from = makeClip('from', 'A', 0, 1)
    const to = makeClip('to', 'A', 1, 1)
    const track = {
      ...makeTrack('V1', [from, to]),
      transitions: [{
        id: 'dissolve',
        type: 'crossfade' as const,
        fromClipId: from.id,
        toClipId: to.id,
        durationFrames: 1,
      }],
    }
    const h = makeHarness()
    await setup(h, makeDoc([track]), [])

    await h.core.handleMessage(compMsg(1, 1, []))

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['from', 'to'],
    })
    expect(h.decoders).toHaveLength(0)
  })

  test('an unconfigured asset turns into missingClipIds, not an error', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A']) // B never configured
    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )
    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: ['b'],
    })
  })

  test('cold cache + empty chunks → missing (no decode, no crash)', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 3, [entry('A', 3)]))
    expect(doneFor(h, 1)).toMatchObject({ drawnClipIds: [], missingClipIds: ['a'] })
    expect(h.decoders[0].decoded).toHaveLength(0)
  })

  test('a non-keyframe-first batch posts an error and the clip goes missing', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(
      compMsg(1, 3, [entry('A', 3, [chunkAt(2, 'delta'), chunkAt(3, 'delta')])]),
    )
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 1,
      assetId: 'A',
      message: 'composite batch must start with a keyframe chunk',
    })
    expect(doneFor(h, 1).missingClipIds).toEqual(['a'])
    expect(h.decoders[0].decoded).toHaveLength(0)
  })

  test('a decoder fault marks the asset dead: error posted, later composites just miss', async () => {
    const h = makeHarness({ errorOnUs: 2 * FRAME_US })
    await setup(h, twoTrackDoc(), ['A', 'B'])

    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )
    // Both decoders hit the poisoned timestamp — but nothing crashed and
    // the composite still completed with both clips missing.
    expect(
      h.posts.filter((p) => p.type === 'error' && p.message === 'decoder: hardware decode fault'),
    ).toHaveLength(2)
    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a', 'b'],
    })

    // Dead assets stay dead (fast-miss) until reconfigured.
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]))
    expect(doneFor(h, 2).missingClipIds).toEqual(['a', 'b'])

    await microtasks()
    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('composite before init/setDoc posts an error tied to the request', async () => {
    const h = makeHarness()
    await h.core.handleMessage(compMsg(9, 0, []))
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 9,
      message: 'composite before init/setDoc',
    })
  })

  test('an unsupported codec posts an error and the asset never exists', async () => {
    const h = makeHarness({ supported: false })
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    expect(h.posts[0]).toMatchObject({ type: 'error', assetId: 'A' })
    expect(h.decoders).toHaveLength(0)

    await h.core.handleMessage(compMsg(1, 3, [entry('A', 3, gop(0, 5))]))
    expect(doneFor(h, 1).missingClipIds).toEqual(['a'])
  })
})

/* ------------------------------------------------------------------ */
/* Asset lifecycle                                                      */
/* ------------------------------------------------------------------ */

describe('asset lifecycle', () => {
  test('re-configuring an asset closes the old decoder and its cached bitmaps', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 2, [entry('A', 2, gop(0, 5))]))
    expect(h.bitmaps.filter((b) => !b.closed)).toHaveLength(5)

    await h.core.handleMessage(cfgMsg('A'))

    expect(h.decoders[0].isClosed).toBe(true)
    expect(h.bitmaps.every((b) => b.closed)).toBe(true) // old stream released
    expect(h.decoders).toHaveLength(2)

    // The fresh decoder serves the same frame again (cache was cleared).
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5))]))
    expect(doneFor(h, 2).drawnClipIds).toEqual(['a'])
    expect(h.decoders[1].decoded).toHaveLength(5)
  })

  test('releaseAsset frees everything; later composites miss cleanly', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 2, [entry('A', 2, gop(0, 5))]))

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })

    expect(h.decoders[0].isClosed).toBe(true)
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)

    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5))]))
    expect(doneFor(h, 2).missingClipIds).toEqual(['a'])
  })
})

/* ------------------------------------------------------------------ */
/* Blob-backed streaming render path                                   */
/* ------------------------------------------------------------------ */

describe('streaming playback lanes', () => {
  test('a newer presentation reuses the clip cursor and keeps one-frame lookahead', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const cursor = new FakeStreamCursor([streamDecoded(h, 0)], true)
    source.queuePlayback(cursor)
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setupStreaming(h, doc, [['A', source]])

    const first = h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )
    await microtasks()
    expect(cursor.nextCount).toBe(2) // current decoded; lookahead is parked

    const second = h.core.handleMessage(
      renderMsg(2, 1, 'playback', [streamEntry('a', 'A', 1, 250_000)]),
    )
    await microtasks()
    expect(cursor.closeCount).toBe(0) // presentation supersession kept the lane

    cursor.push(streamDecoded(h, FRAME_US))
    cursor.push(streamDecoded(h, 150_000))
    cursor.push(streamDecoded(h, 2 * FRAME_US))
    cursor.push(streamDecoded(h, 3 * FRAME_US))
    await Promise.all([first, second])

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
    })
    expect(source.playbackOptions).toEqual([{ startTimestampUs: 0 }])
    expect(h.blits()).toHaveLength(1)
    expect(h.streamingFrames.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 1, 1])
    expect(h.normalizations.map((frame) => frame.timestampUs)).toEqual([
      0,
      FRAME_US,
      2 * FRAME_US,
      3 * FRAME_US,
    ])

    const byTimestamp = new Map(
      h.streamingBitmaps.map((bitmap) => [bitmap.sourceTimestamp, bitmap]),
    )
    expect(byTimestamp.get(0)).toMatchObject({ closed: true, closeCount: 1 })
    expect(byTimestamp.get(FRAME_US)).toMatchObject({ closed: true, closeCount: 1 })
    expect(byTimestamp.has(150_000)).toBe(false)
    expect(byTimestamp.get(2 * FRAME_US)).toMatchObject({ closed: false, closeCount: 0 })
    expect(byTimestamp.get(3 * FRAME_US)).toMatchObject({ closed: false, closeCount: 0 })

    await h.core.handleMessage({ type: 'close' })
    expect(cursor.closeCount).toBe(1)
    expect(source.closeCount).toBe(1)
    expect(h.streamingBitmaps.every((bitmap) => bitmap.closeCount === 1)).toBe(true)
  })

  test('two clips showing one asset keep independent playback lanes', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ]))
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 20 * FRAME_US),
      streamDecoded(h, 21 * FRAME_US),
    ]))
    const doc = makeDoc([
      makeTrack('V1', [makeClip('x', 'A', 0, 10, 0)]),
      makeTrack('V2', [makeClip('y', 'A', 0, 10, 20)]),
    ])
    await setupStreaming(h, doc, [['A', source]])

    await h.core.handleMessage(renderMsg(1, 0, 'playback', [
      streamEntry('x', 'A', 0),
      streamEntry('y', 'A', 20),
    ]))

    expect(doneFor(h, 1)).toMatchObject({
      drawnClipIds: ['x', 'y'],
      missingClipIds: [],
    })
    expect(source.playbackOptions).toEqual([
      { startTimestampUs: 0 },
      { startTimestampUs: 20 * FRAME_US },
    ])
    expect(h.scratchDraws().map(
      (op) => (op.args[0] as TrackedBitmap).sourceTimestamp,
    )).toEqual([0, 20 * FRAME_US])

    await h.core.handleMessage({ type: 'close' })
    expect(source.playbackCursors.map((cursor) => cursor.closeCount)).toEqual([1, 1])
    expect(h.streamingFrames.every((frame) => frame.closeCount === 1)).toBe(true)
    expect(h.streamingBitmaps.every((bitmap) => bitmap.closeCount === 1)).toBe(true)
  })

  test('a missing same-frame clip entry cannot consume another clip\'s lane', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ]))
    const doc = makeDoc([
      makeTrack('V1', [makeClip('x', 'A', 0, 10, 0)]),
      makeTrack('V2', [makeClip('y', 'A', 0, 10, 0)]),
    ])
    await setupStreaming(h, doc, [['A', source]])

    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('y', 'A', 0)]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      drawnClipIds: ['y'],
      missingClipIds: ['x'],
    })
    expect(source.playbackOptions).toEqual([{ startTimestampUs: 0 }])
  })

  test('two valid same-frame entries still open two clip-keyed cursors', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ]))
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ]))
    const doc = makeDoc([
      makeTrack('V1', [makeClip('x', 'A', 0, 10, 0)]),
      makeTrack('V2', [makeClip('y', 'A', 0, 10, 0)]),
    ])
    await setupStreaming(h, doc, [['A', source]])

    await h.core.handleMessage(renderMsg(1, 0, 'playback', [
      streamEntry('x', 'A', 0),
      streamEntry('y', 'A', 0),
    ]))

    expect(doneFor(h, 1)).toMatchObject({
      drawnClipIds: ['x', 'y'],
      missingClipIds: [],
    })
    expect(source.playbackOptions).toEqual([
      { startTimestampUs: 0 },
      { startTimestampUs: 0 },
    ])
    expect(h.scratchDraws()).toHaveLength(2)
  })

  test('a cut closes the parked old clip lane before the new clip renders', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const oldCursor = new FakeStreamCursor([streamDecoded(h, 0)], true)
    const newCursor = new FakeStreamCursor([
      streamDecoded(h, 10 * FRAME_US),
      streamDecoded(h, 11 * FRAME_US),
    ])
    source.queuePlayback(oldCursor)
    source.queuePlayback(newCursor)
    const doc = makeDoc([makeTrack('V1', [
      makeClip('old', 'A', 0, 1, 0),
      makeClip('new', 'A', 1, 10, 10),
    ])])
    await setupStreaming(h, doc, [['A', source]])

    const oldRender = h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('old', 'A', 0)]),
    )
    await microtasks()
    expect(oldCursor.nextCount).toBe(2)

    const newRender = h.core.handleMessage(
      renderMsg(2, 1, 'playback', [streamEntry('new', 'A', 10)]),
    )
    expect(oldCursor.closeCount).toBe(1)
    await Promise.all([oldRender, newRender])

    expect(oldCursor.closeCount).toBe(1)
    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['new'] })
    expect(source.playbackOptions).toEqual([
      { startTimestampUs: 0 },
      { startTimestampUs: 10 * FRAME_US },
    ])
  })

  test('removing one active layer does not invalidate another layer\'s lane', async () => {
    const h = makeHarness()
    const sourceA = new FakeVideoSource()
    const sourceB = new FakeVideoSource()
    const cursorA = new FakeStreamCursor([streamDecoded(h, 0)], true)
    const cursorB = new FakeStreamCursor([streamDecoded(h, 0)], true)
    sourceA.queuePlayback(cursorA)
    sourceB.queuePlayback(cursorB)
    await setupStreaming(h, twoTrackDoc(), [['A', sourceA], ['B', sourceB]])

    const first = h.core.handleMessage(renderMsg(1, 0, 'playback', [
      streamEntry('a', 'A', 0),
      streamEntry('b', 'B', 0),
    ]))
    await microtasks()

    const second = h.core.handleMessage(
      renderMsg(2, 1, 'playback', [streamEntry('a', 'A', 1)]),
    )
    expect(cursorA.closeCount).toBe(0)
    expect(cursorB.closeCount).toBe(1)
    cursorA.push(streamDecoded(h, FRAME_US))
    cursorA.push(streamDecoded(h, 2 * FRAME_US))
    await Promise.all([first, second])

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({
      drawnClipIds: ['a'],
      missingClipIds: ['b'],
    })
    expect(sourceA.playbackOptions).toHaveLength(1)
  })

  test('document updates preserve compatible lanes and prune removed clips', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const cursor = new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
      streamDecoded(h, 2 * FRAME_US),
    ])
    source.queuePlayback(cursor)
    const firstDoc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setupStreaming(h, firstDoc, [['A', source]])
    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )

    const transformed = makeClip('a', 'A', 0, 20)
    transformed.transform.x = 42
    await h.core.handleMessage(docMsg(makeDoc([makeTrack('V1', [transformed])])))
    expect(cursor.closeCount).toBe(0)
    await h.core.handleMessage(
      renderMsg(2, 1, 'playback', [streamEntry('a', 'A', 1)]),
    )
    expect(source.playbackOptions).toHaveLength(1)

    await h.core.handleMessage(docMsg(makeDoc([])))
    expect(cursor.closeCount).toBe(1)
    expect(h.streamingBitmaps.every((bitmap) => bitmap.closeCount === 1)).toBe(true)
    expect(source.closeCount).toBe(0) // setDoc prunes lanes, not the shared source

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })
    expect(source.closeCount).toBe(1)
  })
})

describe('streaming seek lanes', () => {
  test('seek arrival cancels a parked playback lane before entering the render queue', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const playbackCursor = new FakeStreamCursor([streamDecoded(h, 0)], true)
    source.queuePlayback(playbackCursor)
    source.queueSeek(new FakeStreamCursor([streamDecoded(h, FRAME_US)]))
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setupStreaming(h, doc, [['A', source]])

    const playback = h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )
    await microtasks()
    expect(playbackCursor.nextCount).toBe(2)

    const seek = h.core.handleMessage(
      renderMsg(2, 1, 'seek', [streamEntry('a', 'A', 1)]),
    )
    expect(playbackCursor.closeCount).toBe(1)
    await Promise.all([playback, seek])

    expect(playbackCursor.closeCount).toBe(1)
    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a'] })
    expect(source.seekTargets).toEqual([FRAME_US])
  })

  test('a newer seek cancels the parked one-shot cursor and is the only frame presented', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const firstCursor = new FakeStreamCursor([], true)
    const secondCursor = new FakeStreamCursor([streamDecoded(h, FRAME_US)])
    source.queueSeek(firstCursor)
    source.queueSeek(secondCursor)
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setupStreaming(h, doc, [['A', source]])

    const first = h.core.handleMessage(
      renderMsg(1, 0, 'seek', [streamEntry('a', 'A', 0)]),
    )
    await microtasks()
    expect(firstCursor.nextCount).toBe(1)

    const second = h.core.handleMessage(
      renderMsg(2, 1, 'seek', [streamEntry('a', 'A', 1)]),
    )
    await Promise.all([first, second])

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a'] })
    expect(firstCursor.closeCount).toBe(1)
    expect(secondCursor.closeCount).toBe(1)
    expect(source.seekTargets).toEqual([0, FRAME_US])
    expect(h.blits()).toHaveLength(1)
    expect(h.streamingFrames[0].closeCount).toBe(1)
    expect(h.streamingBitmaps[0]).toMatchObject({ closed: true, closeCount: 1 })
  })

  test('seek invalidates playback; the next play opens a fresh cursor', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    const firstPlayback = new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ])
    const secondPlayback = new FakeStreamCursor([
      streamDecoded(h, 2 * FRAME_US),
      streamDecoded(h, 3 * FRAME_US),
    ])
    source.queuePlayback(firstPlayback)
    source.queuePlayback(secondPlayback)
    source.queueSeek(new FakeStreamCursor([streamDecoded(h, FRAME_US)]))
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setupStreaming(h, doc, [['A', source]])

    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )
    await h.core.handleMessage(
      renderMsg(2, 1, 'seek', [streamEntry('a', 'A', 1)]),
    )
    expect(firstPlayback.closeCount).toBe(1)

    await h.core.handleMessage(
      renderMsg(3, 2, 'playback', [streamEntry('a', 'A', 2)]),
    )
    expect(source.playbackOptions).toEqual([
      { startTimestampUs: 0 },
      { startTimestampUs: 2 * FRAME_US },
    ])
    expect(doneFor(h, 3)).toMatchObject({ status: 'drawn', drawnClipIds: ['a'] })
  })

  test('revision bookkeeping retires with completed assets and playback lanes', async () => {
    const h = makeHarness()
    const source = new FakeVideoSource()
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ]))
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])])
    await setupStreaming(h, doc, [['A', source]])

    expect(h.core.revisionEntryCounts()).toEqual({
      assets: 0,
      playbackLanes: 0,
    })

    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )
    expect(h.core.revisionEntryCounts()).toEqual({
      assets: 0,
      playbackLanes: 1,
    })

    await h.core.handleMessage(renderMsg(2, 0, 'seek', []))
    expect(h.core.revisionEntryCounts()).toEqual({
      assets: 0,
      playbackLanes: 0,
    })

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })
    expect(h.core.revisionEntryCounts()).toEqual({
      assets: 0,
      playbackLanes: 0,
    })
  })
})

describe('streaming response contract', () => {
  test('renderFrame before init/setDoc posts one request-fatal error and no done', async () => {
    const h = makeHarness()
    await h.core.handleMessage(renderMsg(9, 0, 'seek', []))

    expect(h.posts).toEqual([{
      type: 'error',
      requestId: 9,
      message: 'renderFrame before init/setDoc',
    }])
  })

  test('an unopened streaming asset is an ordinary missing clip', async () => {
    const h = makeHarness()
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])])
    await h.core.handleMessage(initMsg(h))
    await h.core.handleMessage(docMsg(doc))

    await h.core.handleMessage(
      renderMsg(1, 0, 'seek', [streamEntry('a', 'A', 0)]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
    })
    expect(h.posts.filter((post) => post.type === 'error')).toHaveLength(0)
  })
})

describe('streaming frame ownership', () => {
  test('only the newest deferred open installs; the stale source closes silently', async () => {
    const gate = deferredVoid()
    const h = makeHarness({ openSourceGate: gate.promise })
    await h.core.handleMessage(initMsg(h))
    await h.core.handleMessage(docMsg(makeDoc([])))
    const staleSource = new FakeVideoSource()
    const winningSource = new FakeVideoSource()
    h.sourcesToOpen.push(staleSource, winningSource)

    const staleOpen = h.core.handleMessage(openMsg('A', new Blob(['stale'])))
    await microtasks()
    const winningOpen = h.core.handleMessage(openMsg('A', new Blob(['winning'])))
    await microtasks()
    gate.resolve()
    await Promise.all([staleOpen, winningOpen])

    expect(staleSource.closeCount).toBe(1)
    expect(winningSource.closeCount).toBe(0)
    expect(h.posts.filter((post) => post.type === 'assetConfigured')).toEqual([
      { type: 'assetConfigured', assetId: 'A' },
    ])
    expect(h.posts.filter((post) => post.type === 'error')).toHaveLength(0)

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })
    expect(winningSource.closeCount).toBe(1)
  })

  test('release waits for an in-progress bitmap copy and closes its late result', async () => {
    const gate = deferredVoid()
    const h = makeHarness({ streamBitmapGate: gate.promise })
    const source = new FakeVideoSource()
    const cursor = new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ])
    source.queuePlayback(cursor)
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])])
    await setupStreaming(h, doc, [['A', source]])

    const render = h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )
    await microtasks()
    let released = false
    const release = h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })
      .then(() => {
        released = true
      })
    await microtasks()
    expect(released).toBe(false)

    gate.resolve()
    await Promise.all([render, release])

    expect(released).toBe(true)
    expect(doneFor(h, 1).status).toBe('superseded')
    expect(source.closeCount).toBe(1)
    expect(cursor.closeCount).toBe(1)
    expect(h.streamingFrames.map((frame) => frame.closeCount)).toEqual([1, 1])
    expect(h.streamingBitmaps).toHaveLength(1)
    expect(h.streamingBitmaps[0].closeCount).toBe(1)
  })

  test('asset replacement closes the old source, cursor, and owned bitmaps exactly once', async () => {
    const h = makeHarness()
    const firstSource = new FakeVideoSource()
    const firstCursor = new FakeStreamCursor([
      streamDecoded(h, 0),
      streamDecoded(h, FRAME_US),
    ])
    firstSource.queuePlayback(firstCursor)
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])])
    await setupStreaming(h, doc, [['A', firstSource]])
    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )

    const replacement = new FakeVideoSource()
    h.sourcesToOpen.push(replacement)
    await h.core.handleMessage(openMsg('A', new Blob(['replacement'])))

    expect(firstSource.closeCount).toBe(1)
    expect(firstCursor.closeCount).toBe(1)
    expect(h.streamingBitmaps.every((bitmap) => bitmap.closeCount === 1)).toBe(true)
    expect(h.posts.filter((post) => post.type === 'assetConfigured')).toHaveLength(2)

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })
    expect(replacement.closeCount).toBe(1)
    expect(firstSource.closeCount).toBe(1)
  })

  test('the real normalizer bakes clockwise 90 and 270 degree rotation', async () => {
    const canvases: Array<{
      width: number
      height: number
      ops: Array<{ name: string; args: unknown[] }>
    }> = []
    vi.stubGlobal('OffscreenCanvas', class {
      width: number
      height: number
      private readonly ops: Array<{ name: string; args: unknown[] }> = []

      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        canvases.push({ width, height, ops: this.ops })
      }

      getContext() {
        return {
          save: () => this.ops.push({ name: 'save', args: [] }),
          restore: () => this.ops.push({ name: 'restore', args: [] }),
          translate: (...args: unknown[]) => this.ops.push({ name: 'translate', args }),
          rotate: (...args: unknown[]) => this.ops.push({ name: 'rotate', args }),
          drawImage: (...args: unknown[]) => this.ops.push({ name: 'drawImage', args }),
        }
      }

      transferToImageBitmap() {
        return { width: this.width, height: this.height, close: () => undefined }
      }
    })

    try {
      const rawFrames: TrackedStreamingFrame[] = []
      for (const rotation of [90, 270] as const) {
        const raw: TrackedStreamingFrame = {
          closeCount: 0,
          close() {
            raw.closeCount++
          },
        }
        rawFrames.push(raw)
        const bitmap = await createOrientedStreamingBitmap({
          timestampUs: 0,
          durationUs: FRAME_US,
          rotation,
          displayWidth: 180,
          displayHeight: 320,
          frame: raw,
        })
        expect(bitmap).toMatchObject({ width: 180, height: 320 })
      }

      expect(canvases[0].ops).toEqual([
        { name: 'save', args: [] },
        { name: 'translate', args: [180, 0] },
        { name: 'rotate', args: [Math.PI / 2] },
        { name: 'drawImage', args: [rawFrames[0], 0, 0, 320, 180] },
        { name: 'restore', args: [] },
      ])
      expect(canvases[1].ops).toEqual([
        { name: 'save', args: [] },
        { name: 'translate', args: [0, 320] },
        { name: 'rotate', args: [-Math.PI / 2] },
        { name: 'drawImage', args: [rawFrames[1], 0, 0, 320, 180] },
        { name: 'restore', args: [] },
      ])
      expect(rawFrames.map((frame) => frame.closeCount)).toEqual([0, 0])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('rotation metadata reaches normalization and raw frames close when copying fails', async () => {
    const h = makeHarness({ streamBitmapErrorOnUs: 0 })
    const source = new FakeVideoSource()
    source.queuePlayback(new FakeStreamCursor([
      streamDecoded(h, 0, 90, 180, 320),
      streamDecoded(h, FRAME_US),
    ]))
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])])
    await setupStreaming(h, doc, [['A', source]])

    await h.core.handleMessage(
      renderMsg(1, 0, 'playback', [streamEntry('a', 'A', 0)]),
    )

    expect(h.normalizations).toEqual([{
      timestampUs: 0,
      durationUs: FRAME_US,
      rotation: 90,
      displayWidth: 180,
      displayHeight: 320,
    }])
    expect(h.streamingFrames.map((frame) => frame.closeCount)).toEqual([1, 1])
    expect(h.streamingBitmaps).toHaveLength(0)
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 1,
      assetId: 'A',
      message: 'streaming playback failed: streaming bitmap copy failed',
    })
    expect(doneFor(h, 1).missingClipIds).toEqual(['a'])
  })
})
