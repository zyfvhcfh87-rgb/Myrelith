/**
 * engine/render-bridge.test.ts — Phase 4.1c.
 *
 * Drives RenderWorkerBridge with a fake worker + fake chunk providers and
 * asserts the bridge-side contracts:
 *   1. entry building mirrors the compositor's skip rules, dedupes, and
 *      does all µs math per asset (doc→asset rescale, target/tolerance);
 *   2. latest-wins: a newer renderFrame supersedes older in-flight calls,
 *      both mid-chunk-fetch (never posted) and post-post (settled early);
 *   3. reply routing: compositeDone settles its request; error messages
 *      reject configures / settle composites / reach onWorkerError
 *      depending on their shape (see render-protocol).
 */

import { describe, expect, test, vi } from 'vitest'
import type { Clip, FrameRate, TimelineDoc, Track } from '../domain/schema'
import type { ChunkPayload } from '../workers/decode-protocol'
import type { FromRenderWorker, ToRenderWorker } from '../workers/render-protocol'
import { RenderAssetOpenError, RenderWorkerBridge } from './render-bridge'
import type { ChunkProvider, WorkerLike } from './worker-bridge'

/* ------------------------------------------------------------------ */
/* Fakes & builders                                                     */
/* ------------------------------------------------------------------ */

const R30: FrameRate = { num: 30, den: 1 }
const R60: FrameRate = { num: 60, den: 1 }
const R_NTSC: FrameRate = { num: 30_000, den: 1_001 }

class FakeWorker implements WorkerLike {
  posted: Array<{ msg: ToRenderWorker; transfer: Transferable[] }> = []
  terminated = false
  private listener: ((event: MessageEvent) => void) | null = null

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push({ msg: message as ToRenderWorker, transfer })
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener
  }
  terminate(): void {
    this.terminated = true
  }
  emit(msg: FromRenderWorker): void {
    this.listener?.({ data: msg } as MessageEvent)
  }
  composites(): Array<Extract<ToRenderWorker, { type: 'composite' }>> {
    return this.posted
      .map((p) => p.msg)
      .filter((m): m is Extract<ToRenderWorker, { type: 'composite' }> => m.type === 'composite')
  }
  renderFrames(): Array<Extract<ToRenderWorker, { type: 'renderFrame' }>> {
    return this.posted
      .map((p) => p.msg)
      .filter((m): m is Extract<ToRenderWorker, { type: 'renderFrame' }> => m.type === 'renderFrame')
  }
  openAssets(): Array<Extract<ToRenderWorker, { type: 'openAsset' }>> {
    return this.posted
      .map((p) => p.msg)
      .filter((m): m is Extract<ToRenderWorker, { type: 'openAsset' }> => m.type === 'openAsset')
  }
}

function chunk(tag: number): ChunkPayload {
  return { type: 'key', timestampUs: tag, durationUs: 1, data: new ArrayBuffer(4) }
}

interface RecordedCall {
  targetSec: number
  toleranceSec: number
}

function makeProvider(chunks: ChunkPayload[] = [chunk(1)]) {
  const calls: RecordedCall[] = []
  const provider: ChunkProvider = {
    chunksForTimestamp: async (targetSec, toleranceSec) => {
      calls.push({ targetSec, toleranceSec })
      return chunks
    },
  }
  return { provider, calls }
}

function makeClip(id: string, assetId: string, tlStart: number, duration: number, sourceStart = 0, overrides: Partial<Clip> = {}): Clip {
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
    ...overrides,
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false, ...overrides }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: R30,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
  }
}

/** Bridge with a doc set and its worker exposed. */
function makeBridge(doc?: TimelineDoc) {
  const worker = new FakeWorker()
  const bridge = new RenderWorkerBridge(worker)
  if (doc) bridge.setDoc(doc)
  return { worker, bridge }
}

