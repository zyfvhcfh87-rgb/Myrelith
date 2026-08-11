/**
 * Pure dynamic-zoom/reframe preset planning.
 *
 * Presets are authoring shortcuts only: the output is four ordinary scalar
 * animation tracks. No preset id, focus point, or procedural evaluator enters
 * the document. The framing solver uses the current canvas, source dimensions,
 * crop, anchor, and static rotation to keep the complete canvas inside the
 * transformed visible-source rectangle at both authored endpoints.
 */

import {
  animationEasingValidationError,
  clipAnimation,
  clipAnimationValidationError,
  documentAnimationKeyframeGrowthAllowed,
  isClipPropertyAnimated,
  LINEAR_ANIMATION_EASING,
} from './clipAnimation'
import {
  clipVisualSettings,
  clipVisualSettingsValidationError,
  MAX_CLIP_SCALE,
  MIN_CLIP_SCALE,
  transformScaleValidationError,
} from './clipInspector'
import type {
  Clip,
  ClipAnimationEasing,
  ClipAnimationProperty,
  ClipAnimationTrack,
  TimelineDoc,
} from './schema'

export const MIN_DYNAMIC_ZOOM_DURATION_FRAMES = 2
export const MIN_DYNAMIC_ZOOM_FACTOR = 1
export const MAX_DYNAMIC_ZOOM_FACTOR = 4

export const DYNAMIC_ZOOM_FRAMING_PROPERTIES = [
  'position-x',
  'position-y',
  'scale-x',
  'scale-y',
] as const satisfies readonly ClipAnimationProperty[]

export type DynamicZoomPresetId =
  | 'gentle-in'
  | 'gentle-out'
  | 'reframe-left-right'
  | 'reframe-top-bottom'

export interface DynamicZoomFraming {
  /** Subject/focus position: -1 is left, 0 center, and 1 right. */
  focusX: number
  /** Subject/focus position: -1 is top, 0 center, and 1 bottom. */
  focusY: number
  /** Multiplier over the minimum safe cover scale. */
  zoom: number
}

export interface DynamicZoomPreset {
  id: DynamicZoomPresetId
  label: string
  start: DynamicZoomFraming
  end: DynamicZoomFraming
  easing: ClipAnimationEasing
}

export interface DynamicZoomSourceDimensions {
  width: number
  height: number
}

export interface DynamicZoomRequest {
  start: DynamicZoomFraming
  end: DynamicZoomFraming
  durationFrames: number
  easing: ClipAnimationEasing
}

export interface DynamicZoomResolvedFrame {
  x: number
  y: number
  scale: number
}

export interface DynamicZoomPlan {
  durationFrames: number
  requestedDurationFrames: number
  durationClamped: boolean
  start: DynamicZoomResolvedFrame
  end: DynamicZoomResolvedFrame
  tracks: ClipAnimationTrack[]
}

export type DynamicZoomPlanResult =
  | { ok: true; plan: DynamicZoomPlan }
  | { ok: false; reason: string }

export const DYNAMIC_ZOOM_KEYFRAME_BUDGET_REASON =
  'dynamic zoom would exceed the document keyframe budget'

const EASE_IN_OUT: ClipAnimationEasing = {
  type: 'cubic-bezier',
  x1: 0.42,
  y1: 0,
  x2: 0.58,
  y2: 1,
}

export const DYNAMIC_ZOOM_PRESETS: readonly DynamicZoomPreset[] = [
  {
    id: 'gentle-in',
    label: 'Gentle zoom in',
    start: { focusX: 0, focusY: 0, zoom: 1 },
    end: { focusX: 0, focusY: 0, zoom: 1.2 },
    easing: EASE_IN_OUT,
  },
  {
    id: 'gentle-out',
    label: 'Gentle zoom out',
    start: { focusX: 0, focusY: 0, zoom: 1.2 },
    end: { focusX: 0, focusY: 0, zoom: 1 },
    easing: EASE_IN_OUT,
  },
  {
    id: 'reframe-left-right',
    label: 'Reframe left to right',
    start: { focusX: -0.75, focusY: 0, zoom: 1.2 },
    end: { focusX: 0.75, focusY: 0, zoom: 1.2 },
    easing: EASE_IN_OUT,
  },
  {
    id: 'reframe-top-bottom',
    label: 'Reframe top to bottom',
    start: { focusX: 0, focusY: -0.75, zoom: 1.2 },
    end: { focusX: 0, focusY: 0.75, zoom: 1.2 },
    easing: EASE_IN_OUT,
  },
]

