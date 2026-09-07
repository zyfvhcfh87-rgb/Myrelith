import { COLOR_LUT_TYPE, type PortableColorLutV1 } from './colorLut'
import { colorLutsForEffects, mergeColorLuts, projectVideoEffects } from './colorLutCatalog'
import { effectRegistration } from './effectStack'
import { createProjectEffectIdAllocator, replaceProjectSequence, sequenceById, sequenceProjectWithinEditBudget, type SequenceProject } from './projectSequences'
import type { EffectDescriptor } from './schema'

export type ColorGradingTarget = { readonly sequenceId: string } & (
  | { readonly kind: 'clip'; readonly clipId: string }
  | { readonly kind: 'adjustment'; readonly adjustmentId: string }
  | { readonly kind: 'track'; readonly trackId: string }
  | { readonly kind: 'master' }
)

/** Table and descriptor enter the project together, or neither does. */
export function applyColorLutToProject(project: SequenceProject, target: ColorGradingTarget, table: PortableColorLutV1, freshId: () => string, effectId?: string): SequenceProject {
  const sequence = sequenceById(project, target.sequenceId)
  if (!sequence) throw new Error('The grading sequence no longer exists.')
  const merged = mergeColorLuts(project.colorLuts ?? [], [table], freshId)
  const lutId = merged.ids.get(table.id)!
  const allocate = createProjectEffectIdAllocator(project, freshId)
  let found = false
  const edit = (effects: readonly EffectDescriptor[] = []): EffectDescriptor[] => {
    found = true
    if (effectId) {
      const old = effects.find((effect) => effect.id === effectId && effect.type === COLOR_LUT_TYPE && effect.version === 1)
      if (!old) throw new Error('The LUT effect no longer exists.')
      return effects.map((effect) => effect === old ? { ...effect, params: { ...effect.params, lutId } } : effect)
    }
    const id = allocate()
    if (!id) throw new Error('Could not allocate a unique effect identity.')
    return [...effects, { id, type: COLOR_LUT_TYPE, version: 1, enabled: true, params: { lutId, strength: 1 } }]
  }
  const next = target.kind === 'master' ? { ...sequence, masterVideoEffects: edit(sequence.masterVideoEffects) } : {
    ...sequence,
    tracks: sequence.tracks.map((track) => {
      const selected = target.kind === 'track' ? track.id === target.trackId
        : target.kind === 'clip' ? track.clips.some((clip) => clip.id === target.clipId)
          : (track.adjustments ?? []).some((item) => item.id === target.adjustmentId)
      if (!selected) return track
      if (track.kind !== 'video' || track.locked) throw new Error('Choose an unlocked video target for grading.')
      if (target.kind === 'track') return { ...track, videoEffects: edit(track.videoEffects) }
      if (target.kind === 'clip') return { ...track, clips: track.clips.map((clip) => clip.id === target.clipId ? { ...clip, effects: edit(clip.effects) } : clip) }
      return { ...track, adjustments: track.adjustments?.map((item) => item.id === target.adjustmentId ? { ...item, effects: edit(item.effects) } : item) }
    }),
  }
  if (!found) throw new Error('The grading target no longer exists.')
  const base = merged.catalog === project.colorLuts ? project : { ...project, colorLuts: merged.catalog }
  const candidate = replaceProjectSequence(base, target.sequenceId, next)
  if (candidate === base || !sequenceProjectWithinEditBudget(candidate)) throw new Error('The correction exceeds the project effect or identity budget.')
  if (merged.catalog === project.colorLuts && JSON.stringify(next) === JSON.stringify(sequence)) return project
  return candidate
}

/** Unknown contracts may contain references this release cannot interpret. */
export function removeUnusedColorLuts(project: SequenceProject): SequenceProject {
  const effects = projectVideoEffects(project)
  if (effects.some((effect) => {
    if (effect.type === COLOR_LUT_TYPE && effect.version === 1) return false
    const registration = effectRegistration(effect.type)
    return !registration || registration.version !== effect.version
  })) throw new Error('Preserved unsupported effects may reference LUTs. Remove those effects before removing unused tables.')
  const retained = colorLutsForEffects(effects, project.colorLuts ?? [])
  return retained.length === (project.colorLuts?.length ?? 0) ? project : { ...project, colorLuts: Object.freeze(retained) }
}
