/** Pure product planning for bounded point and similarity-box tracking. */

import { MAX_ANALYSIS_SAMPLES } from './analysisCache'
import {
  clipAnimation,
  clipAnimationValidationError,
  MAX_KEYFRAMES_PER_TRACK,
  resolveClipAnimationAtFrame,
} from './clipAnimation'
import {
  clipVisualSettings,
  clipVisualSettingsValidationError,
  transformScaleValidationError,
} from './clipInspector'
import {
  trackingSamplesToAnimationTracks,
  type TrackingAnimationSample,
} from './motionTrackingResearch'
import type {
  Clip,
  ClipAnimationProperty,
  ClipAnimationTrack,
  FrameRate,
  TimelineDoc,
} from './schema'
import {
  clipSourceTimeMap,
  SOURCE_TIME_TICKS_PER_FRAME,
  sourceTicksAtTimelineOffset,
} from './sourceTimeMap'
import { framesToMicroseconds, rangeEnd } from './time'

export const MOTION_TRACKING_RESULT_VERSION = 1
export const MOTION_TRACKING_ALGORITHM_ID = 'builtin.motion-tracking'
export const MOTION_TRACKING_ALGORITHM_VERSION = 'point-box-product-v1'
export const MAX_MOTION_TRACKING_SAMPLES = Math.min(
  MAX_ANALYSIS_SAMPLES,
  MAX_KEYFRAMES_PER_TRACK,
)

export type MotionTrackingKind = 'point' | 'box'
export type MotionTrackingDirection = 'forward' | 'backward'

export interface NormalizedTrackingPoint {
  readonly x: number
  readonly y: number
}

export interface NormalizedTrackingBox extends NormalizedTrackingPoint {
  readonly width: number
  readonly height: number
}

export type MotionTrackingSelection =
  | { readonly kind: 'point'; readonly point: NormalizedTrackingPoint }
  | { readonly kind: 'box'; readonly box: NormalizedTrackingBox }

export interface MotionTrackingSource {
  readonly width: number
  readonly height: number
  readonly firstTimestampUs: number
  readonly frameRate: FrameRate
}

export interface MotionTrackingSamplePlan {
  readonly direction: MotionTrackingDirection
  readonly selectionLocalFrame: number
  readonly sourceStartMicroseconds: number
  readonly sourceEndMicroseconds: number
  readonly sampleTimestampsUs: readonly number[]
  readonly sampleSourceTimeTicks: readonly number[]
  readonly sampleLocalFrames: readonly number[]
}

export interface MotionTrackingPointSample {
  readonly timestampUs: number
  readonly sourceTimeTicks: number
  readonly localFrame: number
  readonly x: number
  readonly y: number
  readonly confidence: number
}

export interface MotionTrackingBoxSample extends MotionTrackingPointSample {
  readonly width: number
  readonly height: number
}

export interface MotionTrackingAnalysisFailure {
  readonly localFrame: number
  readonly code: 'lost-point' | 'lost-box' | 'low-confidence'
  readonly detail: string
}

interface MotionTrackingAnalysisBase {
  readonly version: typeof MOTION_TRACKING_RESULT_VERSION
  readonly direction: MotionTrackingDirection
  readonly selectionLocalFrame: number
  readonly width: number
  readonly height: number
  readonly failure: MotionTrackingAnalysisFailure | null
}

export interface MotionTrackingPointAnalysis extends MotionTrackingAnalysisBase {
  readonly kind: 'point'
  readonly samples: readonly MotionTrackingPointSample[]
}

export interface MotionTrackingBoxAnalysis extends MotionTrackingAnalysisBase {
  readonly kind: 'box'
  readonly samples: readonly MotionTrackingBoxSample[]
}

export type MotionTrackingAnalysis = MotionTrackingPointAnalysis | MotionTrackingBoxAnalysis

export const POINT_TRACKING_PROPERTIES = [
  'position-x',
  'position-y',
] as const satisfies readonly ClipAnimationProperty[]

export const BOX_TRACKING_PROPERTIES = [
  ...POINT_TRACKING_PROPERTIES,
  'scale-x',
  'scale-y',
] as const satisfies readonly ClipAnimationProperty[]

