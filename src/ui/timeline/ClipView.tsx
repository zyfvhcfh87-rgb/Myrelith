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
 * pushes no history and the clip snaps back.
 *
 * Render isolation: subscriptions are primitives or own-clip slices
 * (null for every other clip), so dragging/selecting clip A never
 * re-renders clip B. `tool` re-renders all clips only when the tool
 * switches (rare, user-initiated).
 */

import { memo, useEffect, useRef } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { Clip, TimelineDoc, TrackId, TrackKind } from '../../domain/schema'
import { findClip, trackOfClip } from '../../domain/selectors'
import { microsecondsDurationToFrames } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { visibleFilmstripBuckets } from './clipVisualPlan'
import {
  linkedGestureBounds,
  type GestureMode,
} from './gestureBounds'
import { useScrubScheduler } from './useScrubScheduler'
import { frameToTimelineLocalPx } from './timelineViewport'

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

/** Live drag-session values; refs, so moves never re-render anything extra. */
interface GestureSession {
  mode: GestureMode
  pointerStartX: number
  /** Exact immutable document snapshot this gesture was opened against. */
  document: TimelineDoc
  originFrame: number
  /** Link identity from the same fresh document snapshot as the bounds. */
  linkGroupId?: string
  /** Current same-kind lane under the pointer during a move gesture. */
  targetTrackId: TrackId
  /** Target-lane top minus source-lane top, for the vertical ghost. */
  trackOffsetY: number
  /** Live clamp for the signed frame delta (source/timeline floors). */
  minDelta: number
  maxDelta: number
}

