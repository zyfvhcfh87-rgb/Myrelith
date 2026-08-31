import type { Clip, ClipAnimationEasing, ClipAnimationKeyframe, ClipAnimationProperty, ClipId, Effect, EffectId, TimelineDoc } from '../schema';
import {
  clipAnimation,
  documentAnimationKeyframeGrowthAllowed,
  effectAnimationTrack,
  isAudioAnimationProperty,
  moveAnimationKeyframe,
  removeAnimationKeyframe,
  removeAnimationTrack,
  moveEffectAnimationKeyframe,
  removeEffectAnimationKeyframe,
  removeEffectAnimationTracks,
  upsertAnimationKeyframe,
  upsertEffectAnimationKeyframe,
} from '../clipAnimation';
import { effectAnimationParameterSpec } from '../effectStack';
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from '../sourceTimeMap';
import { locateClip, reject, withTrack, type ClipLocation } from './operationInternals';

function sameAnimationEasing(
  left: ClipAnimationEasing,
  right: ClipAnimationEasing,
): boolean {
  if (left.type !== right.type) return false
  return left.type !== 'cubic-bezier'
    || (
      right.type === 'cubic-bezier'
      && left.x1 === right.x1
      && left.y1 === right.y1
      && left.x2 === right.x2
      && left.y2 === right.y2
    )
}

function animationEditLocation(
  doc: TimelineDoc,
  clipId: ClipId,
  operation: string,
  property?: ClipAnimationProperty,
): ClipLocation | null {
  const result = animationEditLocationResult(doc, clipId, property)
  if (!result.ok) {
    reject(doc, operation, result.reason)
    return null
  }
  return result.loc
}

type AnimationEditLocationResult =
  | { readonly ok: true; readonly loc: ClipLocation }
  | { readonly ok: false; readonly reason: string }

export function animationEditLocationResult(
  doc: TimelineDoc,
  clipId: ClipId,
  property?: ClipAnimationProperty,
): AnimationEditLocationResult {
  const loc = locateClip(doc, clipId)
  if (!loc) return { ok: false, reason: `clip ${clipId} not found` }
  if (loc.track.locked) {
    return { ok: false, reason: `track ${loc.track.id} is locked` }
  }
  if (loc.clip.text !== undefined) {
    return {
      ok: false,
      reason: 'keyframes are supported only on visual media clips',
    }
  }
  if (loc.track.kind === 'audio') {
    if (property !== undefined && isAudioAnimationProperty(property)) {
      return { ok: true, loc }
    }
    return {
      ok: false,
      reason: 'audio clips support only volume and balance keyframes',
    }
  }
  if (loc.track.kind !== 'video') {
    return {
      ok: false,
      reason: 'keyframes are supported only on visual media clips',
    }
  }
  return { ok: true, loc }
}

export function replaceClipAnimation(
  doc: TimelineDoc,
  loc: ClipLocation,
  animation: NonNullable<Clip['animation']>,
): TimelineDoc {
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, animation }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Add or replace one exact property/time keyframe. Duplicate time is replace. */
export function setClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  keyframe: ClipAnimationKeyframe,
): TimelineDoc {
  const op = 'setClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op, property)
  if (!loc) return doc
  const current = clipAnimation(loc.clip)
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(
      clipSourceTimeMap(loc.clip),
      keyframe.frame,
    )
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const authoredKeyframe = { ...keyframe, sourceTimeTicks }
  const existing = current.tracks
    .find((track) => track.property === property)
    ?.keyframes.find((item) => item.frame === keyframe.frame)
  if (
    existing
    && existing.value === keyframe.value
    && sameAnimationEasing(existing.easing, keyframe.easing)
    && (existing.sourceTimeTicks ?? sourceTimeTicks) === sourceTimeTicks
  ) return doc
  if (!existing && !documentAnimationKeyframeGrowthAllowed(doc, 1)) {
    return reject(doc, op, 'document has reached the keyframe budget')
  }
  const animation = upsertAnimationKeyframe(current, property, authoredKeyframe)
  if (!animation) return reject(doc, op, 'invalid or over-budget keyframe')
  return replaceClipAnimation(doc, loc, animation)
}

/** Move one keyframe; its source replaces any key already at the target time. */
export function moveClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  fromFrame: number,
  toFrame: number,
): TimelineDoc {
  const op = 'moveClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op, property)
  if (!loc) return doc
  const animation = moveAnimationKeyframe(
    clipAnimation(loc.clip),
    property,
    fromFrame,
    toFrame,
  )
  if (!animation) return reject(doc, op, 'source keyframe is missing or target frame is invalid')
  if (animation === clipAnimation(loc.clip)) return doc
  const moved = animation.tracks
    .find((track) => track.property === property)
    ?.keyframes.find((keyframe) => keyframe.frame === toFrame)
  if (!moved) return reject(doc, op, 'moved keyframe is missing')
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(clipSourceTimeMap(loc.clip), toFrame)
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const withIntent = upsertAnimationKeyframe(animation, property, {
    ...moved,
    sourceTimeTicks,
  })
  if (!withIntent) return reject(doc, op, 'moved keyframe source time is invalid')
  return replaceClipAnimation(doc, loc, withIntent)
}

