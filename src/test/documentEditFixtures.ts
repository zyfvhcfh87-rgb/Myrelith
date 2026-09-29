import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'

/**
 * Commit one pure active-document operation through ordinary store history,
 * for setup edits that have no dedicated production store action.
 */
export function commitDocumentEdit<A extends unknown[]>(
  operation: (doc: TimelineDoc, ...args: A) => TimelineDoc,
  ...args: A
): void {
  const state = useDocumentStore.getState()
  state.setDocWithHistory(operation(state.doc, ...args))
}
