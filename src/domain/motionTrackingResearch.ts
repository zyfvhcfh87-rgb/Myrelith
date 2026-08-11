/** Pure point/box tracking feasibility helpers and keyframe projection. */

import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  applySimilarityTransform,
  estimateSimilarityFromMatches,
  matchMotionFeatures,
  validateMotionFrameSequence,
  type GrayFrame,
  type MotionAnalysisBudget,
  type MotionAnalysisCancellationCheck,
  type MotionPoint,
} from './motionAnalysis'
import {
  LINEAR_ANIMATION_EASING,
  MAX_KEYFRAMES_PER_TRACK,
} from './clipAnimation'
import type { ClipAnimationTrack, Transform } from './schema'

export interface PointTrackingSample extends MotionPoint {
  readonly frameIndex: number
  readonly confidence: number
}

export interface TrackingBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BoxTrackingSample extends TrackingBox {
  readonly frameIndex: number
  readonly confidence: number
}

export interface TrackingFailure {
  readonly frameIndex: number
  readonly code: 'lost-point' | 'lost-box' | 'low-confidence'
  readonly detail: string
}

export type PointTrackingResult =
  | { readonly ok: true; readonly samples: readonly PointTrackingSample[] }
  | {
      readonly ok: false
      readonly samples: readonly PointTrackingSample[]
      readonly failure: TrackingFailure
    }

export type BoxTrackingResult =
  | { readonly ok: true; readonly samples: readonly BoxTrackingSample[] }
  | {
      readonly ok: false
      readonly samples: readonly BoxTrackingSample[]
      readonly failure: TrackingFailure
    }

function validPointInFrame(frame: GrayFrame, point: MotionPoint, margin: number): boolean {
  return Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x >= margin
    && point.y >= margin
    && point.x < frame.width - margin
    && point.y < frame.height - margin
}

function pointConfidence(meanAbsoluteError: number): number {
  return Math.max(0, Math.min(1, 1 - meanAbsoluteError / 48))
}

export function trackPointSequence(
  frames: readonly GrayFrame[],
  initialPoint: MotionPoint,
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (completedFrames: number, totalFrames: number) => void,
): PointTrackingResult {
  validateMotionFrameSequence(frames, budget)
  const margin = budget.patchRadius + budget.searchRadius + 1
  if (!validPointInFrame(frames[0]!, initialPoint, margin)) {
    throw new RangeError('Initial tracking point is outside the analyzable frame region')
  }
  const samples: PointTrackingSample[] = [{
    frameIndex: 0,
    x: initialPoint.x,
    y: initialPoint.y,
    confidence: 1,
  }]
  let point = { ...initialPoint }
  for (let index = 1; index < frames.length; index++) {
    const matches = matchMotionFeatures(
      frames[index - 1]!,
      frames[index]!,
      [point],
      budget,
      cancelled,
    )
    const match = matches[0]
    if (!match || !validPointInFrame(frames[index]!, match.to, margin)) {
      return {
        ok: false,
        samples,
        failure: {
          frameIndex: index,
          code: 'lost-point',
          detail: 'Forward/backward patch agreement failed.',
        },
      }
    }
    const confidence = pointConfidence(match.meanAbsoluteError)
    if (confidence < 0.35) {
      return {
        ok: false,
        samples,
        failure: {
          frameIndex: index,
          code: 'low-confidence',
          detail: 'Point patch error exceeded the reviewed confidence floor.',
        },
      }
    }
    point = { ...match.to }
    samples.push({ frameIndex: index, ...point, confidence })
    onProgress?.(index + 1, frames.length)
  }
  return { ok: true, samples }
}

function validateTrackingBox(frame: GrayFrame, box: TrackingBox, margin: number): void {
  if (
    !Number.isFinite(box.x)
    || !Number.isFinite(box.y)
    || !Number.isFinite(box.width)
    || !Number.isFinite(box.height)
    || box.width < 12
    || box.height < 12
    || box.x < margin
    || box.y < margin
    || box.x + box.width >= frame.width - margin
    || box.y + box.height >= frame.height - margin
  ) {
    throw new RangeError('Initial tracking box is outside the analyzable frame region')
  }
}

function boxSeedPoints(box: TrackingBox): MotionPoint[] {
  const fractions = [0.2, 0.4, 0.6, 0.8]
  return fractions.flatMap((vertical) => fractions.map((horizontal) => ({
    x: Math.round(box.x + box.width * horizontal),
    y: Math.round(box.y + box.height * vertical),
  })))
}

function transformBox(box: TrackingBox, a: number, b: number, tx: number, ty: number): TrackingBox {
  const center = applySimilarityTransform(
    { a, b, tx, ty },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  const scale = Math.hypot(a, b)
  const width = box.width * scale
  const height = box.height * scale
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  }
}

