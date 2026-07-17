/**
 * ui/timeline/Timeline.tsx — Timeline container. Phase 3.2+3.3; header
 * gutter + track display order since the timeline tracks upgrade.
 *
 * Two sticky-aligned columns inside the horizontal scroll container:
 *   [ headers gutter | lanes ]
 * The GUTTER (position: sticky, left: 0) holds a TrackHeader per track and
 * the add-track buttons; the LANES column hosts Ruler, Track lanes and
 * Playhead as before — its left edge is the x-origin for frame 0, so all
 * px→frame math (ruler seeks, drops, clip drags) is untouched by the
 * gutter's existence.
 *
 * Tracks render in domain tracksInDisplayOrder: video tracks TOP-DOWN from
 * the topmost composite layer (V2 above V1 — doc order is compositing
 * order, tracks[0] = bottom), then audio tracks below. Both columns map
 * the same ordered array, so header row i always faces lane row i.
 *
 * Subscribes ONLY to the doc and the active tool (4.2 cursor class):
 * re-renders on edits and tool switches (rare), never on playhead movement
 * (Phase 3 gate), and never mid-drag — drags live in transportStore
 * previews until commit. memo'd TrackHeader/Track rows plus structural
 * sharing mean an edit re-renders just the affected row pair.
 */

import './timeline.css'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { tracksInDisplayOrder } from '../../domain/selectors'
import Ruler from './Ruler'
import Track from './Track'
import TrackHeader from './TrackHeader'
import Playhead from './Playhead'

export default function Timeline() {
  const doc = useDocumentStore((s) => s.doc)
  // Tool-specific cursors via a root class; changes only on tool switch.
  const tool = useTransportStore((s) => s.tool)

  // Derived per render (cheap): stable Track references keep memo rows idle.
  const ordered = tracksInDisplayOrder(doc)
  // Solo is cross-track state (one solo dims every OTHER audio lane), so
  // the container derives it and hands each lane a boolean; the actual
  // mix rule lives in domain selectors.audibleTracks.
  const anyAudioSolo = doc.tracks.some((t) => t.kind === 'audio' && t.solo)
  const addTrack = (kind: 'video' | 'audio') =>
    useDocumentStore.getState().addTrack(kind)

  return (
    <div className={`timeline-root tool-${tool}`} data-testid="timeline-root">
      <div
        className="timeline-headers"
        data-timeline-headers
        data-testid="timeline-headers"
      >
        {/* Corner spacer: same height as the ruler so header/lane rows align. */}
        <div className="timeline-headers-corner" />
        {ordered.map((track) => (
          <TrackHeader key={track.id} track={track} />
        ))}
        <div className="track-add-row">
          <button
            type="button"
            className="track-add-button"
            title="Add a video track — composites above the existing video tracks"
            aria-label="add video track"
            onClick={() => addTrack('video')}
          >
            + Video
          </button>
          <button
            type="button"
            className="track-add-button"
            title="Add an audio track"
            aria-label="add audio track"
            onClick={() => addTrack('audio')}
          >
            + Audio
          </button>
        </div>
      </div>
      <div className="timeline-lanes">
        <Ruler />
        <div className="timeline-tracks">
          {ordered.map((track) => (
            <Track
              key={track.id}
              track={track}
              soloDimmed={anyAudioSolo && track.kind === 'audio' && !track.solo}
            />
          ))}
        </div>
        <Playhead />
      </div>
    </div>
  )
}
