import { captureTitleTemplate, instantiateTitleTemplate, type TitleTemplateV1 } from '../domain/titleTemplates'
import type { TitleEditTarget } from '../domain/titleEditing'
import { animationRetentionError } from './projectAnimationRetention'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore, getTransportResetRevision } from '../state/transportStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { useTitleTemplateStore } from '../state/titleTemplateStore'
import { localTitleTemplateStorage, type TitleTemplateRepository } from './localTitleTemplateStorage'
import { portableProjectEditError } from './portableProjectEdit'

export function pinTitleTemplateDialog() {
  const state = useDocumentStore.getState(), transport = useTransportStore.getState(), title = useTitleEditorStore.getState(), reset = getTransportResetRevision()
  return { project: state.project, generation: state.projectGeneration, sequenceId: state.activeSequenceId, frame: transport.playheadFrame,
    current: () => {
      const next = useDocumentStore.getState(), cursor = useTransportStore.getState(), selection = useTitleEditorStore.getState()
      return next.project === state.project && next.projectGeneration === state.projectGeneration && next.activeSequenceId === state.activeSequenceId
        && cursor.playheadFrame === transport.playheadFrame && cursor.selectedClipIds === transport.selectedClipIds && cursor.selectedAdjustmentId === transport.selectedAdjustmentId
        && selection.clipId === title.clipId && selection.ids === title.ids && getTransportResetRevision() === reset && !cursor.isPlaying && !cursor.isScrubbing
    } }
}
export function createTitleTemplateController(repository: TitleTemplateRepository) {
  async function operation(work: () => Promise<import('../domain/titleTemplates').TitleTemplateLibraryView>): Promise<boolean> {
    if (useTitleTemplateStore.getState().busy) return false
    useTitleTemplateStore.setState({ busy: true, error: null })
    try { useTitleTemplateStore.setState({ ...await work(), loaded: true }); return true }
    catch (cause) { useTitleTemplateStore.setState({ error: cause instanceof Error ? cause.message : 'Title storage failed.' }); return false }
    finally { useTitleTemplateStore.setState({ busy: false }) }
  }
  return {
    load: () => operation(() => repository.load()),
    read: (id: string) => repository.read(id),
    save: (pin: ReturnType<typeof pinTitleTemplateDialog>, target: TitleEditTarget, name: string) => operation(async () => {
      if (!pin.current()) throw new Error('The title changed. Reopen Save template.')
      const template = captureTitleTemplate(pin.project, target, crypto.randomUUID(), name.trim())
      return repository.mutate({ kind: 'save', template }, pin.current)
    }),
    delete: (id: string) => operation(() => repository.mutate({ kind: 'delete', id })),
    insert(pin: ReturnType<typeof pinTitleTemplateDialog>, trackId: string, template: TitleTemplateV1): string | null {
      try {
        if (!pin.current()) return 'The receiving project or selection changed. Reopen Templates.'
        const candidate = instantiateTitleTemplate(pin.project, pin.sequenceId, trackId, pin.frame, template, () => crypto.randomUUID())
        const error = animationRetentionError(useDocumentStore.getState(), candidate) ?? portableProjectEditError(pin.project, pin.generation, candidate)
        if (error) return error
        if (!pin.current()) return 'The receiving project or selection changed. Reopen Templates.'
        return useDocumentStore.getState().commitProjectEdit(pin.project, pin.generation, candidate)
      } catch (cause) { return cause instanceof Error ? cause.message : 'Could not insert this template.' }
    },
  }
}
export const titleTemplateController = createTitleTemplateController(localTitleTemplateStorage)