function ClipView({
  clip,
  trackId,
  trackKind = 'video',
  timelineOriginFrame = 0,
  timelineWindowEndFrame = Number.MAX_SAFE_INTEGER,
}: ClipViewProps) {
  const zoom = useTransportStore((s) => s.zoom)
  const tool = useTransportStore((s) => s.tool)
  const isSelected = useTransportStore((s) =>
    s.selectedClipIds.includes(clip.id),
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
      (clip.linkGroupId !== undefined && s.dragPreview.linkGroupId === clip.linkGroupId))
      ? s.dragPreview.deltaFrames
      : null,
  )
  // Only the gesture owner changes lanes. A linked partner follows the
  // horizontal frame delta on its own current track (domain/linking.ts).
  const previewTrackOffsetY = useTransportStore((s) =>
    s.dragPreview?.clipId === clip.id ? (s.dragPreview.trackOffsetY ?? 0) : 0,
  )
  const editPreview = useTransportStore((s) =>
    s.editPreview &&
    (s.editPreview.clipId === clip.id ||
      (clip.linkGroupId !== undefined && s.editPreview.linkGroupId === clip.linkGroupId))
      ? s.editPreview
      : null,
  )
  const ownsLiveGesture = useTransportStore(
    (s) =>
      s.dragPreview?.clipId === clip.id || s.editPreview?.clipId === clip.id,
  )
  const setDragPreview = useTransportStore((s) => s.setDragPreview)
  const setEditPreview = useTransportStore((s) => s.setEditPreview)
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

  const session = useRef<GestureSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // A gesture owner normally remains mounted through pointerup. If a parent
  // disappears for an unrelated reason, clear its session state so a lost DOM
  // capture can never leave the transport store wedged in a live preview.
  useEffect(
    () => () => {
      const transport = useTransportStore.getState()
      if (transport.dragPreview?.clipId === clip.id) {
        transport.setDragPreview(null)
      }
      if (transport.editPreview?.clipId === clip.id) {
        transport.setEditPreview(null)
      }
    },
    [clip.id],
  )

  const scheduleMovePreview = useScrubScheduler((deltaFrames: number) => {
    // Same session guard as scheduleEditPreview below: a rAF flush can land
    // AFTER pointerup already committed and cleared the preview — without
    // this check the stale flush re-posts a dragPreview that nothing ever
    // clears, wedging the clip at the preview position until the next
    // gesture (caught in the 4.3.8 browser pass under a throttled-rAF pane).
    const active = session.current
    if (active?.mode === 'move') {
      const crossTrack = active.targetTrackId !== trackId
      setDragPreview({
        clipId: clip.id,
        deltaFrames,
        linkGroupId: active.linkGroupId,
        ...(crossTrack
          ? {
              targetTrackId: active.targetTrackId,
              trackOffsetY: active.trackOffsetY,
            }
          : {}),
      })
    }
  })
  const scheduleEditPreview = useScrubScheduler((deltaFrames: number) => {
    const active = session.current
    if (active && active.mode !== 'move') {
      setEditPreview({
        clipId: clip.id,
        kind: active.mode,
        deltaFrames,
        linkGroupId: active.linkGroupId,
      })
    }
  })

  /* ---------------- geometry (committed + live preview) ------------- */

  const tl = clip.timelineRange
  // A linked gesture shares one signed delta, never the gesture owner's
  // absolute start. Every member therefore ghosts from its own committed
  // position even when manually linked clips have unequal timeline offsets.
  let startFrame = tl.startFrame + (movePreviewDelta ?? 0)
  let durationFrames = tl.durationFrames
  let badge: string | null = null
  if (editPreview) {
    const d = editPreview.deltaFrames
    badge = `${editPreview.kind} ${d >= 0 ? '+' : ''}${d}`
    switch (editPreview.kind) {
      case 'trim-start':
        startFrame = tl.startFrame + d
        durationFrames = tl.durationFrames - d
        break
      case 'ripple-start': // head stays put; material is cut/restored
        durationFrames = tl.durationFrames - d
        break
      case 'trim-end':
      case 'ripple-end':
        durationFrames = tl.durationFrames + d
        break
      case 'slide':
        startFrame = tl.startFrame + d
        break
      case 'slip': // position and length are fixed by definition
        break
    }
  }
  const dragging = movePreviewDelta !== null || editPreview !== null

  // Source in-point as currently DISPLAYED: slip and start-side trims
  // shift the material under the clip, so the visual tracks the gesture
  // live (the background is anchored to the clip's moving left edge).
  let sourceStartFrame = clip.sourceRange.startFrame
  if (
    editPreview &&
    (editPreview.kind === 'slip' ||
      editPreview.kind === 'trim-start' ||
      editPreview.kind === 'ripple-start')
  ) {
    sourceStartFrame += editPreview.deltaFrames
  }

  // Intersect the live clip geometry with the bounded physical surface. A
  // single multi-hour clip must never emit an 80Mpx DOM width by itself.
  const clippedStartFrame = Math.max(startFrame, timelineOriginFrame)
  const clippedEndFrame = Math.min(
    startFrame + durationFrames,
    timelineWindowEndFrame,
  )
  const hasVisibleSlice = clippedEndFrame > clippedStartFrame
  if (!hasVisibleSlice && !ownsLiveGesture) return null

  // Keep the same root DOM node alive at the nearest surface edge while its
  // pointer capture is active. The invisible 1px host cannot enlarge the
  // bounded surface, but it can still receive pointerup/cancel and commit or
  // clear the gesture normally.
  const displayedStartFrame = hasVisibleSlice
    ? clippedStartFrame
    : Math.min(
        timelineWindowEndFrame,
        Math.max(timelineOriginFrame, startFrame),
      )
  const displayedEndFrame = hasVisibleSlice
    ? clippedEndFrame
    : displayedStartFrame
  const displayedDurationFrames = displayedEndFrame - displayedStartFrame
  const surfaceWidthPx = Math.max(
    1,
    (timelineWindowEndFrame - timelineOriginFrame) * zoom,
  )
  const localStartPx = hasVisibleSlice
    ? frameToTimelineLocalPx(
        displayedStartFrame,
        timelineOriginFrame,
        zoom,
      )
    : startFrame + durationFrames <= timelineOriginFrame
      ? 0
      : Math.max(0, surfaceWidthPx - 1)

  const displayedSourceStartFrame =
    sourceStartFrame + (displayedStartFrame - startFrame)
  const filmstrip = trackKind === 'video' ? visuals?.filmstrip : null
  const waveform = trackKind === 'audio' ? visuals?.waveform : null
  const filmstripBuckets = filmstrip
    ? visibleFilmstripBuckets(
        assetDurationFrames,
        filmstrip.tiles,
        filmstrip.tileWidth,
        zoom,
        displayedSourceStartFrame,
        displayedDurationFrames,
      )
    : []

  /* ---------------- gesture plumbing -------------------------------- */

  /** Intersect every linked member's timeline/source interval from fresh
   * document and media state at pointer-down. */
  const boundsFor = (
    currentDoc: TimelineDoc,
    mode: GestureMode,
  ): { minDelta: number; maxDelta: number } => {
    const media = useMediaStore.getState()
    return linkedGestureBounds(currentDoc, clip.id, mode, (member) => {
      const connected = media.assets.get(member.assetId)
      if (connected) return connected.durationFrames
      const descriptor = media.descriptors.get(member.assetId)
      return descriptor
        ? microsecondsDurationToFrames(
            descriptor.durationMicroseconds,
            currentDoc.frameRate,
          )
        : 0
    })
  }

  const deltaFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const s = session.current as GestureSession
    const raw = Math.round((e.clientX - s.pointerStartX) / zoom)
    return Math.min(s.maxDelta, Math.max(s.minDelta, raw))
  }

  /** Resolve the same-kind lane physically under the pointer. Pointer
   * capture keeps events on this ClipView, so event.target cannot identify
   * the hovered lane; sibling lane rectangles can. */
  const trackTargetAt = (clientX: number, clientY: number): {
    trackId: TrackId
    offsetY: number
  } => {
    const sourceLane = rootRef.current?.closest<HTMLElement>('[data-track-id]')
    const laneContainer = sourceLane?.parentElement
    if (!sourceLane || !laneContainer) return { trackId, offsetY: 0 }

    const sourceRect = sourceLane.getBoundingClientRect()
    const lanes = laneContainer.querySelectorAll<HTMLElement>('[data-track-id]')
    for (const lane of lanes) {
      if (lane.dataset.trackKind !== trackKind) continue
      const rect = lane.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (
        clientX >= rect.left &&
        clientX < rect.right &&
        clientY >= rect.top &&
        clientY < rect.bottom
      ) {
        const targetTrackId = lane.dataset.trackId
        if (targetTrackId) {
          return {
            trackId: targetTrackId,
            offsetY: rect.top - sourceRect.top,
          }
        }
      }
    }
    return { trackId, offsetY: 0 }
  }

  const startGesture = (
    e: ReactPointerEvent<HTMLDivElement>,
    mode: GestureMode,
  ): boolean => {
    const currentDoc = useDocumentStore.getState().doc
    const currentClip = findClip(currentDoc, clip.id)
    const currentTrack = trackOfClip(currentDoc, clip.id)
    // A capture-phase edit can make this rendered ClipView stale before its
    // own pointer handler runs. Fail closed instead of mixing snapshots.
    if (!currentClip || currentTrack?.id !== trackId) return false

    session.current = {
      mode,
      pointerStartX: e.clientX,
      document: currentDoc,
      originFrame: currentClip.timelineRange.startFrame,
      linkGroupId: currentClip.linkGroupId,
      targetTrackId: trackId,
      trackOffsetY: 0,
      ...boundsFor(currentDoc, mode),
    }
    if (mode === 'move') {
      setDragPreview({
        clipId: clip.id,
        deltaFrames: 0,
        linkGroupId: currentClip.linkGroupId,
      })
    } else {
      setEditPreview({
        clipId: clip.id,
        kind: mode,
        deltaFrames: 0,
        linkGroupId: currentClip.linkGroupId,
      })
    }
    try {
      rootRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic/inactive pointer — drag still works via move events */
    }
    return true
  }

  const endGesture = (): void => {
    session.current = null
    setDragPreview(null)
    setEditPreview(null)
  }

  const commitGesture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = session.current as GestureSession
    const store = useDocumentStore.getState()
    // Undo/redo or another edit may replace the immutable document while the
    // pointer is captured. Never retarget a stale delta onto that new snapshot
    // (whose link group and asset bounds may differ).
    if (store.doc !== s.document) {
      endGesture()
      return
    }
    const delta = deltaFromEvent(e)
    const moveTarget =
      s.mode === 'move' ? trackTargetAt(e.clientX, e.clientY) : null
    // Commit exactly once, and only when something actually changed.
    if (delta !== 0 || moveTarget?.trackId !== trackId) {
      switch (s.mode) {
        case 'move':
          store.moveClip(
            clip.id,
            moveTarget?.trackId ?? trackId,
            s.originFrame + delta,
          )
          break
        case 'trim-start':
          store.trimClip(clip.id, 'start', delta)
          break
        case 'trim-end':
          store.trimClip(clip.id, 'end', delta)
          break
        case 'ripple-start':
          store.rippleTrim(clip.id, 'start', delta)
          break
        case 'ripple-end':
          store.rippleTrim(clip.id, 'end', delta)
          break
        case 'slip':
          store.slipClip(clip.id, delta)
          break
        case 'slide':
          store.slideClip(clip.id, delta)
          break
      }
    }
    endGesture()
  }

  /* ---------------- handlers ----------------------------------------- */

  const onBodyPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Route by the CURRENT tool, not the render-time closure — handlers
    // read stores with getState() (a keypress may switch the tool in the
    // same tick as the pointerdown, before React re-renders).
    const transport = useTransportStore.getState()
    switch (transport.tool) {
      case 'razor': {
        // Split at the pointer frame — a click edit, no drag phase.
        const currentDoc = useDocumentStore.getState().doc
        const currentClip = findClip(currentDoc, clip.id)
        if (!currentClip || trackOfClip(currentDoc, clip.id)?.id !== trackId) return
        const rect = e.currentTarget.getBoundingClientRect()
        const frame =
          Math.max(currentClip.timelineRange.startFrame, timelineOriginFrame) +
          Math.round((e.clientX - rect.left) / zoom)
        useDocumentStore.getState().splitClipAt(clip.id, frame)
        if (findClip(useDocumentStore.getState().doc, clip.id)) {
          transport.setSelectedClip(clip.id)
        }
        return
      }
      case 'select':
        // Modifier selection is a discrete toggle, never the start of a
        // move. This makes adding/removing a partner safe even if the pointer
        // shifts a few pixels while Ctrl/Command is held.
        if (e.ctrlKey || e.metaKey) {
          if (findClip(useDocumentStore.getState().doc, clip.id)) {
            transport.toggleClipSelection(clip.id)
          }
          return
        }
        if (startGesture(e, 'move')) transport.setSelectedClip(clip.id)
        return
      case 'trim':
        if (findClip(useDocumentStore.getState().doc, clip.id)) {
          transport.setSelectedClip(clip.id) // edges do the trimming
        }
        return
      case 'slip':
        if (startGesture(e, 'slip')) transport.setSelectedClip(clip.id)
        return
      case 'slide':
        if (startGesture(e, 'slide')) transport.setSelectedClip(clip.id)
        return
    }
  }

  const onEdgePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    edge: 'start' | 'end',
  ): void => {
    e.stopPropagation() // the body handler must not also start a gesture
    const transport = useTransportStore.getState() // current tool, as above
    // In Select mode the handle is still part of the clip's pointer target:
    // modifier activation must toggle selection instead of beginning a trim.
    if (transport.tool === 'select' && (e.ctrlKey || e.metaKey)) {
      if (findClip(useDocumentStore.getState().doc, clip.id)) {
        transport.toggleClipSelection(clip.id)
      }
      return
    }
    if (
      startGesture(
        e,
        transport.tool === 'trim' ? `ripple-${edge}` : `trim-${edge}`,
      )
    ) {
      transport.setSelectedClip(clip.id)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return

    // Match native button activation without relying on a browser-reserved
    // shortcut. Keyboard selection intentionally never starts a drag/edit.
    e.preventDefault()
    e.stopPropagation()
    const transport = useTransportStore.getState()
    if (!findClip(useDocumentStore.getState().doc, clip.id)) return
    if (e.ctrlKey || e.metaKey) {
      transport.toggleClipSelection(clip.id)
    } else {
      transport.setSelectedClip(clip.id)
    }
  }

  const showEdges = hasVisibleSlice && (tool === 'select' || tool === 'trim')
  const showStartEdge = showEdges && displayedStartFrame === startFrame
  const showEndEdge =
    showEdges && displayedEndFrame === startFrame + durationFrames

  return (
    <div
      ref={rootRef}
      className={`clip-view${dragging ? ' dragging' : ''}${isSelected ? ' selected' : ''}${isSelected && isPrimarySelection ? ' primary-selected' : ''}${isOffline ? ' offline' : ''}${hasVisibleSlice ? '' : ' virtual-gesture-host'}`}
      data-testid={`clip-${clip.id}`}
      data-offline={isOffline ? 'true' : 'false'}
      data-primary-selected={isSelected && isPrimarySelection ? 'true' : 'false'}
      data-virtual-gesture-host={hasVisibleSlice ? 'false' : 'true'}
      role="button"
      tabIndex={0}
      aria-label={`${clip.name}, ${trackKind} clip`}
      aria-pressed={isSelected}
      title="Select clip. Hold Ctrl or Command while clicking, or with Enter or Space, to add or remove it from the selection."
      style={{
        transform:
          previewTrackOffsetY === 0
            ? `translateX(${localStartPx}px)`
            : `translate(${localStartPx}px, ${previewTrackOffsetY}px)`,
        width: hasVisibleSlice ? displayedDurationFrames * zoom : 1,
      }}
      onPointerDown={onBodyPointerDown}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => {
        // Gate on OUR session state, never on capture status — capture can
        // fail (and did, in browser verification) while the gesture is
        // perfectly trackable through move events.
        const s = session.current
        if (!s) return
        if (s.mode === 'move') {
          const target = trackTargetAt(e.clientX, e.clientY)
          s.targetTrackId = target.trackId
          s.trackOffsetY = target.offsetY
          scheduleMovePreview(deltaFromEvent(e))
        } else {
          scheduleEditPreview(deltaFromEvent(e))
        }
      }}
      onPointerUp={(e) => {
        if (!session.current) return
        commitGesture(e)
        try {
          rootRef.current?.releasePointerCapture(e.pointerId)
        } catch {
          /* nothing captured */
        }
      }}
      onPointerCancel={() => {
        // Gesture aborted (e.g. touch stolen by the OS): revert, commit nothing.
        endGesture()
      }}
      onPointerLeave={(e) => {
        // Only relevant when capture FAILED: the pointer left us and events
        // stop arriving, so end the gesture cleanly instead of wedging it.
        if (session.current && !e.currentTarget.hasPointerCapture(e.pointerId)) {
          endGesture()
        }
      }}
      onLostPointerCapture={() => {
        if (session.current) endGesture()
      }}
    >
      {hasVisibleSlice &&
        filmstrip &&
        assetDurationFrames > 0 &&
        filmstripBuckets.length > 0 && (
          <div
            className="clip-visual clip-filmstrip"
            data-testid={`clip-${clip.id}-visual`}
          >
          {filmstripBuckets.map((bucket) => {
            const visibleBucketStart = Math.max(
              bucket.startFrame,
              displayedSourceStartFrame,
            )
            const visibleBucketEnd = Math.min(
              bucket.endFrame,
              displayedSourceStartFrame + displayedDurationFrames,
            )
            const croppedHeadPx =
              (visibleBucketStart - bucket.startFrame) * zoom
            return (
              <svg
                key={bucket.index}
                className="clip-filmstrip-tile"
                data-testid={`clip-${clip.id}-filmstrip-tile-${bucket.index}`}
                aria-hidden="true"
                focusable="false"
                style={{
                  left:
                    (visibleBucketStart - displayedSourceStartFrame) * zoom,
                  width: (visibleBucketEnd - visibleBucketStart) * zoom,
                }}
              >
                <defs>
                  <pattern
                    id={`${clip.id}-filmstrip-pattern-${bucket.index}`}
                    patternUnits="userSpaceOnUse"
                    x={-(croppedHeadPx % filmstrip.tileWidth)}
                    width={filmstrip.tileWidth}
                    height={filmstrip.tileHeight}
                  >
                    <image
                      href={filmstrip.url}
                      x={-bucket.spriteIndex * filmstrip.tileWidth}
                      width={filmstrip.tiles * filmstrip.tileWidth}
                      height={filmstrip.tileHeight}
                    />
                  </pattern>
                </defs>
                <rect
                  width="100%"
                  height="100%"
                  fill={`url(#${clip.id}-filmstrip-pattern-${bucket.index})`}
                />
              </svg>
            )
            })}
          </div>
        )}
      {hasVisibleSlice && waveform && assetDurationFrames > 0 && (
        <svg
          className="clip-visual clip-waveform"
          data-testid={`clip-${clip.id}-visual`}
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="none"
          viewBox={`${displayedSourceStartFrame / assetDurationFrames} 0 ${displayedDurationFrames / assetDurationFrames} 1`}
        >
          <image
            href={waveform.url}
            x="0"
            y="0"
            width="1"
            height="1"
            preserveAspectRatio="none"
          />
        </svg>
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
