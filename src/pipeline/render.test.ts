/**
 * pipeline/render.test.ts — compositeFrame unit tests. Phase 4.1.
 *
 * Pure-logic layer: the 2D context and the FrameSource are recording fakes
 * (jsdom has no real canvas), asserting call ORDER and arguments — the
 * browser-truth check of actual pixels happens when the render worker
 * lands (per the plan's test strategy for pipeline/).
 */

import { describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import type { Composite2D, FrameSource } from './render'
import { compositeFrame } from './render'

/* ------------------------------------------------------------------ */
/* Builders                                                             */
/* ------------------------------------------------------------------ */

function makeClip(
  id: string,
  tlStart: number,
  duration: number,
  overrides: Partial<Clip> = {},
): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
    ...overrides,
  }
}

function makeTrack(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    ...overrides,
  }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
  }
}

/** jsdom has no ImageBitmap: a {width,height} stub is all drawing math needs. */
function fakeBitmap(width: number, height: number): ImageBitmap {
  return { width, height } as unknown as ImageBitmap
}

/* ------------------------------------------------------------------ */
/* Recording fakes                                                      */
/* ------------------------------------------------------------------ */

interface Op {
  name: string
  args: unknown[]
}

function makeCtx(opts: { throwOn?: ImageBitmap } = {}) {
  const log: Op[] = []
  let alpha = 1
  let fill: Composite2D['fillStyle'] = ''
  let depth = 0
  const ctx: Composite2D = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v) {
      alpha = v
      log.push({ name: 'alpha', args: [v] })
    },
    get fillStyle() {
      return fill
    },
    set fillStyle(v) {
      fill = v
      log.push({ name: 'fillStyle', args: [v] })
    },
    save: () => {
      depth++
      log.push({ name: 'save', args: [] })
    },
    restore: () => {
      depth--
      log.push({ name: 'restore', args: [] })
    },
    translate: (x, y) => log.push({ name: 'translate', args: [x, y] }),
    rotate: (a) => log.push({ name: 'rotate', args: [a] }),
    scale: (x, y) => log.push({ name: 'scale', args: [x, y] }),
    fillRect: (x, y, w, h) => log.push({ name: 'fillRect', args: [x, y, w, h] }),
    drawImage: (image, dx, dy) => {
      if (opts.throwOn === image) {
        throw new DOMException('bitmap was closed', 'InvalidStateError')
      }
      log.push({ name: 'drawImage', args: [image, dx, dy] })
    },
  }
  const ops = (name: string) => log.filter((op) => op.name === name)
  return { ctx, log, ops, depth: () => depth }
}

