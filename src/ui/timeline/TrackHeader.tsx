/**
 * ui/timeline/TrackHeader.tsx — One row of the timeline's header gutter
 * (timeline tracks upgrade): the track's badge (its name), kind + clip
 * count, and its buttons — hide (video), solo + mute (audio), lock, and
 * delete. Double-click anywhere on the row (buttons aside) renames the
 * track inline: Enter/blur commits, Escape cancels; empty and unchanged
 * names cancel silently (the domain op would no-op/reject anyway, this
 * just spares the console.warn). The global A/B/T/Y/U·S·Del shortcuts
 * already ignore keystrokes in editable targets (isEditableTarget), so
 * typing a name never razors a clip.
 *
 * Receives its Track as a prop from Timeline (which owns the doc
 * subscription) and reads stores only inside event handlers via
 * getState(), so a moving playhead can never re-render a header
 * (invariant 6). All mutations go through documentStore — one undo entry
 * per real change; idempotent toggles/renames push none. The lone local
 * state is the rename-editor flag. Delete is disabled while locked (the
 * lock IS the "don't touch this content" guard); solo's actual mix rule
 * lives in domain selectors.audibleTracks.
 */

import { memo, useState } from 'react'
import { Eye, LockSimple, X } from '@phosphor-icons/react'
import type { Track as TrackData } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import type { TrackFlagsPatch } from '../../domain/operations'

interface TrackHeaderProps {
  track: TrackData
}

function TrackHeader({ track }: TrackHeaderProps) {
  const [renaming, setRenaming] = useState(false)

  const setFlags = (patch: TrackFlagsPatch) =>
    useDocumentStore.getState().setTrackFlags(track.id, patch)

  const commitRename = (raw: string) => {
    setRenaming(false)
    const name = raw.trim()
    if (name === '' || name === track.name) return
    useDocumentStore.getState().renameTrack(track.id, name)
  }

  const clipCount = track.clips.length
  const kindLabel = track.kind === 'video' ? 'Video' : 'Audio'

  return (
    <div
      className={`track-header track-header-${track.kind}`}
      data-testid={`track-header-${track.id}`}
      title="Double-click to rename"
      onDoubleClick={(e) => {
        // Buttons keep their own double-click meaning (fast toggling).
        if ((e.target as HTMLElement).closest('button')) return
        setRenaming(true)
      }}
    >
      <span className={`track-badge track-badge-${track.kind}`}>{track.name}</span>
      {renaming ? (
        <input
          className="track-rename-input"
          defaultValue={track.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(e.currentTarget.value)
            else if (e.key === 'Escape') setRenaming(false)
          }}
          aria-label={`rename track ${track.name}`}
          data-testid={`track-rename-${track.id}`}
        />
      ) : (
        <div className="track-header-info">
          <span className="track-header-kind">{kindLabel}</span>
          <span className="track-header-count">
            {clipCount === 1 ? '1 clip' : `${clipCount} clips`}
          </span>
        </div>
      )}
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
            <Eye aria-hidden="true" size={14} weight="bold" />
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`track-toggle${track.solo ? ' active' : ''}`}
              title="Solo — while any track is solo, only solo tracks play (mute still wins)"
              aria-label={`solo track ${track.name}`}
              aria-pressed={track.solo}
              onClick={() => setFlags({ solo: !track.solo })}
            >
              S
            </button>
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
          </>
        )}
        <button
          type="button"
          className={`track-toggle${track.locked ? ' active' : ''}`}
          title="Lock track — rejects every edit until unlocked"
          aria-label={`lock track ${track.name}`}
          aria-pressed={track.locked}
          onClick={() => setFlags({ locked: !track.locked })}
        >
          <LockSimple aria-hidden="true" size={14} weight="bold" />
        </button>
        <button
          type="button"
          className="track-toggle track-delete"
          title={
            track.locked
              ? 'Unlock the track to delete it'
              : 'Delete track and its clips (one undo restores both)'
          }
          aria-label={`delete track ${track.name}`}
          disabled={track.locked}
          onClick={() => useDocumentStore.getState().removeTrack(track.id)}
        >
          <X aria-hidden="true" size={14} weight="bold" />
        </button>
      </div>
    </div>
  )
}

/** memo: only the edited track's header re-renders (structural sharing). */
export default memo(TrackHeader)
