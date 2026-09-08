/** Shared descriptor transaction used by mask gestures and numeric editing. */
import { clipAnimation, documentAnimationKeyframeGrowthAllowed, MAX_KEYFRAMES_PER_TRACK, resolveClipAnimationAtFrame } from './clipAnimation'
import { effectDescriptorBoundsError, effectReplacementBudgetError } from './effectBounds'
import { effectAnimationParameterSpec, effectParamsValidationError, MASK_EFFECT_TYPE, MASK_EFFECT_VERSION, maskParams, type MaskParams } from './effectStack'
import { updateEffectParamsAtFrame } from './operations/effects'
import { replaceProjectSequence, sequenceProjectWithinEditBudget, type SequenceProject } from './projectSequences'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'
import type { EffectParamValue, TimelineDoc } from './schema'

export interface MaskEditTarget { readonly sequenceId: string; readonly clipId: string; readonly effectId: string }
export type MaskEditPatch = Readonly<Partial<Pick<MaskParams, 'shape' | 'x' | 'y' | 'width' | 'height' | 'feather' | 'invert' | 'path'>>>

export function maskEditingTarget(doc: TimelineDoc, target: MaskEditTarget, frame: number) {
  if (doc.id !== target.sequenceId) throw new Error('The mask sequence is no longer active.')
  const track = doc.tracks.find((track) => track.clips.some((clip) => clip.id === target.clipId))
  const clip = track?.clips.find((clip) => clip.id === target.clipId)
  if (!track || !clip || track.kind !== 'video') throw new Error('Choose a visual clip mask.')
  if (track.locked) throw new Error('This mask is on a locked track.')
  if (track.hidden) throw new Error('Show this video track before editing its mask in Program.')
  if (!Number.isSafeInteger(frame) || frame < clip.timelineRange.startFrame || frame >= clip.timelineRange.startFrame + clip.timelineRange.durationFrames) throw new Error('Move the playhead inside this clip to edit its mask in Program.')
  const effect = resolveClipAnimationAtFrame(clip, frame).effects.find((effect) => effect.id === target.effectId)
  if (!effect || effect.type !== MASK_EFFECT_TYPE || effect.version !== MASK_EFFECT_VERSION) throw new Error('This mask effect version is unavailable.')
  if (!effect.enabled) throw new Error('Enable this mask before editing it in Program.')
  const error = effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
  if (error) throw new Error(`This mask is unavailable: ${error}`)
  return { clip, effect, params: maskParams(effect) }
}

export function editMaskParamsAtFrame(project: SequenceProject, target: MaskEditTarget, frame: number, patch: MaskEditPatch): TimelineDoc {
  const doc = project.sequences.find((sequence) => sequence.id === target.sequenceId)
  if (!doc) throw new Error('The mask sequence no longer exists.')
  const owner = maskEditingTarget(doc, target, frame)
  const allowed = ['shape', 'x', 'y', 'width', 'height', 'feather', 'invert', 'path']
  if (Object.keys(patch).length > allowed.length || Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown mask editing parameter.')
  const proposed = { ...owner.effect, params: { ...owner.effect.params, ...patch } as Record<string, EffectParamValue> }
  const error = effectDescriptorBoundsError(proposed) ?? effectParamsValidationError(proposed)
  if (error) throw new Error(error)
  const changedPatch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => owner.effect.params[key] !== value)) as Record<string, EffectParamValue>
  if (Object.keys(changedPatch).length === 0) return doc
  const animated = (clipAnimation(owner.clip).effectTracks ?? []).filter((track) => track.effectId === target.effectId && Object.hasOwn(changedPatch, track.parameter))
  const localFrame = frame - owner.clip.timelineRange.startFrame
  if (animated.length) {
    if (owner.clip.text) throw new Error('Text mask parameters are static.')
    if (animated.some((track) => !effectAnimationParameterSpec(owner.effect, track.parameter))) throw new Error('This mask parameter animation is unavailable.')
    const growing = animated.filter((track) => !track.keyframes.some((key) => key.frame === localFrame))
    if (growing.some((track) => track.keyframes.length >= MAX_KEYFRAMES_PER_TRACK) || !documentAnimationKeyframeGrowthAllowed(doc, growing.length)) throw new Error('This mask edit exceeds the keyframe budget.')
    sourceTicksAtTimelineOffset(clipSourceTimeMap(owner.clip), localFrame)
  }
  const original = owner.clip.effects.find((effect) => effect.id === target.effectId)!
  const staticPatch = Object.fromEntries(Object.entries(changedPatch).filter(([key]) => !animated.some((track) => track.parameter === key)))
  const budgetError = effectReplacementBudgetError(doc, original, { ...original, params: { ...original.params, ...staticPatch } })
  if (budgetError) throw new Error(budgetError)
  const next = updateEffectParamsAtFrame(doc, target.clipId, target.effectId, frame, changedPatch)
  if (next === doc) throw new Error('The mask edit could not be applied.')
  const candidate = replaceProjectSequence(project, doc.id, next)
  if (candidate === project || !sequenceProjectWithinEditBudget(candidate)) throw new Error('This mask edit exceeds project limits.')
  return next
}