/** Frame table keyed "assetId@sourceFrame"; unknown keys resolve null. */
function makeSource(
  frames: Record<string, ImageBitmap | null | Promise<ImageBitmap | null>> = {},
) {
  const requests: string[] = []
  const source: FrameSource = {
    getFrame: (assetId, sourceFrame) => {
      const key = `${assetId}@${sourceFrame}`
      requests.push(key)
      const value = frames[key]
      return Promise.resolve(value === undefined ? null : value)
    },
  }
  return { source, requests }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe('compositeFrame — background & selection', () => {
  test('empty doc: opaque black background, nothing else', async () => {
    const { ctx, log, depth } = makeCtx()
    const { source, requests } = makeSource()
    const result = await compositeFrame(makeDoc([]), 0, ctx, source)

    expect(requests).toEqual([])
    expect(result).toEqual({ drawn: [], missing: [] })
    expect(depth()).toBe(0)
    // Alpha forced to 1 before the fill; fill covers the full composition.
    const names = log.map((op) => op.name)
    expect(names.slice(0, 4)).toEqual(['save', 'alpha', 'fillStyle', 'fillRect'])
    expect(log[1].args).toEqual([1])
    expect(log[3].args).toEqual([0, 0, 1920, 1080])
  })

  test('skips audio tracks, hidden video tracks, gaps, and text clips', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('audio-clip', 0, 100)]),
      makeTrack('V1', 'video', [makeClip('hidden-clip', 0, 100)], { hidden: true }),
      makeTrack('V2', 'video', [makeClip('later-clip', 50, 10)]), // gap at frame 5
      makeTrack('V3', 'video', [
        makeClip('text-clip', 0, 100, {
          text: {
            content: 'hi',
            fontFamily: 'sans-serif',
            fontSizePx: 40,
            color: '#fff',
            align: 'center',
            bold: false,
            italic: false,
          },
        }),
      ]),
    ])
    const { ctx, ops } = makeCtx()
    const { source, requests } = makeSource()
    const result = await compositeFrame(doc, 5, ctx, source)

    expect(requests).toEqual([]) // nothing even asked for pixels
    expect(ops('drawImage')).toHaveLength(0)
    expect(result).toEqual({ drawn: [], missing: [] })
  })

  test('active-clip boundaries are half-open at the compositor too', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 10, 20, { assetId: 'A' })]),
    ])
    const { source, requests } = makeSource()

    await compositeFrame(doc, 30, makeCtx().ctx, source) // a's exclusive end
    expect(requests).toEqual([])

    await compositeFrame(doc, 10, makeCtx().ctx, source) // inclusive start
    expect(requests).toEqual(['A@0'])
  })

  test('trimmed clip requests the offset source frame', async () => {
    // Shows source frames [30, 80) at timeline [100, 150) → frame 110 = source 40.
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('a', 100, 50, {
          assetId: 'A',
          sourceRange: { startFrame: 30, durationFrames: 50 },
        }),
      ]),
    ])
    const { source, requests } = makeSource()
    await compositeFrame(doc, 110, makeCtx().ctx, source)
    expect(requests).toEqual(['A@40'])
  })
})

describe('compositeFrame — stacking order & concurrency', () => {
  test('draws bottom-to-top even when the top frame decodes first', async () => {
    const bottomImage = fakeBitmap(100, 100)
    const topImage = fakeBitmap(50, 50)
    const bottom = deferred<ImageBitmap | null>()
    const top = deferred<ImageBitmap | null>()
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('bottom', 0, 10, { assetId: 'B' })]),
      makeTrack('V2', 'video', [makeClip('top', 0, 10, { assetId: 'T' })]),
    ])
    const { ctx, ops } = makeCtx()
    const { source, requests } = makeSource({ 'B@3': bottom.promise, 'T@3': top.promise })

    const composite = compositeFrame(doc, 3, ctx, source)
    // Both fetches were issued synchronously, before either resolved.
    expect(requests).toEqual(['B@3', 'T@3'])

    top.resolve(topImage) // top wins the decode race...
    bottom.resolve(bottomImage)
    const result = await composite

    // ...but paint order is still tracks[0] first (bottom layer).
    const draws = ops('drawImage')
    expect(draws.map((op) => op.args[0])).toEqual([bottomImage, topImage])
    expect(result).toEqual({ drawn: ['bottom', 'top'], missing: [] })
  })
})

