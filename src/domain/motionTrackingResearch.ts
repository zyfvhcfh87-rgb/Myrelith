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
  animationTrackValidationError,
  LINEAR_ANIMATION_EASING,
  MAX_KEYFRAMES_PER_TRACK,
} from './clipAnimation'
import { cropInsetsValidationError } from './clipInspector'
import type {
  ClipAnimationTrack,
  ClipVisualSettings,
  Transform,
} from './schema'

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

function isIntegerPixelPoint(point: MotionPoint): boolean {
  return Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y)
}

function validPointInFrame(frame: GrayFrame, point: MotionPoint, margin: number): boolean {
  return isIntegerPixelPoint(point)
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
  if (!isIntegerPixelPoint(initialPoint)) {
    throw new RangeError('Initial tracking point must use safe integer pixel coordinates')
  }
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
  /** Resolved source geometry for this exact accepted sample. */
  readonly source: TrackingSourceProjection
}

type TrackingVisualProjection = Pick<
  ClipVisualSettings,
  'crop' | 'flipHorizontal' | 'flipVertical'
>

export interface TrackingSourceProjection {
  /** Full source dimensions; sample centers use this same pixel space. */
  readonly width: number
  readonly height: number
  readonly transform: Transform
  readonly visual: TrackingVisualProjection
}

export interface TrackingAnimationTarget {
  /** Full target dimensions used to locate its cropped visible center. */
  readonly width: number
  readonly height: number
  readonly visual: TrackingVisualProjection
}

export interface TrackingAnimationMapping {
  readonly includeScale: boolean
  readonly target: TrackingAnimationTarget
}

function linearKeyframe(frame: number, value: number) {
  return { frame, value, easing: { ...LINEAR_ANIMATION_EASING } }
}

function validateGeneratedTracks(tracks: ClipAnimationTrack[]): ClipAnimationTrack[] {
  for (const track of tracks) {
    const error = animationTrackValidationError(track)
    if (error) {
      throw new RangeError(`Generated ${track.property} tracking track is invalid: ${error}`)
    }
  }
  return tracks
}

function positiveDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function projectionValidationError(
  projection: TrackingSourceProjection | TrackingAnimationTarget,
): string | null {
  if (!Number.isSafeInteger(projection.width) || projection.width <= 0) {
    return 'width must be a positive safe integer'
  }
  if (!Number.isSafeInteger(projection.height) || projection.height <= 0) {
    return 'height must be a positive safe integer'
  }
  const cropError = cropInsetsValidationError(projection.visual.crop)
  if (cropError) return cropError
  if (typeof projection.visual.flipHorizontal !== 'boolean') {
    return 'flipHorizontal must be a boolean'
  }
  if (typeof projection.visual.flipVertical !== 'boolean') {
    return 'flipVertical must be a boolean'
  }
  return null
}

function transformProjectionValidationError(transform: Transform): string | null {
  for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const) {
    if (!Number.isFinite(transform[key])) return `transform.${key} must be finite`
  }
  if (transform.scaleX <= 0 || transform.scaleY <= 0) {
    return 'transform scales must be positive'
  }
  for (const key of ['anchorX', 'anchorY'] as const) {
    if (!Number.isFinite(transform[key]) || transform[key] < 0 || transform[key] > 1) {
      return `transform.${key} must be finite from 0 to 1`
    }
  }
  return null
}

function projectSourceCenter(sample: TrackingAnimationSample): {
  readonly x: number
  readonly y: number
} {
  const { source } = sample
  const transformError = transformProjectionValidationError(source.transform)
  if (transformError) throw new RangeError(`Tracking source ${transformError}`)
  const projectionError = projectionValidationError(source)
  if (projectionError) throw new RangeError(`Tracking source ${projectionError}`)
  const anchorX = source.transform.anchorX * source.width
  const anchorY = source.transform.anchorY * source.height
  const localX = (sample.centerX - anchorX)
    * source.transform.scaleX
    * (source.visual.flipHorizontal ? -1 : 1)
  const localY = (sample.centerY - anchorY)
    * source.transform.scaleY
    * (source.visual.flipVertical ? -1 : 1)
  const angle = source.transform.rotation * Math.PI / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: -source.width / 2 + anchorX + source.transform.x
      + cosine * localX - sine * localY,
    y: -source.height / 2 + anchorY + source.transform.y
      + sine * localX + cosine * localY,
  }
}

function targetVisibleCenterOffset(
  base: Transform,
  target: TrackingAnimationTarget,
  scaleX: number,
  scaleY: number,
): { readonly x: number; readonly y: number } {
  const visibleCenterX = target.width * (
    target.visual.crop.left
    + (1 - target.visual.crop.left - target.visual.crop.right) / 2
  )
  const visibleCenterY = target.height * (
    target.visual.crop.top
    + (1 - target.visual.crop.top - target.visual.crop.bottom) / 2
  )
  const localX = (visibleCenterX - base.anchorX * target.width)
    * scaleX
    * (target.visual.flipHorizontal ? -1 : 1)
  const localY = (visibleCenterY - base.anchorY * target.height)
    * scaleY
    * (target.visual.flipVertical ? -1 : 1)
  const angle = base.rotation * Math.PI / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: cosine * localX - sine * localY,
    y: sine * localX + cosine * localY,
  }
}

