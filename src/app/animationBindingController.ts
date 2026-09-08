/** The animation UI will supply the app-owned immutable catalog; binding is an explicit action. */
import { bindPluginAnimationParameter } from '../domain/animationParameterBinding'
import type { PluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import type { SequenceProject } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { commitPortableProjectEdit } from './portableProjectEdit'

export interface AnimationBindingSession {
  readonly project: SequenceProject
  readonly generation: number
  readonly sequenceId: string
  readonly catalog: PluginVideoEffectContributionSnapshot | undefined
}

export function createAnimationBindingController(readCatalog: () => PluginVideoEffectContributionSnapshot | undefined) {
  return {
    begin(): AnimationBindingSession {
      const state = useDocumentStore.getState()
      return { project: state.project, generation: state.projectGeneration, sequenceId: state.activeSequenceId, catalog: readCatalog() }
    },
    bind(session: AnimationBindingSession, clipId: string, effectId: string, parameter: string): string | null {
      const state = useDocumentStore.getState()
      if (state.project !== session.project || state.projectGeneration !== session.generation || state.activeSequenceId !== session.sequenceId
        || !session.catalog || readCatalog() !== session.catalog) return 'The project, sequence or plugin catalog changed. Review the binding again.'
      const clip = state.doc.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
      const effect = clip?.effects.find((item) => item.id === effectId)
      const declaration = session.catalog.declarations.find((item) => item.effectType === effect?.type)
      if (!declaration) return 'The plugin declaration is unavailable.'
      const result = bindPluginAnimationParameter(session.project, session.sequenceId, clipId, effectId, parameter, declaration)
      if (!result.ok) return result.reason
      if (readCatalog() !== session.catalog) return 'The plugin catalog changed. Review the binding again.'
      return commitPortableProjectEdit(session.project, session.generation, result.project)
    },
  }
}