describe('compositeFrame — transform & opacity', () => {
  test('identity transform centers the image in the composition', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 10, { assetId: 'A' })]),
    ])
    const { ctx, ops } = makeCtx()
    const { source } = makeSource({ 'A@0': fakeBitmap(1280, 720) })
    await compositeFrame(doc, 0, ctx, source)

    // Anchor (center) lands at canvas center; image top-left offsets back.
    expect(ops('translate')[0].args).toEqual([960, 540])
    expect(ops('rotate')[0].args).toEqual([0])
    expect(ops('scale')[0].args).toEqual([1, 1])
    expect(ops('drawImage')[0].args.slice(1)).toEqual([-640, -360])
  })

  test('scale→rotate→translate around a custom anchor, x/y offsets applied', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('a', 0, 10, {
          assetId: 'A',
          transform: {
            x: 10,
            y: 20,
            scaleX: 2,
            scaleY: 0.5,
            rotation: 90,
            anchorX: 0.25,
            anchorY: 1,
          },
        }),
      ]),
    ])
    const { ctx, log, ops } = makeCtx()
    const { source } = makeSource({ 'A@0': fakeBitmap(1280, 720) })
    await compositeFrame(doc, 0, ctx, source)

    // Anchor pixel (320, 720); centered default (320, 180) + anchor + offset.
    expect(ops('translate')[0].args).toEqual([650, 920])
    expect((ops('rotate')[0].args[0] as number)).toBeCloseTo(Math.PI / 2, 10)
    expect(ops('scale')[0].args).toEqual([2, 0.5])
    expect(ops('drawImage')[0].args.slice(1)).toEqual([-320, -720])
    // Canvas transforms compose right-to-left: translate before rotate
    // before scale in call order = scale applied to the image first.
    const order = log
      .map((op) => op.name)
      .filter((n) => n === 'translate' || n === 'rotate' || n === 'scale')
    expect(order).toEqual(['translate', 'rotate', 'scale'])
  })

  test('per-clip opacity is set (clamped to 1) inside save/restore', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('half', 0, 10, { assetId: 'A', opacity: 0.5 })]),
      makeTrack('V2', 'video', [makeClip('over', 0, 10, { assetId: 'B', opacity: 1.5 })]),
    ])
    const { ctx, ops, depth } = makeCtx()
    const { source } = makeSource({ 'A@0': fakeBitmap(10, 10), 'B@0': fakeBitmap(10, 10) })
    const result = await compositeFrame(doc, 0, ctx, source)

    // Alpha writes: 1 (background reset), then 0.5, then clamped 1.
    expect(ops('alpha').map((op) => op.args[0])).toEqual([1, 0.5, 1])
    expect(depth()).toBe(0) // every save matched by a restore
    expect(result.drawn).toEqual(['half', 'over'])
  })

  test('opacity <= 0 skips the clip without fetching pixels', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('invisible', 0, 10, { opacity: 0 })]),
    ])
    const { ctx, ops } = makeCtx()
    const { source, requests } = makeSource()
    const result = await compositeFrame(doc, 0, ctx, source)

    expect(requests).toEqual([])
    expect(ops('drawImage')).toHaveLength(0)
    expect(result).toEqual({ drawn: [], missing: [] })
  })
})

describe('compositeFrame — failure isolation', () => {
  test('an undecoded frame goes to missing; other tracks still draw', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('cold', 0, 10, { assetId: 'COLD' })]),
      makeTrack('V2', 'video', [makeClip('warm', 0, 10, { assetId: 'WARM' })]),
    ])
    const { ctx, ops } = makeCtx()
    const { source } = makeSource({ 'WARM@0': fakeBitmap(10, 10) }) // COLD@0 → null
    const result = await compositeFrame(doc, 0, ctx, source)

    expect(ops('drawImage')).toHaveLength(1)
    expect(result).toEqual({ drawn: ['warm'], missing: ['cold'] })
  })

  test('a rejecting source is caught, warned, and counted missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const doc = makeDoc([
        makeTrack('V1', 'video', [makeClip('bad', 0, 10, { assetId: 'BAD' })]),
        makeTrack('V2', 'video', [makeClip('good', 0, 10, { assetId: 'GOOD' })]),
      ])
      const { ctx } = makeCtx()
      const { source } = makeSource({
        'BAD@0': Promise.reject(new Error('demux exploded')),
        'GOOD@0': fakeBitmap(10, 10),
      })
      const result = await compositeFrame(doc, 0, ctx, source)

      expect(result).toEqual({ drawn: ['good'], missing: ['bad'] })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  test('a throwing drawImage (closed bitmap) cannot poison the ctx stack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dead = fakeBitmap(10, 10)
      const doc = makeDoc([
        makeTrack('V1', 'video', [makeClip('dead', 0, 10, { assetId: 'DEAD' })]),
        makeTrack('V2', 'video', [makeClip('alive', 0, 10, { assetId: 'ALIVE' })]),
      ])
      const { ctx, ops, depth } = makeCtx({ throwOn: dead })
      const { source } = makeSource({ 'DEAD@0': dead, 'ALIVE@0': fakeBitmap(10, 10) })
      const result = await compositeFrame(doc, 0, ctx, source)

      expect(result).toEqual({ drawn: ['alive'], missing: ['dead'] })
      expect(ops('drawImage')).toHaveLength(1) // only the live bitmap landed
      expect(depth()).toBe(0) // finally-restore ran despite the throw
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
