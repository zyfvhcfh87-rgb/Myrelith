import type { Clip, ClipAnimationProperty, ClipAnimationTrack, ClipId, TimelineDoc, Transform } from '../schema';
import { ANIMATABLE_CLIP_PROPERTIES, clipAnimation, clipAnimationKeyframeCount, clipAnimationValidationError, documentAnimationKeyframeGrowthAllowed, animationPropertyValueError, isClipPropertyAnimated, LINEAR_ANIMATION_EASING, upsertAnimationKeyframe } from '../clipAnimation';
import { createDynamicZoomPlan, dynamicZoomKeyframeBudgetReason, isDynamicZoomFramingProperty, type DynamicZoomRequest, type DynamicZoomSourceDimensions } from '../dynamicZoom';
import type { VideoStabilizationPlan } from '../videoStabilization';
import type { MotionTrackingPlan } from '../motionTracking';
import { BOX_TRACKING_PROPERTIES, POINT_TRACKING_PROPERTIES, VIDEO_STABILIZATION_PROPERTIES } from '../framingProperties';
import { clipVisualSettings } from '../clipInspector';
import { clipBlendModeIntent } from '../blendModes';
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from '../sourceTimeMap';
import { locateClip, reject, type ClipLocation } from './operationInternals';
import { animationEditLocationResult, replaceClipAnimation } from './animation';
import { sameVisual, TRANSFORM_ANIMATION_PROPERTIES, updateClipVisual, type ClipVisualPatch } from './visual';

/** Framing edits report rejection and no-op outcomes to their Inspector UI. */
export type ClipFramingOperationResult =
  | {
    readonly ok: true
    readonly changed: boolean
    readonly doc: TimelineDoc
  }
  | {
    readonly ok: false
    readonly changed: false
    readonly doc: TimelineDoc
    readonly reason: string
  }

function rejectClipFramingOperation(
  doc: TimelineDoc,
  operation: string,
  reason: string,
): ClipFramingOperationResult {
  reject(doc, operation, reason)
  return { ok: false, changed: false, doc, reason }
}

/** Canonical track order: the animatable property list. */
function byAnimatablePropertyOrder(
  left: { readonly property: string },
  right: { readonly property: string },
): number {
  return ANIMATABLE_CLIP_PROPERTIES.indexOf(left.property as ClipAnimationProperty)
    - ANIMATABLE_CLIP_PROPERTIES.indexOf(right.property as ClipAnimationProperty)
}

/** True when a plan carries exactly one version-1 track per expected property. */
function planTracksMatch(
  tracks: readonly ClipAnimationTrack[],
  expected: readonly string[],
  owned: ReadonlySet<string>,
): boolean {
  return tracks.length === expected.length
    && expected.every((property) => (
      tracks.filter((track) => track.property === property).length === 1
    ))
    && tracks.every((track) => owned.has(track.property) && (track.propertyVersion ?? 1) === 1)
}

/**
 * Swap the tracks a stabilization or tracking plan owns for the plan's
 * copies, keeping every other track, then validate and budget the result.
 */
function replaceOwnedTransformTracks(
  doc: TimelineDoc,
  loc: ClipLocation,
  op: string,
  owned: ReadonlySet<string>,
  planTracks: readonly ClipAnimationTrack[],
  budgetReason: string,
): ClipFramingOperationResult {
  const current = clipAnimation(loc.clip)
  const tracks = [
    ...current.tracks.filter((track) => !owned.has(track.property)),
    ...planTracks.map((track) => ({
      property: track.property,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        easing: keyframe.easing.type === 'cubic-bezier'
          ? { ...keyframe.easing }
          : { type: keyframe.easing.type },
      })),
    })),
  ]
  tracks.sort(byAnimatablePropertyOrder)
  const animation = { ...current, tracks }
  const error = clipAnimationValidationError(animation)
  if (error) return rejectClipFramingOperation(doc, op, error)
  const additionalKeyframes = Math.max(
    0,
    clipAnimationKeyframeCount(animation) - clipAnimationKeyframeCount(current),
  )
  if (!documentAnimationKeyframeGrowthAllowed(doc, additionalKeyframes)) {
    return rejectClipFramingOperation(doc, op, budgetReason)
  }
  if (JSON.stringify(animation) === JSON.stringify(current)) {
    return { ok: true, changed: false, doc }
  }
  return {
    ok: true,
    changed: true,
    doc: replaceClipAnimation(doc, loc, animation),
  }
}

