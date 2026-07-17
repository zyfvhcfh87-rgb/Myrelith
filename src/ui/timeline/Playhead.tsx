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
import { frameToTimelineLocalPx } from './timelineViewport'

interface PlayheadProps {
  timelineOriginFrame?: number
  timelineWindowEndFrame?: number
}

export default function Playhead({
  timelineOriginFrame: providedOriginFrame,
  timelineWindowEndFrame = Number.MAX_SAFE_INTEGER,
}: PlayheadProps = {}) {
  const playheadFrame = useTransportStore((s) => s.playheadFrame)
  const zoom = useTransportStore((s) => s.zoom)
  const storedOriginFrame = useTransportStore((s) => s.timelineOriginFrame)
  const timelineOriginFrame = providedOriginFrame ?? storedOriginFrame

  // A far playhead must never enlarge the bounded native surface by emitting
  // an off-window transform. Zoom anchoring/rebasing makes it visible again.
  if (
    playheadFrame < timelineOriginFrame ||
    playheadFrame > timelineWindowEndFrame
  ) {
    return null
  }

  return (
    <div
      className="playhead"
      data-testid="playhead"
      style={{
        transform: `translateX(${frameToTimelineLocalPx(playheadFrame, timelineOriginFrame, zoom)}px)`,
      }}
    />
  )
}
