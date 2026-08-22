/**
 * ui/timeline/Track.tsx — One horizontal lane of clips. Phase 3.3; drop
 * target for MediaPool assets since 4.0; transition seam host since 5.1e-3.
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
 * Handlers read stores with getState() only. Narrow derived transport
 * subscriptions cover the drop highlight and whether this lane contains a
 * live-gesture participant; neither follows per-frame preview deltas.
 */

import { memo, useMemo, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import { createLinkGroupId } from '../../domain/linking'
import { clipFromAsset } from '../../domain/operations'
import { compatibilityAllowsTimelineUse } from '../../domain/mediaCompatibility'
import { rangeEnd } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { ASSET_DRAG_TYPE, trackAcceptsAssetDrag } from '../dnd'
import ClipView from './ClipView'
import TransitionSeam from './TransitionSeam'

interface TrackProps {
  track: TrackData
  /** True while ANOTHER audio track is solo — this lane is out of the mix. */
  soloDimmed?: boolean
  /** Global frame represented by this bounded lane's local x=0. */
  timelineOriginFrame?: number
  /** Exclusive global frame at the bounded lane's right edge. */
  timelineWindowEndFrame?: number
}

function Track({
  track,
  soloDimmed = false,
  timelineOriginFrame = 0,
  timelineWindowEndFrame = Number.MAX_SAFE_INTEGER,
}: TrackProps) {
  const [dropReady, setDropReady] = useState(false)
  const clipDropTarget = useTransportStore(
    (state) => state.dragPreview?.targetTrackId === track.id,
  )
  // Subscribe only to stable gesture identity. Preview deltas publish on every
  // pointer frame, so scanning the lane inside a selector would defeat
  // virtualization even when this track's membership has not changed.
  const liveGestureClipId = useTransportStore(
    (state) => (state.dragPreview ?? state.editPreview)?.clipId,
  )
  const liveGestureLinkGroupId = useTransportStore(
    (state) => (state.dragPreview ?? state.editPreview)?.linkGroupId,
  )
  const hasLiveGestureParticipant = useMemo(
    () =>
      liveGestureClipId !== undefined && track.clips.some(
        (clip) =>
          liveGestureClipId === clip.id
          || (
            clip.linkGroupId !== undefined
            && liveGestureLinkGroupId === clip.linkGroupId
          ),
      ),
    [liveGestureClipId, liveGestureLinkGroupId, track.clips],
  )

  const acceptsDrag = (e: ReactDragEvent<HTMLDivElement>): boolean =>
    !track.locked && trackAcceptsAssetDrag(track.kind, e.dataTransfer.types)

  const flagClasses =
    (track.hidden ? ' track-hidden' : '') +
    (track.muted ? ' track-muted' : '') +
    (track.locked ? ' track-locked' : '') +
    (soloDimmed ? ' track-solo-dimmed' : '')
  const participatesInLiveGesture = (clipId: string, linkGroupId?: string) =>
    hasLiveGestureParticipant &&
    (liveGestureClipId === clipId ||
      (linkGroupId !== undefined && liveGestureLinkGroupId === linkGroupId))

  return (
    <div
      className={`timeline-track track-${track.kind}${flagClasses}${dropReady ? ' drop-target' : ''}${clipDropTarget ? ' clip-drop-target' : ''}`}
      data-testid={`track-${track.id}`}
      data-track-id={track.id}
      data-track-kind={track.kind}
      data-track-locked={track.locked ? 'true' : 'false'}
      data-track-hidden={track.hidden ? 'true' : 'false'}
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
        const media = useMediaStore.getState()
        const asset = media.assets.get(assetId)
        if (
          !asset
          || asset.durationFrames <= 0
          || !compatibilityAllowsTimelineUse(media.compatibility.get(assetId))
        ) return
        // Same px→frame mapping as the ruler: the lane's left edge is the
        // current global origin, while pointer deltas remain local pixels.
        const rect = e.currentTarget.getBoundingClientRect()
        const zoom = useTransportStore.getState().zoom
        const frame = Math.max(
          0,
          timelineOriginFrame + Math.round((e.clientX - rect.left) / zoom),
        )
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
          const linkGroupId = createLinkGroupId(documentStore.doc)
          documentStore.insertClips([
            { trackId: track.id, clip: clipFromAsset(asset, frame, linkGroupId) },
            { trackId: audioLane.id, clip: clipFromAsset(asset, frame, linkGroupId) },
          ])
        } else {
          documentStore.insertClip(track.id, clipFromAsset(asset, frame))
        }
      }}
    >
      {track.clips
        .filter(
          (clip) =>
            participatesInLiveGesture(clip.id, clip.linkGroupId) ||
            (rangeEnd(clip.timelineRange) > timelineOriginFrame &&
              clip.timelineRange.startFrame < timelineWindowEndFrame),
        )
        .map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            trackId={track.id}
            trackKind={track.kind}
            timelineOriginFrame={timelineOriginFrame}
            timelineWindowEndFrame={timelineWindowEndFrame}
          />
        ))}
      {track.kind === 'video' &&
        track.clips.slice(0, -1).map((from, index) => {
          const to = track.clips[index + 1]
          if (
            from.text !== undefined ||
            to.text !== undefined ||
            rangeEnd(from.timelineRange) !== to.timelineRange.startFrame
          ) {
            return null
          }
          const transition = track.transitions.find(
            (candidate) =>
              candidate.fromClipId === from.id && candidate.toClipId === to.id,
          )
          const seamFrame = rangeEnd(from.timelineRange)
          if (
            seamFrame < timelineOriginFrame ||
            seamFrame > timelineWindowEndFrame
          ) {
            return null
          }
          return (
            <TransitionSeam
              key={`${from.id}:${to.id}`}
              trackId={track.id}
              locked={track.locked}
              from={from}
              to={to}
              transition={transition}
              timelineOriginFrame={timelineOriginFrame}
            />
          )
        })}
    </div>
  )
}

/** memo: structural sharing keeps untouched Track objects identical across
 * edits, so only the edited lane re-renders. */
export default memo(Track)
