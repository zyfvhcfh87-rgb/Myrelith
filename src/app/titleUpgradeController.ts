/** Explicit title upgrade uses the complete app-owned media/file preflight once. */
import type { SequenceProject } from '../domain/projectSequences'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import { useDocumentStore } from '../state/documentStore'
import { commitPortableProjectEdit } from './portableProjectEdit'

export interface TitleUpgradeSession {
  readonly project: SequenceProject
  readonly generation: number
  readonly sequenceId: string
  readonly clipId: string
}

export function createTitleUpgradeController(factory: () => string = () => crypto.randomUUID()) {
  return {
    begin(clipId: string): TitleUpgradeSession {
      const state = useDocumentStore.getState()
      return { project: state.project, generation: state.projectGeneration, sequenceId: state.activeSequenceId, clipId }
    },
    upgrade(session: TitleUpgradeSession): string | null {
      const state = useDocumentStore.getState()
      if (state.project !== session.project || state.projectGeneration !== session.generation || state.activeSequenceId !== session.sequenceId) return 'The project or active sequence changed. Review the upgrade again.'
      const result = upgradeLegacyTextTitle(session.project, session.sequenceId, session.clipId, factory)
      if (!result.ok) return result.reason
      if (useDocumentStore.getState().activeSequenceId !== session.sequenceId) return 'The active sequence changed. Review the upgrade again.'
      return commitPortableProjectEdit(session.project, session.generation, result.project)
    },
  }
}