export interface MotionTrackingPlan {
  readonly sourceClipId: string
  readonly targetClipId: string
  readonly kind: MotionTrackingKind
  readonly includeScale: boolean
  readonly direction: MotionTrackingDirection
  readonly sampleCount: number
  readonly confidenceMinimum: number
  readonly confidenceMean: number
  readonly stopped: MotionTrackingAnalysisFailure | null
  readonly replacementRequired: boolean
  readonly tracks: readonly ClipAnimationTrack[]
}

export type MotionTrackingPlanResult =
  | { readonly ok: true; readonly plan: MotionTrackingPlan }
  | { readonly ok: false; readonly reason: string }

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function finiteNormalizedPoint(point: NormalizedTrackingPoint): boolean {
  return Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x >= 0
    && point.x <= 1
    && point.y >= 0
    && point.y <= 1
}

export function motionTrackingSelectionValidationError(
  selection: MotionTrackingSelection,
): string | null {
  const geometry = selection.kind === 'point' ? selection.point : selection.box
  if (!finiteNormalizedPoint(geometry)) return 'Tracking selection must be normalized from 0 to 1.'
  if (selection.kind === 'box') {
    const box = selection.box
    if (
      !Number.isFinite(box.width)
      || !Number.isFinite(box.height)
      || box.width <= 0
      || box.height <= 0
      || box.x + box.width > 1
      || box.y + box.height > 1
    ) return 'Tracking box must be a positive normalized rectangle inside the source.'
  }
  return null
}

export function motionTrackingAvailabilityReason(
  doc: TimelineDoc,
  clip: Clip,
  source: MotionTrackingSource | null,
  selectionGlobalFrame: number,
): string | null {
  if (clip.text !== undefined || clip.sourceMode !== 'timed') {
    return 'Tracking is available only for timed video clips.'
  }
  if (
    !Number.isSafeInteger(selectionGlobalFrame)
    || selectionGlobalFrame < clip.timelineRange.startFrame
    || selectionGlobalFrame >= rangeEnd(clip.timelineRange)
  ) return 'Place the playhead inside the source clip before tracking.'
  if (
    !source
    || !positiveSafeInteger(source.width)
    || !positiveSafeInteger(source.height)
    || !Number.isSafeInteger(source.firstTimestampUs)
    || !positiveSafeInteger(source.frameRate.num)
    || !positiveSafeInteger(source.frameRate.den)
  ) return 'Tracking needs a connected video source with exact dimensions and timing.'
  if (!positiveSafeInteger(doc.width) || !positiveSafeInteger(doc.height)) {
    return 'Tracking needs valid positive project dimensions.'
  }
  const visualError = clipVisualSettingsValidationError(clipVisualSettings(clip))
  if (visualError) return `Tracking cannot use this crop: ${visualError}.`
  const scaleError = transformScaleValidationError(clip.transform)
  if (scaleError || Object.values(clip.transform).some((value) => !Number.isFinite(value))) {
    return 'Tracking needs a valid finite source transform.'
  }
  const animationError = clipAnimationValidationError(clipAnimation(clip))
  if (animationError) return `Tracking cannot resolve invalid source animation: ${animationError}.`
  return null
}

function conformedRequestTimestamp(sourceTimeTicks: number, frameRate: FrameRate): number {
  if (!Number.isSafeInteger(sourceTimeTicks) || sourceTimeTicks < 0) {
    throw new RangeError('Tracked source time must be a non-negative safe integer')
  }
  return framesToMicroseconds(
    Math.floor(sourceTimeTicks / SOURCE_TIME_TICKS_PER_FRAME),
    frameRate,
  )
}

