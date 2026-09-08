import { editMaskParamsAtFrame, maskEditingTarget, type MaskEditPatch, type MaskEditTarget } from '../domain/maskEditing'
import { replaceProjectSequence } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { getTransportResetRevision, useTransportStore } from '../state/transportStore'
import { portableProjectEditError } from './portableProjectEdit'

export interface MaskEditSession {
  preview(patch: MaskEditPatch): string | null
  commit(patch: MaskEditPatch): string | null
  cancel(): void
}
let active: MaskEditSession | null = null

/** The gesture owns subscriptions; onEnd runs once after cleanup, including commit. */
export function beginMaskEdit(target: MaskEditTarget, onEnd?: () => void): MaskEditSession {
  active?.cancel()
  if (active !== null) throw new Error('Another mask edit started during cleanup. Finish that edit first.')
  const document = useDocumentStore.getState(), transport = useTransportStore.getState()
  if (document.activeSequenceId !== target.sequenceId || transport.selectedClipId !== target.clipId) throw new Error('Select this mask clip before editing it.')
  if (transport.isPlaying || transport.isScrubbing) throw new Error('Pause playback before editing a mask.')
  maskEditingTarget(document.doc, target, transport.playheadFrame)
  const reset = getTransportResetRevision()
  const contextCurrent = () => {
    const next = useDocumentStore.getState(), cursor = useTransportStore.getState()
    return next.project === document.project && next.projectGeneration === document.projectGeneration
      && next.activeSequenceId === target.sequenceId && cursor.playheadFrame === transport.playheadFrame
      && reset === getTransportResetRevision() && !cursor.isPlaying && !cursor.isScrubbing
      && cursor.selectedAdjustmentId === transport.selectedAdjustmentId && cursor.maskEditorTarget === transport.maskEditorTarget
      && cursor.selectedClipId === transport.selectedClipId
      && cursor.selectedClipIds.length === transport.selectedClipIds.length
      && cursor.selectedClipIds.every((id, index) => id === transport.selectedClipIds[index])
  }
  const current = () => active === session && contextCurrent()
  let unsubscribeDocument = () => {}, unsubscribeTransport = () => {}
  function cancel() {
    unsubscribeDocument(); unsubscribeTransport()
    if (active !== session) return
    active = null
    useTransportStore.getState().setMaskPreview(null)
    onEnd?.()
  }
  function edit(patch: MaskEditPatch, commit: boolean): string | null {
    if (!current()) { cancel(); return 'The project, selection or playhead changed. Start the mask edit again.' }
    try {
      const next = editMaskParamsAtFrame(document.project, target, transport.playheadFrame, patch)
      if (commit) {
        cancel()
        if (active !== null || !contextCurrent()) return 'The project, selection or playhead changed. Start the mask edit again.'
        const candidate = replaceProjectSequence(document.project, target.sequenceId, next)
        const error = portableProjectEditError(document.project, document.projectGeneration, candidate)
        if (error) return error
        return useDocumentStore.getState().commitMaskEdit(document.project, document.projectGeneration, target.sequenceId, next)
      }
      useTransportStore.getState().setMaskPreview({ sequenceId: target.sequenceId, effectId: target.effectId, params: { ...patch } as Record<string, number | string | boolean>, document: next })
      return null
    } catch (cause) { cancel(); return cause instanceof Error ? cause.message : 'Could not edit this mask.' }
  }
  const session: MaskEditSession = { preview: (patch) => edit(patch, false), commit: (patch) => edit(patch, true), cancel }
  active = session
  const check = () => { if (!current()) cancel() }
  unsubscribeDocument = useDocumentStore.subscribe(check)
  unsubscribeTransport = useTransportStore.subscribe(check)
  return session
}

export function commitMaskParams(target: MaskEditTarget, patch: MaskEditPatch): string | null {
  try { return beginMaskEdit(target).commit(patch) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not edit this mask.' }
}
