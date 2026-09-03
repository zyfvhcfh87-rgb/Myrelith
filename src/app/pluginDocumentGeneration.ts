/** App-owned document-generation/CAS seam for explicit plugin migration. */

import type { TimelineDoc } from '../domain/schema'
import type { SequenceProject } from '../domain/projectSequences'
import { useDocumentStore, type DocumentState } from '../state/documentStore'

export interface PluginDocumentSnapshot {
  readonly generation: number
  readonly document: TimelineDoc
  readonly project?: SequenceProject
  readonly sequenceId?: string
}

export interface PluginDocumentGenerationController {
  getDocumentSnapshot(): PluginDocumentSnapshot
  commitDocument(
    expectedGeneration: number,
    expectedDocument: TimelineDoc,
    nextDocument: TimelineDoc,
  ): boolean
  dispose(): void
}

export interface PluginDocumentStoreAdapter {
  getState(): Pick<DocumentState, 'doc' | 'setDocWithHistory'>
    & Partial<Pick<DocumentState, 'project' | 'activeSequenceId'>>
  subscribe(
    listener: (state: DocumentState, previous: DocumentState) => void,
  ): () => void
}

export function createPluginDocumentGenerationController(
  store: PluginDocumentStoreAdapter = useDocumentStore,
): PluginDocumentGenerationController {
  let generation = 0
  let disposed = false
  // Every notification invalidates an in-flight migration. This deliberately
  // fails closed even if an adapter reports an in-place/same-reference edit.
  const unsubscribe = store.subscribe(() => { generation += 1 })

  return Object.freeze({
    getDocumentSnapshot() {
      const state = store.getState()
      return Object.freeze({
        generation,
        document: state.doc,
        ...(state.project && state.activeSequenceId
          ? { project: state.project, sequenceId: state.activeSequenceId }
          : {}),
      })
    },
    commitDocument(
      expectedGeneration: number,
      expectedDocument: TimelineDoc,
      nextDocument: TimelineDoc,
    ) {
      if (disposed || nextDocument === expectedDocument) return false
      const current = store.getState()
      if (generation !== expectedGeneration || current.doc !== expectedDocument) return false
      current.setDocWithHistory(nextDocument)
      const committed = store.getState().doc === nextDocument
        && generation === expectedGeneration + 1
      return committed
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    },
  })
}
