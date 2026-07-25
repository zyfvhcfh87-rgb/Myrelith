/**
 * app/selectionReconciliationController.ts — composition-root bridge between
 * document ownership and ephemeral timeline selection.
 *
 * Neither store may import the other. The app layer observes committed
 * document snapshots and gives transportStore only the set of clip ids that
 * still exist. Selection pruning therefore stays out of document history and
 * project serialization while deleted/stale ids cannot survive an edit,
 * undo/redo, track removal, or project replacement.
 */

import type { ClipId, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

function collectClipIds(document: TimelineDoc): ReadonlySet<ClipId> {
  const clipIds = new Set<ClipId>()
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      clipIds.add(clip.id)
    }
  }
  return clipIds
}

function reconcileSelection(document: TimelineDoc): void {
  const transport = useTransportStore.getState()
  if (
    transport.selectedClipIds.length === 0 &&
    transport.selectedClipId === null
  ) {
    return
  }

  transport.reconcileClipSelection(collectClipIds(document))
}

/**
 * Reconcile once for the current document, then after every document-reference
 * change. Zustand subscriptions are synchronous, so callers finish an edit
 * with selection already consistent with the resulting document.
 */
export function initSelectionReconciliation(): () => void {
  reconcileSelection(useDocumentStore.getState().doc)
  return useDocumentStore.subscribe((state, previous) => {
    if (state.doc !== previous.doc) {
      reconcileSelection(state.doc)
    }
  })
}