/**
 * Replace the four ordinary position/scale tracks with one dynamic-zoom plan.
 * Rotation/opacity and future animation-container fields remain untouched.
 */
export function applyDynamicZoomWithResult(
  doc: TimelineDoc,
  clipId: ClipId,
  source: DynamicZoomSourceDimensions,
  request: DynamicZoomRequest,
): ClipFramingOperationResult {
  const op = 'applyDynamicZoom'
  const location = animationEditLocationResult(doc, clipId)
  if (!location.ok) {
    return rejectClipFramingOperation(doc, op, location.reason)
  }
  const loc = location.loc
  const result = createDynamicZoomPlan(doc, loc.clip, source, request)
  if (!result.ok) return rejectClipFramingOperation(doc, op, result.reason)

  const current = clipAnimation(loc.clip)
  const retainedTracks = current.tracks.filter(
    ({ property }) => !isDynamicZoomFramingProperty(property),
  )
  const budgetReason = dynamicZoomKeyframeBudgetReason(doc, loc.clip, result.plan)
  if (budgetReason) return rejectClipFramingOperation(doc, op, budgetReason)
  let plannedTracks: typeof result.plan.tracks
  try {
    plannedTracks = result.plan.tracks.map((track) => ({
      property: track.property,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        sourceTimeTicks: sourceTicksAtTimelineOffset(
          clipSourceTimeMap(loc.clip),
          keyframe.frame,
        ),
      })),
    }))
  } catch {
    return rejectClipFramingOperation(
      doc,
      op,
      'dynamic zoom keyframe source time exceeds safe integer bounds',
    )
  }
  const tracks = [...retainedTracks, ...plannedTracks]
  tracks.sort(byAnimatablePropertyOrder)
  const animation = { ...current, tracks }
  const animationError = clipAnimationValidationError(animation)
  if (animationError) return rejectClipFramingOperation(doc, op, animationError)
  if (JSON.stringify(animation) === JSON.stringify(current)) {
    return { ok: true, changed: false, doc }
  }
  return {
    ok: true,
    changed: true,
    doc: replaceClipAnimation(doc, loc, animation),
  }
}

/** Replace the five ordinary transform tracks with one reviewed stabilization plan. */
export function applyVideoStabilizationWithResult(
  doc: TimelineDoc,
  clipId: ClipId,
  plan: VideoStabilizationPlan,
  replaceExisting: boolean,
): ClipFramingOperationResult {
  const op = 'applyVideoStabilization'
  const location = animationEditLocationResult(doc, clipId)
  if (!location.ok) return rejectClipFramingOperation(doc, op, location.reason)
  const owned = new Set<string>(VIDEO_STABILIZATION_PROPERTIES)
  const existingOwned = clipAnimation(location.loc.clip).tracks
    .some((track) => owned.has(track.property))
  if (existingOwned && !replaceExisting) {
    return rejectClipFramingOperation(
      doc,
      op,
      'existing Position, Rotation, or Scale animation requires explicit replacement confirmation',
    )
  }
  if (!planTracksMatch(plan.tracks, VIDEO_STABILIZATION_PROPERTIES, owned)) {
    return rejectClipFramingOperation(doc, op, 'stabilization plan has an invalid track set')
  }
  return replaceOwnedTransformTracks(
    doc,
    location.loc,
    op,
    owned,
    plan.tracks,
    'stabilization would exceed the document keyframe budget',
  )
}

