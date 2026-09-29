import { useDocumentStore } from '../state/documentStore'

/**
 * Call `onChange` whenever the open project, its generation, or the active
 * sequence changes: the scope a pending caption review, import or export
 * belongs to. Returns the unsubscribe function.
 */
export function watchProjectScope(onChange: () => void): () => void {
  return useDocumentStore.subscribe((next, previous) => {
    if (next.project !== previous.project || next.projectGeneration !== previous.projectGeneration
      || next.activeSequenceId !== previous.activeSequenceId) onChange()
  })
}
