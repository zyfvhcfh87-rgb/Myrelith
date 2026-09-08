import { commitPortableColorEdit } from './colorLutController'
import { colorLutsForEffects, mergeColorLuts, remapColorLutEffects } from '../domain/colorLutCatalog'
import { effectPresetError, type EffectPreset } from '../domain/effectPresets'
import { editVideoBus } from '../domain/videoBusEffects'
import { videoBusOwner, type VideoBusEdit, type VideoBusTarget } from '../domain/videoBusEffects'
import { cloneEffectDescriptor } from '../domain/effectStack'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import type { PresetSaveSession } from './effectPresetController'
export { videoBusEffectIneligibility, videoBusRenderBudgetError } from '../domain/videoBusStage'
export { videoBusOwner, type VideoBusTarget }
export interface VideoBusSession { readonly project: ReturnType<typeof useDocumentStore.getState>['project']; readonly generation: number; readonly target: VideoBusTarget; readonly name: string }
export function openVideoBusEdit(target: VideoBusTarget): VideoBusSession {
  const state = useDocumentStore.getState(), owner = videoBusOwner(state.project, target)
  if (!owner) throw new Error('The video bus no longer exists.')
  return { project: state.project, generation: state.projectGeneration, target: { ...target }, name: owner.name }
}
export function applyVideoBusEdit(session: VideoBusSession, command: VideoBusEdit): string | null {
  const state = useDocumentStore.getState()
  if (state.projectGeneration !== session.generation) return 'The project changed. Reopen the video-bus controls.'
  return state.editVideoBus(session.project, session.target, command)
}
export function openVideoBusPresetSave(target: VideoBusTarget): PresetSaveSession {
  const state = useDocumentStore.getState(), owner = videoBusOwner(state.project, target)
  if (!owner) throw new Error('The video bus no longer exists.')
  return { generation: state.projectGeneration, sourceName: owner.name, frame: useTransportStore.getState().playheadFrame,
    preset: { id: crypto.randomUUID(), name: 'Untitled preset', colorLuts: colorLutsForEffects(owner.effects, state.project.colorLuts ?? []), effects: owner.effects.map((effect, index) => ({ ...cloneEffectDescriptor(effect), id: `template-${index}` })) } }
}

/** Validate and merge a portable bundle before one guarded bus edit. */
export function applyVideoBusPreset(session: VideoBusSession, preset: EffectPreset, mode: 'append' | 'replace'): string | null {
  const state = useDocumentStore.getState()
  if (state.project !== session.project || state.projectGeneration !== session.generation) return 'The project changed. Reopen the video-bus preset browser.'
  try {
    const error = effectPresetError(preset)
    if (error) return error
    const merged = mergeColorLuts(state.project.colorLuts ?? [], preset.colorLuts, () => crypto.randomUUID())
    const project = merged.catalog === state.project.colorLuts ? state.project : { ...state.project, colorLuts: merged.catalog }
    const result = editVideoBus(project, session.target, { kind: 'apply', effects: remapColorLutEffects(preset.effects, merged.ids), mode }, () => crypto.randomUUID())
    return result.ok ? commitPortableColorEdit(state.project, session.generation, result.project) : result.reason
  } catch (cause) { return cause instanceof Error ? cause.message : 'Could not apply the LUT preset.' }
}
