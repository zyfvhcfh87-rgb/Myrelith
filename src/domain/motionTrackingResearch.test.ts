import { describe, expect, test } from 'vitest'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { trackingSamplesToAnimationTracks } from './motionTrackingResearch'
import type { Clip, Transform } from './schema'

const base: Transform = {
  x: 10,
  y: 20,
  scaleX: 2,
  scaleY: 3,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
}

describe('tracking keyframe projection', () => {
  test('maps point/box deltas only to the existing transform animation vocabulary', () => {
    const tracks = trackingSamplesToAnimationTracks([
      { frame: 0, centerX: 100, centerY: 50, width: 40, height: 20 },
      { frame: 10, centerX: 110, centerY: 46, width: 44, height: 24 },
    ], base, {
      projectUnitsPerSourceX: 2,
      projectUnitsPerSourceY: 3,
      includeScale: true,
    })
    expect(tracks.map((track) => track.property)).toEqual([
      'position-x',
      'position-y',
      'scale-x',
      'scale-y',
    ])
    expect(tracks.map((track) => track.keyframes[1]?.value)).toEqual([
      30,
      8,
      2.2,
      3.6,
    ])
  })

  test('uses ordinary animation interpolation shared by preview and export planning', () => {
    const tracks = trackingSamplesToAnimationTracks([
      { frame: 0, centerX: 10, centerY: 20 },
      { frame: 10, centerX: 20, centerY: 10 },
    ], base, {
      projectUnitsPerSourceX: 1,
      projectUnitsPerSourceY: 1,
      includeScale: false,
    })
    const clip = {
      transform: base,
      opacity: 1,
      timelineRange: { startFrame: 0, durationFrames: 11 },
      animation: { tracks, effectTracks: [] },
    } as unknown as Clip
    const resolved = resolveClipAnimationAtFrame(clip, 5)
    expect(resolved.transform.x).toBeCloseTo(15)
    expect(resolved.transform.y).toBeCloseTo(15)
    expect(resolved.transform.scaleX).toBe(2)
    expect(resolved.transform.scaleY).toBe(3)
  })

  test('rejects duplicate clip-local frames instead of dropping authored samples', () => {
    expect(() => trackingSamplesToAnimationTracks([
      { frame: 4, centerX: 1, centerY: 1 },
      { frame: 4, centerX: 2, centerY: 2 },
    ], base, {
      projectUnitsPerSourceX: 1,
      projectUnitsPerSourceY: 1,
      includeScale: false,
    })).toThrow(/strictly increasing/)
  })
})
