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

import { memo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Clip, TrackId, TrackKind } from '../../domain/schema'
import { microsecondsToFrames, rangeEnd } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import type { EditPreviewKind } from '../../state/transportStore'
import { useTransportStore } from '../../state/transportStore'
import { visibleFilmstripBuckets } from './clipVisualPlan'
import { useScrubScheduler } from './useScrubScheduler'

interface ClipViewProps {
  clip: Clip
  trackId: TrackId
  /** Lane kind: picks the visual (filmstrip vs waveform). Default video. */
  trackKind?: TrackKind
}

type GestureMode = 'move' | EditPreviewKind

/** Live drag-session values; refs, so moves never re-render anything extra. */
interface GestureSession {
  mode: GestureMode
  pointerStartX: number
  originFrame: number
  /** Current same-kind lane under the pointer during a move gesture. */
  targetTrackId: TrackId
  /** Target-lane top minus source-lane top, for the vertical ghost. */
  trackOffsetY: number
  /** Live clamp for the signed frame delta (source/timeline floors). */
  minDelta: number
  maxDelta: number
}

function ClipView({ clip, trackId, trackKind = 'video' }: ClipViewProps) {
  const zoom = useTransportStore((s) => s.zoom)
  const tool = useTransportStore((s) => s.tool)
  const isSelected = useTransportStore((s) => s.selectedClipId === clip.id)
  // Narrow slices: null unless THIS clip owns the live gesture OR is linked
  // to the clip that does (partners ghost the same preview) — every other,
  // unrelated clip's subscription still never fires, so render isolation
  // for UNLINKED clips is unchanged.
  const previewStart = useTransportStore((s) =>
    s.dragPreview &&
    (s.dragPreview.clipId === clip.id ||
      (clip.linkGroupId !== undefined && s.dragPreview.linkGroupId === clip.linkGroupId))
      ? s.dragPreview.startFrame
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
  const setDragPreview = useTransportStore((s) => s.setDragPreview)
  const setEditPreview = useTransportStore((s) => s.setEditPreview)
  const documentRate = useDocumentStore((s) => s.doc.frameRate)

  // Both visuals span the asset's FULL source duration. The waveform uses
  // full-source CSS size/position; the filmstrip is cut into integer-frame
  // SVG buckets that repeat each fixed-aspect sprite frame rather than
  // stretching one sample across a potentially huge time span.
  // Stable narrow slices change only when THIS asset's visuals/metadata land.
  const visuals = useMediaStore((s) => s.visuals.get(clip.assetId))
  const assetDurationFrames = useMediaStore((s) => {
    const connected = s.assets.get(clip.assetId)
    if (connected) return connected.durationFrames
    const descriptor = s.descriptors.get(clip.assetId)
    return descriptor
      ? microsecondsToFrames(descriptor.durationMicroseconds, documentRate)
      : 0
  })
  const isOffline = useMediaStore(
    (s) => s.descriptors.has(clip.assetId) && !s.assets.has(clip.assetId),
  )

  const session = useRef<GestureSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const scheduleMovePreview = useScrubScheduler((startFrame: number) => {
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
        startFrame,
        linkGroupId: clip.linkGroupId,
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
    const mode = session.current?.mode
    if (mode && mode !== 'move') {
      setEditPreview({ clipId: clip.id, kind: mode, deltaFrames, linkGroupId: clip.linkGroupId })
    }
  })

  /* ---------------- geometry (committed + live preview) ------------- */

  const tl = clip.timelineRange
  // previewStart may belong to a LINKED PARTNER's gesture (widened slice
  // above). Linked halves share identical timelineRanges by construction
  // (created together at A/V drop, and every linked geometry edit applies
  // the same delta to both), so rendering the gesture owner's ABSOLUTE
  // startFrame here is correct for the partner too — no per-clip delta math
  // needed. editPreview below carries a RELATIVE deltaFrames instead, so the
  // switch already renders correctly on the partner with no special-casing.
  let startFrame = previewStart ?? tl.startFrame
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
  const dragging = previewStart !== null || editPreview !== null

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
  const filmstrip = trackKind === 'video' ? visuals?.filmstrip : null
  const waveform = trackKind === 'audio' ? visuals?.waveform : null
  const filmstripBuckets = filmstrip
    ? visibleFilmstripBuckets(
        assetDurationFrames,
        filmstrip.tiles,
        filmstrip.tileWidth,
        zoom,
        sourceStartFrame,
        durationFrames,
      )
    : []

  /* ---------------- gesture plumbing -------------------------------- */

  /** Signed-delta clamp per mode: timeline floor, source floor, and (when
   * the asset is known) the source ceiling — live-accurate previews. */
  const boundsFor = (mode: GestureMode): { minDelta: number; maxDelta: number } => {
    const src = clip.sourceRange
    // Text clips have no media descriptor and intentionally remain extendable.
    // Unknown non-text sources stay clamped defensively at their current end.
    const headroom = clip.text
      ? Number.POSITIVE_INFINITY
      : Math.max(0, assetDurationFrames - rangeEnd(src))
    switch (mode) {
      case 'move':
      case 'slide':
        return { minDelta: -tl.startFrame, maxDelta: Number.POSITIVE_INFINITY }
      case 'trim-start':
        return {
          minDelta: Math.max(-tl.startFrame, -src.startFrame),
          maxDelta: tl.durationFrames - 1,
        }
      case 'ripple-start':
        return { minDelta: -src.startFrame, maxDelta: tl.durationFrames - 1 }
      case 'trim-end':
      case 'ripple-end':
        return { minDelta: -(tl.durationFrames - 1), maxDelta: headroom }
      case 'slip':
        return { minDelta: -src.startFrame, maxDelta: headroom }
    }
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
  ): void => {
    session.current = {
      mode,
      pointerStartX: e.clientX,
      originFrame: tl.startFrame,
      targetTrackId: trackId,
      trackOffsetY: 0,
      ...boundsFor(mode),
    }
    if (mode === 'move') {
      setDragPreview({ clipId: clip.id, startFrame: tl.startFrame, linkGroupId: clip.linkGroupId })
    } else {
      setEditPreview({ clipId: clip.id, kind: mode, deltaFrames: 0, linkGroupId: clip.linkGroupId })
    }
    try {
      rootRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic/inactive pointer — drag still works via move events */
    }
  }

  const endGesture = (): void => {
    session.current = null
    setDragPreview(null)
    setEditPreview(null)
  }

  const commitGesture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = session.current as GestureSession
    const delta = deltaFromEvent(e)
    const store = useDocumentStore.getState()
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
        const rect = e.currentTarget.getBoundingClientRect()
        const frame =
          tl.startFrame + Math.round((e.clientX - rect.left) / zoom)
        useDocumentStore.getState().splitClipAt(clip.id, frame)
        transport.setSelectedClip(clip.id)
        return
      }
      case 'select':
        transport.setSelectedClip(clip.id)
        startGesture(e, 'move')
        return
      case 'trim':
        transport.setSelectedClip(clip.id) // edges do the trimming
        return
      case 'slip':
        transport.setSelectedClip(clip.id)
        startGesture(e, 'slip')
        return
      case 'slide':
        transport.setSelectedClip(clip.id)
        startGesture(e, 'slide')
        return
    }
  }

  const onEdgePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    edge: 'start' | 'end',
  ): void => {
    e.stopPropagation() // the body handler must not also start a gesture
    const transport = useTransportStore.getState() // current tool, as above
    transport.setSelectedClip(clip.id)
    startGesture(e, transport.tool === 'trim' ? `ripple-${edge}` : `trim-${edge}`)
  }

  const showEdges = tool === 'select' || tool === 'trim'

  return (
    <div
      ref={rootRef}
      className={`clip-view${dragging ? ' dragging' : ''}${isSelected ? ' selected' : ''}${isOffline ? ' offline' : ''}`}
      data-testid={`clip-${clip.id}`}
      data-offline={isOffline ? 'true' : 'false'}
      style={{
        transform:
          previewTrackOffsetY === 0
            ? `translateX(${startFrame * zoom}px)`
            : `translate(${startFrame * zoom}px, ${previewTrackOffsetY}px)`,
        width: durationFrames * zoom,
      }}
      onPointerDown={onBodyPointerDown}
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
          scheduleMovePreview(s.originFrame + deltaFromEvent(e))
        } else {
          scheduleEditPreview(deltaFromEvent(e))
        }
      }}
      onPointerUp={(e) => {
        if (!session.current) return
        try {
          rootRef.current?.releasePointerCapture(e.pointerId)
        } catch {
          /* nothing captured */
        }
        commitGesture(e)
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
    >
      {filmstrip && assetDurationFrames > 0 && filmstripBuckets.length > 0 && (
        <div
          className="clip-visual clip-filmstrip"
          data-testid={`clip-${clip.id}-visual`}
        >
          {filmstripBuckets.map((bucket) => (
            <svg
              key={bucket.index}
              className="clip-filmstrip-tile"
              data-testid={`clip-${clip.id}-filmstrip-tile-${bucket.index}`}
              aria-hidden="true"
              focusable="false"
              style={{
                left: (bucket.startFrame - sourceStartFrame) * zoom,
                width: (bucket.endFrame - bucket.startFrame) * zoom,
              }}
            >
              <defs>
                <pattern
                  id={`${clip.id}-filmstrip-pattern-${bucket.index}`}
                  patternUnits="userSpaceOnUse"
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
          ))}
        </div>
      )}
      {waveform && assetDurationFrames > 0 && (
        <div
          className="clip-visual clip-waveform"
          data-testid={`clip-${clip.id}-visual`}
          style={{
            backgroundImage: `url(${waveform.url})`,
            backgroundSize: `${assetDurationFrames * zoom}px 100%`,
            backgroundPosition: `${-sourceStartFrame * zoom}px 0`,
          }}
        />
      )}
      {showEdges && (
        <>
          <div
            className="clip-edge clip-edge-start"
            data-testid={`clip-${clip.id}-edge-start`}
            onPointerDown={(e) => onEdgePointerDown(e, 'start')}
          />
          <div
            className="clip-edge clip-edge-end"
            data-testid={`clip-${clip.id}-edge-end`}
            onPointerDown={(e) => onEdgePointerDown(e, 'end')}
          />
        </>
      )}
      {badge !== null && <span className="clip-edit-badge">{badge}</span>}
      {isOffline && (
        <span className="clip-offline-badge" aria-label="Source offline">
          Offline
        </span>
      )}
      <span className="clip-name">{clip.name}</span>
      {clip.linkGroupId !== undefined && (
        <span className="clip-link-badge" data-testid={`clip-${clip.id}-link`}>
          🔗
        </span>
      )}
    </div>
  )
}

/** memo: edits rebuild only the touched track's clip objects (structural
 * sharing in domain/operations), so untouched clips skip re-rendering. */
export default memo(ClipView)