/** Replace the exact Position/Scale properties owned by one accepted tracking plan. */
export function applyMotionTrackingWithResult(
  doc: TimelineDoc,
  plan: MotionTrackingPlan,
  replaceExisting: boolean,
): ClipFramingOperationResult {
  const op = 'applyMotionTracking'
  const location = animationEditLocationResult(doc, plan.targetClipId)
  if (!location.ok) return rejectClipFramingOperation(doc, op, location.reason)
  const expected = plan.kind === 'box' && plan.includeScale
    ? BOX_TRACKING_PROPERTIES
    : POINT_TRACKING_PROPERTIES
  const owned = new Set<string>(expected)
  if (!planTracksMatch(plan.tracks, expected, owned)) {
    return rejectClipFramingOperation(doc, op, 'motion-tracking plan has an invalid track set')
  }
  const existingOwned = clipAnimation(location.loc.clip).tracks
    .some((track) => owned.has(track.property))
  if (existingOwned && !replaceExisting) {
    return rejectClipFramingOperation(
      doc,
      op,
      `existing ${plan.includeScale ? 'Position or Scale' : 'Position'} animation requires explicit replacement confirmation`,
    )
  }
  return replaceOwnedTransformTracks(
    doc,
    location.loc,
    op,
    owned,
    plan.tracks,
    'motion tracking would exceed the document keyframe budget',
  )
}

/** Explicit one-entry removal of every ordinary Position/Rotation/Scale track. */
export function resetVideoStabilizationWithResult(
  doc: TimelineDoc,
  clipId: ClipId,
): ClipFramingOperationResult {
  const op = 'resetVideoStabilization'
  const location = animationEditLocationResult(doc, clipId)
  if (!location.ok) return rejectClipFramingOperation(doc, op, location.reason)
  const owned = new Set<string>(VIDEO_STABILIZATION_PROPERTIES)
  const current = clipAnimation(location.loc.clip)
  const tracks = current.tracks.filter((track) => !owned.has(track.property))
  if (tracks.length === current.tracks.length) return { ok: true, changed: false, doc }
  return {
    ok: true,
    changed: true,
    doc: replaceClipAnimation(doc, location.loc, { ...current, tracks }),
  }
}

/**
 * Explicitly remove every Position X/Y and Scale X/Y track. With no hidden
 * preset provenance this also removes later manual edits on those tracks;
 * rotation, opacity, and static transform values remain unchanged.
 */
export function resetClipFramingAnimationWithResult(
  doc: TimelineDoc,
  clipId: ClipId,
): ClipFramingOperationResult {
  const op = 'resetClipFramingAnimation'
  const location = animationEditLocationResult(doc, clipId)
  if (!location.ok) {
    return rejectClipFramingOperation(doc, op, location.reason)
  }
  const loc = location.loc
  const current = clipAnimation(loc.clip)
  const tracks = current.tracks.filter(
    ({ property }) => !isDynamicZoomFramingProperty(property),
  )
  if (tracks.length === current.tracks.length) {
    return { ok: true, changed: false, doc }
  }
  return {
    ok: true,
    changed: true,
    doc: replaceClipAnimation(doc, loc, { ...current, tracks }),
  }
}

function staticVisualPatchDiffers(
  clip: Clip,
  patch: ClipVisualPatch,
): boolean {
  for (const [key, value] of Object.entries(patch.transform ?? {}) as Array<
    [keyof Transform, number]
  >) {
    if (clip.transform[key] !== value) return true
  }
  if (patch.opacity !== undefined && clip.opacity !== patch.opacity) return true
  if (
    patch.blendMode !== undefined
    && clipBlendModeIntent(clip) !== patch.blendMode
  ) return true
  if (patch.visual) {
    const current = clipVisualSettings(clip)
    const next = {
      ...current,
      ...patch.visual,
      crop: { ...current.crop, ...(patch.visual.crop ?? {}) },
    }
    if (!sameVisual(current, next)) return true
  }
  return false
}

/**
 * Apply Inspector/Program Monitor edits at one timeline frame. Static
 * properties keep using their durable fields; already-animated properties
 * receive a keyframe at the playhead without mutating the document per frame.
 */
