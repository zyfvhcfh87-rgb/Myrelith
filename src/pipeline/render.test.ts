/**
 * pipeline/render.test.ts — compositeFrame unit tests. Phase 4.1.
 *
 * Pure-logic layer: the 2D context and the FrameSource are recording fakes
 * (jsdom has no real canvas), asserting call ORDER and arguments — the
 * browser-truth check of actual pixels happens when the render worker
 * lands (per the plan's test strategy for pipeline/).
 */

import { describe, expect, test, vi } from 'vitest'
import type { Clip, EffectDescriptor, TimelineDoc, Track } from '../domain/schema'
import {
  resolvePresentationProfile,
  type PresentationProfile,
} from '../domain/presentationProfile'
import { defaultTextProps } from '../domain/textOverlay'
import { createColorAdjustEffect, createMaskEffect } from '../domain/effectStack'
import { videoCompositionPlanAtFrame } from '../domain/videoCompositionPlan'
import {
  createPluginVideoEffectContributionSnapshot,
  type PluginVideoEffectContributionAvailability,
  type PluginVideoEffectContributionSnapshot,
} from '../domain/pluginVideoEffectStagePlan'
import type {
  Composite2D,
  FrameSource,
  RenderFrameSource,
  TransitionSurfaceProvider,
} from './render'
import { compositeFrame as compositeFrameCore } from './render'
import type { LensRemapProvider } from './lensRemap'
import { DEFAULT_MANUAL_LENS_CORRECTION } from '../domain/lensCorrection'
import {
  VideoEffectStageExecutionError,
  type VideoEffectStageExecutor,
} from './videoEffectStageExecution'

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
    sourceMode: 'timed',
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
    schemaVersion: 14,
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

function fakeVideoFrame(
  displayWidth: number,
  displayHeight: number,
): VideoFrame {
  return { displayWidth, displayHeight } as unknown as VideoFrame
}

const PLUGIN_EFFECT_TYPE = 'plugin:com.example.render-test/channel-shift'

function pluginEffect(id = 'plugin-effect'): EffectDescriptor {
  return {
    id,
    type: PLUGIN_EFFECT_TYPE,
    version: 1,
    enabled: true,
    params: { amount: 1 },
  }
}

function pluginSnapshot(
  availability: PluginVideoEffectContributionAvailability = 'ready',
): PluginVideoEffectContributionSnapshot {
  return createPluginVideoEffectContributionSnapshot(4, [{
    signerFingerprint: `sha256:${'1'.repeat(64)}`,
    packageDigest: `sha256:${'2'.repeat(64)}`,
    pluginId: 'com.example.render-test',
    pluginVersion: '1.0.0',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId: 'channel-shift',
    contributionName: 'Channel Shift',
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_channel_shift',
    parameters: [{
      key: 'amount',
      name: 'Amount',
      kind: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.1,
      animatable: false,
    }],
    availability,
    detail: availability === 'ready' ? 'Ready.' : 'Disabled for this test.',
  }])
}

/* ------------------------------------------------------------------ */
/* Recording fakes                                                      */
/* ------------------------------------------------------------------ */

interface Op {
  name: string
  args: unknown[]
}

function makeCtx(opts: {
  throwOn?: ImageBitmap
  rejectComposite?: GlobalCompositeOperation
  supportsFilter?: boolean
  supportsPixels?: boolean
  pixelData?: Uint8ClampedArray
} = {}) {
  const log: Op[] = []
  let alpha = 1
  let operation: GlobalCompositeOperation = 'source-over'
  let fill: Composite2D['fillStyle'] = ''
  let filter = 'none'
  let depth = 0
  const stack: Array<{
    alpha: number
    operation: GlobalCompositeOperation
    fill: Composite2D['fillStyle']
    filter: string
  }> = []
  const ctx: Composite2D = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v) {
      alpha = v
      log.push({ name: 'alpha', args: [v] })
    },
    get globalCompositeOperation() {
      return operation
    },
    set globalCompositeOperation(v) {
      if (opts.rejectComposite === v) return
      operation = v
      log.push({ name: 'composite', args: [v] })
    },
    get fillStyle() {
      return fill
    },
    set fillStyle(v) {
      fill = v
      log.push({ name: 'fillStyle', args: [v] })
    },
    strokeStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    lineJoin: 'miter',
    shadowColor: '#00000000',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save: () => {
      stack.push({ alpha, operation, fill, filter })
      depth++
      log.push({ name: 'save', args: [] })
    },
    restore: () => {
      const restored = stack.pop()
      if (restored) {
        alpha = restored.alpha
        operation = restored.operation
        fill = restored.fill
        filter = restored.filter
      }
      depth--
      log.push({ name: 'restore', args: [] })
    },
    translate: (x, y) => log.push({ name: 'translate', args: [x, y] }),
    rotate: (a) => log.push({ name: 'rotate', args: [a] }),
    scale: (x, y) => log.push({ name: 'scale', args: [x, y] }),
    clearRect: (x, y, w, h) => log.push({ name: 'clearRect', args: [x, y, w, h] }),
    fillRect: (x, y, w, h) => log.push({ name: 'fillRect', args: [x, y, w, h] }),
    beginPath: () => log.push({ name: 'beginPath', args: [] }),
    rect: (x, y, w, h) => log.push({ name: 'rect', args: [x, y, w, h] }),
    clip: () => log.push({ name: 'clip', args: [] }),
    measureText: (text) => ({ width: text.length * 20 }),
    fillText: (text, x, y) => log.push({ name: 'fillText', args: [text, x, y] }),
    strokeText: (text, x, y) => log.push({ name: 'strokeText', args: [text, x, y] }),
    drawImage: (image, ...args) => {
      if (opts.throwOn === image) {
        throw new DOMException('bitmap was closed', 'InvalidStateError')
      }
      log.push({ name: 'drawImage', args: [image, ...args] })
    },
  }
  if (opts.supportsFilter) {
    Object.defineProperty(ctx, 'filter', {
      configurable: true,
      get: () => filter,
      set: (value: string) => {
        filter = value
        log.push({ name: 'filter', args: [value] })
      },
    })
  }
  if (opts.supportsPixels) {
    ctx.getImageData = (x, y, width, height) => {
      log.push({ name: 'getImageData', args: [x, y, width, height] })
      const data = opts.pixelData ?? new Uint8ClampedArray(width * height * 4)
      return { data, width, height, colorSpace: 'srgb' } as ImageData
    }
    ctx.putImageData = (imageData, x, y) => {
      log.push({ name: 'putImageData', args: [imageData, x, y] })
    }
  }
  const ops = (name: string) => log.filter((op) => op.name === name)
  return {
    ctx,
    log,
    ops,
    depth: () => depth,
    state: () => ({ alpha, operation, fill, filter }),
  }
}

