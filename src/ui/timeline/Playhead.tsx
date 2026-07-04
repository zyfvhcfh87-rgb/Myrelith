/**
 * ui/timeline/Playhead.tsx — The vertical position line. Phase 3.2.
 *
 * THE render-isolation pattern (Phase 3 gate): this component subscribes to
 * playheadFrame via a narrow Zustand selector, so a moving playhead
 * re-renders THIS component and nothing else. Position is applied with
 * translateX — compositor-only, no layout pass. pointer-events: none keeps
 * it from stealing clicks meant for ruler/clips beneath it.
 */

import { useTransportStore } from '../../state/transportStore'

export default function Playhead() {
  const playheadFrame = useTransportStore((s) => s.playheadFrame)
  const zoom = useTransportStore((s) => s.zoom)

  return (
    <div
      className="playhead"
      data-testid="playhead"
      style={{ transform: `translateX(${playheadFrame * zoom}px)` }}
    />
  )
}