export function updateClipVisualAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  timelineFrame: number,
  patch: ClipVisualPatch,
): TimelineDoc {
  const op = 'updateClipVisualAtFrame'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (!Number.isSafeInteger(timelineFrame)) {
    return reject(doc, op, `timeline frame must be a safe integer, got ${timelineFrame}`)
  }

  const normalizedTransform = { ...(patch.transform ?? {}) }
  const currentVisual = clipVisualSettings(loc.clip)
  const scaleLocked = patch.visual?.scaleLocked ?? currentVisual.scaleLocked
  if (
    scaleLocked
    && (normalizedTransform.scaleX !== undefined || normalizedTransform.scaleY !== undefined)
  ) {
    if (
      normalizedTransform.scaleX !== undefined
      && normalizedTransform.scaleY !== undefined
      && normalizedTransform.scaleX !== normalizedTransform.scaleY
    ) return reject(doc, op, 'locked scale X and Y must match')
    const scale = normalizedTransform.scaleX ?? normalizedTransform.scaleY
    normalizedTransform.scaleX = scale
    normalizedTransform.scaleY = scale
  }

  const animatedValues = new Map<ClipAnimationProperty, number>()
  const staticTransform: Partial<Transform> = {}
  for (const [key, value] of Object.entries(normalizedTransform) as Array<
    [keyof Transform, number]
  >) {
    const property = TRANSFORM_ANIMATION_PROPERTIES[key]
    if (property && isClipPropertyAnimated(loc.clip, property)) {
      const valueError = animationPropertyValueError(property, value)
      if (valueError) return reject(doc, op, valueError)
      animatedValues.set(property, value)
    } else {
      staticTransform[key] = value
    }
  }
  let staticOpacity = patch.opacity
  if (patch.opacity !== undefined && isClipPropertyAnimated(loc.clip, 'opacity')) {
    const valueError = animationPropertyValueError('opacity', patch.opacity)
    if (valueError) return reject(doc, op, valueError)
    animatedValues.set('opacity', patch.opacity)
    staticOpacity = undefined
  }

  const localFrame = timelineFrame - loc.clip.timelineRange.startFrame
  if (
    animatedValues.size > 0
    && (
      localFrame < 0
      || localFrame >= loc.clip.timelineRange.durationFrames
    )
  ) return reject(doc, op, 'playhead must be inside the clip to edit animated values')

  const additionalKeyframes = [...animatedValues.keys()].filter((property) => (
    !clipAnimation(loc.clip).tracks
      .find((track) => track.property === property)
      ?.keyframes.some((keyframe) => keyframe.frame === localFrame)
  )).length
  if (!documentAnimationKeyframeGrowthAllowed(doc, additionalKeyframes)) {
    return reject(doc, op, 'animated edit would exceed the document keyframe budget')
  }

  const staticPatch: ClipVisualPatch = {
    ...(Object.keys(staticTransform).length === 0 ? {} : { transform: staticTransform }),
    ...(staticOpacity === undefined ? {} : { opacity: staticOpacity }),
    ...(patch.blendMode === undefined ? {} : { blendMode: patch.blendMode }),
    ...(patch.visual === undefined ? {} : { visual: patch.visual }),
  }
  const hasStaticPatch = Object.keys(staticPatch).length > 0
  let working = doc
  if (hasStaticPatch) {
    const next = updateClipVisual(doc, clipId, staticPatch)
    if (next === doc && staticVisualPatchDiffers(loc.clip, staticPatch)) return doc
    working = next
  }
  if (animatedValues.size === 0) return working

  const workingLoc = locateClip(working, clipId)
  if (!workingLoc) return doc
  let animation = clipAnimation(workingLoc.clip)
  for (const [property, value] of animatedValues) {
    const existing = animation.tracks
      .find((track) => track.property === property)
      ?.keyframes.find((keyframe) => keyframe.frame === localFrame)
    const next = upsertAnimationKeyframe(animation, property, {
      frame: localFrame,
      sourceTimeTicks: sourceTicksAtTimelineOffset(
        clipSourceTimeMap(workingLoc.clip),
        localFrame,
      ),
      value,
      easing: existing?.easing ?? LINEAR_ANIMATION_EASING,
    })
    if (!next) return reject(doc, op, 'animated edit exceeds keyframe limits')
    animation = next
  }
  return replaceClipAnimation(working, workingLoc, animation)
}
