import { maskEditingTarget, type MaskEditTarget } from '../state/maskEditor'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

export default function MaskEditorToggle({ clipId, effectId }: { clipId: string; effectId: string }) {
  const doc = useDocumentStore((state) => state.doc)
  const target = useTransportStore((state) => state.maskEditorTarget)
  const frame = useTransportStore((state) => state.playheadFrame)
  const playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const selected = target?.clipId === clipId && target.effectId === effectId && target.sequenceId === doc.id
  const next: MaskEditTarget = { sequenceId: doc.id, clipId, effectId }
  let reason = playing ? 'Pause playback before editing a mask.' : ''
  try { maskEditingTarget(doc, next, frame) }
  catch (cause) { reason = cause instanceof Error ? cause.message : 'This mask is unavailable.' }
  return <div className="inspector-effect-parameter">
    <button type="button" id={`mask-editor-toggle-${effectId}`} aria-pressed={selected} aria-disabled={!!reason && !selected}
      aria-describedby={`mask-editor-reason-${effectId}`}
      onClick={() => { if (selected || !reason) useTransportStore.getState().setMaskEditorTarget(selected ? null : next) }}>
      {selected ? 'Hide mask handles' : 'Edit mask in Program'}
    </button>
    <span className="inspector-note" id={`mask-editor-reason-${effectId}`}>{reason || 'Move or resize in Program. Bezier points also have keyboard and numeric controls.'}</span>
  </div>
}
