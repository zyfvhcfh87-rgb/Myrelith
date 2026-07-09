/**
 * ui/timeline/Track.tsx — One horizontal lane of clips. Phase 3.3; drop
 * target for MediaPool assets since 4.0.
 *
 * Presentation + drop wiring: receives its Track as a prop (Timeline
 * subscribes to the doc), renders a ClipView per clip. Identity and
 * toggles live in the header gutter (TrackHeader) — a separate sticky
 * column, so the lane keeps the same x-origin as the ruler and playhead.
 * Flag classes (track-hidden/-muted/-locked) only restyle the lane; the
 * flags' behavior is enforced in the compositor and domain ops.
 *
 * Dropping an asset (ui/dnd.ts contract) builds clips via domain
 * clipFromAsset and commits ONE documentStore action — insertClip, or
 * insertClips when a video asset brings its audio along as a second clip
 * on the first unlocked audio lane, the pair lands LINKED (edits follow
 * the link; Inspector unlinks). Either way it is a plain click-release
 * edit (one undo entry), so unlike clip drags there is no scrub-preview
 * phase.
 * Handlers read stores with getState() only; the lone subscription-free
 * local state is the drop highlight, so render isolation is unchanged.
 */

import { memo, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import { createLinkGroupId } from '../../domain/linking'
import { clipFromAsset } from '../../domain/operations'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { ASSET_DRAG_TYPE, trackAcceptsAssetDrag } from '../dnd'
import ClipView from './ClipView'

interface TrackProps {
  track: TrackData
  /** True while ANOTHER audio track is solo — this lane is out of the mix. */
  soloDimmed?: boolean
}

function Track({ track, soloDimmed = false }: TrackProps) {
  const [dropReady, setDropReady] = useState(false)

  const acceptsDrag = (e: ReactDragEvent<HTMLDivElement>): boolean =>
    !track.locked && trackAcceptsAssetDrag(track.kind, e.dataTransfer.types)

  const flagClasses =
    (track.hidden ? ' track-hidden' : '') +
    (track.muted ? ' track-muted' : '') +
    (track.locked ? ' track-locked' : '') +
    (soloDimmed ? ' track-solo-dimmed' : '')

  return (
    <div
      className={`timeline-track track-${track.kind}${flagClasses}${dropReady ? ' drop-target' : ''}`}
      data-testid={`track-${track.id}`}
      onPointerDown={(e) => {
        // Empty-lane click deselects; clip pointerdowns have the CLIP as
        // target, so they never land here (Phase 4.2 selection).
        if (e.target === e.currentTarget) {
          useTransportStore.getState().setSelectedClip(null)
        }
      }}
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return
        e.preventDefault() // required by DnD: marks the lane as droppable
        e.dataTransfer.dropEffect = 'copy'
        setDropReady(true)
      }}
      onDragLeave={() => setDropReady(false)}
      onDrop={(e) => {
        setDropReady(false)
        if (!acceptsDrag(e)) return
        e.preventDefault()
        const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
        const asset = useMediaStore.getState().assets.get(assetId)
        if (!asset) return
        // Same px→frame mapping as the ruler: the lane's left edge is
        // frame 0, so this stays correct under horizontal scroll.
        const rect = e.currentTarget.getBoundingClientRect()
        const zoom = useTransportStore.getState().zoom
        const frame = Math.max(0, Math.round((e.clientX - rect.left) / zoom))
        const documentStore = useDocumentStore.getState()
        // A video asset that carries audio lands as a PAIR (NLE convention):
        // its video clip on this lane plus an audio clip on the first
        // unlocked audio lane, both stamped with ONE fresh linkGroupId so
        // the pair lands LINKED — one atomic insertClips, one undo entry.
        // If the audio spot is taken the whole drop is rejected (never half
        // a pair); with no usable audio lane the video half lands alone,
        // unlinked.
        const audioLane =
          asset.kind === 'video' && asset.hasAudio
            ? documentStore.doc.tracks.find((t) => t.kind === 'audio' && !t.locked)
            : undefined
        if (audioLane) {
          const linkGroupId = createLinkGroupId()
          documentStore.insertClips([
            { trackId: track.id, clip: clipFromAsset(asset, frame, linkGroupId) },
            { trackId: audioLane.id, clip: clipFromAsset(asset, frame, linkGroupId) },
          ])
        } else {
          documentStore.insertClip(track.id, clipFromAsset(asset, frame))
        }
      }}
    >
      {track.clips.map((clip) => (
        <ClipView key={clip.id} clip={clip} trackId={track.id} trackKind={track.kind} />
      ))}
    </div>
  )
}

/** memo: structural sharing keeps untouched Track objects identical across
 * edits, so only the edited lane re-renders. */
export default memo(Track)