export function createMotionTrackingSamplePlan(
  doc: Pick<TimelineDoc, 'frameRate'>,
  clip: Clip,
  source: MotionTrackingSource,
  bounds: Readonly<{ firstTimestampUs: number; endTimestampUs: number }>,
  selectionGlobalFrame: number,
  direction: MotionTrackingDirection,
  maximumSamples = MAX_MOTION_TRACKING_SAMPLES,
): MotionTrackingSamplePlan {
  if (
    !Number.isSafeInteger(bounds.firstTimestampUs)
    || !Number.isSafeInteger(bounds.endTimestampUs)
    || bounds.endTimestampUs <= bounds.firstTimestampUs
    || source.firstTimestampUs !== bounds.firstTimestampUs
  ) throw new RangeError('Video source timestamp bounds are invalid')
  if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 2 || maximumSamples > MAX_MOTION_TRACKING_SAMPLES) {
    throw new RangeError('Motion-tracking sample limit is invalid')
  }
  const selectionLocalFrame = selectionGlobalFrame - clip.timelineRange.startFrame
  if (
    !Number.isSafeInteger(selectionLocalFrame)
    || selectionLocalFrame < 0
    || selectionLocalFrame >= clip.timelineRange.durationFrames
  ) throw new RangeError('Motion-tracking selection frame is outside the source clip')
  const normalizedEnd = bounds.endTimestampUs - bounds.firstTimestampUs
  const map = clipSourceTimeMap(clip)
  const step = direction === 'forward' ? 1 : -1
  const final = direction === 'forward' ? clip.timelineRange.durationFrames : -1
  const sampleTimestampsUs: number[] = []
  const sampleSourceTimeTicks: number[] = []
  const sampleLocalFrames: number[] = []
  let previousConformedFrame: number | null = null
  for (let localFrame = selectionLocalFrame; localFrame !== final; localFrame += step) {
    const sourceTimeTicks = sourceTicksAtTimelineOffset(map, localFrame)
    const conformedFrame = Math.floor(sourceTimeTicks / SOURCE_TIME_TICKS_PER_FRAME)
    if (previousConformedFrame !== null) {
      if (
        (direction === 'forward' && conformedFrame < previousConformedFrame)
        || (direction === 'backward' && conformedFrame > previousConformedFrame)
      ) throw new RangeError('Motion tracking requires monotonic conformed source frames')
      if (conformedFrame === previousConformedFrame) {
        throw new RangeError(
          'Motion tracking rejects duplicate conformed source frames, including freezes',
        )
      }
    }
    const timestampUs = conformedRequestTimestamp(sourceTimeTicks, doc.frameRate)
    if (timestampUs < 0 || timestampUs >= normalizedEnd) {
      throw new RangeError('Tracked source frame is outside the exact video bounds')
    }
    if (sampleTimestampsUs.length >= maximumSamples) {
      throw new RangeError('Motion-tracking sample plan exceeds the reviewed product envelope')
    }
    sampleTimestampsUs.push(timestampUs)
    sampleSourceTimeTicks.push(sourceTimeTicks)
    sampleLocalFrames.push(localFrame)
    previousConformedFrame = conformedFrame
  }
  if (sampleTimestampsUs.length < 2) {
    throw new RangeError(`Tracking ${direction} needs at least two distinct rendered source frames`)
  }
  const lowest = Math.min(...sampleTimestampsUs)
  const highest = Math.max(...sampleTimestampsUs)
  const sourceEndMicroseconds = Math.min(normalizedEnd, Math.max(highest + 1, framesToMicroseconds(
    Math.max(...sampleSourceTimeTicks.map((ticks) => Math.floor(ticks / SOURCE_TIME_TICKS_PER_FRAME))) + 1,
    doc.frameRate,
  )))
  if (sourceEndMicroseconds <= highest) {
    throw new RangeError('The last tracked source frame is outside the exact video bounds')
  }
  return {
    direction,
    selectionLocalFrame,
    sourceStartMicroseconds: lowest,
    sourceEndMicroseconds,
    sampleTimestampsUs,
    sampleSourceTimeTicks,
    sampleLocalFrames,
  }
}

function targetAvailabilityReason(doc: TimelineDoc, target: Clip): string | null {
  if (target.text !== undefined) return 'Choose a video or image clip as the tracking target.'
  const animationError = clipAnimationValidationError(clipAnimation(target))
  if (animationError) return `Target animation is invalid: ${animationError}.`
  const visualError = clipVisualSettingsValidationError(clipVisualSettings(target))
  if (visualError) return `Target crop is invalid: ${visualError}.`
  const scaleError = transformScaleValidationError(target.transform)
  if (scaleError || Object.values(target.transform).some((value) => !Number.isFinite(value))) {
    return 'Target transform must be finite and use valid scales.'
  }
  void doc
  return null
}

