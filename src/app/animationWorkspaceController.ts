/** App facade for the lazy workspace's pointer, declaration and announcement wiring. */
import type { AnimationLaneIndex } from '../domain/animationLaneIndex'
import type { AnimationLaneAddress } from '../domain/animationAddresses'
import { createAnimationSnapSession } from '../domain/animationSnapping'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { usePreferencesStore } from '../state/preferencesStore'
import { createAnimationBindingController } from './animationBindingController'
import { animationEditorController, getAnimationEditorContext } from './animationEditorController'

export function animationCommandResult(error: string | null, success: string): void {
  useTransportStore.getState().announceAnimation(error ?? success)
}
export function closeAnimationWorkspace(): void {
  animationEditorController.cancel()
  useTransportStore.getState().setAnimationWorkspaceOpen(false)
}
export function bindAnimationLane(lane: AnimationLaneAddress): string | null {
  if (lane.kind !== 'effect' || lane.owner.kind !== 'clip') return 'Only clip plugin lanes can be bound here.'
  const binding = createAnimationBindingController(() => getAnimationEditorContext().plugins)
  return binding.bind(binding.begin(), lane.owner.id, lane.effectId, lane.parameter)
}
export function beginAnimationKeyDrag(index: AnimationLaneIndex, onEnd: () => void) {
  const state = useTransportStore.getState(), document = useDocumentStore.getState().doc
  if (document !== index.document) throw new Error('The sequence changed. Start the key drag again.')
  const snapping = createAnimationSnapSession(index, state.animationSelection, state.playheadFrame)
  let active = true
  const gesture = animationEditorController.begin(() => { active = false; useTransportStore.getState().setSnapGuide(null); onEnd() })
  const resolve = (delta: number, bypass: boolean) => snapping.resolve(delta, state.zoom, bypass || !usePreferencesStore.getState().snappingEnabled)
  return {
    cancel: gesture.cancel,
    preview(delta: number, bypass: boolean) {
      if (!active) return
      if (useTransportStore.getState().zoom !== state.zoom) { gesture.cancel(); return }
      const result = resolve(delta, bypass)
      useTransportStore.getState().setSnapGuide(result.guide)
      gesture.preview({ kind: 'move', deltaFrames: result.deltaFrames })
    },
    commit(delta: number, bypass: boolean): string | null {
      if (!active || useTransportStore.getState().zoom !== state.zoom) { gesture.cancel(); return 'The key drag was cancelled.' }
      return gesture.commit({ kind: 'move', deltaFrames: resolve(delta, bypass).deltaFrames })
    },
  }
}