function makeTransitionSurfaceProvider(opts: {
  supportsFilter?: boolean
  supportsPixels?: boolean
  pixelData?: Uint8ClampedArray
} = {}) {
  const leg = makeCtx(opts)
  const group = makeCtx({ supportsPixels: opts.supportsPixels })
  const legCanvas = fakeBitmap(1920, 1080)
  const groupCanvas = fakeBitmap(1920, 1080)
  let gets = 0
  const provider: TransitionSurfaceProvider = {
    get: () => {
      gets++
      return {
        leg: { canvas: legCanvas, ctx: leg.ctx },
        group: { canvas: groupCanvas, ctx: group.ctx },
      }
    },
  }
  return { provider, leg, group, legCanvas, groupCanvas, gets: () => gets }
}

function compositeFrame(
  doc: TimelineDoc,
  frame: number,
  ctx: Composite2D,
  source: FrameSource,
  provider = makeTransitionSurfaceProvider().provider,
  presentation?: PresentationProfile,
  lensRemapProvider?: LensRemapProvider | null,
  pluginContributions?: PluginVideoEffectContributionSnapshot,
  videoEffectStageExecutor?: VideoEffectStageExecutor | null,
) {
  const catalog = new Map(
    doc.tracks.flatMap((track) => track.clips.map((clip) => [
      clip.assetId,
      {
        video: {
          status: 'exact' as const,
          firstTimestampUs: 0,
          endTimestampUs: 1_000_000_000,
        },
        audio: null,
      },
    ] as const)),
  )
  return compositeFrameCore(
    doc,
    videoCompositionPlanAtFrame(doc, frame, catalog, pluginContributions),
    ctx,
    source,
    provider,
    presentation,
    lensRemapProvider,
    videoEffectStageExecutor,
  )
}