/** configureAsset + immediately ack it from the fake worker. */
function configureAcked(
  ctx: { worker: FakeWorker; bridge: RenderWorkerBridge },
  assetId: string,
  rate: FrameRate,
  provider: ChunkProvider,
): Promise<void> {
  const done = ctx.bridge.configureAsset(assetId, { codec: 'avc1.640028' }, rate, provider)
  ctx.worker.emit({ type: 'assetConfigured', assetId })
  return done
}

/** openAsset + immediately ack it from the fake worker. */
function openAcked(
  ctx: { worker: FakeWorker; bridge: RenderWorkerBridge },
  assetId: string,
  blob: Blob,
  rate: FrameRate,
  runtimeToken: object = {},
): Promise<void> {
  const done = ctx.bridge.openAsset(assetId, blob, rate, runtimeToken)
  ctx.worker.emit({ type: 'assetConfigured', assetId })
  return done
}

/** Enough hops for provider promise → Promise.all → post continuation. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/* ------------------------------------------------------------------ */
/* Entry building                                                       */
/* ------------------------------------------------------------------ */

describe('renderFrame entry building', () => {
  test('requests both centered crossfade legs from the canonical render plan', async () => {
    const from = makeClip('from', 'A', 0, 10, 30)
    const to = makeClip('to', 'B', 10, 10, 50)
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
        }],
      }),
    ])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider([chunk(11)])
    const b = makeProvider([chunk(22)])
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)
    await configureAcked({ worker, bridge }, 'B', R60, b.provider)

    void bridge.renderFrame(10)
    await flushMicrotasks()

    expect(b.calls[0].targetSec).toBeCloseTo((50 * 2) / 60, 9)
    expect(b.calls[0].toleranceSec).toBeCloseTo(1 / 120, 9)
    expect(a.calls[0].targetSec).toBeCloseTo(39 / 30, 9)
    expect(a.calls[0].toleranceSec).toBeCloseTo(1 / 60, 9)
    expect(worker.composites()[0].sources.map((entry) => ({
      assetId: entry.assetId,
      sourceFrame: entry.sourceFrame,
    }))).toEqual([
      { assetId: 'A', sourceFrame: 39 },
      { assetId: 'B', sourceFrame: 50 },
    ])
  })

  test('dedupes identical transition source keys without suppressing either render layer', async () => {
    const from = makeClip('from', 'A', 0, 1)
    const to = makeClip('to', 'A', 1, 1)
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
        }],
      }),
    ])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    void bridge.renderFrame(1)
    await flushMicrotasks()

    expect(a.calls).toHaveLength(1)
    expect(worker.composites()[0].sources).toHaveLength(1)
    expect(worker.composites()[0].sources[0].sourceFrame).toBe(0)
  })
  test('per-asset µs math: doc frames rescale to each asset rate; buffers transfer', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)]), // 30fps asset
      makeTrack('V2', 'video', [makeClip('b', 'B', 0, 100, 30)]), // 60fps asset, trimmed
    ])
    const { worker, bridge } = makeBridge(doc)
    const chunksA = [chunk(11)]
    const chunksB = [chunk(22)]
    const a = makeProvider(chunksA)
    const b = makeProvider(chunksB)
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)
    await configureAcked({ worker, bridge }, 'B', R60, b.provider)

    const result = bridge.renderFrame(10)
    await flushMicrotasks()

    // A: source frame 10 at 30fps → 1/3 s. B: source frame 40 → asset
    // frame 80 at 60fps → 4/3 s. Tolerance = half a frame at each rate.
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].targetSec).toBeCloseTo(10 / 30, 9)
    expect(a.calls[0].toleranceSec).toBeCloseTo(1 / 60, 9)
    expect(b.calls[0].targetSec).toBeCloseTo(80 / 60, 9)
    expect(b.calls[0].toleranceSec).toBeCloseTo(1 / 120, 9)

    const composites = worker.composites()
    expect(composites).toHaveLength(1)
    expect(composites[0].frame).toBe(10)
    expect(composites[0].sources).toEqual([
      {
        assetId: 'A',
        sourceFrame: 10,
        targetTimestampUs: Math.round((10 / 30) * 1e6),
        toleranceUs: Math.round((1 / 60) * 1e6),
        chunks: chunksA,
      },
      {
        assetId: 'B',
        sourceFrame: 40,
        targetTimestampUs: Math.round((80 / 60) * 1e6),
        toleranceUs: Math.round((1 / 120) * 1e6),
        chunks: chunksB,
      },
    ])
    // Chunk buffers were transferred, not copied.
    const post = worker.posted.find((p) => p.msg.type === 'composite')
    expect(post?.transfer).toEqual([chunksA[0].data, chunksB[0].data])

    worker.emit({
      type: 'compositeDone',
      requestId: composites[0].requestId,
      status: 'drawn',
      drawnClipIds: ['a', 'b'],
      missingClipIds: [],
      renderMs: 3,
    })
    await expect(result).resolves.toEqual({
      status: 'drawn',
      drawnClipIds: ['a', 'b'],
      missingClipIds: [],
      renderMs: 3,
    })
  })

  test('mirrors the compositor skip rules and never fetches for them', async () => {
    const text = {
      content: 'hi',
      fontFamily: 'sans-serif',
      fontSizePx: 40,
      color: '#fff',
      align: 'center' as const,
      bold: false,
      italic: false,
    }
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('audio', 'A', 0, 100)]),
      makeTrack('V1', 'video', [makeClip('hidden', 'A', 0, 100)], { hidden: true }),
      makeTrack('V2', 'video', [makeClip('text', 'A', 0, 100, 0, { text })]),
      makeTrack('V3', 'video', [makeClip('invisible', 'A', 0, 100, 0, { opacity: 0 })]),
      makeTrack('V4', 'video', [makeClip('unconfigured', 'NOPE', 0, 100)]),
      makeTrack('V5', 'video', [makeClip('real', 'A', 0, 100)]),
      makeTrack('V6', 'video', [makeClip('gap', 'A', 90, 10)]), // not active at 5
    ])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    void bridge.renderFrame(5)
    await flushMicrotasks()

    expect(a.calls).toHaveLength(1) // only 'real'
    expect(worker.composites()[0].sources.map((s) => s.assetId)).toEqual(['A'])
  })

  test('dedupes identical (asset, sourceFrame) wants across tracks', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('one', 'A', 0, 100)]),
      makeTrack('V2', 'video', [makeClip('two', 'A', 0, 100)]), // same asset+offset
    ])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    void bridge.renderFrame(7)
    await flushMicrotasks()

    expect(a.calls).toHaveLength(1)
    expect(worker.composites()[0].sources).toHaveLength(1)
  })

  test('renderFrame without a doc resolves an error result and posts nothing', async () => {
    const { worker, bridge } = makeBridge()
    const result = await bridge.renderFrame(0)
    expect(result.status).toBe('error')
    expect(worker.composites()).toHaveLength(0)
  })

  test('a throwing provider degrades to an empty batch (cache may serve it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
      const { worker, bridge } = makeBridge(doc)
      const provider: ChunkProvider = {
        chunksForTimestamp: async () => {
          throw new Error('demux exploded')
        },
      }
      await configureAcked({ worker, bridge }, 'A', R30, provider)

      void bridge.renderFrame(3)
      await flushMicrotasks()

      const composites = worker.composites()
      expect(composites).toHaveLength(1)
      expect(composites[0].sources[0].chunks).toEqual([])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Blob-backed streaming path                                          */
/* ------------------------------------------------------------------ */

describe('Blob-backed streaming path', () => {
  test('openAsset structured-clones the Blob with no transferables and resolves on ready', async () => {
    const { worker, bridge } = makeBridge(makeDoc([]))
    const blob = new Blob(['video'], { type: 'video/mp4' })
    const ready: string[] = []
    bridge.onAssetReady = (assetId) => ready.push(assetId)

    const done = bridge.openAsset('A', blob, R_NTSC)

    expect(worker.openAssets()).toHaveLength(1)
    expect(worker.openAssets()[0]).toEqual({ type: 'openAsset', assetId: 'A', blob })
    expect(worker.posted.find((post) => post.msg.type === 'openAsset')?.transfer).toEqual([])

    worker.emit({ type: 'assetConfigured', assetId: 'A' })
    await expect(done).resolves.toBeUndefined()
    expect(ready).toEqual(['A'])
  })

  test('serializes same-asset setup until the pending acknowledgement arrives', async () => {
    const { worker, bridge } = makeBridge(makeDoc([]))
    const firstBlob = new Blob(['first'])
    const secondBlob = new Blob(['second'])

    const first = bridge.openAsset('A', firstBlob, R30)
    await expect(bridge.openAsset('A', secondBlob, R60)).rejects.toThrow(
      'asset A registration already pending',
    )
    expect(worker.openAssets().map((message) => message.blob)).toEqual([firstBlob])

    worker.emit({ type: 'assetConfigured', assetId: 'A' })
    await expect(first).resolves.toBeUndefined()

    const replacement = bridge.openAsset('A', secondBlob, R60)
    expect(worker.openAssets().map((message) => message.blob)).toEqual([
      firstBlob,
      secondBlob,
    ])
    worker.emit({ type: 'assetConfigured', assetId: 'A' })
    await expect(replacement).resolves.toBeUndefined()
  })

  test('keeps same-frame clips as ordered lanes and forwards exact native timestamps and mode', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('one', 'A', 0, 200)]),
      makeTrack('V2', 'video', [makeClip('two', 'A', 0, 200)]),
    ])
    const { worker, bridge } = makeBridge(doc)
    await openAcked({ worker, bridge }, 'A', new Blob(['video']), R_NTSC)

    const playback = bridge.renderFrame(100, 'playback')
    const first = worker.renderFrames()[0]

    expect(first.mode).toBe('playback')
    expect(first.sources).toEqual([
      {
        clipId: 'one',
        assetId: 'A',
        sourceFrame: 100,
        targetTimestampUs: 3_336_667,
      },
      {
        clipId: 'two',
        assetId: 'A',
        sourceFrame: 100,
        targetTimestampUs: 3_336_667,
      },
    ])
    expect(worker.posted.find((post) => post.msg === first)?.transfer).toEqual([])

    worker.emit({
      type: 'compositeDone',
      requestId: first.requestId,
      status: 'drawn',
      drawnClipIds: ['one', 'two'],
      missingClipIds: [],
      renderMs: 2,
    })
    await expect(playback).resolves.toMatchObject({ status: 'drawn' })

    const seek = bridge.renderFrame(101, 'seek')
    const second = worker.renderFrames()[1]
    expect(second.mode).toBe('seek')
    expect(worker.posted.find((post) => post.msg === second)?.transfer).toEqual([])
    worker.emit({
      type: 'compositeDone',
      requestId: second.requestId,
      status: 'drawn',
      drawnClipIds: ['one', 'two'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(seek).resolves.toMatchObject({ status: 'drawn' })
  })

  test('rejects protocol mismatches instead of drawing a partial frame', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])

    const legacy = makeBridge(doc)
    await configureAcked(legacy, 'A', R30, makeProvider().provider)
    await expect(legacy.bridge.renderFrame(1, 'playback')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringContaining('legacy render protocol'),
    })
    expect(legacy.worker.renderFrames()).toHaveLength(0)
    expect(legacy.worker.composites()).toHaveLength(0)

    const streaming = makeBridge(doc)
    await openAcked(streaming, 'A', new Blob(['video']), R30)
    await expect(streaming.bridge.renderFrame(1)).resolves.toMatchObject({
      status: 'error',
      message: expect.stringContaining('streaming render protocol'),
    })
    expect(streaming.worker.renderFrames()).toHaveLength(0)
    expect(streaming.worker.composites()).toHaveLength(0)
  })

  test('a protocol mismatch does not supersede the last valid render', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('streaming', 'A', 0, 10),
        makeClip('legacy', 'B', 10, 10),
      ]),
    ])
    const { worker, bridge } = makeBridge(doc)
    await openAcked({ worker, bridge }, 'A', new Blob(['video']), R30)
    await configureAcked({ worker, bridge }, 'B', R30, makeProvider().provider)

    const valid = bridge.renderFrame(1, 'playback')
    await expect(bridge.renderFrame(10, 'playback')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringContaining('legacy render protocol'),
    })
    expect(worker.renderFrames()).toHaveLength(1)

    worker.emit({
      type: 'compositeDone',
      requestId: worker.renderFrames()[0].requestId,
      status: 'drawn',
      drawnClipIds: ['streaming'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(valid).resolves.toMatchObject({ status: 'drawn' })
  })

  test('omits truly unregistered assets while keeping registered streaming entries', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('ready', 'A', 0, 100)]),
      makeTrack('V2', 'video', [makeClip('missing', 'NOPE', 0, 100)]),
    ])
    const { worker, bridge } = makeBridge(doc)
    await openAcked({ worker, bridge }, 'A', new Blob(['video']), R30)

    const result = bridge.renderFrame(3, 'seek')
    const render = worker.renderFrames()[0]
    expect(render.sources.map((source) => source.clipId)).toEqual(['ready'])

    worker.emit({
      type: 'compositeDone',
      requestId: render.requestId,
      status: 'drawn',
      drawnClipIds: ['ready'],
      missingClipIds: ['missing'],
      renderMs: 1,
    })
    await expect(result).resolves.toMatchObject({
      status: 'drawn',
      missingClipIds: ['missing'],
    })
  })

  test('a newer streaming request supersedes the posted request immediately', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    await openAcked({ worker, bridge }, 'A', new Blob(['video']), R30)

    const first = bridge.renderFrame(1, 'playback')
    const second = bridge.renderFrame(2, 'seek')
    await expect(first).resolves.toMatchObject({ status: 'superseded' })

    const renders = worker.renderFrames()
    expect(renders.map((render) => render.mode)).toEqual(['playback', 'seek'])
    worker.emit({
      type: 'compositeDone',
      requestId: renders[0].requestId,
      status: 'superseded',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 0,
    })
    worker.emit({
      type: 'compositeDone',
      requestId: renders[1].requestId,
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(second).resolves.toMatchObject({ status: 'drawn' })
  })

  test('an open error removes the failed registration', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const opening = bridge.openAsset('A', new Blob(['bad']), R30)

    worker.emit({ type: 'error', assetId: 'A', message: 'container unsupported' })
    await expect(opening).rejects.toThrow('container unsupported')

    const result = bridge.renderFrame(1, 'seek')
    const render = worker.renderFrames()[0]
    expect(render.sources).toEqual([])
    worker.emit({
      type: 'compositeDone',
      requestId: render.requestId,
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
      renderMs: 0,
    })
    await expect(result).resolves.toMatchObject({ status: 'drawn' })
  })

  test('a typed worker source failure preserves file-level classification', async () => {
    const { worker, bridge } = makeBridge(makeDoc([]))
    const opening = bridge.openAsset('A', new Blob(['bad']), R30)

    worker.emit({
      type: 'error',
      assetId: 'A',
      mediaFailure: {
        trackKind: null,
        reason: 'resource-unavailable',
      },
      message: 'worker openAsset failed: Input construction failed',
    })

    const failure = await opening.catch((cause) => cause)
    expect(failure).toBeInstanceOf(RenderAssetOpenError)
    expect(failure).toMatchObject({
      failure: {
        trackKind: null,
        reason: 'resource-unavailable',
      },
    })
  })

  test('a stale release cleanup warning cannot reject a pending replacement', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const warnings: string[] = []
    bridge.onWorkerError = (message) => warnings.push(message)
    const opening = bridge.openAsset('A', new Blob(['replacement']), R30)

    worker.emit({
      type: 'error',
      message: 'stale release cleanup failed for asset A',
    })
    worker.emit({ type: 'assetConfigured', assetId: 'A' })

    await expect(opening).resolves.toBeUndefined()
    expect(warnings).toEqual(['stale release cleanup failed for asset A'])
    const result = bridge.renderFrame(1, 'seek')
    expect(worker.renderFrames()[0].sources.map((source) => source.assetId))
      .toEqual(['A'])
    worker.emit({
      type: 'compositeDone',
      requestId: worker.renderFrames()[0].requestId,
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(result).resolves.toMatchObject({ status: 'drawn' })
  })

  test('releaseAsset rejects a pending open and omits its source afterward', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const opening = bridge.openAsset('A', new Blob(['video']), R30)

    bridge.releaseAsset('A')
    await expect(opening).rejects.toThrow('asset released')
    expect(worker.posted.find((post) => post.msg.type === 'releaseAsset')?.transfer).toEqual([])

    const result = bridge.renderFrame(1, 'seek')
    const render = worker.renderFrames()[0]
    expect(render.sources).toEqual([])
    worker.emit({
      type: 'compositeDone',
      requestId: render.requestId,
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
      renderMs: 0,
    })
    await expect(result).resolves.toMatchObject({ status: 'drawn' })
  })
})

