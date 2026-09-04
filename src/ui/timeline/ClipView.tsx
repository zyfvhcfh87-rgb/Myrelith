/**
 * ui/timeline/ClipView.tsx — One clip as a positioned block with the full
 * Phase 4.2 gesture set. Phase 3.3; tools added in 4.2.
 *
 * Tool routing (transportStore.tool):
 * - select: body drag = move (dragPreview), edge drag = plain trim,
 *   pointerdown selects;
 * - razor:  pointerdown splits THIS clip at the pointer frame (no drag);
 * - trim:   edge drag = RIPPLE trim (downstream follows on commit);
 * - slip:   body drag shifts source material (position fixed, badge shows
 *           the delta), clamped live against the asset's length;
 * - slide:  body drag moves the clip between its touching neighbors.
 *
 * Every drag follows the scrubbing-vs-committed pattern exactly as
 * ARCHITECTURE.md demands: pointermove writes ONLY transportStore preview
 * state (rAF-coalesced), pointerup commits ONE documentStore action (one
 * undo entry) and clears the preview. A rejected commit (overlap etc.)
 * pushes no history and the clip snaps back. The gesture session itself lives
 * in useClipGestureSession; this component binds it to the rendered clip.
 *
 * Render isolation: subscriptions are primitives or own-clip slices
 * (null for every other clip), so dragging/selecting clip A never
 * re-renders clip B. `tool` re-renders all clips only when the tool
 * switches (rare, user-initiated). Render-only geometry/source mapping lives
 * in clipVisualPlan; ClipVisualLayer owns the decorative generated-media JSX.
 */

import { memo } from 'react'
import type { Clip, TrackId, TrackKind } from '../../domain/schema'
import { microsecondsDurationToFrames } from '../../domain/time'
import { findClip } from '../../domain/selectors'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { useSequenceInstanceSelectionStore } from '../../state/sequenceInstanceSelectionStore'
import { useMulticamSelectionStore } from '../../state/multicamSelectionStore'
import ClipAutomationLane from './ClipAutomationLane'
import {
  clipAutomationMarkers,
  clipHasSpeedLane,
} from './clipAutomationPlan'
import { planClipPresentation } from './clipVisualPlan'
import ClipVisualLayer from './ClipVisualLayer'
import { useClipGestureSession } from './useClipGestureSession'
import { frameAtTimelineClientX } from './timelineViewport'
import {
  editorContextMenuIdentity,
} from '../../app/editorContextMenuCommands'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from '../editorContextMenuController'

interface ClipViewProps {
  clip: Clip
  trackId: TrackId
  /** Lane kind: picks the visual (filmstrip vs waveform). Default video. */
  trackKind?: TrackKind
  /** Global frame represented by the bounded lane's local x=0. */
  timelineOriginFrame?: number
  /** Exclusive global frame at the bounded lane's right edge. */
  timelineWindowEndFrame?: number
}

