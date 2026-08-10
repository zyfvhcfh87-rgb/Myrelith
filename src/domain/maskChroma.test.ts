import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  createChromaKeyEffect,
  createMaskEffect,
  DEFAULT_MASK_BEZIER_PATH,
  resolveCanvasEffectStack,
} from './effectStack'
import { EFFECT_STACK_LIMITS } from './effectBounds'
import { applyOrderedPixelEffectsToRgba } from './effectPixels'
import {
  defaultClipAnimation,
  resolveClipAnimationAtFrame,
} from './clipAnimation'
import {
  insertClip,
  moveEffectKeyframe,
  removeEffect,
  removeEffectKeyframe,
  retimeClip,
  resetEffect,
  setClipKeyframe,
  setEffectKeyframe,
  splitClipAtFrame,
  trimClip,
  updateClipVisualAtFrame,
  updateEffectParamsAtFrame,
} from './operations'
import { PROJECT_FILE_LIMITS } from './projectFile'
import { defaultTextProps } from './textOverlay'
import { clipWithAnimationKeyframeCount } from '../test/animationBudgetFixtures'

const linear = { type: 'linear' } as const

function mediaClip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Masked clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    timelineRange: { startFrame: 10, durationFrames: 40 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    animation: defaultClipAnimation(),
    effects: [
      createMaskEffect('mask-a', 'rectangle'),
      createMaskEffect('mask-b', 'ellipse'),
    ],
  }
}

function documentWithClip(clip = mediaClip()): TimelineDoc {
  const track: Track = {
    id: 'track-1',
    kind: 'video',
    name: 'Video 1',
    clips: [clip],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 13,
    id: 'doc-1',
    name: 'Masks and chroma',
    frameRate: { num: 30, den: 1 },
    width: 4,
    height: 2,
    audioSampleRate: 48_000,
    tracks: [track],
  }
}

function clipFrom(doc: TimelineDoc, id = 'clip-1'): Clip {
  const clip = doc.tracks[0].clips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`missing clip ${id}`)
  return clip
}

function documentAtAnimationKeyframeBudget(): TimelineDoc {
  const clip = mediaClip()
  clip.animation = {
    tracks: [{
      property: 'opacity',
      keyframes: [{
        frame: 0,
        sourceTimeTicks: 0,
        value: 1,
        easing: linear,
      }],
    }],
    effectTracks: [
      {
        effectId: 'mask-a',
        parameter: 'x',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0, easing: linear }],
      },
      {
        effectId: 'mask-a',
        parameter: 'y',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0, easing: linear }],
      },
    ],
  }
  return documentWithClip(clipWithAnimationKeyframeCount(clip))
}

