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
  const state = useDocumentStore.getState(), transport = useTransportStore.getState()
  const owner = colorGradingOwner(state.project, target)
  if (owner.locked) throw new Error('This video track is locked.')
  const reset = getTransportResetRevision(), frame = transport.playheadFrame
  const current = () => {
    const next = useDocumentStore.getState(), cursor = useTransportStore.getState()
    return active === session && next.project === state.project && next.projectGeneration === state.projectGeneration
      && next.activeSequenceId === target.sequenceId && frame === cursor.playheadFrame && reset === getTransportResetRevision()
      && transport.selectedAdjustmentId === cursor.selectedAdjustmentId && transport.selectedClipIds.length === cursor.selectedClipIds.length
      && transport.selectedClipIds.every((id, index) => id === cursor.selectedClipIds[index])
  }
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
        return useDocumentStore.getState().commitColorLutEdit(state.project, state.projectGeneration, next)
      }
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
  try { return state.commitColorLutEdit(state.project, state.projectGeneration, addColorGradingEffect(state.project, target, type, () => crypto.randomUUID())) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not add grading.' }
}
