/**
 * app/selectionReconciliationController.ts — composition-root bridge between
 * document ownership and ephemeral timeline selection.
 *
 * Neither store may import the other. The app layer observes committed
 * document snapshots and gives transportStore only the clip/marker ids that
 * still exist. Selection pruning therefore stays out of document history and
 * project serialization while deleted/stale ids cannot survive an edit,
 * undo/redo, track removal, or project replacement. It also re-conforms the
 * one shared connected-media catalog when project-wide history changes the
 * common sequence frame rate.
 */

import type {
  AdjustmentItemId,
  ClipId,
  TimelineDoc,
  TimelineMarkerId,
} from '../domain/schema'
import { adjustmentItems } from '../domain/adjustmentItems'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { rateEquals } from '../domain/time'

function collectClipIds(document: TimelineDoc): ReadonlySet<ClipId> {
  const clipIds = new Set<ClipId>()
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      clipIds.add(clip.id)
    }
  }
  return clipIds
}

function collectMarkerIds(document: TimelineDoc): ReadonlySet<TimelineMarkerId> {
  return new Set((document.markers ?? []).map((marker) => marker.id))
}

function collectAdjustmentIds(document: TimelineDoc): ReadonlySet<AdjustmentItemId> {
  return new Set(document.tracks.flatMap((track) => (
    adjustmentItems(track).map((adjustment) => adjustment.id)
  )))
}

function reconcileSelection(document: TimelineDoc): void {
  const transport = useTransportStore.getState()
  if (transport.selectedClipIds.length > 0 || transport.selectedClipId !== null) {
    transport.reconcileClipSelection(collectClipIds(document))
  }
  if (transport.selectedMarkerId !== null || transport.editingMarkerId !== null) {
    transport.reconcileMarkerSelection(collectMarkerIds(document))
  }
  if (transport.selectedAdjustmentId !== null) {
    transport.reconcileAdjustmentSelection(collectAdjustmentIds(document))
  }
}

/**
 * Reconcile once for the current document, then after every document-reference
 * change. Zustand subscriptions are synchronous, so callers finish an edit
 * with selection already consistent with the resulting document.
 */
export function initSelectionReconciliation(): () => void {
  reconcileSelection(useDocumentStore.getState().doc)
  return useDocumentStore.subscribe((state, previous) => {
    if (
      state.project.id === previous.project.id
      && !rateEquals(state.doc.frameRate, previous.doc.frameRate)
    ) {
      useMediaStore.getState().reconformAssets(state.doc.frameRate)
    }
    if (
      state.activeSequenceId !== previous.activeSequenceId
      && state.project.id === previous.project.id
    ) {
      useTransportStore.getState().resetTransport()
    }
    if (state.doc !== previous.doc) {
      reconcileSelection(state.doc)
    }
  })
}
