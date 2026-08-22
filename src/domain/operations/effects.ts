import type { ClipId, Effect, EffectId, EffectParamValue, TimelineDoc } from '../schema';
import { clipAnimation, documentAnimationKeyframeGrowthAllowed, effectAnimationTrack, effectAnimationTracks, LINEAR_ANIMATION_EASING, removeEffectAnimationTracks, upsertEffectAnimationKeyframe } from '../clipAnimation';
import { effectParamsValidationError, effectAnimationParameterSpec, effectRegistration, cloneEffectDescriptor } from '../effectStack';
import { effectAppendBudgetError, effectDescriptorBoundsError, effectReplacementBudgetError } from '../effectBounds';
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from '../sourceTimeMap';
import { locateClip, reject, withTrack } from './operationInternals';
import { replaceClipAnimation } from './animation';

/**
 * Append an effect to a clip's chain. The effect is defensively copied so
 * later mutation of the caller's object cannot reach into the doc.
 */
export function addEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effect: Effect,
): TimelineDoc {
  const op = 'addEffect'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const validationError = effectDescriptorValidationError(effect)
  if (validationError) return reject(doc, op, validationError)
  const budgetError = effectAppendBudgetError(doc, loc.clip, effect)
  if (budgetError) return reject(doc, op, budgetError)
  if (effectIdExists(doc, effect.id)) {
    return reject(doc, op, `document already has an effect with id ${effect.id}`)
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    effects: [...loc.clip.effects, cloneEffectDescriptor(effect)],
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

function effectIdExists(doc: TimelineDoc, effectId: EffectId): boolean {
  return doc.tracks.some((track) =>
    track.clips.some((clip) => clip.effects.some((effect) => effect.id === effectId)),
  )
}

function effectDescriptorValidationError(effect: Effect): string | null {
  return effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
}

function updateEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  op: string,
  update: (effect: Effect, index: number, effects: readonly Effect[]) => Effect[] | null,
): TimelineDoc {
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const effectIndex = loc.clip.effects.findIndex((effect) => effect.id === effectId)
  if (effectIndex < 0) return reject(doc, op, `effect ${effectId} not found on clip ${clipId}`)
  const effects = update(loc.clip.effects[effectIndex], effectIndex, loc.clip.effects)
  if (!effects) return doc
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, effects }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Enable or bypass one effect without disturbing its position or parameters. */
export function setEffectEnabled(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  enabled: boolean,
): TimelineDoc {
  if (typeof enabled !== 'boolean') return reject(doc, 'setEffectEnabled', 'enabled must be a boolean')
  return updateEffect(doc, clipId, effectId, 'setEffectEnabled', (effect, index, current) => {
    if (effect.enabled === enabled) return null
    const effects = current.slice()
    effects[index] = { ...effect, enabled, params: { ...effect.params } }
    return effects
  })
}

/** Merge a typed parameter patch into one descriptor after registry validation. */
export function updateEffectParams(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  patch: Readonly<Record<string, EffectParamValue>>,
): TimelineDoc {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return reject(doc, 'updateEffectParams', 'parameter patch must be a record')
  }
  return updateEffect(doc, clipId, effectId, 'updateEffectParams', (effect, index, current) => {
    const next = { ...effect, params: { ...effect.params, ...patch } }
    const validationError = effectDescriptorValidationError(next)
    if (validationError) {
      reject(doc, 'updateEffectParams', validationError)
      return null
    }
    const budgetError = effectReplacementBudgetError(doc, effect, next)
    if (budgetError) {
      reject(doc, 'updateEffectParams', budgetError)
      return null
    }
    const changed = Object.entries(patch).some(([key, value]) => effect.params[key] !== value)
    if (!changed) return null
    const effects = current.slice()
    effects[index] = next
    return effects
  })
}

/**
 * Inspector edit semantics: static parameters stay static; an already-keyed
 * scalar parameter receives one key at the exact clip-local playhead frame.
 */
