import { describe, expect, test } from 'vitest'
import {
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  resolveClipAnimationAtFrame,
} from './clipAnimation'
import { MAX_CLIP_SCALE } from './clipInspector'
import {
  trackingSamplesToAnimationTracks,
  type TrackingAnimationSample,
  type TrackingAnimationTarget,
  type TrackingSourceProjection,
} from './motionTrackingResearch'
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

const visual = {
  crop: { left: 0, right: 0, top: 0, bottom: 0 },
  flipHorizontal: false,
  flipVertical: false,
}

const identitySource: TrackingSourceProjection = {
  width: 200,
  height: 100,
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
  },
  visual,
}

const centeredTarget: TrackingAnimationTarget = {
  width: 200,
  height: 100,
  visual,
}

function sample(
  frame: number,
  centerX: number,
  centerY: number,
  source: TrackingSourceProjection = identitySource,
  size?: { readonly width: number; readonly height: number },
): TrackingAnimationSample {
  return {
    frame,
    centerX,
    centerY,
    source,
    ...size,
  }
}

function targetVisibleCenter(
  transform: Transform,
  target: TrackingAnimationTarget,
): { readonly x: number; readonly y: number } {
  const visibleCenterX = target.width * (
    target.visual.crop.left
    + (1 - target.visual.crop.left - target.visual.crop.right) / 2
  )
  const visibleCenterY = target.height * (
    target.visual.crop.top
    + (1 - target.visual.crop.top - target.visual.crop.bottom) / 2
  )
  const localX = (visibleCenterX - transform.anchorX * target.width)
    * transform.scaleX
    * (target.visual.flipHorizontal ? -1 : 1)
  const localY = (visibleCenterY - transform.anchorY * target.height)
    * transform.scaleY
    * (target.visual.flipVertical ? -1 : 1)
  const angle = transform.rotation * Math.PI / 180
  return {
    x: transform.x + Math.cos(angle) * localX - Math.sin(angle) * localY,
    y: transform.y + Math.sin(angle) * localX + Math.cos(angle) * localY,
  }
}

describe('tracking keyframe projection', () => {
  test('maps point/box deltas only to the existing transform animation vocabulary', () => {
    const scaledSource = {
      ...identitySource,
      transform: { ...identitySource.transform, scaleX: 2, scaleY: 3 },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, scaledSource, { width: 40, height: 20 }),
      sample(10, 110, 46, scaledSource, { width: 44, height: 24 }),
    ], base, {
      includeScale: true,
      target: centeredTarget,
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
      sample(0, 10, 20),
      sample(10, 20, 10),
    ], base, {
      includeScale: false,
      target: centeredTarget,
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

  test('projects source rotation and flips, then compensates target crop and anchor scaling', () => {
    const source = {
      ...identitySource,
      transform: {
        ...identitySource.transform,
        x: 7,
        y: -3,
        scaleX: 2,
        scaleY: 3,
        rotation: 90,
        anchorX: 0.2,
        anchorY: 0.8,
      },
      visual: {
        ...visual,
        crop: { left: 0.05, right: 0.1, top: 0.1, bottom: 0.05 },
        flipHorizontal: true,
      },
    }
    const target = {
      width: 200,
      height: 100,
      visual: {
        ...visual,
        crop: { left: 0.1, right: 0.3, top: 0.2, bottom: 0 },
        flipHorizontal: true,
      },
    }
    const targetBase = {
      ...base,
      rotation: 30,
      anchorX: 0.25,
      anchorY: 0.75,
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, source, { width: 40, height: 20 }),
      sample(10, 110, 46, source, { width: 44, height: 24 }),
    ], targetBase, { includeScale: true, target })
    const clip = {
      transform: targetBase,
      opacity: 1,
      timelineRange: { startFrame: 0, durationFrames: 11 },
      animation: { tracks, effectTracks: [] },
    } as unknown as Clip
    const resolved = resolveClipAnimationAtFrame(clip, 10)
    const initialCenter = targetVisibleCenter(targetBase, target)
    const resolvedCenter = targetVisibleCenter(resolved.transform, target)

    // R(90 degrees) * diag(-2, 3) * [10, -4] = [12, -20].
    expect(resolvedCenter.x - initialCenter.x).toBeCloseTo(12, 12)
    expect(resolvedCenter.y - initialCenter.y).toBeCloseTo(-20, 12)
    expect(resolved.transform.scaleX).toBeCloseTo(2.2, 12)
    expect(resolved.transform.scaleY).toBeCloseTo(3.6, 12)
  })

  test('uses the source transform resolved for each accepted sample', () => {
    const movedSource = {
      ...identitySource,
      transform: { ...identitySource.transform, x: 5, y: -7 },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50),
      sample(10, 100, 50, movedSource),
    ], base, {
      includeScale: false,
      target: centeredTarget,
    })
    expect(tracks.map((track) => track.keyframes[1]?.value)).toEqual([15, 13])
  })

  test('rejects duplicate clip-local frames instead of dropping authored samples', () => {
    expect(() => trackingSamplesToAnimationTracks([
      sample(4, 1, 1),
      sample(4, 2, 2),
    ], base, {
      includeScale: false,
      target: centeredTarget,
    })).toThrow(/strictly increasing/)
  })

  test('rejects mapped frames above the canonical animation ceiling', () => {
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50),
      sample(MAX_KEYFRAME_FRAME + 1, 101, 50),
    ], base, {
      includeScale: false,
      target: centeredTarget,
    })).toThrow(/Generated position-x tracking track.*keyframe frame must be/)
  })

  test('rejects box growth above the canonical clip-scale bound', () => {
    const maximumScaleBase = {
      ...base,
      scaleX: MAX_CLIP_SCALE,
      scaleY: MAX_CLIP_SCALE,
    }
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50, identitySource, { width: 20, height: 20 }),
      sample(10, 100, 50, identitySource, { width: 20, height: 40 }),
    ], maximumScaleBase, {
      includeScale: true,
      target: centeredTarget,
    })).toThrow(/Generated scale-y tracking track.*keyframe value must be from/)
  })

  test('rejects projected position above the canonical finite bound', () => {
    const distantSource = {
      ...identitySource,
      transform: {
        ...identitySource.transform,
        y: MAX_ANIMATED_FINITE_MAGNITUDE,
      },
    }
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50),
      sample(10, 100, 50, distantSource),
    ], base, {
      includeScale: false,
      target: centeredTarget,
    })).toThrow(/Generated position-y tracking track.*finite project bound/)
  })
})
