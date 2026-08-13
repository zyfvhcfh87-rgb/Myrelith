import { describe, expect, test } from 'vitest'
import {
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  resolveClipAnimationAtFrame,
} from './clipAnimation'
import { MAX_CLIP_SCALE } from './clipInspector'
import type { GrayFrame } from './motionAnalysis'
import {
  trackPointSequence,
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

function translatedTexturedFrames(): readonly GrayFrame[] {
  const width = 64
  const height = 48
  const texture = new Uint8Array(width * height)
  let state = 0x44a11ce
  for (let index = 0; index < texture.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    texture[index] = state >>> 24
  }
  return [
    { x: 0, y: 0 },
    { x: 2, y: 1 },
    { x: 4, y: 2 },
  ].map((offset) => {
    const data = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const targetX = x + offset.x
        const targetY = y + offset.y
        if (targetX < width && targetY < height) {
          data[targetY * width + targetX] = texture[y * width + x]!
        }
      }
    }
    return { width, height, data }
  })
}

describe('integer-pixel point tracking', () => {
  test('rejects fractional seeds distinctly from integer bounds failures', () => {
    const frames = translatedTexturedFrames()

    expect(() => trackPointSequence(frames, { x: 32.5, y: 24 })).toThrowError(
      new RangeError('Initial tracking point must use safe integer pixel coordinates'),
    )
    expect(() => trackPointSequence(frames, { x: 8, y: 24 })).toThrowError(
      new RangeError('Initial tracking point is outside the analyzable frame region'),
    )
  })

  test('tracks a translated textured target through integral internal matches', () => {
    const result = trackPointSequence(translatedTexturedFrames(), { x: 32, y: 24 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`Unexpected point-tracking failure: ${result.failure.code}`)
    expect(result.samples.map(({ frameIndex, x, y }) => ({ frameIndex, x, y }))).toEqual([
      { frameIndex: 0, x: 32, y: 24 },
      { frameIndex: 1, x: 34, y: 25 },
      { frameIndex: 2, x: 36, y: 26 },
    ])
    expect(result.samples.every((sample) => (
      Number.isSafeInteger(sample.x) && Number.isSafeInteger(sample.y)
    ))).toBe(true)
  })
})

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
    const values = tracks.map((track) => track.keyframes[1]?.value)
    expect(values.slice(0, 2)).toEqual([30, 8])
    expect(values[2]).toBeCloseTo(2.2, 12)
    expect(values[3]).toBeCloseTo(3.6, 12)
  })

  test.each([
    { label: '0 degrees', rotation: 0, mirrored: false, scaleX: 4, scaleY: 3 },
    { label: '+90 degrees', rotation: 90, mirrored: false, scaleX: 2, scaleY: 6 },
    { label: '-90 degrees with source and target mirrors', rotation: -90, mirrored: true, scaleX: 2, scaleY: 6 },
  ])('projects anisotropic source scale at $label into target scale axes', ({
    rotation,
    mirrored,
    scaleX,
    scaleY,
  }) => {
    const source = {
      ...identitySource,
      transform: { ...identitySource.transform, rotation },
      visual: {
        ...visual,
        flipHorizontal: mirrored,
        flipVertical: mirrored,
      },
    }
    const scaledSource = {
      ...source,
      transform: { ...source.transform, scaleX: 2 },
    }
    const target = {
      ...centeredTarget,
      visual: {
        ...centeredTarget.visual,
        flipHorizontal: mirrored,
        flipVertical: mirrored,
      },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, source, { width: 40, height: 20 }),
      sample(10, 100, 50, scaledSource, { width: 40, height: 20 }),
    ], base, { includeScale: true, target })
    const clip = {
      transform: base,
      opacity: 1,
      timelineRange: { startFrame: 0, durationFrames: 11 },
      animation: { tracks, effectTracks: [] },
    } as unknown as Clip
    const resolved = resolveClipAnimationAtFrame(clip, 10)

    expect(resolved.transform.scaleX).toBeCloseTo(scaleX, 12)
    expect(resolved.transform.scaleY).toBeCloseTo(scaleY, 12)
  })

  test('uses target-relative axes for per-sample rotation and anisotropic source scale', () => {
    const targetBase = { ...base, rotation: 30 }
    const initialSource = {
      ...identitySource,
      transform: { ...identitySource.transform, rotation: 30 },
    }
    const changedSource = {
      ...identitySource,
      transform: {
        ...identitySource.transform,
        scaleX: 2,
        rotation: 90,
      },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, initialSource, { width: 40, height: 20 }),
      sample(10, 100, 50, changedSource, { width: 40, height: 20 }),
    ], targetBase, { includeScale: true, target: centeredTarget })
    const clip = {
      transform: targetBase,
      opacity: 1,
      timelineRange: { startFrame: 0, durationFrames: 11 },
      animation: { tracks, effectTracks: [] },
    } as unknown as Clip
    const resolved = resolveClipAnimationAtFrame(clip, 10)

    expect(resolved.transform.scaleX).toBeCloseTo(2 + Math.sqrt(3) / 2, 12)
    expect(resolved.transform.scaleY).toBeCloseTo(1.5 + 6 * Math.sqrt(3), 12)
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
    expect(resolved.transform.scaleX).toBeCloseTo(
      2 * (44 + 36 * Math.sqrt(3)) / (40 + 30 * Math.sqrt(3)),
      12,
    )
    expect(resolved.transform.scaleY).toBeCloseTo(
      3 * (44 * Math.sqrt(3) + 36) / (40 * Math.sqrt(3) + 30),
      12,
    )
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
      scaleX: 1,
      scaleY: MAX_CLIP_SCALE,
    }
    const quarterTurnSource = {
      ...identitySource,
      transform: { ...identitySource.transform, rotation: 90 },
    }
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50, quarterTurnSource, { width: 20, height: 20 }),
      sample(10, 100, 50, quarterTurnSource, { width: 40, height: 20 }),
    ], maximumScaleBase, {
      includeScale: true,
      target: centeredTarget,
    })).toThrow(/Generated scale-y tracking track.*keyframe value must be from/)
  })

  test('does not leak exact quarter-turn growth into an unchanged maximum-scale axis', () => {
    const maximumXBase = {
      ...base,
      scaleX: MAX_CLIP_SCALE,
      scaleY: 1,
    }
    const quarterTurnSource = {
      ...identitySource,
      transform: { ...identitySource.transform, rotation: 90 },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, quarterTurnSource, { width: 20, height: 20 }),
      sample(10, 100, 50, quarterTurnSource, { width: 40, height: 20 }),
    ], maximumXBase, {
      includeScale: true,
      target: centeredTarget,
    })

    expect(tracks.find((track) => track.property === 'scale-x')?.keyframes[1]?.value)
      .toBe(MAX_CLIP_SCALE)
    expect(tracks.find((track) => track.property === 'scale-y')?.keyframes[1]?.value)
      .toBe(2)
  })

  test('retains the exact authored base scale before multiplying extreme extent ratios', () => {
    const halfScaleSource = {
      ...identitySource,
      transform: {
        ...identitySource.transform,
        scaleX: 0.5,
        scaleY: 0.5,
      },
    }
    const tracks = trackingSamplesToAnimationTracks([
      sample(0, 100, 50, halfScaleSource, {
        width: Number.MAX_VALUE,
        height: Number.MAX_VALUE,
      }),
      sample(10, 100, 50, halfScaleSource, {
        width: Number.MAX_VALUE,
        height: Number.MAX_VALUE,
      }),
    ], base, {
      includeScale: true,
      target: centeredTarget,
    })

    expect(tracks.find((track) => track.property === 'scale-x')?.keyframes[0]?.value)
      .toBe(base.scaleX)
    expect(tracks.find((track) => track.property === 'scale-y')?.keyframes[0]?.value)
      .toBe(base.scaleY)
  })

  test.each([
    {
      label: 'non-finite',
      source: {
        ...identitySource,
        transform: { ...identitySource.transform, scaleX: 2 },
      },
      size: { width: Number.MAX_VALUE, height: 20 },
    },
    {
      label: 'zero after underflow',
      source: {
        ...identitySource,
        transform: {
          ...identitySource.transform,
          scaleX: Number.MIN_VALUE,
          scaleY: Number.MIN_VALUE,
        },
      },
      size: { width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    },
  ])('rejects $label projected box extents before scale ratios are emitted', ({
    source,
    size,
  }) => {
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50, identitySource, { width: 20, height: 20 }),
      sample(10, 100, 50, source, size),
    ], base, {
      includeScale: true,
      target: centeredTarget,
    })).toThrow(new RangeError('Projected box tracking extents must be positive and finite'))
  })

  test.each([
    {
      label: 'underflows to zero scale',
      firstSource: {
        ...identitySource,
        transform: {
          ...identitySource.transform,
          scaleX: 0.5,
          scaleY: 0.5,
        },
      },
      firstSize: { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
      secondSource: identitySource,
      secondSize: { width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    },
    {
      label: 'overflows to non-finite scale',
      firstSource: identitySource,
      firstSize: { width: Number.MIN_VALUE, height: Number.MIN_VALUE },
      secondSource: {
        ...identitySource,
        transform: {
          ...identitySource.transform,
          scaleX: 0.5,
          scaleY: 0.5,
        },
      },
      secondSize: { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
    },
  ])('rejects a positive extent ratio that $label', ({
    firstSource,
    firstSize,
    secondSource,
    secondSize,
  }) => {
    expect(() => trackingSamplesToAnimationTracks([
      sample(0, 100, 50, firstSource, firstSize),
      sample(10, 100, 50, secondSource, secondSize),
    ], base, {
      includeScale: true,
      target: centeredTarget,
    })).toThrow(new RangeError('Projected box tracking scales must be positive and finite'))
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
