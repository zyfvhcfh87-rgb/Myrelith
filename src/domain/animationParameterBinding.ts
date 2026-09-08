/** Explicit binding changes only declaration intent; it never infers historical provenance. */
import type { PluginVideoEffectContributionDeclaration } from './pluginVideoEffectStagePlan'
import type { AnimationParameterIdentity } from './animationParameterIdentity'
import { animationParameterIdentityMatches } from './animationParameterIdentity'
import { resolveScalarAnimationProperty, scalarAnimationValueError } from './animationPropertyCatalog'
import { keyframesValidationError } from './scalarAnimation'
import { replaceProjectSequence, sequenceById, type SequenceProject } from './projectSequences'

export function bindPluginAnimationParameter(
  project: SequenceProject,
  sequenceId: string,
  clipId: string,
  effectId: string,
  parameter: string,
  declaration: PluginVideoEffectContributionDeclaration,
): { readonly ok: true; readonly project: SequenceProject } | { readonly ok: false; readonly reason: string } {
  const sequence = sequenceById(project, sequenceId)
  const trackIndex = sequence?.tracks.findIndex((track) => track.clips.some((clip) => clip.id === clipId)) ?? -1
  if (!sequence || trackIndex < 0) return { ok: false, reason: 'The animation owner no longer exists.' }
  const track = sequence.tracks[trackIndex]
  if (track.locked || track.kind !== 'video') return { ok: false, reason: 'Binding requires an unlocked visual clip.' }
  const clipIndex = track.clips.findIndex((clip) => clip.id === clipId)
  const clip = track.clips[clipIndex]
  const effect = clip.effects.find((item) => item.id === effectId)
  const lane = clip.animation?.effectTracks?.find((item) => item.effectId === effectId && item.parameter === parameter)
  if (!effect || !effect.type.startsWith('plugin:') || !lane) return { ok: false, reason: 'The plugin effect or stored scalar keys are unavailable.' }
  const identity: AnimationParameterIdentity = {
    version: 1, effectType: declaration.effectType, descriptorVersion: declaration.descriptorVersion,
    contributionId: declaration.contributionId, contributionVersion: declaration.contributionVersion,
    packageDigest: declaration.packageDigest,
  }
  const property = resolveScalarAnimationProperty({ kind: 'effect', effect, parameter, identity, declaration })
  if (property.status !== 'available') return { ok: false, reason: property.reason }
  const error = keyframesValidationError(lane.keyframes, (value) => scalarAnimationValueError(property.spec, value))
  if (error) return { ok: false, reason: error }
  if (animationParameterIdentityMatches(lane.parameterIdentity, declaration)) return { ok: true, project }
  const clips = track.clips.slice()
  clips[clipIndex] = { ...clip, animation: { ...clip.animation!, effectTracks: clip.animation!.effectTracks!.map((item) => item === lane ? { ...item, parameterIdentity: identity } : item) } }
  const tracks = sequence.tracks.slice()
  tracks[trackIndex] = { ...track, clips }
  const candidate = replaceProjectSequence(project, sequenceId, { ...sequence, tracks })
  return candidate === project ? { ok: false, reason: 'Binding exceeds the project animation limits.' } : { ok: true, project: candidate }
}