export function updateEffectParamsAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  timelineFrame: number,
  patch: Readonly<Record<string, EffectParamValue>>,
): TimelineDoc {
  const op = 'updateEffectParamsAtFrame'
  if (!Number.isSafeInteger(timelineFrame)) {
    return reject(doc, op, `timeline frame must be a safe integer, got ${timelineFrame}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const effect = loc.clip.effects.find((candidate) => candidate.id === effectId)
  if (!effect) return reject(doc, op, `effect ${effectId} not found on clip ${clipId}`)
  const currentAnimation = clipAnimation(loc.clip)
  const animated = new Map<string, number>()
  const staticPatch: Record<string, EffectParamValue> = {}
  for (const [parameter, value] of Object.entries(patch)) {
    if (effectAnimationTrack(currentAnimation, effectId, parameter)) {
      const spec = effectAnimationParameterSpec(effect, parameter)
      if (
        !spec
        || typeof value !== 'number'
        || !Number.isFinite(value)
        || value < spec.min
        || value > spec.max
      ) return reject(doc, op, `${effect.type}.${parameter} keyframe value is invalid`)
      animated.set(parameter, value)
    } else {
      staticPatch[parameter] = value
    }
  }
  const localFrame = timelineFrame - loc.clip.timelineRange.startFrame
  if (
    animated.size > 0
    && (loc.track.kind !== 'video' || loc.clip.text !== undefined)
  ) return reject(doc, op, 'effect keyframes are supported only on visual media clips')
  if (
    animated.size > 0
    && (localFrame < 0 || localFrame >= loc.clip.timelineRange.durationFrames)
  ) return reject(doc, op, 'playhead must be inside the clip to edit animated values')

  const additionalKeyframes = [...animated.keys()].filter((parameter) => (
    !effectAnimationTrack(currentAnimation, effectId, parameter)
      ?.keyframes.some((keyframe) => keyframe.frame === localFrame)
  )).length
  if (!documentAnimationKeyframeGrowthAllowed(doc, additionalKeyframes)) {
    return reject(doc, op, 'animated edit would exceed the document keyframe budget')
  }

  let working = doc
  if (Object.keys(staticPatch).length > 0) {
    working = updateEffectParams(doc, clipId, effectId, staticPatch)
    if (working === doc && Object.entries(staticPatch).some(
      ([parameter, value]) => effect.params[parameter] !== value,
    )) return doc
  }
  if (animated.size === 0) return working

  const workingLoc = locateClip(working, clipId)
  const workingEffect = workingLoc?.clip.effects.find((candidate) => candidate.id === effectId)
  if (!workingLoc || !workingEffect) return doc
  let animation = clipAnimation(workingLoc.clip)
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(
      clipSourceTimeMap(workingLoc.clip),
      localFrame,
    )
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  for (const [parameter, value] of animated) {
    const existing = effectAnimationTrack(animation, effectId, parameter)
      ?.keyframes.find((keyframe) => keyframe.frame === localFrame)
    const next = upsertEffectAnimationKeyframe(
      animation,
      workingEffect,
      parameter,
      {
        frame: localFrame,
        sourceTimeTicks,
        value,
        easing: existing?.easing ?? LINEAR_ANIMATION_EASING,
      },
    )
    if (!next) return reject(doc, op, 'animated edit exceeds effect keyframe limits')
    animation = next
  }
  return replaceClipAnimation(working, workingLoc, animation)
}

/** Move one descriptor to an exact index while retaining stable instance identity. */
export function reorderEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  targetIndex: number,
): TimelineDoc {
  if (!Number.isSafeInteger(targetIndex)) {
    return reject(doc, 'reorderEffect', `target index must be a safe integer, got ${targetIndex}`)
  }
  return updateEffect(doc, clipId, effectId, 'reorderEffect', (_effect, index, current) => {
    if (targetIndex < 0 || targetIndex >= current.length) {
      reject(doc, 'reorderEffect', `target index ${targetIndex} is outside the effect stack`)
      return null
    }
    if (targetIndex === index) return null
    const effects = current.slice()
    const [moved] = effects.splice(index, 1)
    effects.splice(targetIndex, 0, moved)
    return effects
  })
}

/** Reset registered parameters while retaining unknown forward-compatible keys. */
export function resetEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
): TimelineDoc {
  const op = 'resetEffect'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const index = loc.clip.effects.findIndex((effect) => effect.id === effectId)
  if (index < 0) return reject(doc, op, `effect ${effectId} not found on clip ${clipId}`)
  const effect = loc.clip.effects[index]
  const registration = effectRegistration(effect.type)
  if (!registration || registration.version !== effect.version) {
    return reject(doc, op, `effect ${effectId} has no supported reset contract`)
  }
  const params = { ...effect.params, ...registration.defaultParams }
  const candidate = { ...effect, params }
  const boundsError = effectDescriptorBoundsError(candidate)
  if (boundsError) return reject(doc, op, boundsError)
  const budgetError = effectReplacementBudgetError(doc, effect, candidate)
  if (budgetError) return reject(doc, op, budgetError)
  const animation = removeEffectAnimationTracks(clipAnimation(loc.clip), effectId)
  const changedParams = Object.entries(registration.defaultParams)
    .some(([key, value]) => effect.params[key] !== value)
  const changedTracks = effectAnimationTracks(animation).length
    !== effectAnimationTracks(clipAnimation(loc.clip)).length
  if (!changedParams && !changedTracks) return doc
  const effects = loc.clip.effects.slice()
  effects[index] = candidate
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, effects, animation }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Remove one descriptor from a clip's ordered stack. */
export function removeEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
): TimelineDoc {
  const op = 'removeEffect'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const index = loc.clip.effects.findIndex((effect) => effect.id === effectId)
  if (index < 0) return reject(doc, op, `effect ${effectId} not found on clip ${clipId}`)
  const effects = loc.clip.effects.slice()
  effects.splice(index, 1)
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    effects,
    animation: removeEffectAnimationTracks(clipAnimation(loc.clip), effectId),
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}
