import { isProceduralTitleClip } from './textOverlay'
/** Shared descriptor transaction used by mask gestures and numeric editing. */
import { clipAnimation, clipAnimationKeyframeCount, documentAnimationKeyframeGrowthAllowed, MAX_KEYFRAMES_PER_TRACK, resolveClipAnimationAtFrame } from './clipAnimation'
import { effectDescriptorBoundsError, effectReplacementBudgetError } from './effectBounds'
import { effectAnimationParameterSpec, effectParamsValidationError, MASK_EFFECT_TYPE, MASK_EFFECT_VERSION, maskParams, type MaskParams } from './effectStack'
import { updateEffectParamsAtFrame } from './operations/effects'
import { replaceProjectSequence, sequenceProjectWithinEditBudget, type SequenceProject } from './projectSequences'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'
import type { ClipAnimation, EffectParamValue, TimelineDoc } from './schema'
import { editMaskPathKeys, heldMaskPathAtFrame, maskPathAnimationStatus, type MaskPathKeyEdit } from './maskPathEditing'
import { locateClip } from './operations/operationInternals'
import { replaceClipAnimation } from './operations/animation'

export interface MaskEditTarget { readonly sequenceId: string; readonly clipId: string; readonly effectId: string }
export type MaskEditPatch = Readonly<Partial<Pick<MaskParams, 'shape' | 'x' | 'y' | 'width' | 'height' | 'feather' | 'invert' | 'path'>>>

function replaceMaskPathAnimation(doc: TimelineDoc, clipId: string, animation: ClipAnimation): TimelineDoc {
  const location = locateClip(doc, clipId)!
  if (animation === clipAnimation(location.clip)) return doc
  const growth = Math.max(0, clipAnimationKeyframeCount(animation) - clipAnimationKeyframeCount(clipAnimation(location.clip)))
  if (!documentAnimationKeyframeGrowthAllowed(doc, growth)) throw new Error('This path edit exceeds the document keyframe budget.')
  return replaceClipAnimation(doc, location, animation)
}

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
  const pathTrack = owner.clip.animation?.effectPathTracks?.find((track) => track.effectId === target.effectId && track.parameter === 'path')
  const localFrame = frame - owner.clip.timelineRange.startFrame
  if (patch.path !== undefined && pathTrack) {
    // Explicit closure can reactivate a dormant lane; compare its held value,
    // not the rectangle's static fallback, before deciding whether this is a no-op.
    const reason = maskPathAnimationStatus(owner.clip, proposed).reason
    if (reason) throw new Error(reason)
    if (heldMaskPathAtFrame(owner.clip, proposed, localFrame) !== patch.path) changedPatch.path = patch.path
    else delete changedPatch.path
  }
  if (Object.keys(changedPatch).length === 0) return doc
  const animated = (clipAnimation(owner.clip).effectTracks ?? []).filter((track) => track.effectId === target.effectId && Object.hasOwn(changedPatch, track.parameter))
  if (animated.length) {
    if (isProceduralTitleClip(owner.clip)) throw new Error('Text mask parameters are static.')
    if (animated.some((track) => !effectAnimationParameterSpec(owner.effect, track.parameter))) throw new Error('This mask parameter animation is unavailable.')
    const growing = animated.filter((track) => !track.keyframes.some((key) => key.frame === localFrame))
    if (growing.some((track) => track.keyframes.length >= MAX_KEYFRAMES_PER_TRACK) || !documentAnimationKeyframeGrowthAllowed(doc, growing.length)) throw new Error('This mask edit exceeds the keyframe budget.')
    sourceTicksAtTimelineOffset(clipSourceTimeMap(owner.clip), localFrame)
  }
  const original = owner.clip.effects.find((effect) => effect.id === target.effectId)!
  const pathValue = pathTrack && typeof changedPatch.path === 'string' ? changedPatch.path : undefined
  const scalarPatch = { ...changedPatch }
  if (pathValue !== undefined) delete scalarPatch.path
  const staticPatch = Object.fromEntries(Object.entries(scalarPatch).filter(([key]) => !animated.some((track) => track.parameter === key)))
  const budgetError = effectReplacementBudgetError(doc, original, { ...original, params: { ...original.params, ...staticPatch } })
  if (budgetError) throw new Error(budgetError)
  let next = Object.keys(scalarPatch).length ? updateEffectParamsAtFrame(doc, target.clipId, target.effectId, frame, scalarPatch) : doc
  if (Object.keys(scalarPatch).length && next === doc) throw new Error('The mask parameter edit could not be applied.')
  if (pathValue !== undefined) {
    const location = locateClip(next, target.clipId)!
    const effect = location.clip.effects.find((item) => item.id === target.effectId)!
    const animation = editMaskPathKeys(location.clip, effect, { kind: 'set', frame: localFrame, value: pathValue })
    next = replaceMaskPathAnimation(next, target.clipId, animation)
  }
  if (next === doc) throw new Error('The mask edit could not be applied.')
  const candidate = replaceProjectSequence(project, doc.id, next)
  if (candidate === project || !sequenceProjectWithinEditBudget(candidate)) throw new Error('This mask edit exceeds project limits.')
  return next
}

export function editMaskPathAnimation(project: SequenceProject, target: MaskEditTarget, frame: number, action: 'set' | 'remove' | 'clear'): TimelineDoc {
  const doc = project.sequences.find((sequence) => sequence.id === target.sequenceId)
  if (!doc) throw new Error('The mask sequence no longer exists.')
  const owner = maskEditingTarget(doc, target, frame)
  const localFrame = frame - owner.clip.timelineRange.startFrame
  const edit: MaskPathKeyEdit = action === 'clear' ? { kind: 'clear' } : action === 'remove'
    ? { kind: 'remove', frame: localFrame } : { kind: 'set', frame: localFrame, value: owner.params.path }
  const animation = editMaskPathKeys(owner.clip, owner.effect, edit)
  if (animation === clipAnimation(owner.clip)) return doc
  const next = replaceMaskPathAnimation(doc, target.clipId, animation)
  const candidate = replaceProjectSequence(project, doc.id, next)
  if (candidate === project || !sequenceProjectWithinEditBudget(candidate)) throw new Error('This path edit exceeds project limits.')
  return next
}
