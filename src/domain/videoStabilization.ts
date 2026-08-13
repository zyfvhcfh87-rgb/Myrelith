/** Pure product planning for bounded similarity-transform video stabilization. */

import {
  clipAnimation,
  clipAnimationValidationError,
  documentAnimationKeyframeGrowthAllowed,
  MAX_KEYFRAMES_PER_TRACK,
} from './clipAnimation'
import {
  clipVisualSettings,
  clipVisualSettingsValidationError,
  MAX_CLIP_SCALE,
  transformScaleValidationError,
} from './clipInspector'
import {
  composeSimilarityTransforms,
  invertSimilarityTransform,
  rootMeanSquareSecondDifference,
  similarityFromPathSample,
  similarityPathSample,
  type GlobalMotionEstimate,
  type SimilarityPathSample,
  type SimilarityTransform,
} from './motionAnalysis'
import { MAX_ANALYSIS_SAMPLES } from './analysisCache'
import type {
  Clip,
  ClipAnimationProperty,
  ClipAnimationTrack,
  FrameRate,
  TimelineDoc,
  Transform,
} from './schema'
import {
  clipSourceTimeMap,
  SOURCE_TIME_TICKS_PER_FRAME,
  sourceFrameAtTimelineOffset,
  sourceTicksAtTimelineOffset,
  sourceTimeSpeedPointsAtClip,
  timelineOffsetAtSourceTicks,
} from './sourceTimeMap'
import { microsecondsToFrames } from './time'

export const VIDEO_STABILIZATION_RESULT_VERSION = 1
export const VIDEO_STABILIZATION_ALGORITHM_ID = 'builtin.video-stabilization'
export const VIDEO_STABILIZATION_ALGORITHM_VERSION = 'similarity-product-v1'
export const MAX_STABILIZATION_SAFE_ZOOM = 1.35
export const STABILIZATION_CORNER_TOLERANCE_PX = 0.5
export const STABILIZATION_SOURCE_PROJECTION_TOLERANCE_PX = 0.25
export const STABILIZATION_ROTATION_TOLERANCE_DEGREES = 0.05
export const STABILIZATION_SCALE_TOLERANCE_RATIO = 0.0005
export const MAX_STABILIZATION_SIMPLIFICATION_COMPARISONS = 4_000_000
const PRE_ZOOM_CORNER_TOLERANCE_PX = STABILIZATION_CORNER_TOLERANCE_PX
  / MAX_STABILIZATION_SAFE_ZOOM

export const VIDEO_STABILIZATION_PROPERTIES = [
  'position-x',
  'position-y',
  'rotation',
  'scale-x',
  'scale-y',
] as const satisfies readonly ClipAnimationProperty[]

export interface VideoStabilizationAnalysisSample {
  readonly timestampUs: number
  readonly estimateFromPrevious: GlobalMotionEstimate | null
}

export interface VideoStabilizationAnalysis {
  readonly version: typeof VIDEO_STABILIZATION_RESULT_VERSION
  readonly width: number
  readonly height: number
  readonly samples: readonly VideoStabilizationAnalysisSample[]
}

export interface VideoStabilizationSettings {
  readonly strengthPercent: number
  readonly smoothingRadiusFrames: number
}

export interface VideoStabilizationSource {
  readonly width: number
  readonly height: number
  readonly firstTimestampUs: number
  readonly frameRate: FrameRate
}

export interface VideoStabilizationFrame {
  readonly frame: number
  readonly sourceTimeTicks: number
  readonly transform: Transform
  readonly easing: 'linear' | 'hold'
}

export interface VideoStabilizationPlan {
  readonly settings: VideoStabilizationSettings
  readonly safeZoom: number
  readonly requiredCropRatio: number
  readonly sampleCount: number
  readonly retainedKeyframeCount: number
  readonly replacementRequired: boolean
  readonly jitterReductionRatio: number
  readonly frames: readonly VideoStabilizationFrame[]
  readonly tracks: readonly ClipAnimationTrack[]
}

export type VideoStabilizationPlanResult =
  | { readonly ok: true; readonly plan: VideoStabilizationPlan }
  | { readonly ok: false; readonly reason: string }

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function finiteTransform(transform: Transform): boolean {
  return Object.values(transform).every(Number.isFinite)
}

