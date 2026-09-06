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
    preset: { id: crypto.randomUUID(), name: 'Untitled preset', effects: owner.effects.map((effect, index) => ({ ...cloneEffectDescriptor(effect), id: `template-${index}` })) } }
}
