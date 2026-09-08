/** Explicit compact-text upgrade builds one candidate; callers own file/history admission. */
import { clipAnimation, resolveClipAnimationAtFrame } from './clipAnimation'
import { animationParameterIdentityError } from './animationParameterIdentity'
import { effectAnimationParameterSpec, effectSupportsSurface } from './effectStack'
import { clipVisualSettings, defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { projectTitleAnimationError } from './animationProjectBudget'
import { replaceProjectSequence, sequenceById, type SequenceProject } from './projectSequences'
import { reanchorProceduralAnimation } from './sourceTimeMap'
import { textPropsValidationError } from './textOverlay'
import { createTitleElementIdAllocator, projectTitleOwnershipError } from './titleOwnership'
import type { TitleTextElementV1 } from './titleElements'

export type TitleUpgradeResult =
  | { readonly ok: true; readonly project: SequenceProject; readonly elementId: string | null }
  | { readonly ok: false; readonly reason: string }

export function upgradeLegacyTextTitle(
  project: SequenceProject, sequenceId: string, clipId: string, factory: () => string,
): TitleUpgradeResult {
  try {
    const sequence = sequenceById(project, sequenceId)
    const track = sequence?.tracks.find((item) => item.clips.some((clip) => clip.id === clipId))
    const clip = track?.clips.find((item) => item.id === clipId)
    if (!sequence || !track || !clip) return { ok: false, reason: 'The text clip no longer exists.' }
    if (track.locked) return { ok: false, reason: 'Unlock the track before upgrading this title.' }
    if (clip.title !== undefined && clip.text === undefined) return { ok: true, project, elementId: null }
    if (clip.text === undefined || clip.title !== undefined || track.kind !== 'video') return { ok: false, reason: 'Choose one compact text clip on a video track.' }
    const textError = textPropsValidationError(clip.text)
    if (textError) return { ok: false, reason: textError }
    const pluginAnimation = clip.effects.some((effect) => effect.enabled && effect.type.startsWith('plugin:')
      && clip.animation?.effectTracks?.some((lane) => {
        const identity = lane.parameterIdentity
        return lane.effectId === effect.id && lane.keyframes.length > 0
          && identity?.version === 1 && animationParameterIdentityError(identity) === null
          && identity.effectType === effect.type && identity.descriptorVersion === effect.version
      }))
    if (pluginAnimation) return { ok: false, reason: 'Upgrading could change stored plugin animation. Keep this compact text clip to preserve its animation.' }
    const sourceEffectAnimation = clip.effects.some((effect, effectIndex) => effect.enabled
      && effectSupportsSurface(effect, 'source-layer') && !effectSupportsSurface(effect, 'post-composite')
      && clip.animation?.effectTracks?.some((lane) => {
        if (lane.effectId !== effect.id || lane.parameterIdentity !== undefined
          || !effectAnimationParameterSpec(effect, lane.parameter)) return false
        const key = lane.keyframes.find((key) => key.value !== effect.params[lane.parameter])
        if (!key) return false
        // The existing evaluator is the authority for track/value/descriptor
        // validity. Inactive malformed/future keys cannot trigger this refusal.
        const resolved = resolveClipAnimationAtFrame(clip, clip.timelineRange.startFrame + key.frame)
        return resolved.effects[effectIndex].params[lane.parameter] !== effect.params[lane.parameter]
      }))
    if (sourceEffectAnimation) return { ok: false, reason: 'Upgrading could change stored source-effect animation. Keep this compact text clip to preserve its animation.' }
    const allocate = createTitleElementIdAllocator(project, factory)
    const { fontFamily, ...text } = clip.text
    const visual = clipVisualSettings(clip)
    const element: TitleTextElementV1 = {
      id: allocate(), version: 1, kind: 'text', name: 'Text', enabled: true,
      transform: { ...clip.transform }, visual: { ...visual, crop: { ...visual.crop } }, opacity: 1,
      text, font: { family: fontFamily, fallbackFamily: null },
    }
    const { text: _legacy, ...base } = clip
    const replacement = {
      ...base, title: { version: 1 as const, elements: [element] },
      transform: defaultClipTransform(), visual: defaultClipVisualSettings(),
      animation: reanchorProceduralAnimation(clipAnimation(clip)),
    }
    const document = { ...sequence, tracks: sequence.tracks.map((item) => item !== track ? item : {
      ...item, clips: item.clips.map((item) => item === clip ? replacement : item),
    }) }
    const candidate = { ...project, sequences: project.sequences.map((item) => item === sequence ? document : item) }
    const error = projectTitleOwnershipError(candidate) ?? projectTitleAnimationError(candidate)
    if (error) return { ok: false, reason: error }
    const next = replaceProjectSequence(project, sequenceId, document)
    return next === project ? { ok: false, reason: 'This upgrade exceeds the complete project limits.' }
      : { ok: true, project: next, elementId: element.id }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'The title could not be upgraded.' } }
}
