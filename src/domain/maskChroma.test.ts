import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  createChromaKeyEffect,
  createMaskEffect,
  resolveCanvasEffectStack,
} from './effectStack'
import { applyOrderedPixelEffectsToRgba } from './effectPixels'
import { defaultClipAnimation, resolveClipAnimationAtFrame } from './clipAnimation'
import {
  removeEffect,
  retimeClip,
  resetEffect,
  setEffectKeyframe,
  splitClipAtFrame,
  trimClip,
  updateEffectParamsAtFrame,
} from './operations'
import { defaultTextProps } from './textOverlay'

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
})
