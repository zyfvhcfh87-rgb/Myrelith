/**
 * ui/timeline/Timeline.tsx — Timeline container. Phase 3.2+3.3: hosts
 * Ruler, Track lanes and Playhead as SIBLINGS.
 *
 * Subscribes ONLY to doc.tracks and the active tool (4.2 cursor class):
 * re-renders on edits and tool switches (rare), never on playhead movement
 * (Phase 3 gate), and never mid-drag — drags live in transportStore
 * previews until commit. memo'd Track lanes plus structural sharing mean
 * an edit re-renders just the affected lane.
 */

import './timeline.css'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import Ruler from './Ruler'
import Track from './Track'
import Playhead from './Playhead'

export default function Timeline() {
  const tracks = useDocumentStore((s) => s.doc.tracks)
  // Tool-specific cursors via a root class; changes only on tool switch.
  const tool = useTransportStore((s) => s.tool)

  return (
    <div className={`timeline-root tool-${tool}`} data-testid="timeline-root">
      <Ruler />
      <div className="timeline-tracks">
        {tracks.map((track) => (
          <Track key={track.id} track={track} />
        ))}
      </div>
      <Playhead />
    </div>
  )
}