function projectSourceBoxExtents(
  sample: TrackingAnimationSample,
  targetRotation: number,
): { readonly x: number; readonly y: number } {
  // Express the transformed source box's support extents in the target's
  // rotation-local axes. Mirror signs disappear because size is unsigned.
  const sourceWidth = sample.width! * sample.source.transform.scaleX
  const sourceHeight = sample.height! * sample.source.transform.scaleY
  const relativeRotation = ((
    sample.source.transform.rotation % 360
    - targetRotation % 360
  ) % 360 + 360) % 360
  let cosine: number
  let sine: number
  if (relativeRotation === 0 || relativeRotation === 180) {
    cosine = 1
    sine = 0
  } else if (relativeRotation === 90 || relativeRotation === 270) {
    cosine = 0
    sine = 1
  } else {
    const relativeAngle = relativeRotation * Math.PI / 180
    cosine = Math.abs(Math.cos(relativeAngle))
    sine = Math.abs(Math.sin(relativeAngle))
  }
  const extents = {
    x: cosine * sourceWidth + sine * sourceHeight,
    y: sine * sourceWidth + cosine * sourceHeight,
  }
  if (
    !Number.isFinite(extents.x)
    || !Number.isFinite(extents.y)
    || extents.x <= 0
    || extents.y <= 0
  ) {
    throw new RangeError('Projected box tracking extents must be positive and finite')
  }
  return extents
}

/**
 * Projects accepted, clip-local tracking samples onto the existing scalar
 * animation vocabulary. Each center is mapped through the source clip's exact
 * resolved transform. Box scale is projected onto target-local axes relative to
 * the target rotation, then Position X/Y compensates for scaling the target's
 * cropped visible center around its authored anchor. The caller owns source-time
 * -> clip-frame mapping and must invoke this only after analysis has completed
 * and passed review.
 */
export function trackingSamplesToAnimationTracks(
  samples: readonly TrackingAnimationSample[],
  base: Transform,
  mapping: TrackingAnimationMapping,
): ClipAnimationTrack[] {
  if (samples.length < 2 || samples.length > MAX_KEYFRAMES_PER_TRACK) {
    throw new RangeError(`Tracking needs 2 to ${MAX_KEYFRAMES_PER_TRACK} mapped samples`)
  }
  positiveDimension(mapping.target.width, 'Tracking target width')
  positiveDimension(mapping.target.height, 'Tracking target height')
  const targetError = projectionValidationError(mapping.target)
  if (targetError) throw new RangeError(`Tracking target ${targetError}`)
  const baseError = transformProjectionValidationError(base)
  if (baseError) throw new RangeError(`Tracking target ${baseError}`)
  const first = samples[0]!
  const firstProjectCenter = projectSourceCenter(first)
  let previousFrame = -1
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.frame) || sample.frame < 0 || sample.frame <= previousFrame) {
      throw new RangeError('Tracking sample frames must be strictly increasing non-negative integers')
    }
    if (!Number.isFinite(sample.centerX) || !Number.isFinite(sample.centerY)) {
      throw new RangeError('Tracking sample centers must be finite')
    }
    projectSourceCenter(sample)
    previousFrame = sample.frame
  }
  let scales: readonly { readonly x: number; readonly y: number }[] | null = null
  if (mapping.includeScale) {
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
    const projectedExtents = samples.map((sample) => (
      projectSourceBoxExtents(sample, base.rotation)
    ))
    const firstProjectedExtents = projectedExtents[0]!
    scales = projectedExtents.map((extents, index) => {
      const scale = index === 0
        ? { x: base.scaleX, y: base.scaleY }
        : {
            x: extents.x / firstProjectedExtents.x * base.scaleX,
            y: extents.y / firstProjectedExtents.y * base.scaleY,
          }
      if (
        !Number.isFinite(scale.x)
        || !Number.isFinite(scale.y)
        || scale.x <= 0
        || scale.y <= 0
      ) {
        throw new RangeError('Projected box tracking scales must be positive and finite')
      }
      return scale
    })
  }
  const baseTargetOffset = targetVisibleCenterOffset(
    base,
    mapping.target,
    base.scaleX,
    base.scaleY,
  )
  const positions = samples.map((sample, index) => {
    const projectCenter = projectSourceCenter(sample)
    const scale = scales?.[index] ?? { x: base.scaleX, y: base.scaleY }
    const targetOffset = targetVisibleCenterOffset(
      base,
      mapping.target,
      scale.x,
      scale.y,
    )
    return {
      x: base.x + projectCenter.x - firstProjectCenter.x
        + baseTargetOffset.x - targetOffset.x,
      y: base.y + projectCenter.y - firstProjectCenter.y
        + baseTargetOffset.y - targetOffset.y,
    }
  })
  const tracks: ClipAnimationTrack[] = [
    {
      property: 'position-x',
      keyframes: samples.map((sample, index) => linearKeyframe(
        sample.frame,
        positions[index]!.x,
      )),
    },
    {
      property: 'position-y',
      keyframes: samples.map((sample, index) => linearKeyframe(
        sample.frame,
        positions[index]!.y,
      )),
    },
  ]
  if (!mapping.includeScale) return validateGeneratedTracks(tracks)
  tracks.push(
    {
      property: 'scale-x',
      keyframes: samples.map((sample, index) => linearKeyframe(
        sample.frame,
        scales![index]!.x,
      )),
    },
    {
      property: 'scale-y',
      keyframes: samples.map((sample, index) => linearKeyframe(
        sample.frame,
        scales![index]!.y,
      )),
    },
  )
  return validateGeneratedTracks(tracks)
}
