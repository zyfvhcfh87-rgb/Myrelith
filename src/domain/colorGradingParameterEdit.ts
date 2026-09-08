import type { ColorGradingTarget } from './colorGradingEdits'
import { isColorGradingType } from './colorGradingEffects'
import { effectAnimationParameterSpec, effectParamsValidationError, effectRegistration } from './effectStack'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { effectAppendBudgetError, effectDescriptorBoundsError, effectReplacementBudgetError } from './effectBounds'
import { documentAnimationKeyframeGrowthAllowed, MAX_KEYFRAMES_PER_TRACK } from './clipAnimation'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'
import { COLOR_CURVES_TYPE } from './colorCurves'
import { COLOR_WHEELS_TYPE } from './colorWheels'
import { updateEffectParamsAtFrame } from './operations/effects'
import { updateAdjustmentEffectParamsAtFrame } from './adjustmentItems'
import { editVideoBus } from './videoBusEffects'
import { createProjectEffectIdAllocator, replaceProjectSequence, sequenceById, sequenceProjectWithinEditBudget, type SequenceProject } from './projectSequences'
import type { EffectParamValue } from './schema'

export function colorGradingOwner(project: SequenceProject, target: ColorGradingTarget) {
  const sequence = sequenceById(project, target.sequenceId)
  if (!sequence) throw new Error('The grading sequence no longer exists.')
  if (target.kind === 'master') return { sequence, effects: sequence.masterVideoEffects ?? [], locked: false, clip: undefined, adjustment: undefined }
  const track = sequence.tracks.find((track) => target.kind === 'track' ? track.id === target.trackId
    : target.kind === 'clip' ? track.clips.some((clip) => clip.id === target.clipId)
      : track.adjustments?.some((item) => item.id === target.adjustmentId))
  if (!track || track.kind !== 'video') throw new Error('Choose a video grading target.')
  const clip = target.kind === 'clip' ? track.clips.find((clip) => clip.id === target.clipId) : undefined
  const adjustment = target.kind === 'adjustment' ? track.adjustments?.find((item) => item.id === target.adjustmentId) : undefined
  return { sequence, effects: clip?.effects ?? adjustment?.effects ?? track.videoEffects ?? [], locked: track.locked, clip, adjustment }
}

/** Shared preview/commit operation; existing keyframe semantics stay authoritative. */
export function editColorGradingParams(project: SequenceProject, target: ColorGradingTarget, effectId: string, frame: number, patch: Readonly<Record<string, EffectParamValue>>): SequenceProject {
  if (!Number.isSafeInteger(frame)) throw new Error('The playhead frame is invalid.')
  const owner = colorGradingOwner(project, target)
  if (owner.locked) throw new Error('This video track is locked.')
  const effect = owner.effects.find((effect) => effect.id === effectId)
  if (!effect || effect.version !== 1 || !isColorGradingType(effect.type)) throw new Error('This grading effect is unavailable.')
  const proposed = { ...effect, params: { ...effect.params, ...patch } }
  const error = effectDescriptorBoundsError(proposed) ?? effectParamsValidationError(proposed)
  if (error) throw new Error(error)
  const item = owner.clip ?? owner.adjustment
  const keys = item?.animation?.effectTracks ?? []
  const animated = keys.filter((track) => track.effectId === effectId && Object.hasOwn(patch, track.parameter))
  if (item && animated.length) {
    const localFrame = frame - item.timelineRange.startFrame
    if (localFrame < 0 || localFrame >= item.timelineRange.durationFrames) throw new Error('Move the playhead inside this item to edit animated grading.')
    if (owner.clip?.text) throw new Error('Text grading parameters are static.')
    const growing = animated.filter((track) => !track.keyframes.some((key) => key.frame === localFrame))
    if (growing.some((track) => track.keyframes.length >= MAX_KEYFRAMES_PER_TRACK)
      || !documentAnimationKeyframeGrowthAllowed(owner.sequence, growing.length)) throw new Error('This grading edit exceeds the keyframe budget.')
    for (const track of animated) {
      const spec = owner.clip?.title === undefined ? effectAnimationParameterSpec(effect, track.parameter)
        : titleEffectAnimationParameterSpec(owner.clip, effect, track.parameter)
      const value = patch[track.parameter]
      if (!spec || typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw new Error('This grading parameter cannot receive that animation key.')
    }
    if (owner.clip) sourceTicksAtTimelineOffset(clipSourceTimeMap(owner.clip), localFrame)
  }
  const staticPatch = Object.fromEntries(Object.entries(patch).filter(([parameter]) => !animated.some((track) => track.parameter === parameter)))
  const replacementError = effectReplacementBudgetError(owner.sequence, effect, { ...effect, params: { ...effect.params, ...staticPatch } })
  if (replacementError) throw new Error(replacementError)
  let candidate: SequenceProject
  if (target.kind === 'master' || target.kind === 'track') {
    const result = editVideoBus(project, target, { kind: 'params', effectId, patch }, () => '')
    if (!result.ok) throw new Error(result.reason)
    candidate = result.project
  } else {
    const sequence = target.kind === 'clip'
      ? updateEffectParamsAtFrame(owner.sequence, target.clipId, effectId, frame, patch)
      : updateAdjustmentEffectParamsAtFrame(owner.sequence, target.adjustmentId, effectId, frame, patch)
    candidate = replaceProjectSequence(project, target.sequenceId, sequence)
  }
  if (!sequenceProjectWithinEditBudget(candidate)) throw new Error('This grading edit exceeds project limits.')
  return candidate
}

export function addColorGradingEffect(project: SequenceProject, target: ColorGradingTarget, type: string, freshId: () => string): SequenceProject {
  if (type !== COLOR_CURVES_TYPE && type !== COLOR_WHEELS_TYPE) throw new Error('Choose a LUT through its import or reuse picker.')
  const owner = colorGradingOwner(project, target), registration = effectRegistration(type)!
  if (owner.locked) throw new Error('This video track is locked.')
  const id = createProjectEffectIdAllocator(project, freshId)()
  if (!id) throw new Error('Could not allocate an effect identity.')
  const effect = { id, type, version: 1, enabled: true, params: { ...registration.defaultParams } }
  const error = effectAppendBudgetError(owner.sequence, owner, effect, target.kind)
  if (error) throw new Error(error)
  const effects = [...owner.effects, effect], sequence = owner.sequence
  const next = target.kind === 'master' ? { ...sequence, masterVideoEffects: effects }
    : { ...sequence, tracks: sequence.tracks.map((track) => target.kind === 'track' ? track.id === target.trackId ? { ...track, videoEffects: effects } : track
      : target.kind === 'clip' ? { ...track, clips: track.clips.map((clip) => clip.id === target.clipId ? { ...clip, effects } : clip) }
        : { ...track, adjustments: track.adjustments?.map((item) => item.id === target.adjustmentId ? { ...item, effects } : item) }) }
  const candidate = replaceProjectSequence(project, target.sequenceId, next)
  if (!sequenceProjectWithinEditBudget(candidate)) throw new Error('This effect exceeds the project budget.')
  return candidate
}