export function videoStabilizationAvailabilityReason(
  doc: TimelineDoc,
  clip: Clip,
  source: VideoStabilizationSource | null,
): string | null {
  if (clip.text !== undefined || clip.sourceMode !== 'timed') {
    return 'Stabilization is available only for timed video clips.'
  }
  if (clip.timelineRange.durationFrames < 2) {
    return 'Stabilization needs a clip with at least 2 frames.'
  }
  if (clip.timelineRange.durationFrames > MAX_ANALYSIS_SAMPLES) {
    return `Stabilization is limited to ${MAX_ANALYSIS_SAMPLES.toLocaleString('en-US')} clip frames per run.`
  }
  if (
    !source
    || !positiveSafeInteger(source.width)
    || !positiveSafeInteger(source.height)
    || !Number.isSafeInteger(source.firstTimestampUs)
    || !positiveSafeInteger(source.frameRate.num)
    || !positiveSafeInteger(source.frameRate.den)
  ) return 'Stabilization needs a connected video source with exact dimensions and timing.'
  if (!positiveSafeInteger(doc.width) || !positiveSafeInteger(doc.height)) {
    return 'Stabilization needs valid positive project dimensions.'
  }
  const visualError = clipVisualSettingsValidationError(clipVisualSettings(clip))
  if (visualError) return `Stabilization cannot use this crop: ${visualError}.`
  const scaleError = transformScaleValidationError(clip.transform)
  if (scaleError || !finiteTransform(clip.transform)) {
    return 'Stabilization needs a valid finite clip transform.'
  }
  if (clip.transform.scaleX <= 0 || clip.transform.scaleX !== clip.transform.scaleY) {
    return 'Stabilization needs equal positive Scale X and Scale Y values.'
  }
  const animationError = clipAnimationValidationError(clipAnimation(clip))
  if (animationError) return `Stabilization cannot replace invalid animation: ${animationError}.`
  return null
}

