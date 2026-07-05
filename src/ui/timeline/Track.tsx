/**
 * ui/timeline/Track.tsx — One horizontal lane of clips. Phase 3.3; drop
 * target for MediaPool assets since 4.0.
 *
 * Presentation + drop wiring: receives its Track as a prop (Timeline
 * subscribes to the tracks array), renders a ClipView per clip. The sticky
 * label chip lives INSIDE the lane so clips keep the same x-origin as the
 * ruler and playhead — a label gutter would break their alignment.
 *
 * Dropping an asset (ui/dnd.ts contract) builds a clip via domain
 * clipFromAsset and commits ONE documentStore.insertClip — a plain
 * click-release edit, so unlike clip drags there is no scrub-preview phase.
 * Handlers read stores with getState() only; the lone subscription-free
 * local state is the drop highlight, so render isolation is unchanged.
 */

import { memo, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import { clipFromAsset } from '../../domain/operations'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { ASSET_DRAG_TYPE, trackAcceptsAssetDrag } from '../dnd'
import ClipView from './ClipView'

interface TrackProps {
  track: TrackData
}

function Track({ track }: TrackProps) {
  const [dropReady, setDropReady] = useState(false)

  const acceptsDrag = (e: ReactDragEvent<HTMLDivElement>): boolean =>
    !track.locked && trackAcceptsAssetDrag(track.kind, e.dataTransfer.types)

  return (
    <div
      className={`timeline-track track-${track.kind}${dropReady ? ' drop-target' : ''}`}
      data-testid={`track-${track.id}`}
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
        useDocumentStore.getState().insertClip(track.id, clipFromAsset(asset, frame))
      }}
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
