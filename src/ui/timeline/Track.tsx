/**
 * ui/timeline/Track.tsx — One horizontal lane of clips. Phase 3.3.
 *
 * Pure presentation: receives its Track as a prop (Timeline subscribes to
 * the tracks array), renders a ClipView per clip. The sticky label chip
 * lives INSIDE the lane so clips keep the same x-origin as the ruler and
 * playhead — a label gutter would break their alignment.
 */

import { memo } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import ClipView from './ClipView'

interface TrackProps {
  track: TrackData
}

function Track({ track }: TrackProps) {
  return (
    <div
      className={`timeline-track track-${track.kind}`}
      data-testid={`track-${track.id}`}
    >
      <span className="track-label">{track.name}</span>
      {track.clips.map((clip) => (
        <ClipView key={clip.id} clip={clip} trackId={track.id} />
      ))}
    </div>
  )
}

/** memo: structural sharing keeps untouched Track objects identical across
 * edits, so only the edited lane re-renders. */
export default memo(Track)