export function trackBoxSequence(
  frames: readonly GrayFrame[],
  initialBox: TrackingBox,
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (completedFrames: number, totalFrames: number) => void,
): BoxTrackingResult {
  validateMotionFrameSequence(frames, budget)
  const margin = budget.patchRadius + budget.searchRadius + 1
  validateTrackingBox(frames[0]!, initialBox, margin)
  const samples: BoxTrackingSample[] = [{
    frameIndex: 0,
    ...initialBox,
    confidence: 1,
  }]
  let box = { ...initialBox }
  let points = boxSeedPoints(initialBox)
  for (let index = 1; index < frames.length; index++) {
    const matches = matchMotionFeatures(
      frames[index - 1]!,
      frames[index]!,
      points,
      budget,
      cancelled,
    )
    const estimate = estimateSimilarityFromMatches(matches, budget, cancelled)
    if (!estimate || estimate.confidence < 0.25) {
      return {
        ok: false,
        samples,
        failure: {
          frameIndex: index,
          code: estimate ? 'low-confidence' : 'lost-box',
          detail: 'The box no longer has enough mutually consistent tracked patches.',
        },
      }
    }
    box = transformBox(
      box,
      estimate.transform.a,
      estimate.transform.b,
      estimate.transform.tx,
      estimate.transform.ty,
    )
    if (
      box.width < 8
      || box.height < 8
      || box.x < margin
      || box.y < margin
      || box.x + box.width >= frames[index]!.width - margin
      || box.y + box.height >= frames[index]!.height - margin
    ) {
      return {
        ok: false,
        samples,
        failure: {
          frameIndex: index,
          code: 'lost-box',
          detail: 'The tracked box left the bounded analyzable region.',
        },
      }
    }
    points = boxSeedPoints(box)
    samples.push({ frameIndex: index, ...box, confidence: estimate.confidence })
    onProgress?.(index + 1, frames.length)
  }
  return { ok: true, samples }
}

export interface TrackingAnimationSample {
  readonly frame: number
  readonly centerX: number
  readonly centerY: number
  readonly width?: number
  readonly height?: number
}

export interface TrackingAnimationMapping {
  readonly projectUnitsPerSourceX: number
  readonly projectUnitsPerSourceY: number
  readonly includeScale: boolean
}

function linearKeyframe(frame: number, value: number) {
  return { frame, value, easing: { ...LINEAR_ANIMATION_EASING } }
}

/**
 * Projects accepted, clip-local tracking samples onto the existing scalar
 * animation vocabulary. The caller owns source-time -> clip-frame mapping and
 * must invoke this only after analysis has completed and passed review.
 */
export function trackingSamplesToAnimationTracks(
  samples: readonly TrackingAnimationSample[],
  base: Transform,
  mapping: TrackingAnimationMapping,
): ClipAnimationTrack[] {
  if (samples.length < 2 || samples.length > MAX_KEYFRAMES_PER_TRACK) {
    throw new RangeError(`Tracking needs 2 to ${MAX_KEYFRAMES_PER_TRACK} mapped samples`)
  }
  if (
    !Number.isFinite(mapping.projectUnitsPerSourceX)
    || mapping.projectUnitsPerSourceX <= 0
    || !Number.isFinite(mapping.projectUnitsPerSourceY)
    || mapping.projectUnitsPerSourceY <= 0
  ) throw new RangeError('Tracking source/project mapping must be finite and positive')
  const first = samples[0]!
  let previousFrame = -1
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.frame) || sample.frame < 0 || sample.frame <= previousFrame) {
      throw new RangeError('Tracking sample frames must be strictly increasing non-negative integers')
    }
    if (!Number.isFinite(sample.centerX) || !Number.isFinite(sample.centerY)) {
      throw new RangeError('Tracking sample centers must be finite')
    }
    previousFrame = sample.frame
  }
  const tracks: ClipAnimationTrack[] = [
    {
      property: 'position-x',
      keyframes: samples.map((sample) => linearKeyframe(
        sample.frame,
        base.x + (sample.centerX - first.centerX) * mapping.projectUnitsPerSourceX,
      )),
    },
    {
      property: 'position-y',
      keyframes: samples.map((sample) => linearKeyframe(
        sample.frame,
        base.y + (sample.centerY - first.centerY) * mapping.projectUnitsPerSourceY,
      )),
    },
  ]
  if (!mapping.includeScale) return tracks
  if (
    !Number.isFinite(first.width)
    || !Number.isFinite(first.height)
    || first.width! <= 0
    || first.height! <= 0
    || samples.some((sample) => (
      !Number.isFinite(sample.width)
      || !Number.isFinite(sample.height)
      || sample.width! <= 0
      || sample.height! <= 0
    ))
  ) throw new RangeError('Box tracking scale mapping needs positive finite sample sizes')
  tracks.push(
    {
      property: 'scale-x',
      keyframes: samples.map((sample) => linearKeyframe(
        sample.frame,
        base.scaleX * sample.width! / first.width!,
      )),
    },
    {
      property: 'scale-y',
      keyframes: samples.map((sample) => linearKeyframe(
        sample.frame,
        base.scaleY * sample.height! / first.height!,
      )),
    },
  )
  return tracks
}
