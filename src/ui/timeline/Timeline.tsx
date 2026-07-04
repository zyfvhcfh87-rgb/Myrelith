/**
 * ui/timeline/Timeline.tsx — Timeline container. Phase 3.2: hosts Ruler +
 * Playhead as SIBLINGS and subscribes to nothing itself — playhead movement
 * must never re-render this container (Phase 3 gate). Track lanes land in
 * 3.3 inside .timeline-tracks.
 */

import './timeline.css'
import Ruler from './Ruler'
import Playhead from './Playhead'

export default function Timeline() {
  return (
    <div className="timeline-root" data-testid="timeline-root">
      <Ruler />
      <div className="timeline-tracks">{/* Track lanes arrive in 3.3 */}</div>
      <Playhead />
    </div>
  )
}