function ClipView({
  clip,
  trackId,
  trackKind = 'video',
  timelineOriginFrame = 0,
  timelineWindowEndFrame = Number.MAX_SAFE_INTEGER,
}: ClipViewProps) {
  const contextMenu = useEditorContextMenu()
  const zoom = useTransportStore((s) => s.zoom)
  const tool = useTransportStore((s) => s.tool)
  const isSelected = useTransportStore((s) =>
    s.selectedClipIds.includes(clip.id)
    || s.selectionMarquee?.clipIds.includes(clip.id) === true,
  )
  const isPrimarySelection = useTransportStore(
    (s) => s.selectedClipId === clip.id,
  )
  // Narrow slices: null unless THIS clip owns the live gesture OR is linked
  // to the clip that does (partners ghost the same preview) — every other,
  // unrelated clip's subscription still never fires, so render isolation
  // for UNLINKED clips is unchanged.
  const movePreviewDelta = useTransportStore((s) =>
    s.dragPreview &&
    (s.dragPreview.clipId === clip.id ||
      s.dragPreview.clipIds?.includes(clip.id) === true ||
      (clip.linkGroupId !== undefined && s.dragPreview.linkGroupId === clip.linkGroupId))
      ? s.dragPreview.deltaFrames
      : null,
  )
  // The gesture owner uses trackOffsetY. A linked partner uses the
  // matching kind-index lane offset from partnerTrackOffsets.
  const previewTrackOffsetY = useTransportStore((s) => {
    if (!s.dragPreview) return 0
    if (s.dragPreview.clipId === clip.id) return s.dragPreview.trackOffsetY ?? 0
    return s.dragPreview.partnerTrackOffsets?.[clip.id] ?? 0
  })
  const editPreview = useTransportStore((s) =>
    s.editPreview &&
    (s.editPreview.clipId === clip.id ||
      (clip.linkGroupId !== undefined && s.editPreview.linkGroupId === clip.linkGroupId))
      ? s.editPreview
      : null,
  )
  const participatesInLiveGesture = useTransportStore((s) => {
    const gesture = s.dragPreview ?? s.editPreview
    return gesture !== null && (
      gesture.clipId === clip.id
      || ('clipIds' in gesture && gesture.clipIds?.includes(clip.id) === true)
      || (clip.linkGroupId !== undefined && gesture.linkGroupId === clip.linkGroupId)
    )
  })
  // The capture/keyboard owner stays focused when its preview leaves the
  // window. Only cold-mounted linked partners may be aria-hidden.
  const ownsLiveGesture = useTransportStore(
    (s) =>
      s.dragPreview?.clipId === clip.id || s.editPreview?.clipId === clip.id,
  )
  const documentRate = useDocumentStore((s) => s.doc.frameRate)

  // Both visuals map the asset's FULL source duration. The waveform crops a
  // normalized SVG source-time viewBox; the filmstrip is cut into integer-
  // frame SVG buckets that repeat each fixed-aspect sprite frame rather than
  // stretching one sample across a potentially huge time span.
  // Stable narrow slices change only when THIS asset's visuals/metadata land.
  const visuals = useMediaStore((s) => s.visuals.get(clip.assetId))
  const assetDurationFrames = useMediaStore((s) => {
    const connected = s.assets.get(clip.assetId)
    if (connected) return connected.durationFrames
    const descriptor = s.descriptors.get(clip.assetId)
    return descriptor
      ? microsecondsDurationToFrames(
          descriptor.durationMicroseconds,
          documentRate,
        )
      : 0
  })
  const isOffline = useMediaStore(
    (s) => s.descriptors.has(clip.assetId) && !s.assets.has(clip.assetId),
  )

  const {
    rootRef,
    announceRef,
    onBodyPointerDown,
    onEdgePointerDown,
    onKeyDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onLostPointerCapture,
  } = useClipGestureSession({
    clipId: clip.id,
    trackId,
    trackKind,
    zoom,
    timelineOriginFrame,
  })

  /* ---------------- geometry (committed + live preview) ------------- */

  const presentation = planClipPresentation({
    clip,
    trackKind,
    zoom,
    tool,
    movePreviewDelta,
    editPreview,
    participatesInLiveGesture,
    timelineOriginFrame,
    timelineWindowEndFrame,
    assetDurationFrames,
    visuals,
  })
  if (!presentation) return null

  const {
    dragging,
    badge,
    hasVisibleSlice,
    displayedDurationFrames,
    localStartPx,
    showStartEdge,
    showEndEdge,
    accessibleKind,
    interactionTitle,
  } = presentation
  const hasSpeedLane = trackKind === 'video' && clipHasSpeedLane(clip)
  const allMarkers = clipAutomationMarkers(clip)
    .map((marker) => ({
      ...marker,
      frame: presentation.automationMarkerStartFrame + marker.frame,
    }))
    .filter((marker) =>
      marker.frame >= presentation.displayedStartFrame
      && marker.frame < presentation.displayedEndFrame,
    )
  const markerStride = Math.max(1, Math.ceil(allMarkers.length / 128))
  const markers = allMarkers.filter((_, index) => index % markerStride === 0)
  const exposesInteractiveSemantics = hasVisibleSlice || ownsLiveGesture

  return (
    <div
      ref={rootRef}
      className={`clip-view${dragging ? ' dragging' : ''}${isSelected ? ' selected' : ''}${isSelected && isPrimarySelection ? ' primary-selected' : ''}${isOffline ? ' offline' : ''}${hasSpeedLane ? ' has-speed-lane' : ''}${hasVisibleSlice ? '' : ' virtual-gesture-host'}`}
      data-testid={`clip-${clip.id}`}
      data-clip-id={clip.id}
      data-offline={isOffline ? 'true' : 'false'}
      data-source-mode={clip.sourceMode ?? 'timed'}
      data-primary-selected={isSelected && isPrimarySelection ? 'true' : 'false'}
      data-virtual-gesture-host={hasVisibleSlice ? 'false' : 'true'}
      role={exposesInteractiveSemantics ? 'button' : undefined}
      tabIndex={exposesInteractiveSemantics ? 0 : -1}
      aria-hidden={exposesInteractiveSemantics ? undefined : true}
      aria-label={
        exposesInteractiveSemantics
          ? `${clip.name}, ${accessibleKind} clip`
          : undefined
      }
      aria-pressed={exposesInteractiveSemantics ? isSelected : undefined}
      aria-keyshortcuts={
        exposesInteractiveSemantics
          ? 'Control+ArrowLeft Control+ArrowRight Meta+ArrowLeft Meta+ArrowRight [ ] ArrowLeft ArrowRight Enter Escape'
          : undefined
      }
      title={interactionTitle}
      style={{
        transform:
          previewTrackOffsetY === 0
            ? `translateX(${localStartPx}px)`
            : `translate(${localStartPx}px, ${previewTrackOffsetY}px)`,
        width: hasVisibleSlice ? displayedDurationFrames * zoom : 1,
      }}
      onPointerDown={(event) => {
        useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
        useMulticamSelectionStore.getState().setSelectedInstanceId(null)
        onBodyPointerDown(event)
      }}
      onContextMenu={(event) => {
        const currentClip = findClip(useDocumentStore.getState().doc, clip.id)
        if (!currentClip) return
        const rect = event.currentTarget.getBoundingClientRect()
        const transport = useTransportStore.getState()
        const clipEnd = currentClip.timelineRange.startFrame
          + currentClip.timelineRange.durationFrames
        const frame = event.clientX === 0 && event.clientY === 0
          ? Math.min(
              clipEnd,
              Math.max(
                currentClip.timelineRange.startFrame,
                transport.playheadFrame,
              ),
            )
          : frameAtTimelineClientX(
              event.clientX,
              rect.left,
              Math.max(currentClip.timelineRange.startFrame, timelineOriginFrame),
              transport.zoom,
              currentClip.timelineRange.startFrame,
              clipEnd,
            )
        if (openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'clip',
            clipId: currentClip.id,
            frame,
          },
          restoreFocusTo: event.currentTarget,
        })) {
          transport.promoteContextClipSelection(currentClip.id)
        }
      }}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onLostPointerCapture={onLostPointerCapture}
    >
      <span
        ref={announceRef}
        className="visually-hidden"
        aria-live="polite"
      />
      <ClipVisualLayer clipId={clip.id} visual={presentation.visual} />
      {hasVisibleSlice && hasSpeedLane && (
        <ClipAutomationLane
          clip={clip}
          previewedClipStartFrame={presentation.previewedClipStartFrame}
          previewedClipDurationFrames={presentation.previewedClipDurationFrames}
          previewedSourceTimeMap={presentation.previewedSourceTimeMap}
          displayedStartFrame={presentation.displayedStartFrame}
          displayedEndFrame={presentation.displayedEndFrame}
          zoom={zoom}
        />
      )}
      {hasVisibleSlice && markers.length > 0 && (
        <span className="clip-keyframe-markers" aria-hidden="true">
          {markers.map((marker) => (
            <span
              key={marker.frame}
              className={`clip-keyframe-marker${marker.kinds.includes('effect') ? ' effect-key' : ''}${marker.kinds.length > 1 ? ' mixed-key' : ''}`}
              style={{
                left: (marker.frame - presentation.displayedStartFrame) * zoom,
              }}
            />
          ))}
        </span>
      )}
      {(showStartEdge || showEndEdge) && (
        <>
          {showStartEdge && (
            <div
              className="clip-edge clip-edge-start"
              data-testid={`clip-${clip.id}-edge-start`}
              onPointerDown={(e) => onEdgePointerDown(e, 'start')}
            />
          )}
          {showEndEdge && (
            <div
              className="clip-edge clip-edge-end"
              data-testid={`clip-${clip.id}-edge-end`}
              onPointerDown={(e) => onEdgePointerDown(e, 'end')}
            />
          )}
        </>
      )}
      {hasVisibleSlice && (
        <>
          {badge !== null && <span className="clip-edit-badge">{badge}</span>}
          {isOffline && (
            <span className="clip-offline-badge" aria-label="Source offline">
              Offline
            </span>
          )}
          <span className="clip-name">{clip.name}</span>
          {clip.linkGroupId !== undefined && (
            <span
              className="clip-link-badge"
              data-testid={`clip-${clip.id}-link`}
              aria-hidden="true"
            >
              🔗
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** memo: edits rebuild only the touched track's clip objects (structural
 * sharing in domain/operations), so untouched clips skip re-rendering. */
export default memo(ClipView)
