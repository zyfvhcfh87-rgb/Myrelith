import { animationRetentionError } from './projectAnimationRetention'
import { addColorGradingEffect, colorGradingOwner, editColorGradingParams } from '../domain/colorGradingParameterEdit'
import type { ColorGradingTarget } from '../domain/colorGradingEdits'
import type { EffectParamValue } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { getTransportResetRevision, useTransportStore } from '../state/transportStore'

export type { ColorGradingTarget }
export type ColorGradingPatch = Readonly<Record<string, EffectParamValue>>
export interface ColorGradingEditSession {
  preview(patch: ColorGradingPatch): string | null
  commit(patch: ColorGradingPatch): string | null
  cancel(): void
}
let active: ColorGradingEditSession | null = null

/** A gesture pins project, selection, playhead and transport lifetime. */
export function beginColorGradingEdit(target: ColorGradingTarget, effectId: string): ColorGradingEditSession {
  active?.cancel()
  if (active !== null) throw new Error('Another grading edit started during cleanup. Finish that edit first.')
  const state = useDocumentStore.getState(), transport = useTransportStore.getState()
  if (transport.isPlaying || transport.isScrubbing) throw new Error('Pause playback before editing grading.')
  const owner = colorGradingOwner(state.project, target)
  if (owner.locked) throw new Error('This video track is locked.')
  const reset = getTransportResetRevision(), frame = transport.playheadFrame
  const contextCurrent = () => {
    const next = useDocumentStore.getState(), cursor = useTransportStore.getState()
    return next.project === state.project && next.projectGeneration === state.projectGeneration
      && next.activeSequenceId === target.sequenceId && frame === cursor.playheadFrame && reset === getTransportResetRevision()
      && !cursor.isPlaying && !cursor.isScrubbing && transport.selectedClipId === cursor.selectedClipId
      && transport.selectedAdjustmentId === cursor.selectedAdjustmentId && transport.selectedClipIds.length === cursor.selectedClipIds.length
      && transport.selectedClipIds.every((id, index) => id === cursor.selectedClipIds[index])
  }
  const current = () => active === session && contextCurrent()
  let unsubscribeDocument = () => {}, unsubscribeTransport = () => {}
  function cancel() {
    unsubscribeDocument(); unsubscribeTransport()
    if (active !== session) return
    active = null
    useTransportStore.getState().setColorGradingPreview(null)
  }
  function edit(patch: ColorGradingPatch, commit: boolean): string | null {
    if (!current()) { cancel(); return 'The project, selection or playhead changed. Start the grading edit again.' }
    try {
      const next = editColorGradingParams(state.project, target, effectId, frame, patch)
      if (commit) {
        cancel()
        if (active !== null || !contextCurrent()) return 'The project, selection or playhead changed. Start the grading edit again.'
        return useDocumentStore.getState().commitProjectEdit(state.project, state.projectGeneration, next)
      }
      const retention = animationRetentionError(useDocumentStore.getState(), next)
      if (retention) return retention
      useTransportStore.getState().setColorGradingPreview({ sequenceId: target.sequenceId, effectId,
        params: patch, document: next.sequences.find((sequence) => sequence.id === target.sequenceId)! })
      return null
    } catch (cause) { cancel(); return cause instanceof Error ? cause.message : 'Could not change grading.' }
  }
  const session: ColorGradingEditSession = { preview: (patch) => edit(patch, false), commit: (patch) => edit(patch, true), cancel }
  active = session
  const check = () => { if (!current()) cancel() }
  unsubscribeDocument = useDocumentStore.subscribe(check); unsubscribeTransport = useTransportStore.subscribe(check)
  return session
}

export function commitColorGradingParams(target: ColorGradingTarget, effectId: string, patch: ColorGradingPatch): string | null {
  try { return beginColorGradingEdit(target, effectId).commit(patch) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not change grading.' }
}

export function addGradingEffect(target: ColorGradingTarget, type: string): string | null {
  const state = useDocumentStore.getState()
  try { return state.commitProjectEdit(state.project, state.projectGeneration, addColorGradingEffect(state.project, target, type, () => crypto.randomUUID())) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not add grading.' }
}