describe('mask and chroma-key effects', () => {
  test('keeps an exact executable command for every authored ready effect', () => {
    const firstColor = {
      id: 'color-a', type: 'builtin.color-adjust', version: 1, enabled: true,
      params: { exposure: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
    }
    const mask = createMaskEffect('mask-a', 'ellipse')
    const secondColor = {
      id: 'color-b', type: 'builtin.color-adjust', version: 1, enabled: true,
      params: { exposure: 0, contrast: 0.25, saturation: 0, temperature: 0, tint: 0 },
    }
    const key = createChromaKeyEffect('key-a')

    const result = resolveCanvasEffectStack(
      [firstColor, mask, secondColor, key],
      true,
      true,
    )

    expect(result.filter).toBeNull()
    expect(result.pixelEffects.map((effect) => effect.kind)).toEqual([
      'color-adjust',
      'mask',
      'color-adjust',
      'chroma-key',
    ])
    expect(result.effects.map((effect) => effect.status)).toEqual([
      'ready', 'ready', 'ready', 'ready',
    ])
  })

  test('applies rectangle, ellipse, bezier, feather, invert, and clipping deterministically', () => {
    const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(255)
    const rectangle = createMaskEffect('mask-rectangle', 'rectangle')
    rectangle.params = {
      ...rectangle.params,
      x: -0.25,
      y: 0,
      width: 0.75,
      height: 1,
      feather: 0,
    }
    const resolution = resolveCanvasEffectStack([rectangle], true, true)
    applyOrderedPixelEffectsToRgba(pixels, resolution.pixelEffects, {
      surfaceWidth: 4,
      surfaceHeight: 2,
      projectWidth: 4,
      projectHeight: 2,
    })
    expect([...pixels.filter((_value, index) => index % 4 === 3)]).toEqual([
      255, 255, 0, 0,
      255, 255, 0, 0,
    ])

    const ellipse = createMaskEffect('mask-ellipse', 'ellipse')
    ellipse.params.invert = true
    ellipse.params.feather = 0.2
    expect(resolveCanvasEffectStack([ellipse], true, true).pixelEffects).toHaveLength(1)

    const bezier = createMaskEffect('mask-bezier', 'bezier')
    expect(resolveCanvasEffectStack([bezier], true, true).effects[0].status).toBe('ready')
    bezier.params.path = 'M 0 0 C nope Z'
    const invalid = resolveCanvasEffectStack([bezier], true, true)
    expect(invalid.effects[0].status).toBe('invalid')
    expect(invalid.pixelEffects).toEqual([])
    expect(bezier.params.path).toBe('M 0 0 C nope Z')
  })

  test('keeps Bezier raster output stable and bounds zero-feather work by rows and edges', () => {
    const mask = createMaskEffect('mask-bezier-output', 'bezier')
    mask.params = {
      ...mask.params,
      x: 0.125,
      y: 0.125,
      width: 0.75,
      height: 0.75,
      feather: 0.125,
    }
    const pixels = new Uint8ClampedArray(8 * 6 * 4).fill(255)
    applyOrderedPixelEffectsToRgba(
      pixels,
      resolveCanvasEffectStack([mask], true, true).pixelEffects,
      { surfaceWidth: 8, surfaceHeight: 6, projectWidth: 8, projectHeight: 6 },
    )
    expect([...pixels.filter((_value, index) => index % 4 === 3)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 137, 241, 241, 137, 0, 0,
      0, 132, 255, 255, 255, 255, 132, 0,
      0, 132, 255, 255, 255, 255, 132, 0,
      0, 0, 137, 241, 241, 137, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ])

    mask.params.feather = 0
    const hdPixels = new Uint8ClampedArray(960 * 540 * 4).fill(255)
    const work = {
      maskScanlineEdgeTests: 0,
      maskDistanceSamples: 0,
      maskInsideScratchPixelsPeak: 0,
      maskDistanceScratchPixelsPeak: 0,
    }
    applyOrderedPixelEffectsToRgba(
      hdPixels,
      resolveCanvasEffectStack([mask], true, true).pixelEffects,
      { surfaceWidth: 960, surfaceHeight: 540, projectWidth: 1920, projectHeight: 1080 },
      work,
    )
    expect(work.maskScanlineEdgeTests).toBeGreaterThan(0)
    expect(work.maskScanlineEdgeTests).toBeLessThanOrEqual(540 * 64)
    expect(work.maskDistanceSamples).toBe(0)
    expect(work.maskInsideScratchPixelsPeak).toBeLessThan(960 * 540)
    expect(work.maskDistanceScratchPixelsPeak).toBe(0)

    mask.params.feather = 0.05
    const hdFeathered = new Uint8ClampedArray(1920 * 1080 * 4).fill(255)
    const featheredWork = {
      maskScanlineEdgeTests: 0,
      maskDistanceSamples: 0,
      maskInsideScratchPixelsPeak: 0,
      maskDistanceScratchPixelsPeak: 0,
    }
    const startedAt = performance.now()
    applyOrderedPixelEffectsToRgba(
      hdFeathered,
      resolveCanvasEffectStack([mask], true, true).pixelEffects,
      {
        surfaceWidth: 1920,
        surfaceHeight: 1080,
        projectWidth: 1920,
        projectHeight: 1080,
      },
      featheredWork,
    )
    expect(performance.now() - startedAt).toBeLessThan(1_500)
    expect(featheredWork.maskDistanceSamples).toBeGreaterThan(0)
    expect(featheredWork.maskDistanceSamples).toBeLessThan(1920 * 1080 * 8)
    expect(featheredWork.maskDistanceScratchPixelsPeak).toBeLessThan(1920 * 1080)
  })

  test('uses project-pixel Euclidean feather distance on wide and tall ellipse axes', () => {
    const axisAlpha = (
      projectWidth: number,
      projectHeight: number,
      width: number,
      height: number,
      horizontal: readonly [number, number],
      vertical: readonly [number, number],
    ): readonly [number, number] => {
      const mask = createMaskEffect('mask-ellipse-distance', 'ellipse')
      mask.params = {
        ...mask.params,
        x: 0.5 / projectWidth,
        y: 0.5 / projectHeight,
        width: width / projectWidth,
        height: height / projectHeight,
        feather: 2 / Math.min(projectWidth, projectHeight),
      }
      const pixels = new Uint8ClampedArray(projectWidth * projectHeight * 4).fill(255)
      applyOrderedPixelEffectsToRgba(
        pixels,
        resolveCanvasEffectStack([mask], true, true).pixelEffects,
        { surfaceWidth: projectWidth, surfaceHeight: projectHeight, projectWidth, projectHeight },
      )
      const alpha = (point: readonly [number, number]): number => (
        pixels[(point[1] * projectWidth + point[0]) * 4 + 3]
      )
      return [alpha(horizontal), alpha(vertical)]
    }

    const wide = axisAlpha(12, 8, 10, 6, [9, 3], [5, 1])
    const tall = axisAlpha(8, 12, 6, 10, [5, 5], [3, 1])
    expect(wide[0]).toBe(wide[1])
    expect(tall[0]).toBe(tall[1])
    expect(wide[0]).toBe(128)
    expect(tall[0]).toBe(128)
  })

  test('keys matching color, softens the boundary, and suppresses spill with explicit defaults', () => {
    const key = createChromaKeyEffect('key-a')
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      20, 220, 20, 255,
      255, 0, 0, 255,
    ])
    const resolution = resolveCanvasEffectStack([key], true, true)
    applyOrderedPixelEffectsToRgba(pixels, resolution.pixelEffects, {
      surfaceWidth: 3,
      surfaceHeight: 1,
      projectWidth: 3,
      projectHeight: 1,
    })
    expect(pixels[3]).toBe(0)
    expect(pixels[7]).toBeGreaterThan(0)
    expect(pixels[7]).toBeLessThan(255)
    expect(pixels[11]).toBe(255)
    expect(pixels[5]).toBeLessThan(220)
  })

  test('executes noncommuting color and chroma stages in their authored order', () => {
    const color = {
      id: 'brighten', type: 'builtin.color-adjust', version: 1, enabled: true,
      params: { exposure: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
    }
    const key = createChromaKeyEffect('key')
    const colorThenKey = new Uint8ClampedArray([0, 128, 0, 255])
    const keyThenColor = new Uint8ClampedArray(colorThenKey)
    const geometry = {
      surfaceWidth: 1, surfaceHeight: 1, projectWidth: 1, projectHeight: 1,
    }
    applyOrderedPixelEffectsToRgba(
      colorThenKey,
      resolveCanvasEffectStack([color, key], true, true).pixelEffects,
      geometry,
    )
    applyOrderedPixelEffectsToRgba(
      keyThenColor,
      resolveCanvasEffectStack([key, color], true, true).pixelEffects,
      geometry,
    )
    expect(colorThenKey[3]).toBe(0)
    expect(keyThenColor[3]).toBe(255)
  })
})