function cloneEasing(easing: ClipAnimationEasing): ClipAnimationEasing {
  return easing.type === 'cubic-bezier' ? { ...easing } : { type: easing.type }
}

export function dynamicZoomPreset(id: DynamicZoomPresetId): DynamicZoomPreset {
  const preset = DYNAMIC_ZOOM_PRESETS.find((item) => item.id === id)
  if (!preset) throw new RangeError(`Unknown dynamic zoom preset: ${id}`)
  return {
    ...preset,
    start: { ...preset.start },
    end: { ...preset.end },
    easing: cloneEasing(preset.easing),
  }
}

export function dynamicZoomRequestFromPreset(
  id: DynamicZoomPresetId,
  durationFrames: number,
): DynamicZoomRequest {
  const preset = dynamicZoomPreset(id)
  return {
    start: preset.start,
    end: preset.end,
    durationFrames,
    easing: preset.easing,
  }
}

export function reverseDynamicZoomEasing(
  easing: ClipAnimationEasing,
): ClipAnimationEasing {
  if (easing.type !== 'cubic-bezier') return cloneEasing(easing)
  return {
    type: 'cubic-bezier',
    x1: 1 - easing.x2,
    y1: 1 - easing.y2,
    x2: 1 - easing.x1,
    y2: 1 - easing.y1,
  }
}

export function reverseDynamicZoomRequest(
  request: DynamicZoomRequest,
): DynamicZoomRequest {
  return {
    start: { ...request.end },
    end: { ...request.start },
    durationFrames: request.durationFrames,
    easing: reverseDynamicZoomEasing(request.easing),
  }
}

function positiveSafeDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function framingValidationError(
  framing: DynamicZoomFraming,
  label: string,
): string | null {
  for (const key of ['focusX', 'focusY'] as const) {
    const value = framing[key]
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      return `${label} ${key} must be from -1 to 1`
    }
  }
  if (
    !Number.isFinite(framing.zoom)
    || framing.zoom < MIN_DYNAMIC_ZOOM_FACTOR
    || framing.zoom > MAX_DYNAMIC_ZOOM_FACTOR
  ) {
    return `${label} zoom must be from ${MIN_DYNAMIC_ZOOM_FACTOR} to ${MAX_DYNAMIC_ZOOM_FACTOR}`
  }
  return null
}

export function dynamicZoomAvailabilityReason(
  doc: TimelineDoc,
  clip: Clip,
  source: DynamicZoomSourceDimensions | null,
): string | null {
  if (clip.text !== undefined) {
    return 'Dynamic zoom is not available for text overlays; text animation is outside the current keyframe property set.'
  }
  if (clip.timelineRange.durationFrames < MIN_DYNAMIC_ZOOM_DURATION_FRAMES) {
    return 'Dynamic zoom needs a clip with at least 2 frames.'
  }
  if (!source || !positiveSafeDimension(source.width) || !positiveSafeDimension(source.height)) {
    return 'Dynamic zoom needs known positive source dimensions. Relink or re-import this media first.'
  }
  if (!positiveSafeDimension(doc.width) || !positiveSafeDimension(doc.height)) {
    return 'Dynamic zoom needs valid positive project dimensions.'
  }
  const visualError = clipVisualSettingsValidationError(clipVisualSettings(clip))
  if (visualError) return `Dynamic zoom cannot use this crop: ${visualError}.`
  const transformError = transformScaleValidationError(clip.transform)
  if (transformError || !Number.isFinite(clip.transform.rotation)) {
    return 'Dynamic zoom needs a valid finite clip transform.'
  }
  const animationError = clipAnimationValidationError(clipAnimation(clip))
  if (animationError) return `Dynamic zoom cannot replace invalid animation: ${animationError}.`
  if (isClipPropertyAnimated(clip, 'rotation')) {
    return 'Reset Rotation animation before applying dynamic zoom so safe framing can be guaranteed at every frame.'
  }
  return null
}

