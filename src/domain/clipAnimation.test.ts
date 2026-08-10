import { describe, expect, test } from 'vitest'
import type {
  Clip,
  ClipAnimation,
  ClipAnimationEasing,
  ClipAnimationTrack,
} from './schema'
import {
  animationEasingProgress,
  clipAnimationValidationError,
  evaluateAnimationTrack,
  MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP,
  moveAnimationKeyframe,
  removeAnimationKeyframe,
  resolveClipAnimationAtFrame,
  shiftClipAnimation,
  upsertAnimationKeyframe,
} from './clipAnimation'

const linear = { type: 'linear' } as const

function mediaClip(animation: ClipAnimation): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Animated clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    timelineRange: { startFrame: 100, durationFrames: 40 },
    transform: {
      x: -10,
      y: 5,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    animation,
    effects: [],
  }
}

function positionTrack(easing: ClipAnimationEasing = linear): ClipAnimationTrack {
  return {
    property: 'position-x',
    keyframes: [
      { frame: 0, value: 0, easing },
      { frame: 10, value: 100, easing: linear },
    ],
  }
}

describe('clip animation evaluator', () => {
  test('holds boundaries and linearly interpolates exact integer frames', () => {
    const track = positionTrack()

    expect(evaluateAnimationTrack(track, -5, -10)).toBe(0)
    expect(evaluateAnimationTrack(track, 0, -10)).toBe(0)
    expect(evaluateAnimationTrack(track, 5, -10)).toBe(50)
    expect(evaluateAnimationTrack(track, 10, -10)).toBe(100)
    expect(evaluateAnimationTrack(track, 15, -10)).toBe(100)
  })

  test('supports hold and deterministic cubic-bezier easing', () => {
    expect(evaluateAnimationTrack(positionTrack({ type: 'hold' }), 9, -10)).toBe(0)
    expect(evaluateAnimationTrack(positionTrack({
      type: 'cubic-bezier',
      x1: 0.42,
      y1: 0,
      x2: 1,
      y2: 1,
    }), 5, -10)).toBeLessThan(50)
    expect(animationEasingProgress({
      type: 'cubic-bezier',
      x1: 0.25,
      y1: 0.1,
      x2: 0.25,
      y2: 1,
    }, 0.5)).toBe(animationEasingProgress({
      type: 'cubic-bezier',
      x1: 0.25,
      y1: 0.1,
      x2: 0.25,
      y2: 1,
    }, 0.5))
  })

  test('resolves all animated properties without mutating the durable clip', () => {
    const clip = mediaClip({
      tracks: [
        positionTrack(),
        {
          property: 'opacity',
          keyframes: [
            { frame: 0, value: 1, easing: linear },
            { frame: 10, value: 0, easing: linear },
          ],
        },
      ],
    })

    const resolved = resolveClipAnimationAtFrame(clip, 105)

    expect(resolved.transform.x).toBe(50)
    expect(resolved.opacity).toBe(0.5)
    expect(clip.transform.x).toBe(-10)
    expect(clip.opacity).toBe(1)
  })

  test('replaces duplicate times and target-time keys with explicit semantics', () => {
    const original: ClipAnimation = { tracks: [positionTrack()] }
    const replaced = upsertAnimationKeyframe(original, 'position-x', {
      frame: 10,
      value: 250,
      easing: { type: 'hold' },
    })
    const moved = replaced && moveAnimationKeyframe(replaced, 'position-x', 0, 10)

    expect(replaced?.tracks[0].keyframes).toHaveLength(2)
    expect(replaced?.tracks[0].keyframes[1]).toMatchObject({ frame: 10, value: 250 })
    expect(moved?.tracks[0].keyframes).toEqual([
      { frame: 10, value: 0, easing: linear },
    ])

    const single: ClipAnimation = {
      tracks: [{
        property: 'rotation',
        keyframes: [{ frame: 0, value: 12, easing: linear }],
      }],
    }
    expect(moveAnimationKeyframe(single, 'rotation', 0, 5)?.tracks[0].keyframes[0].frame)
      .toBe(5)
  })

  test('removes empty tracks and shifts local time without changing curve geometry', () => {
    const original: ClipAnimation = { tracks: [positionTrack()] }
    const shifted = shiftClipAnimation(original, -4)
    const removed = removeAnimationKeyframe({
      tracks: [{
        property: 'rotation',
        keyframes: [{ frame: 0, value: 12, easing: linear }],
      }],
    }, 'rotation', 0)

    expect(shifted).not.toBeNull()
    if (!shifted) return
    expect(evaluateAnimationTrack(shifted.tracks[0], 1, 0))
      .toBe(evaluateAnimationTrack(original.tracks[0], 5, 0))
    expect(removed).toEqual({ tracks: [], effectTracks: [] })
  })

  test('rejects invalid easing, values, ordering, and duplicate times', () => {
    expect(clipAnimationValidationError({
      tracks: [{
        property: 'opacity',
        keyframes: [
          { frame: 0, value: 2, easing: linear },
          { frame: 0, value: 0, easing: linear },
        ],
      }],
    })).toMatch(/opacity|strictly increasing/)
    expect(clipAnimationValidationError({
      tracks: [{
        property: 'position-x',
        keyframes: [{
          frame: 0,
          value: 0,
          easing: { type: 'cubic-bezier', x1: -1, y1: 0, x2: 1, y2: 1 },
        }],
      }],
    })).toMatch(/from 0 to 1/)
  })

  test('bounds effect-animation tracks per clip without resolving their targets', () => {
    const effectTracks = Array.from(
      { length: MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP + 1 },
      (_unused, index) => ({
        effectId: `future-effect-${index}`,
        parameter: 'future-scalar',
        keyframes: [{ frame: 0, value: index, easing: linear }],
      }),
    )

    expect(clipAnimationValidationError({ tracks: [], effectTracks }))
      .toBe(`clip animation exceeds ${MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP} effect tracks`)
  })
})
