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
 * Dropping an already-imported asset, or one OS file after import, goes
 * through app/mediaPlacementController so both paths share overlap, kind,
 * and linked A/V pairing. Hover writes only transport preview geometry.
 * Handlers read stores with getState() only. Narrow derived transport
 * subscriptions cover the drop highlight and whether this lane contains a
 * live-gesture participant; neither follows per-frame preview deltas.
 */

import { memo, useMemo, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { Track as TrackData } from '../../domain/schema'
import { rangeEnd } from '../../domain/time'
import {
  applyMediaPlacementHoverPreview,
  clearMediaPlacementPreview,
  dropOsFilesOnTimeline,
  invalidateMediaPlacementHover,
  mediaPlacementPreviewEpoch,
  placeImportedAsset,
  previewImportedAssetPlacement,
  previewOsFilePlacement,
  timelineFrameFromPointer,
  visiblePlacementPreviewRange,
} from '../../app/mediaPlacementController'
import { useDocumentStore } from '../../state/documentStore'
import { useSequenceInstanceSelectionStore } from '../../state/sequenceInstanceSelectionStore'
import { useTransportStore } from '../../state/transportStore'
import {
  ASSET_DRAG_TYPE,
  endAssetDrag,
  getActiveAssetDrag,
  trackAcceptsAssetDrag,
} from '../dnd'
import { extractDroppedFiles, isFileDrag } from '../fileDrag'
import { isPrimaryEditingPointer } from '../pointerButtons'
import ClipView from './ClipView'
import AdjustmentView from './AdjustmentView'
import SequenceInstanceView from './SequenceInstanceView'
import TransitionSeam from './TransitionSeam'
import {
  frameAtTimelineClientX,
  frameToTimelineLocalPx,
} from './timelineViewport'
import { useScrubScheduler } from './useScrubScheduler'
import { editorContextMenuIdentity } from '../../app/editorContextMenuCommands'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from '../editorContextMenuController'

interface TrackProps {
  track: TrackData
  /**
   * Document identity from the last committed render of this lane.
   * Timeline always passes the snapshot it rendered; tests may omit it.
   */
  documentId?: string
  /** True while ANOTHER audio track is solo — this lane is out of the mix. */
  soloDimmed?: boolean
  /** Global frame represented by this bounded lane's local x=0. */
  timelineOriginFrame?: number
  /** Exclusive global frame at the bounded lane's right edge. */
  timelineWindowEndFrame?: number
}

// Authored link groups are pairs, while imported documents may contain a
// defensive larger group. Keep the normal offscreen partner preview without
// allowing one pathological lane to replace virtualization with thousands of
// live ClipViews. Project files cap tracks at 256, so this also gives the
// whole timeline a strict upper bound of 256 cold hosts per gesture.
const MAX_COLD_LIVE_GESTURE_HOSTS_PER_TRACK = 1

function pointerFrame(
  event: ReactDragEvent<HTMLDivElement>,
  originFrame: number,
): number {
  const rect = event.currentTarget.getBoundingClientRect()
  return timelineFrameFromPointer(
    originFrame,
    event.clientX - rect.left,
    useTransportStore.getState().zoom,
  )
}

function isLeavingLane(event: ReactDragEvent<HTMLDivElement>): boolean {
  const related = event.relatedTarget
  return !(related instanceof Node && event.currentTarget.contains(related))
}

function MediaPlacementGhost({
  trackId,
  timelineOriginFrame,
  timelineWindowEndFrame,
}: {
  trackId: string
  timelineOriginFrame: number
  timelineWindowEndFrame: number
}) {
  const preview = useTransportStore((state) => (
    state.mediaPlacementPreview?.trackId === trackId
      ? state.mediaPlacementPreview
      : null
  ))
  const zoom = useTransportStore((state) => state.zoom)
  if (!preview) return null
  const visible = visiblePlacementPreviewRange(
    preview.startFrame,
    preview.durationFrames,
    timelineOriginFrame,
    timelineWindowEndFrame,
  )
  if (!visible) return null
  const marker = preview.durationFrames === null
  return (
    <div
      className={
        `media-placement-ghost${marker ? ' marker' : ''}${preview.valid ? '' : ' invalid'}`
      }
      data-testid="media-placement-ghost"
      data-placement-valid={preview.valid ? 'true' : 'false'}
      data-placement-phase={preview.phase}
      aria-hidden="true"
      style={{
        transform: `translateX(${frameToTimelineLocalPx(
          visible.startFrame,
          timelineOriginFrame,
          zoom,
        )}px)`,
        width: Math.max(1, visible.durationFrames * zoom),
      }}
    />
  )
}

function Track({
  track,
  documentId,
  soloDimmed = false,
  timelineOriginFrame = 0,
  timelineWindowEndFrame = Number.MAX_SAFE_INTEGER,
}: TrackProps) {
  const contextMenu = useEditorContextMenu()
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
  const liveGestureClipIds = useTransportStore(
    (state) => state.dragPreview?.clipIds,
  )
  const schedulePlacementPreview = useScrubScheduler(
    (payload: { preview: ReturnType<typeof previewOsFilePlacement>; epoch: number }) => {
      applyMediaPlacementHoverPreview(payload.preview, payload.epoch)
    },
  )
  const acceptsAssetDrag = (e: ReactDragEvent<HTMLDivElement>): boolean =>
    !track.locked && trackAcceptsAssetDrag(track.kind, e.dataTransfer.types)
  const acceptsFileDrag = (e: ReactDragEvent<HTMLDivElement>): boolean =>
    !track.locked && isFileDrag(e.dataTransfer)
  const snapshotDocumentId = documentId ?? useDocumentStore.getState().doc.id

  const flagClasses =
    (track.hidden ? ' track-hidden' : '') +
    (track.muted ? ' track-muted' : '') +
    (track.locked ? ' track-locked' : '') +
    (soloDimmed ? ' track-solo-dimmed' : '')
  const clipsToRender = useMemo(() => {
    let coldGestureHostCount = 0
    return track.clips.filter((clip) => {
      const intersectsWindow =
        rangeEnd(clip.timelineRange) > timelineOriginFrame
        && clip.timelineRange.startFrame < timelineWindowEndFrame
      if (intersectsWindow || clip.id === liveGestureClipId) return true
      if (
        liveGestureClipIds?.includes(clip.id) === true
        && coldGestureHostCount < MAX_COLD_LIVE_GESTURE_HOSTS_PER_TRACK
      ) {
        coldGestureHostCount += 1
        return true
      }
      if (
        liveGestureLinkGroupId === undefined
        || clip.linkGroupId !== liveGestureLinkGroupId
        || coldGestureHostCount >= MAX_COLD_LIVE_GESTURE_HOSTS_PER_TRACK
      ) return false
      coldGestureHostCount += 1
      return true
    })
  }, [
    liveGestureClipId,
    liveGestureClipIds,
    liveGestureLinkGroupId,
    timelineOriginFrame,
    timelineWindowEndFrame,
    track.clips,
  ])

  return (
    <div
      className={`timeline-track track-${track.kind}${flagClasses}${dropReady ? ' drop-target' : ''}${clipDropTarget ? ' clip-drop-target' : ''}`}
      data-testid={`track-${track.id}`}
      data-track-id={track.id}
      data-track-kind={track.kind}
      data-track-locked={track.locked ? 'true' : 'false'}
      data-track-hidden={track.hidden ? 'true' : 'false'}
      onPointerDown={(e) => {
        if (!isPrimaryEditingPointer(e)) return
        // Empty-lane click deselects; clip pointerdowns have the CLIP as
        // target, so they never land here (Phase 4.2 selection).
        if (e.target === e.currentTarget) {
          useTransportStore.getState().setSelectedClip(null)
          useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
        }
      }}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        const frame = frameAtTimelineClientX(
          event.clientX,
          rect.left,
          useTransportStore.getState().timelineOriginFrame,
          useTransportStore.getState().zoom,
        )
        openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'lane',
            trackId: track.id,
            frame,
          },
          restoreFocusTo: null,
        })
      }}
      onDragOver={(e) => {
        const fileDrag = acceptsFileDrag(e)
        const assetDrag = acceptsAssetDrag(e)
        if (!fileDrag && !assetDrag) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropReady(true)
        const startFrame = pointerFrame(e, timelineOriginFrame)
        const epoch = mediaPlacementPreviewEpoch()
        if (fileDrag) {
          schedulePlacementPreview({
            preview: previewOsFilePlacement(track.id, startFrame),
            epoch,
          })
          return
        }
        const active = getActiveAssetDrag()
        schedulePlacementPreview({
          preview: previewImportedAssetPlacement({
            trackId: track.id,
            startFrame,
            assetId: active?.assetId ?? null,
            fallbackDurationFrames: active?.durationFrames ?? null,
          }),
          epoch,
        })
      }}
      onDragLeave={(e) => {
        if (!isLeavingLane(e)) return
        setDropReady(false)
        clearMediaPlacementPreview()
      }}
      onDrop={(e) => {
        setDropReady(false)
        invalidateMediaPlacementHover()
        const startFrame = pointerFrame(e, timelineOriginFrame)
        if (isFileDrag(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          if (track.locked) {
            clearMediaPlacementPreview()
            return
          }
          void dropOsFilesOnTimeline({
            documentId: snapshotDocumentId,
            trackId: track.id,
            trackKind: track.kind,
            startFrame,
            files: extractDroppedFiles(e.dataTransfer),
          })
          return
        }
        if (!acceptsAssetDrag(e)) {
          clearMediaPlacementPreview()
          return
        }
        e.preventDefault()
        const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
        placeImportedAsset(
          snapshotDocumentId,
          assetId,
          track.id,
          startFrame,
        )
        clearMediaPlacementPreview()
        endAssetDrag()
      }}
    >
      {clipsToRender.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          trackId={track.id}
          trackKind={track.kind}
          timelineOriginFrame={timelineOriginFrame}
          timelineWindowEndFrame={timelineWindowEndFrame}
        />
      ))}
      {(track.sequenceInstances ?? []).map((instance) => (
        <SequenceInstanceView
          key={instance.id}
          instance={instance}
          trackId={track.id}
          trackKind={track.kind}
          timelineOriginFrame={timelineOriginFrame}
          timelineWindowEndFrame={timelineWindowEndFrame}
        />
      ))}
      {track.kind === 'video' && (track.adjustments ?? [])
        .filter((adjustment) => (
          rangeEnd(adjustment.timelineRange) > timelineOriginFrame
          && adjustment.timelineRange.startFrame < timelineWindowEndFrame
        ) || useTransportStore.getState().adjustmentEditPreview?.adjustmentId === adjustment.id)
        .map((adjustment) => (
          <AdjustmentView
            key={adjustment.id}
            adjustment={adjustment}
            trackId={track.id}
            locked={track.locked}
            timelineOriginFrame={timelineOriginFrame}
            timelineWindowEndFrame={timelineWindowEndFrame}
          />
        ))}
      <MediaPlacementGhost
        trackId={track.id}
        timelineOriginFrame={timelineOriginFrame}
        timelineWindowEndFrame={timelineWindowEndFrame}
      />
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