export function createMotionTrackingPlan(
  doc: TimelineDoc,
  sourceClip: Clip,
  targetClip: Clip,
  source: MotionTrackingSource,
  targetDimensions: Readonly<{ width: number; height: number }>,
  analysis: MotionTrackingAnalysis,
  includeScale: boolean,
): MotionTrackingPlanResult {
  const targetReason = targetAvailabilityReason(doc, targetClip)
  if (targetReason) return { ok: false, reason: targetReason }
  if (analysis.samples.length < 2) {
    return { ok: false, reason: 'Tracking stopped before two usable samples were accepted.' }
  }
  if (analysis.kind === 'point' && includeScale) {
    return { ok: false, reason: 'Point tracking can author Position only.' }
  }
  if (!positiveSafeInteger(targetDimensions.width) || !positiveSafeInteger(targetDimensions.height)) {
    return { ok: false, reason: 'Tracking target dimensions are unavailable.' }
  }
  const ordered = [...analysis.samples].sort((left, right) => left.localFrame - right.localFrame)
  const minimumGlobalFrame = sourceClip.timelineRange.startFrame + ordered[0]!.localFrame
  const maximumGlobalFrame = sourceClip.timelineRange.startFrame + ordered.at(-1)!.localFrame
  if (
    minimumGlobalFrame < targetClip.timelineRange.startFrame
    || maximumGlobalFrame >= rangeEnd(targetClip.timelineRange)
  ) return { ok: false, reason: 'The target clip must overlap the complete accepted tracking range.' }
  const selectionTargetFrame = sourceClip.timelineRange.startFrame
    + analysis.selectionLocalFrame
    - targetClip.timelineRange.startFrame
  if (selectionTargetFrame < 0 || selectionTargetFrame >= targetClip.timelineRange.durationFrames) {
    return { ok: false, reason: 'The target clip does not overlap the tracking selection frame.' }
  }
  const selectionGlobalFrame = sourceClip.timelineRange.startFrame + analysis.selectionLocalFrame
  const baseTarget = resolveClipAnimationAtFrame(targetClip, selectionGlobalFrame).transform
  const trackingSamples: TrackingAnimationSample[] = ordered.map((sample) => {
    const globalFrame = sourceClip.timelineRange.startFrame + sample.localFrame
    const resolvedSource = resolveClipAnimationAtFrame(sourceClip, globalFrame)
    const resolvedTarget = resolveClipAnimationAtFrame(targetClip, globalFrame)
    const boxSample = analysis.kind === 'box'
      ? sample as MotionTrackingBoxSample
      : null
    const centerX = (sample.x + (boxSample ? boxSample.width / 2 : 0))
      / analysis.width * source.width
    const centerY = (sample.y + (boxSample ? boxSample.height / 2 : 0))
      / analysis.height * source.height
    const mapped: TrackingAnimationSample = {
      frame: globalFrame - targetClip.timelineRange.startFrame,
      centerX,
      centerY,
      source: {
        width: source.width,
        height: source.height,
        transform: { ...resolvedSource.transform },
        visual: clipVisualSettings(resolvedSource),
      },
      targetTransform: { ...resolvedTarget.transform },
    }
    if (boxSample) {
      return {
        ...mapped,
        width: boxSample.width / analysis.width * source.width,
        height: boxSample.height / analysis.height * source.height,
      }
    }
    return mapped
  })
  let tracks: ClipAnimationTrack[]
  try {
    tracks = trackingSamplesToAnimationTracks(trackingSamples, baseTarget, {
      includeScale: analysis.kind === 'box' && includeScale,
      referenceFrame: selectionTargetFrame,
      target: {
        width: targetDimensions.width,
        height: targetDimensions.height,
        visual: clipVisualSettings(targetClip),
      },
    }).map((track) => ({
      ...track,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        sourceTimeTicks: sourceTicksAtTimelineOffset(
          clipSourceTimeMap(targetClip),
          keyframe.frame,
        ),
      })),
    }))
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const owned = new Set(tracks.map((track) => track.property))
  const replacementRequired = clipAnimation(targetClip).tracks.some((track) => owned.has(track.property))
  const confidences = ordered.map((sample) => sample.confidence)
  return {
    ok: true,
    plan: {
      sourceClipId: sourceClip.id,
      targetClipId: targetClip.id,
      kind: analysis.kind,
      includeScale: analysis.kind === 'box' && includeScale,
      direction: analysis.direction,
      sampleCount: ordered.length,
      confidenceMinimum: Math.min(...confidences),
      confidenceMean: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
      stopped: analysis.failure,
      replacementRequired,
      tracks,
    },
  }
}