function finiteMinimum(left: number, right: number): number {
  if (!Number.isFinite(left)) return right
  if (!Number.isFinite(right)) return left
  return Math.min(left, right)
}

function maximumOffset(
  firstRemaining: number,
  firstCoefficient: number,
  secondRemaining: number,
  secondCoefficient: number,
): number {
  const epsilon = 1e-12
  const first = firstCoefficient > epsilon
    ? firstRemaining / firstCoefficient
    : Number.POSITIVE_INFINITY
  const second = secondCoefficient > epsilon
    ? secondRemaining / secondCoefficient
    : Number.POSITIVE_INFINITY
  return Math.max(0, finiteMinimum(first, second))
}

function resolveFraming(
  doc: TimelineDoc,
  clip: Clip,
  source: DynamicZoomSourceDimensions,
  framing: DynamicZoomFraming,
): DynamicZoomResolvedFrame | null {
  const visual = clipVisualSettings(clip)
  const visibleWidth = source.width * (1 - visual.crop.left - visual.crop.right)
  const visibleHeight = source.height * (1 - visual.crop.top - visual.crop.bottom)
  const halfVisibleWidth = visibleWidth / 2
  const halfVisibleHeight = visibleHeight / 2
  const halfCanvasWidth = doc.width / 2
  const halfCanvasHeight = doc.height / 2
  const angle = clip.transform.rotation * Math.PI / 180
  const cosine = Math.abs(Math.cos(angle))
  const sine = Math.abs(Math.sin(angle))

  const minimumScale = Math.max(
    (cosine * halfCanvasWidth + sine * halfCanvasHeight) / halfVisibleWidth,
    (sine * halfCanvasWidth + cosine * halfCanvasHeight) / halfVisibleHeight,
  )
  const scale = minimumScale * framing.zoom
  if (
    !Number.isFinite(scale)
    || scale < MIN_CLIP_SCALE
    || scale > MAX_CLIP_SCALE
  ) return null

  // The two inequalities describe an axis-aligned canvas inside the rotated
  // visible-source rectangle. Requested focus offsets are projected back into
  // their shared feasible diamond so a diagonal reframe stays safe too.
  const firstRemaining = Math.max(
    0,
    scale * halfVisibleWidth
      - cosine * halfCanvasWidth
      - sine * halfCanvasHeight,
  )
  const secondRemaining = Math.max(
    0,
    scale * halfVisibleHeight
      - sine * halfCanvasWidth
      - cosine * halfCanvasHeight,
  )
  const maxOffsetX = maximumOffset(
    firstRemaining,
    cosine,
    secondRemaining,
    sine,
  )
  const maxOffsetY = maximumOffset(
    firstRemaining,
    sine,
    secondRemaining,
    cosine,
  )
  let centerOffsetX = -framing.focusX * maxOffsetX
  let centerOffsetY = -framing.focusY * maxOffsetY
  const firstUse = cosine * Math.abs(centerOffsetX) + sine * Math.abs(centerOffsetY)
  const secondUse = sine * Math.abs(centerOffsetX) + cosine * Math.abs(centerOffsetY)
  const firstRatio = firstRemaining === 0
    ? (firstUse === 0 ? 0 : Number.POSITIVE_INFINITY)
    : firstUse / firstRemaining
  const secondRatio = secondRemaining === 0
    ? (secondUse === 0 ? 0 : Number.POSITIVE_INFINITY)
    : secondUse / secondRemaining
  const projectionRatio = Math.max(1, firstRatio, secondRatio)
  centerOffsetX /= projectionRatio
  centerOffsetY /= projectionRatio

  const sourceCenterX = source.width * (visual.crop.left
    + (1 - visual.crop.left - visual.crop.right) / 2)
  const sourceCenterY = source.height * (visual.crop.top
    + (1 - visual.crop.top - visual.crop.bottom) / 2)
  const anchorX = clip.transform.anchorX * source.width
  const anchorY = clip.transform.anchorY * source.height
  const localCenterX = sourceCenterX - anchorX
  const localCenterY = sourceCenterY - anchorY
  const flipX = visual.flipHorizontal ? -1 : 1
  const flipY = visual.flipVertical ? -1 : 1
  const signedCosine = Math.cos(angle)
  const signedSine = Math.sin(angle)
  const rotatedCenterX = scale * (
    signedCosine * flipX * localCenterX - signedSine * flipY * localCenterY
  )
  const rotatedCenterY = scale * (
    signedSine * flipX * localCenterX + signedCosine * flipY * localCenterY
  )

  return {
    x: source.width / 2 - anchorX + centerOffsetX - rotatedCenterX,
    y: source.height / 2 - anchorY + centerOffsetY - rotatedCenterY,
    scale,
  }
}

