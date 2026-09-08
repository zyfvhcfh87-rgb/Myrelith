/** Lightweight entry only; the workspace itself stays behind EditorShell's lazy boundary. */
import type { AnimationLaneAddress } from '../../state/animationEditor'
import { useTransportStore } from '../../state/transportStore'
import { BezierCurve } from '@phosphor-icons/react'

export default function AnimationEntry({ lane, label = 'Open Animation workspace', variant = 'inspector' }: { lane?: AnimationLaneAddress; label?: string; variant?: 'inspector' | 'tool' }) {
  const open = useTransportStore((state) => state.animationWorkspaceOpen)
  return <button type="button" className={variant === 'tool' ? 'tool-button' : 'inspector-action'} aria-label={label} title={label}
    aria-controls="workspace-timeline-panel" aria-expanded={open} onClick={() => {
    const transport = useTransportStore.getState()
    if (lane) { transport.setAnimationSelection([]); transport.setAnimationFocusedLane(lane) }
    transport.setAnimationWorkspaceOpen(true)
  }}>{variant === 'tool' ? <BezierCurve aria-hidden="true" size={16} weight="bold" /> : label}</button>
}
