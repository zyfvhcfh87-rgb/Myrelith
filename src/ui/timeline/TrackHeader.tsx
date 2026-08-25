/**
 * ui/timeline/TrackHeader.tsx — One row of the timeline's header gutter
 * (timeline tracks upgrade): the track's badge (its name), kind + clip
 * count, and its buttons — rename, hide (video), solo + mute (audio),
 * lock, and delete. The Rename button (or double-click anywhere on the
 * row, buttons aside) opens the inline editor: Enter/blur commits,
 * Escape cancels; empty and unchanged names cancel silently (the domain
 * op would no-op/reject anyway, this just spares the console.warn).
 * Focus returns to Rename after commit or cancel. The global
 * A/B/T/Y/U·S·Del shortcuts already ignore keystrokes in editable
 * targets (isEditableTarget), so typing a name never razors a clip.
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

import { memo, useEffect, useRef, useState } from 'react'
import { Eye, LockSimple, PencilSimple, X } from '@phosphor-icons/react'
import type { Track as TrackData } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import {
  resolvedTrackTargets,
  toggleTrackTarget,
} from '../../app/sequenceEditController'
import type { TrackFlagsPatch } from '../../domain/operations'
import { editorContextMenuIdentity } from '../../app/editorContextMenuCommands'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from '../editorContextMenuController'

interface TrackHeaderProps {
  track: TrackData
}

function TrackHeader({ track }: TrackHeaderProps) {
  useTransportStore((state) => state.videoTargetTrackId)
  useTransportStore((state) => state.audioTargetTrackId)
  useTransportStore((state) => state.trackTargetsTouched)
  const targeted = track.kind === 'video'
    ? resolvedTrackTargets().videoTrackId === track.id
    : resolvedTrackTargets().audioTrackId === track.id
  const contextMenu = useEditorContextMenu()
  const [renaming, setRenaming] = useState(false)
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const restoreRenameFocusRef = useRef(false)

  const setFlags = (patch: TrackFlagsPatch) =>
    useDocumentStore.getState().setTrackFlags(track.id, patch)

  const beginRename = (): void => {
    restoreRenameFocusRef.current = true
    setRenaming(true)
  }

  const finishRename = (raw: string | null): void => {
    setRenaming(false)
    if (raw !== null) {
      const name = raw.trim()
      if (name !== '' && name !== track.name) {
        useDocumentStore.getState().renameTrack(track.id, name)
      }
    }
  }

  useEffect(() => {
    if (renaming || !restoreRenameFocusRef.current) return
    restoreRenameFocusRef.current = false
    renameTriggerRef.current?.focus()
  }, [renaming])

  const clipCount = track.clips.length
  const kindLabel = track.kind === 'video' ? 'Video' : 'Audio'

  return (
    <div
      className={`track-header track-header-${track.kind}`}
      data-testid={`track-header-${track.id}`}
      title="Rename from the Rename button, or double-click the header"
      onContextMenu={(event) => {
        openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'track',
            trackId: track.id,
          },
          restoreFocusTo: event.target instanceof HTMLElement
            ? event.target
            : null,
          uiActions: {
            openTrackRename: () => {
              beginRename()
              return true
            },
          },
        })
      }}
      onDoubleClick={(e) => {
        // Buttons keep their own double-click meaning (fast toggling).
        if ((e.target as HTMLElement).closest('button')) return
        beginRename()
      }}
    >
      <span className={`track-badge track-badge-${track.kind}`}>{track.name}</span>
      {renaming ? (
        <input
          className="track-rename-input"
          defaultValue={track.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finishRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename(e.currentTarget.value)
            else if (e.key === 'Escape') {
              e.preventDefault()
              finishRename(null)
            }
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
        <button
          type="button"
          className={`track-toggle${targeted ? ' active' : ''}`}
          title={
            targeted
              ? 'Remove this track as a sequence-edit destination'
              : 'Target this track for insert, overwrite, lift, and extract'
          }
          aria-label={`target track ${track.name}`}
          aria-pressed={targeted}
          onClick={() => toggleTrackTarget(track.id, track.kind)}
        >
          T
        </button>
        {!renaming ? (
          <button
            ref={renameTriggerRef}
            type="button"
            className="track-toggle"
            title="Rename track"
            aria-label={`rename track ${track.name}`}
            onClick={beginRename}
          >
            <PencilSimple aria-hidden="true" size={14} weight="bold" />
          </button>
        ) : null}
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