/** Frame table keyed "assetId@sourceFrame"; unknown keys resolve null. */
function makeSource(
  frames: Record<
    string,
    RenderFrameSource
    | null
    | Promise<RenderFrameSource | null>
  > = {},
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
  test('no effects never touches Canvas filter state', async () => {
    const bitmap = fakeBitmap(640, 360)
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('plain', 0, 30)])])
    const { ctx, ops, state } = makeCtx({ supportsFilter: true })

    await compositeFrame(doc, 0, ctx, makeSource({ 'asset-1@0': bitmap }).source)

    expect(ops('filter')).toEqual([])
    expect(state().filter).toBe('none')
  })

  test('applies supported effects in order and restores filter ownership', async () => {
    const bitmap = fakeBitmap(640, 360)
    const first = createColorAdjustEffect('fx-first')
    first.params = { exposure: 1, contrast: 0.25, saturation: -0.5 }
    const second = createColorAdjustEffect('fx-second')
    second.params = { exposure: -1, contrast: -0.25, saturation: 0.5 }
    const clip = makeClip('graded', 0, 30, { effects: [first, second] })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    const { ctx, ops, state } = makeCtx({ supportsFilter: true })

    const result = await compositeFrame(
      doc,
      0,
      ctx,
      makeSource({ 'asset-1@0': bitmap }).source,
    )

    expect(ops('filter').map((op) => op.args[0])).toEqual([
      'brightness(2) contrast(1.25) saturate(0.5) '
      + 'brightness(0.5) contrast(0.75) saturate(1.5)',
    ])
    expect(state().filter).toBe('none')
    expect(result).toEqual({ drawn: ['graded'], missing: [] })
  })

  test('keeps a disabled plugin plan on the historical direct Canvas path', async () => {
    const bitmap = fakeBitmap(640, 360)
    const builtIn = createColorAdjustEffect('legacy-built-in')
    builtIn.params.exposure = 1
    const clip = makeClip('disabled-plugin', 0, 30, {
      effects: [builtIn, pluginEffect()],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    const destination = makeCtx({ supportsFilter: true })
    const surfaces = makeTransitionSurfaceProvider({ supportsPixels: true })

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': bitmap }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot('disabled'),
    )

    expect(destination.ops('drawImage')[0].args[0]).toBe(bitmap)
    expect(destination.ops('filter').map((operation) => operation.args[0]))
      .toEqual(['brightness(2) contrast(1) saturate(1)'])
    expect(surfaces.gets()).toBe(0)
    expect(result).toEqual({ drawn: ['disabled-plugin'], missing: [] })
  })

  test('visibly bypasses a ready plugin when scratch pixel access is unavailable', async () => {
    const bitmap = fakeBitmap(640, 360)
    const builtIn = createColorAdjustEffect('fallback-built-in')
    builtIn.params.exposure = 1
    const clip = makeClip('capability-fallback', 0, 30, {
      effects: [builtIn, pluginEffect()],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    const destination = makeCtx({ supportsFilter: true })
    const surfaces = makeTransitionSurfaceProvider()
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async () => {
        throw new Error('executor must not be reached without pixel access')
      }),
    }

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': bitmap }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    expect(executor.applyPluginEffect).not.toHaveBeenCalled()
    expect(destination.ops('drawImage')[0].args[0]).toBe(bitmap)
    expect(destination.ops('filter').map((operation) => operation.args[0]))
      .toEqual(['brightness(2) contrast(1) saturate(1)'])
    expect(result).toEqual({ drawn: ['capability-fallback'], missing: [] })
  })

  test('awaits a mixed built-in/plugin stage transaction before painting the layer', async () => {
    const builtIn = createColorAdjustEffect('warm-before-plugin')
    builtIn.params.temperature = 1
    const clip = makeClip('mixed-effects', 0, 30, {
      effects: [builtIn, pluginEffect()],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const pixels = new Uint8ClampedArray([128, 128, 128, 128])
    const surfaces = makeTransitionSurfaceProvider({ supportsPixels: true, pixelData: pixels })
    const pluginGate = deferred<void>()
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async (request) => {
        expect([...request.rgba]).toEqual([181, 128, 91, 128])
        await pluginGate.promise
        const output = new Uint8Array(request.rgba)
        output[0] = 7
        return { status: 'applied' as const, rgba: output }
      }),
    }

    const composite = compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': fakeBitmap(1, 1) }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )
    await vi.waitFor(() => expect(executor.applyPluginEffect).toHaveBeenCalledOnce())
    expect(destination.ops('drawImage')).toHaveLength(0)

    pluginGate.resolve()
    const result = await composite

    expect([...pixels]).toEqual([7, 128, 91, 128])
    expect(destination.ops('drawImage')[0].args[0]).toBe(surfaces.legCanvas)
    expect(result).toEqual({ drawn: ['mixed-effects'], missing: [] })
  })

  test('propagates a typed stage failure without publishing partial pixels', async () => {
    const builtIn = createColorAdjustEffect('uncommitted-warmth')
    builtIn.params.temperature = 1
    const clip = makeClip('rejected-plugin', 0, 30, {
      effects: [builtIn, pluginEffect()],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const pixels = new Uint8ClampedArray([128, 128, 128, 128])
    const surfaces = makeTransitionSurfaceProvider({ supportsPixels: true, pixelData: pixels })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async () => {
        throw new Error('sandbox rejected the stage')
      }),
    }

    const composite = compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': fakeBitmap(1, 1) }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    await expect(composite).rejects.toBeInstanceOf(VideoEffectStageExecutionError)
    expect([...pixels]).toEqual([128, 128, 128, 128])
    expect(surfaces.leg.ops('putImageData')).toHaveLength(0)
    expect(destination.ops('drawImage')).toHaveLength(0)
  })

  test('pixel-corrects a still on an isolated layer before compositing', async () => {
    const effect = createColorAdjustEffect('fx-warm-still')
    effect.params.temperature = 1
    const clip = makeClip('warm-still', 0, 30, {
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
      opacity: 0.5,
      effects: [effect],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const pixels = new Uint8ClampedArray([128, 128, 128, 128])
    const surfaces = makeTransitionSurfaceProvider({
      supportsPixels: true,
      pixelData: pixels,
    })

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': fakeBitmap(1, 1) }).source,
      surfaces.provider,
    )

    expect([...pixels]).toEqual([181, 128, 91, 128])
    expect(surfaces.leg.ops('getImageData')).toHaveLength(1)
    expect(surfaces.leg.ops('putImageData')).toHaveLength(1)
    expect(surfaces.leg.ops('alpha').map((op) => op.args[0])).toContain(1)
    expect(destination.ops('alpha').map((op) => op.args[0])).toEqual([1, 0.5])
    expect(destination.ops('filter')).toHaveLength(0)
    expect(destination.ops('drawImage')[0].args[0]).toBe(surfaces.legCanvas)
    expect(result).toEqual({ drawn: ['warm-still'], missing: [] })
  })

  test('masks the transformed/cropped project-space layer before clip opacity', async () => {
    const mask = createMaskEffect('left-half', 'rectangle')
    mask.params.width = 0.5
    const clip = makeClip('masked-still', 0, 30, {
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
      opacity: 0.5,
      transform: {
        x: 0.25,
        y: -0.1,
        scaleX: 1.5,
        scaleY: 0.75,
        rotation: 15,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      visual: {
        crop: { left: 0.1, right: 0, top: 0, bottom: 0 },
        flipHorizontal: false,
        flipVertical: false,
        scaleLocked: true,
      },
      effects: [mask],
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    doc.width = 2
    doc.height = 1
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      255, 255, 255, 255,
    ])
    const destination = makeCtx({ supportsPixels: true })
    const surfaces = makeTransitionSurfaceProvider({
      supportsPixels: true,
      pixelData: pixels,
    })

    await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource({ 'asset-1@0': fakeBitmap(2, 1) }).source,
      surfaces.provider,
    )

    expect([pixels[3], pixels[7]]).toEqual([255, 0])
    expect(surfaces.leg.ops('scale').map((op) => op.args)).toContainEqual([1.5, 0.75])
    expect(surfaces.leg.ops('rotate')[0].args[0]).toBeCloseTo(Math.PI / 12, 10)
    expect(surfaces.leg.log.findIndex((op) => op.name === 'drawImage'))
      .toBeLessThan(surfaces.leg.log.findIndex((op) => op.name === 'getImageData'))
    expect(destination.ops('alpha').map((op) => op.args[0])).toEqual([1, 0.5])
  })

  test('presentation scaling wraps project-space geometry without changing it', async () => {
    const bitmap = fakeBitmap(640, 360)
    const clip = makeClip('scaled-preview', 0, 30, {
      transform: {
        x: 120,
        y: -45,
        scaleX: 1.5,
        scaleY: 0.75,
        rotation: 15,
        anchorX: 0.25,
        anchorY: 0.5,
      },
    })
    const doc = makeDoc([makeTrack('V1', 'video', [clip])])
    const { ctx, ops } = makeCtx()
    const profile = resolvePresentationProfile(doc, {
      qualityMode: 'quarter',
      reason: 'playing',
      viewport: null,
    })

    await compositeFrame(
      doc,
      0,
      ctx,
      makeSource({ 'asset-1@0': bitmap }).source,
      undefined,
      profile,
    )

    expect(ops('scale').map((op) => op.args)).toEqual([
      [0.25, 0.25],
      [1.5, 0.75],
    ])
    expect(ops('translate')[0].args).toEqual([920, 495])
    expect(ops('drawImage')[0].args.slice(1)).toEqual([-160, -180])
  })

  test('empty doc: opaque black background, nothing else', async () => {
    const { ctx, log, depth } = makeCtx()
    const { source, requests } = makeSource()
    const result = await compositeFrame(makeDoc([]), 0, ctx, source)

    expect(requests).toEqual([])
    expect(result).toEqual({ drawn: [], missing: [] })
    expect(depth()).toBe(0)
    // Alpha forced to 1 before the fill; fill covers the full composition.
    const names = log.map((op) => op.name)
    expect(names.slice(0, 5)).toEqual([
      'save',
      'alpha',
      'composite',
      'fillStyle',
      'fillRect',
    ])
    expect(log[1].args).toEqual([1])
    expect(log[4].args).toEqual([0, 0, 1920, 1080])
  })

  test('draws text without media requests while skipping audio, hidden tracks, and gaps', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('audio-clip', 0, 100)]),
      makeTrack('V1', 'video', [makeClip('hidden-clip', 0, 100)], { hidden: true }),
      makeTrack('V2', 'video', [makeClip('later-clip', 50, 10)]), // gap at frame 5
      makeTrack('V3', 'video', [
        makeClip('text-clip', 0, 100, {
          blendMode: 'screen',
          text: {
            ...defaultTextProps(1920, 1080),
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
    const surfaces = makeTransitionSurfaceProvider()
    const { source, requests } = makeSource()
    const result = await compositeFrame(doc, 5, ctx, source, surfaces.provider)

    expect(requests).toEqual([]) // nothing even asked for pixels
    expect(ops('drawImage')).toHaveLength(1)
    expect(ops('composite').map((op) => op.args[0])).toContain('screen')
    expect(surfaces.leg.ops('fillText')).toHaveLength(1)
    expect(surfaces.leg.ops('composite').map((op) => op.args[0])).not.toContain('screen')
    expect(surfaces.gets()).toBe(1)
    expect(result).toEqual({ drawn: ['text-clip'], missing: [] })
  })

  test('applies ordered effects once to the completed isolated text layer', async () => {
    const first = createColorAdjustEffect('text-fx-a')
    first.params = { exposure: 1, contrast: 0.25, saturation: -0.5 }
    const second = createColorAdjustEffect('text-fx-b')
    second.params = { exposure: -1, contrast: -0.25, saturation: 0.5 }
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('styled-text', 0, 30, {
          opacity: 0.75,
          blendMode: 'screen',
          effects: [first, second],
          text: {
            ...defaultTextProps(1920, 1080),
            content: 'Layered',
            backgroundEnabled: true,
            outlineWidthPx: 3,
          },
        }),
      ]),
    ])
    const destination = makeCtx({ supportsFilter: true })
    const surfaces = makeTransitionSurfaceProvider()

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource().source,
      surfaces.provider,
    )

    expect(surfaces.leg.ops('fillRect')).not.toHaveLength(0)
    expect(surfaces.leg.ops('strokeText')).toHaveLength(1)
    expect(surfaces.leg.ops('fillText')).toHaveLength(1)
    expect(surfaces.leg.ops('filter')).toHaveLength(0)
    expect(destination.ops('filter').map((operation) => operation.args[0])).toEqual([
      'brightness(2) contrast(1.25) saturate(0.5) '
      + 'brightness(0.5) contrast(0.75) saturate(1.5)',
    ])
    const layerDraw = destination.ops('drawImage')[0]
    expect(layerDraw.args[0]).toBe(surfaces.legCanvas)
    const names = destination.log.map((operation) => operation.name)
    expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('filter'))
    expect(names.indexOf('composite')).toBeLessThan(names.indexOf('filter'))
    expect(names.indexOf('filter')).toBeLessThan(names.indexOf('drawImage'))
    expect(destination.state()).toMatchObject({ filter: 'none', operation: 'source-over' })
    expect(destination.depth()).toBe(0)
    expect(surfaces.leg.depth()).toBe(0)
    expect(surfaces.gets()).toBe(1)
    expect(result).toEqual({ drawn: ['styled-text'], missing: [] })
  })

  test('pixel-corrects completed text without changing transparent alpha', async () => {
    const effect = createColorAdjustEffect('text-tint')
    effect.params.tint = 1
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('tinted-text', 0, 30, {
          effects: [effect],
          text: {
            ...defaultTextProps(1, 1),
            content: 'T',
          },
        }),
      ]),
    ])
    doc.width = 1
    doc.height = 1
    const pixels = new Uint8ClampedArray([128, 128, 128, 0])
    const surfaces = makeTransitionSurfaceProvider({
      supportsPixels: true,
      pixelData: pixels,
    })

    const result = await compositeFrame(
      doc,
      0,
      makeCtx({ supportsPixels: true }).ctx,
      makeSource().source,
      surfaces.provider,
    )

    expect([...pixels]).toEqual([140, 108, 140, 0])
    expect(surfaces.leg.ops('putImageData')).toHaveLength(1)
    expect(result).toEqual({ drawn: ['tinted-text'], missing: [] })
  })

  test('runs a text layer through its planned mixed built-in/plugin pixel order', async () => {
    const builtIn = createColorAdjustEffect('text-warm-before-plugin')
    builtIn.params.temperature = 1
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('plugin-text', 0, 30, {
          effects: [builtIn, pluginEffect('text-plugin')],
          text: {
            ...defaultTextProps(1, 1),
            content: 'T',
          },
        }),
      ]),
    ])
    doc.width = 1
    doc.height = 1
    const pixels = new Uint8ClampedArray([128, 128, 128, 0])
    const surfaces = makeTransitionSurfaceProvider({ supportsPixels: true, pixelData: pixels })
    const destination = makeCtx({ supportsPixels: true })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async (request) => {
        expect([...request.rgba]).toEqual([181, 128, 91, 0])
        const output = new Uint8Array(request.rgba)
        output[1] = 7
        return { status: 'applied' as const, rgba: output }
      }),
    }

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource().source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    expect([...pixels]).toEqual([181, 7, 91, 0])
    expect(surfaces.leg.ops('fillText')).toHaveLength(1)
    expect(surfaces.leg.ops('putImageData')).toHaveLength(1)
    expect(destination.ops('drawImage')[0].args[0]).toBe(surfaces.legCanvas)
    expect(result).toEqual({ drawn: ['plugin-text'], missing: [] })
  })

  test('keeps legacy text effects when its ready plugin cannot access scratch pixels', async () => {
    const builtIn = createColorAdjustEffect('text-fallback-built-in')
    builtIn.params.exposure = 1
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('fallback-text', 0, 30, {
          effects: [builtIn, pluginEffect('text-unavailable')],
          text: {
            ...defaultTextProps(1920, 1080),
            content: 'Fallback',
          },
        }),
      ]),
    ])
    const destination = makeCtx({ supportsFilter: true })
    const surfaces = makeTransitionSurfaceProvider()
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async () => {
        throw new Error('executor must not be reached without pixel access')
      }),
    }

    const result = await compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource().source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    expect(executor.applyPluginEffect).not.toHaveBeenCalled()
    expect(surfaces.leg.ops('fillText')).toHaveLength(1)
    expect(destination.ops('filter').map((operation) => operation.args[0]))
      .toEqual(['brightness(2) contrast(1) saturate(1)'])
    expect(result).toEqual({ drawn: ['fallback-text'], missing: [] })
  })

  test('propagates typed stage failure from text composition', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [
        makeClip('rejected-text', 0, 30, {
          effects: [pluginEffect('rejected-text-plugin')],
          text: { ...defaultTextProps(1, 1), content: 'T' },
        }),
      ]),
    ])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const surfaces = makeTransitionSurfaceProvider({
      supportsPixels: true,
      pixelData: new Uint8ClampedArray(4),
    })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: async () => {
        throw new Error('text sandbox failed')
      },
    }

    const composite = compositeFrame(
      doc,
      0,
      destination.ctx,
      makeSource().source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    await expect(composite).rejects.toBeInstanceOf(VideoEffectStageExecutionError)
    expect(destination.ops('drawImage')).toHaveLength(0)
  })

  test('draws semantic captions through shared text layout without media requests', async () => {
    const doc = makeDoc([])
    doc.captionTracks = [{
      id: 'captions-en',
      name: 'English',
      language: 'en',
      role: 'captions',
      stylePreset: 'boxed',
      hidden: false,
      items: [{ id: 'cue-1', range: { startFrame: 4, durationFrames: 2 }, text: 'Caption' }],
    }]
    const { ctx, ops } = makeCtx()
    const { source, requests } = makeSource()

    const active = await compositeFrame(doc, 4, ctx, source)
    const ended = await compositeFrame(doc, 6, makeCtx().ctx, source)

    expect(requests).toEqual([])
    expect(ops('fillText').map((operation) => operation.args[0])).toContain('Caption')
    expect(active).toEqual({ drawn: ['cue-1'], missing: [] })
    expect(ended).toEqual({ drawn: [], missing: [] })
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

  test('fetches a crossfade concurrently and builds one isolated plus group', async () => {
    const outgoingImage = fakeBitmap(100, 100)
    const incomingImage = fakeBitmap(100, 100)
    const outgoing = deferred<ImageBitmap | null>()
    const incoming = deferred<ImageBitmap | null>()
    const from = makeClip('from', 0, 10, { assetId: 'A' })
    const to = makeClip('to', 10, 10, { assetId: 'B' })
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      }),
    ])
    const { ctx, ops } = makeCtx()
    const surfaces = makeTransitionSurfaceProvider()
    const { source, requests } = makeSource({
      'A@10': outgoing.promise,
      'B@0': incoming.promise,
    })

    const composite = compositeFrame(doc, 10, ctx, source, surfaces.provider)
    expect(requests).toEqual(['A@10', 'B@0'])

    outgoing.resolve(outgoingImage)
    incoming.resolve(incomingImage)
    const result = await composite

    expect(surfaces.leg.ops('drawImage').map((op) => op.args[0])).toEqual([
      outgoingImage,
      incomingImage,
    ])
    expect(surfaces.group.ops('drawImage').map((op) => op.args[0])).toEqual([
      surfaces.legCanvas,
      surfaces.legCanvas,
    ])
    expect(
      surfaces.group.ops('composite').map((op) => op.args[0]),
    ).toContain('lighter')
    expect(
      surfaces.group.ops('alpha').map((op) => op.args[0]),
    ).toEqual([1, 0.5, 0.5, 1])
    expect(ops('drawImage').map((op) => op.args[0])).toEqual([
      surfaces.groupCanvas,
    ])
    expect(surfaces.gets()).toBe(1)
    expect(surfaces.leg.ops('clearRect')).toHaveLength(3)
    expect(surfaces.group.ops('clearRect')).toHaveLength(2)
    expect(surfaces.leg.depth()).toBe(0)
    expect(surfaces.group.depth()).toBe(0)
    expect(result).toEqual({ drawn: ['from', 'to'], missing: [] })
  })

  test('pixel-corrects each crossfade leg before weighted accumulation', async () => {
    const outgoingEffect = createColorAdjustEffect('outgoing-warm')
    outgoingEffect.params.temperature = 0.5
    const incomingEffect = createColorAdjustEffect('incoming-tint')
    incomingEffect.params.tint = -0.5
    const from = makeClip('from-color', 0, 10, {
      assetId: 'A',
      effects: [outgoingEffect],
    })
    const to = makeClip('to-color', 10, 10, {
      assetId: 'B',
      effects: [incomingEffect],
    })
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'color-dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      }),
    ])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const surfaces = makeTransitionSurfaceProvider({ supportsPixels: true })

    const result = await compositeFrame(
      doc,
      10,
      destination.ctx,
      makeSource({
        'A@10': fakeBitmap(1, 1),
        'B@0': fakeBitmap(1, 1),
      }).source,
      surfaces.provider,
    )

    expect(surfaces.leg.ops('getImageData')).toHaveLength(2)
    expect(surfaces.leg.ops('putImageData')).toHaveLength(2)
    expect(surfaces.group.ops('drawImage')).toHaveLength(2)
    expect(destination.ops('drawImage')[0].args[0]).toBe(surfaces.groupCanvas)
    expect(result).toEqual({ drawn: ['from-color', 'to-color'], missing: [] })
  })

  test('bypasses ready transition plugins when the shared leg has no pixel access', async () => {
    const outgoingEffect = createColorAdjustEffect('outgoing-fallback')
    outgoingEffect.params.exposure = 1
    const incomingEffect = createColorAdjustEffect('incoming-fallback')
    incomingEffect.params.exposure = -1
    const from = makeClip('from-fallback', 0, 10, {
      assetId: 'A',
      effects: [outgoingEffect, pluginEffect('from-unavailable')],
    })
    const to = makeClip('to-fallback', 10, 10, {
      assetId: 'B',
      effects: [incomingEffect, pluginEffect('to-unavailable')],
    })
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'fallback-dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      }),
    ])
    const destination = makeCtx()
    const surfaces = makeTransitionSurfaceProvider({ supportsFilter: true })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: vi.fn(async () => {
        throw new Error('executor must not be reached without pixel access')
      }),
    }

    const result = await compositeFrame(
      doc,
      10,
      destination.ctx,
      makeSource({
        'A@10': fakeBitmap(100, 100),
        'B@0': fakeBitmap(100, 100),
      }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    expect(executor.applyPluginEffect).not.toHaveBeenCalled()
    expect(surfaces.leg.ops('filter').map((operation) => operation.args[0]))
      .toEqual([
        'brightness(2) contrast(1) saturate(1)',
        'brightness(0.5) contrast(1) saturate(1)',
      ])
    expect(surfaces.group.ops('drawImage')).toHaveLength(2)
    expect(result).toEqual({ drawn: ['from-fallback', 'to-fallback'], missing: [] })
  })

  test('propagates typed stage failure from an isolated transition leg', async () => {
    const from = makeClip('from-rejected', 0, 10, {
      assetId: 'A',
      effects: [pluginEffect('rejected-transition-plugin')],
    })
    const to = makeClip('to-unreached', 10, 10, { assetId: 'B' })
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'rejected-dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      }),
    ])
    doc.width = 1
    doc.height = 1
    const destination = makeCtx({ supportsPixels: true })
    const surfaces = makeTransitionSurfaceProvider({
      supportsPixels: true,
      pixelData: new Uint8ClampedArray(4),
    })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: async () => {
        throw new Error('transition sandbox failed')
      },
    }

    const composite = compositeFrame(
      doc,
      10,
      destination.ctx,
      makeSource({
        'A@10': fakeBitmap(1, 1),
        'B@0': fakeBitmap(1, 1),
      }).source,
      surfaces.provider,
      undefined,
      undefined,
      pluginSnapshot(),
      executor,
    )

    await expect(composite).rejects.toBeInstanceOf(VideoEffectStageExecutionError)
    expect(destination.ops('drawImage')).toHaveLength(0)
    expect(surfaces.group.ops('drawImage')).toHaveLength(0)
  })

  test('keeps one missing crossfade leg isolated from the other', async () => {
    const from = makeClip('from', 0, 10, { assetId: 'A' })
    const to = makeClip('to', 10, 10, { assetId: 'B' })
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{
          id: 'dissolve',
          type: 'crossfade',
          fromClipId: from.id,
          toClipId: to.id,
          durationFrames: 1,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      }),
    ])
    const incomingImage = fakeBitmap(100, 100)
    const { ctx, ops } = makeCtx()
    const surfaces = makeTransitionSurfaceProvider()
    const { source } = makeSource({ 'B@0': incomingImage })

    const result = await compositeFrame(
      doc,
      10,
      ctx,
      source,
      surfaces.provider,
    )

    expect(surfaces.leg.ops('drawImage').map((op) => op.args[0])).toEqual([
      incomingImage,
    ])
    expect(ops('drawImage').map((op) => op.args[0])).toEqual([
      surfaces.groupCanvas,
    ])
    expect(surfaces.leg.ops('clearRect')).toHaveLength(2)
    expect(surfaces.group.ops('clearRect')).toHaveLength(2)
    expect(result).toEqual({ drawn: ['to'], missing: ['from'] })
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

  test('a retained VideoFrame uses presentation dimensions without copying', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('still', 0, 10, {
        assetId: 'IMAGE',
        sourceMode: 'still',
        sourceRange: { startFrame: 0, durationFrames: 1 },
      })]),
    ])
    const frame = fakeVideoFrame(640, 360)
    const { ctx, ops } = makeCtx()
    const { source } = makeSource({ 'IMAGE@0': frame })

    await compositeFrame(doc, 7, ctx, source)

    expect(ops('translate')[0].args).toEqual([960, 540])
    expect(ops('drawImage')[0].args).toEqual([frame, -320, -180])
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

  test('crop uses intrinsic source pixels without stretching and flips around the anchor', async () => {
    const clip = makeClip('cropped', 0, 10, {
      assetId: 'A',
      transform: {
        x: 0,
        y: 0,
        scaleX: 2,
        scaleY: 0.5,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      visual: {
        crop: { left: 0.1, right: 0.15, top: 0.2, bottom: 0.2 },
        flipHorizontal: true,
        flipVertical: false,
        scaleLocked: false,
      },
    })
    const bitmap = fakeBitmap(800, 600)
    const { ctx, ops } = makeCtx()
    const { source } = makeSource({ 'A@0': bitmap })

    await compositeFrame(makeDoc([makeTrack('V1', 'video', [clip])]), 0, ctx, source)

    expect(ops('translate')[0].args).toEqual([960, 540])
    expect(ops('scale')[0].args).toEqual([-2, 0.5])
    const drawArgs = ops('drawImage')[0].args
    expect(drawArgs.slice(0, 4)).toEqual([bitmap, 80, 120, 600])
    expect(drawArgs[4]).toBeCloseTo(360, 10)
    expect(drawArgs.slice(5, 8)).toEqual([-320, -180, 600])
    expect(drawArgs[8]).toBeCloseTo(360, 10)
  })

  test('manual lens correction replaces decoded source before crop and transform', async () => {
    const clip = makeClip('lens', 0, 10, {
      assetId: 'A',
      lensCorrection: {
        ...DEFAULT_MANUAL_LENS_CORRECTION,
        k1: 0.16,
        outputScale: 1.2,
      },
      visual: {
        crop: { left: 0.1, right: 0, top: 0, bottom: 0 },
        flipHorizontal: false,
        flipVertical: false,
        scaleLocked: true,
      },
    })
    const decoded = fakeBitmap(800, 600)
    const corrected = fakeBitmap(800, 600)
    const remap = vi.fn(() => corrected)
    const lensProvider: LensRemapProvider = { remap }
    const { ctx, ops } = makeCtx()
    const { source } = makeSource({ 'A@0': decoded })

    await compositeFrame(
      makeDoc([makeTrack('V1', 'video', [clip])]),
      0,
      ctx,
      source,
      makeTransitionSurfaceProvider().provider,
      undefined,
      lensProvider,
    )

    expect(remap).toHaveBeenCalledWith(clip, decoded)
    expect(ops('drawImage')[0].args.slice(0, 5)).toEqual([
      corrected,
      80,
      0,
      720,
      600,
    ])
  })

  test('authored lens intent rejects when the renderer has no remap provider', async () => {
    const clip = makeClip('lens', 0, 10, {
      assetId: 'A',
      lensCorrection: { ...DEFAULT_MANUAL_LENS_CORRECTION, k1: 0.1 },
    })
    const { ctx } = makeCtx()
    const { source } = makeSource({ 'A@0': fakeBitmap(32, 18) })

    await expect(compositeFrame(
      makeDoc([makeTrack('V1', 'video', [clip])]),
      0,
      ctx,
      source,
    )).rejects.toMatchObject({ name: 'LensRemapUnavailableError' })
  })

  test('text crop and flips use the same normalized visual contract without media', async () => {
    const text = defaultTextProps(1920, 1080)
    text.boxWidthPx = 1000
    text.boxHeightPx = 400
    const clip = makeClip('cropped-text', 0, 10, {
      text,
      visual: {
        crop: { left: 0.1, right: 0.2, top: 0.25, bottom: 0.15 },
        flipHorizontal: false,
        flipVertical: true,
        scaleLocked: true,
      },
    })
    const { ctx, ops } = makeCtx()
    const surfaces = makeTransitionSurfaceProvider()
    const { source, requests } = makeSource()

    await compositeFrame(
      makeDoc([makeTrack('V1', 'video', [clip])]),
      0,
      ctx,
      source,
      surfaces.provider,
    )

    expect(requests).toEqual([])
    expect(ops('drawImage')).toHaveLength(1)
    expect(surfaces.leg.ops('scale')[0].args).toEqual([1, -1])
    expect(surfaces.leg.ops('rect')[0].args).toEqual([100, 100, 700, 240])
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

  test('uses the resolved Canvas blend operation and restores incoming state', async () => {
    const clip = makeClip('blend', 0, 10, { assetId: 'A', blendMode: 'overlay' })
    const { ctx, ops, depth, state } = makeCtx()
    ctx.globalAlpha = 0.25
    ctx.globalCompositeOperation = 'destination-over'
    const { source } = makeSource({ 'A@0': fakeBitmap(10, 10) })

    const result = await compositeFrame(
      makeDoc([makeTrack('V1', 'video', [clip])]),
      0,
      ctx,
      source,
    )

    expect(result.drawn).toEqual(['blend'])
    expect(ops('composite').map((op) => op.args[0])).toContain('overlay')
    expect(state()).toMatchObject({ alpha: 0.25, operation: 'destination-over' })
    expect(depth()).toBe(0)
  })

  test('uses source-over when the concrete Canvas context rejects a supported name', async () => {
    const clip = makeClip('blend', 0, 10, { assetId: 'A', blendMode: 'overlay' })
    const { ctx, ops, state } = makeCtx({ rejectComposite: 'overlay' })
    const { source } = makeSource({ 'A@0': fakeBitmap(10, 10) })

    const result = await compositeFrame(
      makeDoc([makeTrack('V1', 'video', [clip])]),
      0,
      ctx,
      source,
    )

    expect(result.drawn).toEqual(['blend'])
    expect(ops('composite').map((op) => op.args[0])).not.toContain('overlay')
    expect(ops('composite').map((op) => op.args[0])).toContain('source-over')
    expect(state().operation).toBe('source-over')
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
      const { ctx, ops, depth, state } = makeCtx({ throwOn: dead })
      ctx.globalAlpha = 0.75
      ctx.globalCompositeOperation = 'destination-over'
      const { source } = makeSource({ 'DEAD@0': dead, 'ALIVE@0': fakeBitmap(10, 10) })
      const result = await compositeFrame(doc, 0, ctx, source)

      expect(result).toEqual({ drawn: ['alive'], missing: ['dead'] })
      expect(ops('drawImage')).toHaveLength(1) // only the live bitmap landed
      expect(depth()).toBe(0) // finally-restore ran despite the throw
      expect(state()).toMatchObject({ alpha: 0.75, operation: 'destination-over' })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