function safeBigIntNumber(value: bigint, label: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range`)
  }
  return Number(value)
}

export function timestampToSourceTicks(
  timestampUs: number,
  source: Pick<VideoStabilizationSource, 'firstTimestampUs'>,
  projectFrameRate: FrameRate,
): number {
  if (!Number.isSafeInteger(timestampUs) || timestampUs < source.firstTimestampUs) {
    throw new RangeError('Analysis timestamp is outside the connected source')
  }
  // WebCodecs timestamps are integer microseconds, so exact CFR boundaries
  // such as 1/30 s may arrive one microsecond below their rational value.
  // Re-enter the editor through its canonical nearest-frame time adapter.
  const sourceFrame = microsecondsToFrames(
    timestampUs - source.firstTimestampUs,
    projectFrameRate,
  )
  const ticks = BigInt(sourceFrame) * BigInt(SOURCE_TIME_TICKS_PER_FRAME)
  return safeBigIntNumber(ticks, 'Analysis source time')
}

export function sourceTicksToTimestamp(
  sourceTimeTicks: number,
  source: Pick<VideoStabilizationSource, 'firstTimestampUs'>,
  projectFrameRate: FrameRate,
  rounding: 'floor' | 'ceil',
): number {
  if (!Number.isSafeInteger(sourceTimeTicks) || sourceTimeTicks < 0) {
    throw new RangeError('Mapped source time must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(source.firstTimestampUs)) {
    throw new RangeError('Connected source timestamp exceeds the safe integer range')
  }
  if (!positiveSafeInteger(projectFrameRate.num) || !positiveSafeInteger(projectFrameRate.den)) {
    throw new RangeError('Project frame rate must be a positive rational')
  }
  const numerator = BigInt(sourceTimeTicks) * BigInt(projectFrameRate.den)
  const denominator = BigInt(projectFrameRate.num)
  const offset = rounding === 'floor'
    ? numerator / denominator
    : (numerator + denominator - 1n) / denominator
  return safeBigIntNumber(
    BigInt(source.firstTimestampUs) + offset,
    'Stabilization source timestamp',
  )
}

interface SourceCorrectionProjection {
  readonly correction: SimilarityTransform
  readonly maximumProjectError: number
}

function correctionInSourcePixels(
  clip: Clip,
  correction: SimilarityTransform,
  analysisWidth: number,
  analysisHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): SourceCorrectionProjection {
  const sourceToAnalysisX = analysisWidth / sourceWidth
  const sourceToAnalysisY = analysisHeight / sourceHeight
  const exactXFromY = -correction.b * sourceToAnalysisY / sourceToAnalysisX
  const exactYFromX = correction.b * sourceToAnalysisX / sourceToAnalysisY
  const projectedB = (exactYFromX - exactXFromY) / 2
  const anchorX = clip.transform.anchorX * sourceWidth
  const anchorY = clip.transform.anchorY * sourceHeight
  const exactMovedAnchorX = correction.a * anchorX
    + exactXFromY * anchorY
    + correction.tx / sourceToAnalysisX
  const exactMovedAnchorY = exactYFromX * anchorX
    + correction.a * anchorY
    + correction.ty / sourceToAnalysisY
  const projected = {
    a: correction.a,
    b: projectedB,
    tx: exactMovedAnchorX - correction.a * anchorX + projectedB * anchorY,
    ty: exactMovedAnchorY - projectedB * anchorX - correction.a * anchorY,
  }
  let maximumSourceError = 0
  for (const point of visibleSourceCorners(clip, { width: sourceWidth, height: sourceHeight })) {
    const exactX = correction.a * point.x
      + exactXFromY * point.y
      + correction.tx / sourceToAnalysisX
    const exactY = exactYFromX * point.x
      + correction.a * point.y
      + correction.ty / sourceToAnalysisY
    const projectedX = projected.a * point.x - projected.b * point.y + projected.tx
    const projectedY = projected.b * point.x + projected.a * point.y + projected.ty
    maximumSourceError = Math.max(
      maximumSourceError,
      Math.hypot(exactX - projectedX, exactY - projectedY),
    )
  }
  return {
    correction: projected,
    // Rotation and flips preserve length; the clip's uniform static scale is
    // therefore the exact project-space error multiplier.
    maximumProjectError: maximumSourceError * clip.transform.scaleX,
  }
}

interface ProductStabilizationPath {
  readonly corrections: readonly SimilarityTransform[]
  readonly jitterReductionRatio: number
}

function unwrapPathAngles(samples: readonly SimilarityPathSample[]): number[] {
  if (samples.length === 0) return []
  const output = [samples[0]!.angleRadians]
  for (let index = 1; index < samples.length; index++) {
    let angle = samples[index]!.angleRadians
    const previous = output[index - 1]!
    while (angle - previous > Math.PI) angle -= Math.PI * 2
    while (angle - previous < -Math.PI) angle += Math.PI * 2
    output.push(angle)
  }
  return output
}

function movingAverageLinear(values: readonly number[], radius: number): number[] {
  const prefix = new Float64Array(values.length + 1)
  for (let index = 0; index < values.length; index++) {
    prefix[index + 1] = prefix[index]! + values[index]!
  }
  return values.map((_, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(values.length - 1, index + radius)
    return (prefix[end + 1]! - prefix[start]!) / (end - start + 1)
  })
}

function pathJitter(samples: readonly SimilarityPathSample[]): number {
  return Math.hypot(
    rootMeanSquareSecondDifference(samples.map((sample) => sample.x)),
    rootMeanSquareSecondDifference(samples.map((sample) => sample.y)),
    rootMeanSquareSecondDifference(samples.map((sample) => sample.angleRadians * 100)),
    rootMeanSquareSecondDifference(samples.map((sample) => sample.logScale * 100)),
  )
}

/** O(n) product smoother; unlike the 300-frame research helper it spans windows. */
function createProductStabilizationPath(
  estimates: readonly GlobalMotionEstimate[],
  strength: number,
  radius: number,
): ProductStabilizationPath {
  if (estimates.length < 1 || estimates.length >= MAX_ANALYSIS_SAMPLES) {
    throw new RangeError('Stabilization result exceeds the product sample envelope')
  }
  const cameraPath: SimilarityTransform[] = [{ a: 1, b: 0, tx: 0, ty: 0 }]
  for (const estimate of estimates) {
    if (Object.values(estimate.transform).some((value) => !Number.isFinite(value))) {
      throw new RangeError('Stabilization estimate contains a non-finite transform')
    }
    cameraPath.push(composeSimilarityTransforms(
      estimate.transform,
      cameraPath[cameraPath.length - 1]!,
    ))
  }
  const original = cameraPath.map(similarityPathSample)
  const angles = unwrapPathAngles(original)
  const canonicalOriginal = original.map((sample, index) => ({
    ...sample,
    angleRadians: angles[index]!,
  }))
  const averages = {
    x: movingAverageLinear(original.map((sample) => sample.x), radius),
    y: movingAverageLinear(original.map((sample) => sample.y), radius),
    angle: movingAverageLinear(angles, radius),
    logScale: movingAverageLinear(original.map((sample) => sample.logScale), radius),
  }
  const stabilized = canonicalOriginal.map((sample, index) => ({
    x: sample.x + (averages.x[index]! - sample.x) * strength,
    y: sample.y + (averages.y[index]! - sample.y) * strength,
    angleRadians: sample.angleRadians
      + (averages.angle[index]! - sample.angleRadians) * strength,
    logScale: sample.logScale
      + (averages.logScale[index]! - sample.logScale) * strength,
  }))
  const corrections = stabilized.map((sample, index) => composeSimilarityTransforms(
    similarityFromPathSample(sample),
    invertSimilarityTransform(cameraPath[index]!),
  ))
  const before = pathJitter(canonicalOriginal)
  const after = pathJitter(stabilized)
  const jitterReductionRatio = before === 0 ? 0 : 1 - after / before
  if (!Number.isFinite(jitterReductionRatio)) {
    throw new RangeError('Stabilization path metrics are not finite')
  }
  return { corrections, jitterReductionRatio }
}

function transformedFrame(
  doc: TimelineDoc,
  clip: Clip,
  source: VideoStabilizationSource,
  correction: SimilarityTransform,
  analysisWidth: number,
  analysisHeight: number,
): Transform {
  const projection = correctionInSourcePixels(
    clip,
    correction,
    analysisWidth,
    analysisHeight,
    source.width,
    source.height,
  )
  if (
    !Number.isFinite(projection.maximumProjectError)
    || projection.maximumProjectError > STABILIZATION_SOURCE_PROJECTION_TOLERANCE_PX
  ) {
    throw new RangeError(
      `Stabilization downsampling would exceed the reviewed ${STABILIZATION_SOURCE_PROJECTION_TOLERANCE_PX.toFixed(2)} px source-projection tolerance.`,
    )
  }
  const normalized = projection.correction
  const correctionScale = Math.hypot(normalized.a, normalized.b)
  const correctionAngle = Math.atan2(normalized.b, normalized.a)
  const anchorX = clip.transform.anchorX * source.width
  const anchorY = clip.transform.anchorY * source.height
  const movedAnchorX = normalized.a * anchorX - normalized.b * anchorY + normalized.tx
  const movedAnchorY = normalized.b * anchorX + normalized.a * anchorY + normalized.ty
  const localX = movedAnchorX - anchorX
  const localY = movedAnchorY - anchorY
  const visual = clipVisualSettings(clip)
  const flipX = visual.flipHorizontal ? -1 : 1
  const flipY = visual.flipVertical ? -1 : 1
  const baseAngle = clip.transform.rotation * Math.PI / 180
  const cosine = Math.cos(baseAngle)
  const sine = Math.sin(baseAngle)
  const scale = clip.transform.scaleX
  const deltaX = scale * (cosine * flipX * localX - sine * flipY * localY)
  const deltaY = scale * (sine * flipX * localX + cosine * flipY * localY)
  const flipParity = flipX * flipY
  const rotation = clip.transform.rotation + flipParity * correctionAngle * 180 / Math.PI
  const nextScale = scale * correctionScale
  const transform = {
    ...clip.transform,
    x: clip.transform.x + deltaX,
    y: clip.transform.y + deltaY,
    rotation,
    scaleX: nextScale,
    scaleY: nextScale,
  }
  if (!finiteTransform(transform) || nextScale <= 0) {
    throw new RangeError('Stabilization correction produced an invalid transform')
  }
  // Touch the project here deliberately: this planner is project-space, and
  // callers must not accidentally reuse a plan against a differently sized canvas.
  void doc.width
  return transform
}

interface ReciprocalZoomInterval {
  minimum: number
  maximum: number
}

function constrainReciprocalZoom(
  interval: ReciprocalZoomInterval,
  coefficient: number,
  minimum: number,
  maximum: number,
): boolean {
  if (Math.abs(coefficient) < 1e-14) return minimum <= 0 && maximum >= 0
  const first = minimum / coefficient
  const second = maximum / coefficient
  interval.minimum = Math.max(interval.minimum, Math.min(first, second))
  interval.maximum = Math.min(interval.maximum, Math.max(first, second))
  return interval.maximum >= interval.minimum
}

/** Minimum shared extra zoom whose exact transformed crop covers the project. */
export function requiredVideoStabilizationSafeZoom(
  doc: TimelineDoc,
  clip: Clip,
  source: Pick<VideoStabilizationSource, 'width' | 'height'>,
  transforms: readonly Transform[],
): number | null {
  const visual = clipVisualSettings(clip)
  const cropLeft = source.width * visual.crop.left
  const cropRight = source.width * (1 - visual.crop.right)
  const cropTop = source.height * visual.crop.top
  const cropBottom = source.height * (1 - visual.crop.bottom)
  const anchorX = clip.transform.anchorX * source.width
  const anchorY = clip.transform.anchorY * source.height
  const flipX = visual.flipHorizontal ? -1 : 1
  const flipY = visual.flipVertical ? -1 : 1
  const projectCorners = [
    { x: 0, y: 0 },
    { x: doc.width, y: 0 },
    { x: 0, y: doc.height },
    { x: doc.width, y: doc.height },
  ]
  const interval = { minimum: 0, maximum: 1 }
  for (const transform of transforms) {
    if (!finiteTransform(transform) || transform.scaleX <= 0 || transform.scaleX !== transform.scaleY) {
      return null
    }
    const angle = transform.rotation * Math.PI / 180
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const canvasAnchorX = (doc.width - source.width) / 2 + anchorX + transform.x
    const canvasAnchorY = (doc.height - source.height) / 2 + anchorY + transform.y
    for (const corner of projectCorners) {
      const projectX = corner.x - canvasAnchorX
      const projectY = corner.y - canvasAnchorY
      const localX = flipX * (cosine * projectX + sine * projectY) / transform.scaleX
      const localY = flipY * (-sine * projectX + cosine * projectY) / transform.scaleY
      if (!constrainReciprocalZoom(
        interval,
        localX,
        cropLeft - anchorX,
        cropRight - anchorX,
      )) return null
      if (!constrainReciprocalZoom(
        interval,
        localY,
        cropTop - anchorY,
        cropBottom - anchorY,
      )) return null
    }
  }
  const reciprocal = Math.min(1, interval.maximum)
  if (!Number.isFinite(reciprocal) || reciprocal <= 0 || reciprocal < interval.minimum) return null
  const zoom = 1 / reciprocal
  return Number.isFinite(zoom) && zoom >= 1 ? zoom : null
}

function visibleSourceCorners(
  clip: Clip,
  source: Pick<VideoStabilizationSource, 'width' | 'height'>,
): readonly { readonly x: number; readonly y: number }[] {
  const crop = clipVisualSettings(clip).crop
  const left = source.width * crop.left
  const right = source.width * (1 - crop.right)
  const top = source.height * crop.top
  const bottom = source.height * (1 - crop.bottom)
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ]
}

function renderPoint(
  doc: TimelineDoc,
  clip: Clip,
  source: Pick<VideoStabilizationSource, 'width' | 'height'>,
  transform: Transform,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const visual = clipVisualSettings(clip)
  const anchorX = transform.anchorX * source.width
  const anchorY = transform.anchorY * source.height
  const localX = (point.x - anchorX) * (visual.flipHorizontal ? -1 : 1)
  const localY = (point.y - anchorY) * (visual.flipVertical ? -1 : 1)
  const angle = transform.rotation * Math.PI / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: (doc.width - source.width) / 2 + anchorX + transform.x
      + cosine * transform.scaleX * localX - sine * transform.scaleY * localY,
    y: (doc.height - source.height) / 2 + anchorY + transform.y
      + sine * transform.scaleX * localX + cosine * transform.scaleY * localY,
  }
}

function interpolateTransform(
  left: VideoStabilizationFrame,
  right: VideoStabilizationFrame,
  frame: number,
): Transform {
  if (left.easing === 'hold') return { ...left.transform }
  const ratio = (frame - left.frame) / (right.frame - left.frame)
  const interpolate = (a: number, b: number) => a + (b - a) * ratio
  return {
    x: interpolate(left.transform.x, right.transform.x),
    y: interpolate(left.transform.y, right.transform.y),
    scaleX: interpolate(left.transform.scaleX, right.transform.scaleX),
    scaleY: interpolate(left.transform.scaleY, right.transform.scaleY),
    rotation: interpolate(left.transform.rotation, right.transform.rotation),
    anchorX: left.transform.anchorX,
    anchorY: left.transform.anchorY,
  }
}

function transformAtMappedFrame(
  frames: readonly VideoStabilizationFrame[],
  frame: number,
): Transform {
  let rightIndex = 0
  while (rightIndex < frames.length && frames[rightIndex]!.frame < frame) rightIndex++
  if (rightIndex === 0) return { ...frames[0]!.transform }
  if (rightIndex >= frames.length) return { ...frames[frames.length - 1]!.transform }
  const right = frames[rightIndex]!
  if (right.frame === frame) return { ...right.transform }
  return interpolateTransform(frames[rightIndex - 1]!, right, frame)
}

function preserveRepeatedSourceFrameBoundaries(
  durationFrames: number,
  map: ReturnType<typeof clipSourceTimeMap>,
  frames: readonly VideoStabilizationFrame[],
): VideoStabilizationFrame[] | null {
  const speedPoints = sourceTimeSpeedPointsAtClip(map)
  const canRepeatSourceFrames = speedPoints.length > 0
    ? speedPoints.some((point) => point.rate.numerator < point.rate.denominator)
    : map.rate.numerator < map.rate.denominator
  if (!canRepeatSourceFrames) {
    return frames.map((frame) => ({ ...frame, transform: { ...frame.transform } }))
  }
  const byFrame = new Map<number, VideoStabilizationFrame>()
  const transformBySourceFrame = new Map<number, Transform>()
  for (const mapped of frames) {
    const sourceFrame = Math.floor(mapped.sourceTimeTicks / SOURCE_TIME_TICKS_PER_FRAME)
    if (!transformBySourceFrame.has(sourceFrame)) {
      transformBySourceFrame.set(sourceFrame, mapped.transform)
    }
  }
  const protectedFrames = new Set<number>()
  let frame = 0
  while (frame < durationFrames) {
    const sourceFrame = sourceFrameAtTimelineOffset(map, frame)
    const start = frame
    let end = frame
    while (
      end < durationFrames - 1
      && sourceFrameAtTimelineOffset(map, end + 1) === sourceFrame
    ) end++
    const exactTransform = transformBySourceFrame.get(sourceFrame)
    if (end > start) {
      protectedFrames.add(start)
      protectedFrames.add(end)
      if (protectedFrames.size > MAX_KEYFRAMES_PER_TRACK) return null
    }
    if (exactTransform || end > start) {
      const transform = exactTransform ?? transformAtMappedFrame(frames, start)
      byFrame.set(start, {
        frame: start,
        sourceTimeTicks: sourceTicksAtTimelineOffset(map, start),
        transform: { ...transform },
        easing: end > start ? 'hold' : 'linear',
      })
      if (end > start) {
        byFrame.set(end, {
          frame: end,
          sourceTimeTicks: sourceTicksAtTimelineOffset(map, end),
          transform: { ...transform },
          easing: 'linear',
        })
      }
    }
    frame = end + 1
  }
  return [...byFrame.values()].sort((left, right) => left.frame - right.frame)
}

function normalizedFitError(
  doc: TimelineDoc,
  clip: Clip,
  source: VideoStabilizationSource,
  actual: VideoStabilizationFrame,
  fitted: Transform,
): number {
  let cornerError = 0
  for (const corner of visibleSourceCorners(clip, source)) {
    const actualPoint = renderPoint(doc, clip, source, actual.transform, corner)
    const fittedPoint = renderPoint(doc, clip, source, fitted, corner)
    cornerError = Math.max(cornerError, Math.hypot(
      actualPoint.x - fittedPoint.x,
      actualPoint.y - fittedPoint.y,
    ))
  }
  const rotationError = Math.abs(actual.transform.rotation - fitted.rotation)
  const scaleError = Math.abs(actual.transform.scaleX / fitted.scaleX - 1)
  return Math.max(
    cornerError / PRE_ZOOM_CORNER_TOLERANCE_PX,
    rotationError / STABILIZATION_ROTATION_TOLERANCE_DEGREES,
    scaleError / STABILIZATION_SCALE_TOLERANCE_RATIO,
  )
}

export function simplifyVideoStabilizationFrames(
  doc: TimelineDoc,
  clip: Clip,
  source: VideoStabilizationSource,
  frames: readonly VideoStabilizationFrame[],
): VideoStabilizationFrame[] | null {
  if (frames.length <= 2) return frames.map((frame) => ({ ...frame, transform: { ...frame.transform } }))
  const retained = new Set([0, frames.length - 1])
  for (let index = 0; index < frames.length; index++) {
    if (frames[index]!.easing !== 'hold') continue
    retained.add(index)
    if (index + 1 < frames.length) retained.add(index + 1)
  }
  if (retained.size > MAX_KEYFRAMES_PER_TRACK) return null
  const protectedIndices = [...retained].sort((left, right) => left - right)
  const segments: Array<readonly [number, number]> = []
  for (let index = 1; index < protectedIndices.length; index++) {
    segments.push([protectedIndices[index - 1]!, protectedIndices[index]!])
  }
  let comparisons = 0
  while (segments.length > 0) {
    const [start, end] = segments.pop()!
    let worstIndex = -1
    let worstError = 1
    for (let index = start + 1; index < end; index++) {
      comparisons++
      if (comparisons > MAX_STABILIZATION_SIMPLIFICATION_COMPARISONS) return null
      const fitted = interpolateTransform(frames[start]!, frames[end]!, frames[index]!.frame)
      const error = normalizedFitError(doc, clip, source, frames[index]!, fitted)
      if (error > worstError) {
        worstError = error
        worstIndex = index
      }
    }
    if (worstIndex < 0) continue
    retained.add(worstIndex)
    if (retained.size > MAX_KEYFRAMES_PER_TRACK) return null
    segments.push([start, worstIndex], [worstIndex, end])
  }
  return [...retained]
    .sort((left, right) => left - right)
    .map((index) => ({ ...frames[index]!, transform: { ...frames[index]!.transform } }))
}

function transformsAtEveryClipFrame(
  durationFrames: number,
  frames: readonly VideoStabilizationFrame[],
): Transform[] {
  if (frames.length < 1 || durationFrames < 1 || durationFrames > MAX_ANALYSIS_SAMPLES) {
    throw new RangeError('Stabilization coverage exceeds the product frame envelope')
  }
  const transforms: Transform[] = []
  let rightIndex = 0
  for (let frame = 0; frame < durationFrames; frame++) {
    while (rightIndex < frames.length && frames[rightIndex]!.frame < frame) rightIndex++
    if (rightIndex === 0) {
      transforms.push({ ...frames[0]!.transform })
      continue
    }
    if (rightIndex >= frames.length) {
      transforms.push({ ...frames[frames.length - 1]!.transform })
      continue
    }
    const right = frames[rightIndex]!
    if (right.frame === frame) {
      transforms.push({ ...right.transform })
      continue
    }
    transforms.push(interpolateTransform(frames[rightIndex - 1]!, right, frame))
  }
  return transforms
}

function trackFor(
  property: ClipAnimationProperty,
  frames: readonly VideoStabilizationFrame[],
): ClipAnimationTrack {
  const value = (frame: VideoStabilizationFrame): number => {
    if (property === 'position-x') return frame.transform.x
    if (property === 'position-y') return frame.transform.y
    if (property === 'rotation') return frame.transform.rotation
    if (property === 'scale-x') return frame.transform.scaleX
    return frame.transform.scaleY
  }
  return {
    property,
    keyframes: frames.map((frame) => ({
      frame: frame.frame,
      sourceTimeTicks: frame.sourceTimeTicks,
      value: value(frame),
      easing: { type: frame.easing },
    })),
  }
}

export function createVideoStabilizationPlan(
  doc: TimelineDoc,
  clip: Clip,
  source: VideoStabilizationSource | null,
  analysis: VideoStabilizationAnalysis,
  settings: VideoStabilizationSettings,
): VideoStabilizationPlanResult {
  const unavailable = videoStabilizationAvailabilityReason(doc, clip, source)
  if (unavailable) return { ok: false, reason: unavailable }
  if (!source) return { ok: false, reason: 'Stabilization source facts are missing.' }
  if (
    analysis.version !== VIDEO_STABILIZATION_RESULT_VERSION
    || !positiveSafeInteger(analysis.width)
    || !positiveSafeInteger(analysis.height)
    || analysis.samples.length < 2
    || analysis.samples[0]?.estimateFromPrevious !== null
    || analysis.samples.slice(1).some((sample) => sample.estimateFromPrevious === null)
  ) return { ok: false, reason: 'The cached stabilization result is invalid or incomplete.' }
  if (
    !Number.isFinite(settings.strengthPercent)
    || settings.strengthPercent < 0
    || settings.strengthPercent > 100
    || !Number.isSafeInteger(settings.smoothingRadiusFrames)
    || settings.smoothingRadiusFrames < 1
    || settings.smoothingRadiusFrames > 120
  ) return { ok: false, reason: 'Strength must be 0–100% and smoothing must be 1–120 frames.' }
  for (let index = 0; index < analysis.samples.length; index++) {
    const sample = analysis.samples[index]!
    if (
      !Number.isSafeInteger(sample.timestampUs)
      || (index > 0 && sample.timestampUs <= analysis.samples[index - 1]!.timestampUs)
    ) return { ok: false, reason: 'Analysis timestamps must be strictly increasing safe integers.' }
  }
  let productPath
  try {
    productPath = createProductStabilizationPath(
      analysis.samples.slice(1).map((sample) => sample.estimateFromPrevious!),
      settings.strengthPercent / 100,
      settings.smoothingRadiusFrames,
    )
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const map = clipSourceTimeMap(clip)
  const frames: VideoStabilizationFrame[] = []
  let previousFrame = -1
  try {
    for (let index = 0; index < analysis.samples.length; index++) {
      const sourceTimeTicks = timestampToSourceTicks(
        analysis.samples[index]!.timestampUs,
        source,
        doc.frameRate,
      )
      const frame = timelineOffsetAtSourceTicks(
        map,
        sourceTimeTicks,
        0,
        clip.timelineRange.durationFrames - 1,
      )
      if (frame === null) continue
      if (frame <= previousFrame) {
        return { ok: false, reason: 'Source-time mapping produced duplicate stabilization frames.' }
      }
      previousFrame = frame
      frames.push({
        frame,
        sourceTimeTicks,
        transform: transformedFrame(
          doc,
          clip,
          source,
          productPath.corrections[index]!,
          analysis.width,
          analysis.height,
        ),
        easing: 'linear',
      })
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  if (frames.length < 2) {
    return { ok: false, reason: 'The analyzed source does not map to at least two unique clip frames.' }
  }
  let repeatSafeFrames: VideoStabilizationFrame[] | null
  try {
    repeatSafeFrames = preserveRepeatedSourceFrameBoundaries(
      clip.timelineRange.durationFrames,
      map,
      frames,
    )
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const simplified = repeatSafeFrames
    ? simplifyVideoStabilizationFrames(doc, clip, source, repeatSafeFrames)
    : null
  if (!simplified) {
    return {
      ok: false,
      reason: `Stabilization exceeds the bounded simplification envelope or ${MAX_KEYFRAMES_PER_TRACK} keys per track.`,
    }
  }
  let coverageTransforms: Transform[]
  try {
    coverageTransforms = transformsAtEveryClipFrame(
      clip.timelineRange.durationFrames,
      simplified,
    )
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const safeZoom = requiredVideoStabilizationSafeZoom(doc, clip, source, coverageTransforms)
  if (safeZoom === null || safeZoom > MAX_STABILIZATION_SAFE_ZOOM) {
    return {
      ok: false,
      reason: `Stabilization needs more than the reviewed ${MAX_STABILIZATION_SAFE_ZOOM.toFixed(2)}× safe-zoom envelope.`,
    }
  }
  if (coverageTransforms.some((transform) => transform.scaleX * safeZoom > MAX_CLIP_SCALE)) {
    return { ok: false, reason: 'Stabilization would exceed the clip scale limit.' }
  }
  for (const frame of simplified) {
    frame.transform.scaleX *= safeZoom
    frame.transform.scaleY *= safeZoom
    if (frame.transform.scaleX > MAX_CLIP_SCALE) {
      return { ok: false, reason: 'Stabilization would exceed the clip scale limit.' }
    }
  }
  const owned = new Set<ClipAnimationProperty>(VIDEO_STABILIZATION_PROPERTIES)
  const current = clipAnimation(clip)
  const replacementRequired = current.tracks.some((track) => owned.has(track.property))
  const retainedKeyCount = current.tracks
    .filter((track) => !owned.has(track.property))
    .reduce((total, track) => total + track.keyframes.length, 0)
  const nextTotal = retainedKeyCount + simplified.length * VIDEO_STABILIZATION_PROPERTIES.length
  const currentTotal = current.tracks.reduce((total, track) => total + track.keyframes.length, 0)
  if (!documentAnimationKeyframeGrowthAllowed(doc, Math.max(0, nextTotal - currentTotal))) {
    return { ok: false, reason: 'Stabilization would exceed the document keyframe budget.' }
  }
  const plannedTracks = VIDEO_STABILIZATION_PROPERTIES.map((property) => trackFor(property, simplified))
  const plannedAnimationError = clipAnimationValidationError({
    ...current,
    tracks: [
      ...current.tracks.filter((track) => !owned.has(track.property)),
      ...plannedTracks,
    ],
  })
  if (plannedAnimationError) {
    return { ok: false, reason: `Stabilization cannot author this animation: ${plannedAnimationError}.` }
  }
  return {
    ok: true,
    plan: {
      settings: { ...settings },
      safeZoom,
      requiredCropRatio: 1 - 1 / safeZoom,
      sampleCount: frames.length,
      retainedKeyframeCount: simplified.length,
      replacementRequired,
      jitterReductionRatio: productPath.jitterReductionRatio,
      frames: simplified,
      tracks: plannedTracks,
    },
  }
}