describe('effect parameter animation', () => {
  test('addresses multiple masks by stable effect id through the scalar evaluator', () => {
    let doc = documentWithClip()
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-a', 'x', {
      frame: 0, value: 0, easing: linear,
    })
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-a', 'x', {
      frame: 10, value: 0.5, easing: linear,
    })
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-b', 'feather', {
      frame: 0, value: 0, easing: linear,
    })
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-b', 'feather', {
      frame: 10, value: 0.2, easing: linear,
    })

    const resolved = resolveClipAnimationAtFrame(clipFrom(doc), 15)
    expect(resolved.effects[0].params.x).toBeCloseTo(0.25)
    expect(resolved.effects[1].params.feather).toBeCloseTo(0.1)
    expect(clipFrom(doc).effects[0].params.x).toBe(0)
  })

  test('edits an existing track at the playhead, resets keys, and removes keys atomically', () => {
    let doc = documentWithClip()
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-a', 'x', {
      frame: 0, value: 0, easing: linear,
    })
    const keyed = updateEffectParamsAtFrame(doc, 'clip-1', 'mask-a', 15, { x: 0.5 })
    expect(clipFrom(keyed).effects[0].params.x).toBe(0)
    expect(clipFrom(keyed).animation?.effectTracks?.[0].keyframes).toEqual([
      { frame: 0, sourceTimeTicks: 0, value: 0, easing: linear },
      { frame: 5, sourceTimeTicks: 5_000_000, value: 0.5, easing: linear },
    ])

    const reset = resetEffect(keyed, 'clip-1', 'mask-a')
    expect(clipFrom(reset).animation?.effectTracks).toEqual([])
    expect(clipFrom(reset).effects[0].params.x).toBe(0)

    const keyedAgain = setEffectKeyframe(reset, 'clip-1', 'mask-a', 'x', {
      frame: 0, value: 0.25, easing: linear,
    })
    const removed = removeEffect(keyedAgain, 'clip-1', 'mask-a')
    expect(clipFrom(removed).effects.map((effect) => effect.id)).toEqual(['mask-b'])
    expect(clipFrom(removed).animation?.effectTracks).toEqual([])
  })

  test('retains source intent through split/head trim and remaps split effect ids', () => {
    let doc = documentWithClip()
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-a', 'x', {
      frame: 0, value: 0, easing: linear,
    })
    doc = setEffectKeyframe(doc, 'clip-1', 'mask-a', 'x', {
      frame: 20, value: 1, easing: linear,
    })
    const expected = resolveClipAnimationAtFrame(clipFrom(doc), 25).effects[0].params.x
    const split = splitClipAtFrame(doc, 'clip-1', 20)
    const right = split.tracks[0].clips[1]
    expect(right.animation?.effectTracks?.[0].effectId).toBe(right.effects[0].id)
    expect(right.effects[0].id).not.toBe('mask-a')
    expect(resolveClipAnimationAtFrame(right, 25).effects[0].params.x).toBe(expected)

    const trimmed = trimClip(doc, 'clip-1', 'start', 5)
    expect(resolveClipAnimationAtFrame(clipFrom(trimmed), 25).effects[0].params.x)
      .toBe(expected)

    const retimed = retimeClip(doc, 'clip-1', { numerator: 2, denominator: 1 })
    expect(clipFrom(retimed).animation?.effectTracks?.[0].keyframes.map((keyframe) => ({
      frame: keyframe.frame,
      sourceTimeTicks: keyframe.sourceTimeTicks,
    }))).toEqual([
      { frame: 0, sourceTimeTicks: 0 },
      { frame: 10, sourceTimeTicks: 20_000_000 },
    ])
  })

  test('preserves unknown or dangling authored tracks and ignores them at evaluation', () => {
    const clip = mediaClip()
    clip.animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'future-effect',
        parameter: 'future-number',
        keyframes: [{ frame: 0, value: 42, easing: linear }],
      }],
    }
    const resolved = resolveClipAnimationAtFrame(clip, 10)
    expect(resolved).toBe(clip)
    expect(clip.animation.effectTracks?.[0].keyframes[0].value).toBe(42)
  })

  test('keeps static text effects editable while rejecting text effect keyframes', () => {
    const text = mediaClip()
    text.text = defaultTextProps(4, 2)
    text.effects = [createMaskEffect('text-mask', 'ellipse')]
    const original = documentWithClip(text)
    const edited = updateEffectParamsAtFrame(
      original,
      'clip-1',
      'text-mask',
      15,
      { x: 0.2 },
    )
    expect(clipFrom(edited).effects[0].params.x).toBe(0.2)
    expect(setEffectKeyframe(edited, 'clip-1', 'text-mask', 'x', {
      frame: 5,
      value: 0.3,
      easing: linear,
    })).toBe(edited)
  })

  test('rejects direct and multi-parameter key insertions beyond the document budget', () => {
    const capped = documentAtAnimationKeyframeBudget()

    expect(setEffectKeyframe(capped, 'clip-1', 'mask-a', 'x', {
      frame: 5,
      value: 0.25,
      easing: linear,
    })).toBe(capped)
    expect(setClipKeyframe(capped, 'clip-1', 'opacity', {
      frame: 5,
      value: 0.5,
      easing: linear,
    })).toBe(capped)
    expect(updateClipVisualAtFrame(capped, 'clip-1', 15, { opacity: 0.5 }))
      .toBe(capped)
    expect(updateEffectParamsAtFrame(
      capped,
      'clip-1',
      'mask-a',
      15,
      { x: 0.25, y: 0.5 },
    )).toBe(capped)
  })

  test('allows effect-key replacement, movement, and removal at the document budget', () => {
    const capped = documentAtAnimationKeyframeBudget()
    const replaced = setEffectKeyframe(capped, 'clip-1', 'mask-a', 'x', {
      frame: 0,
      value: 0.25,
      easing: linear,
    })
    expect(replaced).not.toBe(capped)
    expect(clipFrom(replaced).animation?.effectTracks
      ?.find((track) => track.effectId === 'mask-a' && track.parameter === 'x')
      ?.keyframes[0].value).toBe(0.25)

    const moved = moveEffectKeyframe(capped, 'clip-1', 'mask-a', 'x', 0, 1)
    expect(moved).not.toBe(capped)
    const removed = removeEffectKeyframe(capped, 'clip-1', 'mask-a', 'x', 0)
    expect(removed).not.toBe(capped)
  })

  test('rejects clip insertion and split when cloned animation crosses the document budget', () => {
    const capped = documentAtAnimationKeyframeBudget()
    const incoming = mediaClip()
    incoming.id = 'clip-incoming'
    incoming.timelineRange = { startFrame: 100, durationFrames: 40 }
    incoming.effects = [createMaskEffect('mask-incoming', 'rectangle')]
    incoming.animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'mask-incoming',
        parameter: 'x',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0, easing: linear }],
      }],
    }

    expect(insertClip(capped, 'track-1', incoming)).toBe(capped)
    expect(splitClipAtFrame(capped, 'clip-1', 20)).toBe(capped)
    expect(clipFrom(capped).animation?.effectTracks?.reduce(
      (total, track) => total + track.keyframes.length,
      clipFrom(capped).animation?.tracks.reduce(
        (total, track) => total + track.keyframes.length,
        0,
      ) ?? 0,
    )).toBe(PROJECT_FILE_LIMITS.maxTotalKeyframes)
  })

  test('rejects reset before clearing tracks when merged defaults exceed descriptor bounds', () => {
    const clip = mediaClip()
    const mask = createMaskEffect('mask-reset-bounds', 'rectangle')
    const { path: _missingPath, ...paramsWithoutPath } = mask.params
    mask.params = { ...paramsWithoutPath }
    for (
      let index = 0;
      Object.keys(mask.params).length < EFFECT_STACK_LIMITS.maxEffectParams;
      index++
    ) mask.params[`future-${index}`] = index
    clip.effects = [mask]
    clip.animation = {
      tracks: [],
      effectTracks: [{
        effectId: mask.id,
        parameter: 'x',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0, easing: linear }],
      }],
    }
    const doc = documentWithClip(clip)

    expect(resetEffect(doc, clip.id, mask.id)).toBe(doc)
    expect(clipFrom(doc).animation?.effectTracks).toHaveLength(1)
    expect(clipFrom(doc).effects[0].params.path).toBeUndefined()
  })

  test('rejects reset when a default path would cross the aggregate string budget', () => {
    const clip = mediaClip()
    const mask = createMaskEffect('mask-reset-strings', 'rectangle')
    Reflect.deleteProperty(mask.params, 'path')
    clip.effects = [mask]
    const existingStrings = Object.values(mask.params).reduce<number>(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0,
    )
    let remaining = EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters
      - DEFAULT_MASK_BEZIER_PATH.length
      + 1
      - existingStrings
    let index = 0
    while (remaining > 0) {
      const length = Math.min(remaining, EFFECT_STACK_LIMITS.maxEffectStringCharacters)
      clip.effects.push({
        id: `string-budget-${index}`,
        type: 'future.opaque',
        version: 1,
        enabled: true,
        params: { value: 'x'.repeat(length) },
      })
      remaining -= length
      index++
    }
    const doc = documentWithClip(clip)

    expect(resetEffect(doc, clip.id, mask.id)).toBe(doc)
    expect(clipFrom(doc).effects[0].params.path).toBeUndefined()
  })
})