export function removeClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  frame: number,
): TimelineDoc {
  const op = 'removeClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op, property)
  if (!loc) return doc
  const animation = removeAnimationKeyframe(clipAnimation(loc.clip), property, frame)
  if (!animation) return reject(doc, op, 'keyframe not found')
  return replaceClipAnimation(doc, loc, animation)
}

/** Remove one property track while retaining its underlying static value. */
export function resetClipAnimationTrack(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
): TimelineDoc {
  const op = 'resetClipAnimationTrack'
  const loc = animationEditLocation(doc, clipId, op, property)
  if (!loc) return doc
  const animation = removeAnimationTrack(clipAnimation(loc.clip), property)
  if (!animation) return doc
  return replaceClipAnimation(doc, loc, animation)
}

function effectAnimationEditLocation(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  parameter: string,
  operation: string,
): { loc: ClipLocation; effect: Effect } | null {
  const loc = animationEditLocation(doc, clipId, operation)
  if (!loc) return null
  const effect = loc.clip.effects.find((candidate) => candidate.id === effectId)
  if (!effect) {
    reject(doc, operation, `effect ${effectId} not found on clip ${clipId}`)
    return null
  }
  if (!effectAnimationParameterSpec(effect, parameter)) {
    reject(doc, operation, `${effect.type}.${parameter} is not keyframeable`)
    return null
  }
  return { loc, effect }
}

/** Add or replace one exact effect-parameter/time keyframe. */
export function setEffectKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  parameter: string,
  keyframe: ClipAnimationKeyframe,
): TimelineDoc {
  const op = 'setEffectKeyframe'
  const target = effectAnimationEditLocation(doc, clipId, effectId, parameter, op)
  if (!target) return doc
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(
      clipSourceTimeMap(target.loc.clip),
      keyframe.frame,
    )
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const current = clipAnimation(target.loc.clip)
  const existing = effectAnimationTrack(current, effectId, parameter)
    ?.keyframes.find((item) => item.frame === keyframe.frame)
  if (
    existing
    && existing.value === keyframe.value
    && sameAnimationEasing(existing.easing, keyframe.easing)
    && (existing.sourceTimeTicks ?? sourceTimeTicks) === sourceTimeTicks
  ) return doc
  if (!existing && !documentAnimationKeyframeGrowthAllowed(doc, 1)) {
    return reject(doc, op, 'document has reached the keyframe budget')
  }
  const animation = upsertEffectAnimationKeyframe(
    current,
    target.effect,
    parameter,
    { ...keyframe, sourceTimeTicks },
  )
  if (!animation) return reject(doc, op, 'invalid or over-budget effect keyframe')
  return replaceClipAnimation(doc, target.loc, animation)
}

export function moveEffectKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  parameter: string,
  fromFrame: number,
  toFrame: number,
): TimelineDoc {
  const op = 'moveEffectKeyframe'
  const target = effectAnimationEditLocation(doc, clipId, effectId, parameter, op)
  if (!target) return doc
  const animation = moveEffectAnimationKeyframe(
    clipAnimation(target.loc.clip),
    target.effect,
    parameter,
    fromFrame,
    toFrame,
  )
  if (!animation) return reject(doc, op, 'source keyframe is missing or target frame is invalid')
  if (animation === clipAnimation(target.loc.clip)) return doc
  const moved = effectAnimationTrack(animation, effectId, parameter)
    ?.keyframes.find((keyframe) => keyframe.frame === toFrame)
  if (!moved) return reject(doc, op, 'moved keyframe is missing')
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(clipSourceTimeMap(target.loc.clip), toFrame)
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const withIntent = upsertEffectAnimationKeyframe(
    animation,
    target.effect,
    parameter,
    { ...moved, sourceTimeTicks },
  )
  return withIntent
    ? replaceClipAnimation(doc, target.loc, withIntent)
    : reject(doc, op, 'moved keyframe source time is invalid')
}

export function removeEffectKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  parameter: string,
  frame: number,
): TimelineDoc {
  const op = 'removeEffectKeyframe'
  const target = effectAnimationEditLocation(doc, clipId, effectId, parameter, op)
  if (!target) return doc
  const animation = removeEffectAnimationKeyframe(
    clipAnimation(target.loc.clip),
    effectId,
    parameter,
    frame,
  )
  return animation
    ? replaceClipAnimation(doc, target.loc, animation)
    : reject(doc, op, 'keyframe not found')
}

export function resetEffectAnimationTrack(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  parameter: string,
): TimelineDoc {
  const op = 'resetEffectAnimationTrack'
  const target = effectAnimationEditLocation(doc, clipId, effectId, parameter, op)
  if (!target) return doc
  if (!effectAnimationTrack(clipAnimation(target.loc.clip), effectId, parameter)) return doc
  return replaceClipAnimation(
    doc,
    target.loc,
    removeEffectAnimationTracks(
      clipAnimation(target.loc.clip),
      effectId,
      new Set([parameter]),
    ),
  )
}
