/** App-owned document-generation/CAS seam for explicit plugin migration. */

import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore, type DocumentState } from '../state/documentStore'

export interface PluginDocumentSnapshot {
  readonly generation: number
  readonly document: TimelineDoc
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
      return Object.freeze({ generation, document: store.getState().doc })
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