/* ------------------------------------------------------------------ */
/* Latest-wins                                                          */
/* ------------------------------------------------------------------ */

describe('latest-wins', () => {
  test('a call superseded mid-chunk-fetch is never posted', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)

    const pendingFetches: Array<(chunks: ChunkPayload[]) => void> = []
    const provider: ChunkProvider = {
      chunksForTimestamp: () =>
        new Promise((resolve) => pendingFetches.push(resolve)),
    }
    await configureAcked({ worker, bridge }, 'A', R30, provider)

    const first = bridge.renderFrame(1)
    await flushMicrotasks()
    const second = bridge.renderFrame(2)
    await flushMicrotasks()
    expect(pendingFetches).toHaveLength(2)

    // Resolve out of order: the SECOND call's fetch lands first and posts.
    pendingFetches[1]([chunk(2)])
    await flushMicrotasks()
    expect(worker.composites()).toHaveLength(1)
    expect(worker.composites()[0].frame).toBe(2)

    // The first call's fetch lands late: superseded, still exactly one post.
    pendingFetches[0]([chunk(1)])
    await expect(first).resolves.toMatchObject({ status: 'superseded' })
    expect(worker.composites()).toHaveLength(1)

    worker.emit({
      type: 'compositeDone',
      requestId: worker.composites()[0].requestId,
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(second).resolves.toMatchObject({ status: 'drawn' })
  })

  test('opening a streaming replacement invalidates an in-progress legacy chunk read', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const pendingFetches: Array<(chunks: ChunkPayload[]) => void> = []
    const provider: ChunkProvider = {
      chunksForTimestamp: () => new Promise((resolve) => pendingFetches.push(resolve)),
    }
    await configureAcked({ worker, bridge }, 'A', R30, provider)

    const render = bridge.renderFrame(1)
    await flushMicrotasks()
    expect(pendingFetches).toHaveLength(1)

    await openAcked({ worker, bridge }, 'A', new Blob(['video']), R30)
    pendingFetches[0]([chunk(1)])

    await expect(render).resolves.toMatchObject({ status: 'superseded' })
    expect(worker.composites()).toHaveLength(0)
  })

  test('releasing an asset invalidates an in-progress legacy chunk read', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const pendingFetches: Array<(chunks: ChunkPayload[]) => void> = []
    const provider: ChunkProvider = {
      chunksForTimestamp: () => new Promise((resolve) => pendingFetches.push(resolve)),
    }
    await configureAcked({ worker, bridge }, 'A', R30, provider)

    const render = bridge.renderFrame(1)
    await flushMicrotasks()
    bridge.releaseAsset('A')
    pendingFetches[0]([chunk(1)])

    await expect(render).resolves.toMatchObject({ status: 'superseded' })
    expect(worker.composites()).toHaveLength(0)
  })

  test('disposing during a legacy chunk read never posts after termination', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const pendingFetches: Array<(chunks: ChunkPayload[]) => void> = []
    const provider: ChunkProvider = {
      chunksForTimestamp: () => new Promise((resolve) => pendingFetches.push(resolve)),
    }
    await configureAcked({ worker, bridge }, 'A', R30, provider)

    const render = bridge.renderFrame(1)
    await flushMicrotasks()
    bridge.dispose()
    pendingFetches[0]([chunk(1)])

    await expect(render).resolves.toMatchObject({ status: 'superseded' })
    expect(worker.composites()).toHaveLength(0)
    expect(worker.posted.at(-1)).toEqual({ msg: { type: 'close' }, transfer: [] })
    expect(worker.terminated).toBe(true)
  })

  test('posting a newer composite settles older posted ones as superseded', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    const first = bridge.renderFrame(1)
    await flushMicrotasks()
    expect(worker.composites()).toHaveLength(1)

    const second = bridge.renderFrame(2)
    await expect(first).resolves.toMatchObject({ status: 'superseded' })

    await flushMicrotasks()
    const composites = worker.composites()
    expect(composites).toHaveLength(2)

    // The worker's own late 'superseded' reply for request 1 is ignored.
    worker.emit({
      type: 'compositeDone',
      requestId: composites[0].requestId,
      status: 'superseded',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 0,
    })
    worker.emit({
      type: 'compositeDone',
      requestId: composites[1].requestId,
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(second).resolves.toMatchObject({ status: 'drawn' })
  })
})

