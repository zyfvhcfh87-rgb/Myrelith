/** Lightweight entry only; the workspace itself stays behind EditorShell's lazy boundary. */
import type { AnimationLaneAddress } from '../../state/animationEditor'
import { useTransportStore } from '../../state/transportStore'

export default function AnimationEntry({ lane, label = 'Open Animation workspace' }: { lane?: AnimationLaneAddress; label?: string }) {
  return <button type="button" className="inspector-action" onClick={() => {
    const transport = useTransportStore.getState()
    if (lane) { transport.setAnimationSelection([]); transport.setAnimationFocusedLane(lane) }
    transport.setAnimationWorkspaceOpen(true)
  }}>{label}</button>
}
