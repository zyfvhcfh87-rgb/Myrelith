/**
 * ui/timeline/Timeline.tsx — Timeline container. Phase 3.2+3.3: hosts
 * Ruler, Track lanes and Playhead as SIBLINGS.
 *
 * Subscribes ONLY to doc.tracks: re-renders on edits (rare), never on
 * playhead movement (Phase 3 gate), and never mid-drag — drags live in
 * transportStore.dragPreview until commit. memo'd Track lanes plus
 * structural sharing mean an edit re-renders just the affected lane.
 */

import './timeline.css'
import { useDocumentStore } from '../../state/documentStore'
import Ruler from './Ruler'
import Track from './Track'
import Playhead from './Playhead'

export default function Timeline() {
  const tracks = useDocumentStore((s) => s.doc.tracks)

  return (
    <div className="timeline-root" data-testid="timeline-root">
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
