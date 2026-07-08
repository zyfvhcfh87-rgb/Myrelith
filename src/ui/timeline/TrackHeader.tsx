/**
 * ui/timeline/TrackHeader.tsx — One row of the timeline's header gutter
 * (timeline tracks upgrade): the track's badge (V1/A1), kind + clip count,
 * and its toggle buttons — hide (video), mute (audio), lock (both).
 *
 * Receives its Track as a prop from Timeline (which owns the doc
 * subscription) and reads stores only inside event handlers via getState(),
 * so a moving playhead can never re-render a header (invariant 6). Toggles
 * call documentStore.setTrackFlags — one undo entry per real change; the
 * store treats idempotent patches as no-ops.
 */

import { memo } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import type { TrackFlagsPatch } from '../../domain/operations'

interface TrackHeaderProps {
  track: TrackData
}

function TrackHeader({ track }: TrackHeaderProps) {
  const setFlags = (patch: TrackFlagsPatch) =>
    useDocumentStore.getState().setTrackFlags(track.id, patch)

  const clipCount = track.clips.length
  const kindLabel = track.kind === 'video' ? 'Video' : 'Audio'

  return (
    <div
      className={`track-header track-header-${track.kind}`}
      data-testid={`track-header-${track.id}`}
    >
      <span className={`track-badge track-badge-${track.kind}`}>{track.name}</span>
      <div className="track-header-info">
        <span className="track-header-kind">{kindLabel}</span>
        <span className="track-header-count">
          {clipCount === 1 ? '1 clip' : `${clipCount} clips`}
        </span>
      </div>
      <div className="track-header-toggles">
        {track.kind === 'video' ? (
          <button
            type="button"
            className={`track-toggle${track.hidden ? ' active' : ''}`}
            title="Hide track — its clips are skipped in the preview"
            aria-label={`hide track ${track.name}`}
            aria-pressed={track.hidden}
            onClick={() => setFlags({ hidden: !track.hidden })}
          >
            👁
          </button>
        ) : (
          <button
            type="button"
            className={`track-toggle${track.muted ? ' active' : ''}`}
            title="Mute track — excluded from the audio mix"
            aria-label={`mute track ${track.name}`}
            aria-pressed={track.muted}
            onClick={() => setFlags({ muted: !track.muted })}
          >
            M
          </button>
        )}
        <button
          type="button"
          className={`track-toggle${track.locked ? ' active' : ''}`}
          title="Lock track — rejects every edit until unlocked"
          aria-label={`lock track ${track.name}`}
          aria-pressed={track.locked}
          onClick={() => setFlags({ locked: !track.locked })}
        >
          🔒
        </button>
      </div>
    </div>
  )
}

/** memo: only the edited track's header re-renders (structural sharing). */
export default memo(TrackHeader)