function framingTrack(
  property: ClipAnimationProperty,
  startValue: number,
  endValue: number,
  endFrame: number,
  easing: ClipAnimationEasing,
): ClipAnimationTrack {
  return {
    property,
    keyframes: [
      { frame: 0, value: startValue, easing: cloneEasing(easing) },
      { frame: endFrame, value: endValue, easing: LINEAR_ANIMATION_EASING },
    ],
  }
}

export function createDynamicZoomPlan(
  doc: TimelineDoc,
  clip: Clip,
  source: DynamicZoomSourceDimensions | null,
  request: DynamicZoomRequest,
): DynamicZoomPlanResult {
  const unavailable = dynamicZoomAvailabilityReason(doc, clip, source)
  if (unavailable) return { ok: false, reason: unavailable }
  if (!source) return { ok: false, reason: 'Dynamic zoom source dimensions are missing.' }
  if (
    !Number.isSafeInteger(request.durationFrames)
    || request.durationFrames < MIN_DYNAMIC_ZOOM_DURATION_FRAMES
  ) {
    return {
      ok: false,
      reason: `Dynamic zoom duration must be a safe integer of at least ${MIN_DYNAMIC_ZOOM_DURATION_FRAMES} frames.`,
    }
  }
  const startError = framingValidationError(request.start, 'Start')
  if (startError) return { ok: false, reason: startError }
  const endError = framingValidationError(request.end, 'End')
  if (endError) return { ok: false, reason: endError }
  const easingError = animationEasingValidationError(request.easing)
  if (easingError) return { ok: false, reason: easingError }

  const durationFrames = Math.min(
    request.durationFrames,
    clip.timelineRange.durationFrames,
  )
  const endFrame = durationFrames - 1
  const start = resolveFraming(doc, clip, source, request.start)
  const end = resolveFraming(doc, clip, source, request.end)
  if (!start || !end) {
    return {
      ok: false,
      reason: `Dynamic zoom would exceed the supported scale range of ${MIN_CLIP_SCALE} to ${MAX_CLIP_SCALE}.`,
    }
  }
  const tracks = [
    framingTrack('position-x', start.x, end.x, endFrame, request.easing),
    framingTrack('position-y', start.y, end.y, endFrame, request.easing),
    framingTrack('scale-x', start.scale, end.scale, endFrame, request.easing),
    framingTrack('scale-y', start.scale, end.scale, endFrame, request.easing),
  ]
  return {
    ok: true,
    plan: {
      durationFrames,
      requestedDurationFrames: request.durationFrames,
      durationClamped: durationFrames !== request.durationFrames,
      start,
      end,
      tracks,
    },
  }
}

/** The exact net-growth guard shared by readiness UI and the document edit. */
export function dynamicZoomKeyframeBudgetReason(
  doc: TimelineDoc,
  clip: Clip,
  plan: DynamicZoomPlan,
): string | null {
  const replacedKeyframes = clipAnimation(clip).tracks
    .filter(({ property }) => isDynamicZoomFramingProperty(property))
    .reduce((total, track) => total + track.keyframes.length, 0)
  const plannedKeyframes = plan.tracks.reduce(
    (total, track) => total + track.keyframes.length,
    0,
  )
  return documentAnimationKeyframeGrowthAllowed(
    doc,
    Math.max(0, plannedKeyframes - replacedKeyframes),
  )
    ? null
    : DYNAMIC_ZOOM_KEYFRAME_BUDGET_REASON
}

export function isDynamicZoomFramingProperty(
  property: ClipAnimationProperty,
): boolean {
  return DYNAMIC_ZOOM_FRAMING_PROPERTIES.includes(
    property as (typeof DYNAMIC_ZOOM_FRAMING_PROPERTIES)[number],
  )
}