/* ------------------------------------------------------------------ */
/* Reply routing                                                        */
/* ------------------------------------------------------------------ */

describe('reply routing', () => {
  test('assetConfigured resolves configureAsset and fires onAssetReady', async () => {
    const { worker, bridge } = makeBridge(makeDoc([]))
    const ready: string[] = []
    bridge.onAssetReady = (assetId) => ready.push(assetId)

    const done = bridge.configureAsset('A', { codec: 'avc1.640028' }, R30, makeProvider().provider)
    worker.emit({ type: 'assetConfigured', assetId: 'A' })
    await expect(done).resolves.toBeUndefined()
    expect(ready).toEqual(['A'])
  })

  test('an asset error while its configure is pending rejects the configure', async () => {
    const { worker, bridge } = makeBridge(makeDoc([]))
    const done = bridge.configureAsset('A', { codec: 'nope' }, R30, makeProvider().provider)
    worker.emit({ type: 'error', assetId: 'A', message: 'codec not supported by this browser: nope' })
    await expect(done).rejects.toThrow('codec not supported')
  })

  test('a request-fatal error settles the composite as an error result', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    const result = bridge.renderFrame(1)
    await flushMicrotasks()
    const requestId = worker.composites()[0].requestId
    worker.emit({ type: 'error', requestId, message: 'composite before init/setDoc' })
    await expect(result).resolves.toMatchObject({
      status: 'error',
      message: 'composite before init/setDoc',
    })
  })

  test('asset-scoped errors during a composite reach onWorkerError; compositeDone still settles it', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const warnings: string[] = []
    bridge.onWorkerError = (m) => warnings.push(m)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    const result = bridge.renderFrame(1)
    await flushMicrotasks()
    const requestId = worker.composites()[0].requestId

    worker.emit({ type: 'error', requestId, assetId: 'A', message: 'decode failed: boom' })
    worker.emit({
      type: 'compositeDone',
      requestId,
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
      renderMs: 2,
    })

    await expect(result).resolves.toMatchObject({ status: 'drawn', missingClipIds: ['a'] })
    expect(warnings).toEqual(['decode failed: boom'])
  })

  test('a streaming request error carries the exact source open token', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const runtimeToken = { generation: 'source-A' }
    await openAcked(
      { worker, bridge },
      'A',
      new Blob(['video']),
      R30,
      runtimeToken,
    )
    const assetFailures: Array<{
      assetId: string
      runtimeToken: object
      message: string
    }> = []
    bridge.onAssetError = (assetId, token, message) => {
      assetFailures.push({ assetId, runtimeToken: token, message })
    }

    const result = bridge.renderFrame(1, 'seek')
    const requestId = worker.renderFrames()[0].requestId
    worker.emit({
      type: 'error',
      requestId,
      assetId: 'A',
      message: 'decode failed: boom',
    })
    worker.emit({
      type: 'compositeDone',
      requestId,
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
      renderMs: 2,
    })

    await expect(result).resolves.toMatchObject({ status: 'drawn' })
    expect(assetFailures).toEqual([{
      assetId: 'A',
      runtimeToken,
      message: 'decode failed: boom',
    }])
  })

  test('an old render diagnostic cannot reject a pending asset replacement', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const oldToken = { generation: 'old' }
    const newToken = { generation: 'new' }
    await openAcked(
      { worker, bridge },
      'A',
      new Blob(['first']),
      R30,
      oldToken,
    )
    const warnings: string[] = []
    const assetFailures: object[] = []
    bridge.onWorkerError = (message) => warnings.push(message)
    bridge.onAssetError = (_assetId, token) => assetFailures.push(token)

    const oldResult = bridge.renderFrame(1, 'seek')
    const oldRequestId = worker.renderFrames()[0].requestId

    const replacement = bridge.openAsset('A', new Blob(['second']), R60, newToken)
    worker.emit({
      type: 'error',
      requestId: oldRequestId,
      assetId: 'A',
      message: 'late decode diagnostic',
    })
    worker.emit({
      type: 'compositeDone',
      requestId: oldRequestId,
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a'],
      renderMs: 1,
    })
    worker.emit({ type: 'assetConfigured', assetId: 'A' })

    await expect(oldResult).resolves.toMatchObject({ status: 'drawn' })
    await expect(replacement).resolves.toBeUndefined()
    expect(warnings).toEqual(['late decode diagnostic'])
    expect(assetFailures).toEqual([])

    const result = bridge.renderFrame(1, 'seek')
    const render = worker.renderFrames().at(-1)!
    expect(render.sources.map((source) => source.assetId)).toEqual(['A'])
    worker.emit({
      type: 'compositeDone',
      requestId: render.requestId,
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: [],
      renderMs: 1,
    })
    await expect(result).resolves.toMatchObject({ status: 'drawn' })
  })

  test('releaseAsset drops the source: later frames skip the asset', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    bridge.releaseAsset('A')
    expect(worker.posted.some((p) => p.msg.type === 'releaseAsset')).toBe(true)

    void bridge.renderFrame(1)
    await flushMicrotasks()
    expect(a.calls).toHaveLength(0)
    expect(worker.composites()[0].sources).toEqual([])
  })

  test('dispose closes the worker and settles everything in flight', async () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 'A', 0, 100)])])
    const { worker, bridge } = makeBridge(doc)
    const a = makeProvider()
    await configureAcked({ worker, bridge }, 'A', R30, a.provider)

    const inflight = bridge.renderFrame(1)
    await flushMicrotasks()
    const configuring = bridge.configureAsset('B', { codec: 'x' }, R30, a.provider)

    bridge.dispose()

    expect(worker.terminated).toBe(true)
    expect(worker.posted.at(-1)?.msg).toEqual({ type: 'close' })
    await expect(inflight).resolves.toMatchObject({ status: 'superseded' })
    await expect(configuring).rejects.toThrow('bridge disposed')
  })
})
