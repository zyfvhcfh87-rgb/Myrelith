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
import type { Clip, TrackId } from '../../domain/schema'
import { rangeEnd } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import type { EditPreviewKind } from '../../state/transportStore'
import { useTransportStore } from '../../state/transportStore'
import { useScrubScheduler } from './useScrubScheduler'

interface ClipViewProps {
  clip: Clip
  trackId: TrackId
}

type GestureMode = 'move' | EditPreviewKind

/** Live drag-session values; refs, so moves never re-render anything extra. */
interface GestureSession {
  mode: GestureMode
  pointerStartX: number
  originFrame: number
  /** Live clamp for the signed frame delta (source/timeline floors). */
  minDelta: number
  maxDelta: number
}

function ClipView({ clip, trackId }: ClipViewProps) {
  const zoom = useTransportStore((s) => s.zoom)
  const tool = useTransportStore((s) => s.tool)
  const isSelected = useTransportStore((s) => s.selectedClipId === clip.id)
  // Narrow slices: null unless THIS clip owns the live gesture — other
  // clips' subscriptions never fire during someone else's drag.
  const previewStart = useTransportStore((s) =>
    s.dragPreview && s.dragPreview.clipId === clip.id
      ? s.dragPreview.startFrame
      : null,
  )
  const editPreview = useTransportStore((s) =>
    s.editPreview && s.editPreview.clipId === clip.id ? s.editPreview : null,
  )
  const setDragPreview = useTransportStore((s) => s.setDragPreview)
  const setEditPreview = useTransportStore((s) => s.setEditPreview)

  const session = useRef<GestureSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const scheduleMovePreview = useScrubScheduler((startFrame: number) =>
    setDragPreview({ clipId: clip.id, startFrame }),
  )
  const scheduleEditPreview = useScrubScheduler((deltaFrames: number) => {
    const mode = session.current?.mode
    if (mode && mode !== 'move') {
      setEditPreview({ clipId: clip.id, kind: mode, deltaFrames })
    }
  })

  /* ---------------- geometry (committed + live preview) ------------- */

  const tl = clip.timelineRange
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

  /* ---------------- gesture plumbing -------------------------------- */

  /** Signed-delta clamp per mode: timeline floor, source floor, and (when
   * the asset is known) the source ceiling — live-accurate previews. */
  const boundsFor = (mode: GestureMode): { minDelta: number; maxDelta: number } => {
    const src = clip.sourceRange
    const asset = useMediaStore.getState().assets.get(clip.assetId)
    const headroom = asset
      ? Math.max(0, asset.durationFrames - rangeEnd(src))
      : Number.POSITIVE_INFINITY
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

  const startGesture = (
    e: ReactPointerEvent<HTMLDivElement>,
    mode: GestureMode,
  ): void => {
    session.current = {
      mode,
      pointerStartX: e.clientX,
      originFrame: tl.startFrame,
      ...boundsFor(mode),
    }
    if (mode === 'move') {
      setDragPreview({ clipId: clip.id, startFrame: tl.startFrame })
    } else {
      setEditPreview({ clipId: clip.id, kind: mode, deltaFrames: 0 })
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
    // Commit exactly once, and only when something actually changed.
    if (delta !== 0) {
      switch (s.mode) {
        case 'move':
          store.moveClip(clip.id, trackId, s.originFrame + delta)
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
    const transport = useTransportStore.getState()
    switch (tool) {
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
    useTransportStore.getState().setSelectedClip(clip.id)
    startGesture(e, tool === 'trim' ? `ripple-${edge}` : `trim-${edge}`)
  }

  const showEdges = tool === 'select' || tool === 'trim'

  return (
    <div
      ref={rootRef}
      className={`clip-view${dragging ? ' dragging' : ''}${isSelected ? ' selected' : ''}`}
      data-testid={`clip-${clip.id}`}
      style={{
        transform: `translateX(${startFrame * zoom}px)`,
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
      <span className="clip-name">{clip.name}</span>
    </div>
  )
}

/** memo: edits rebuild only the touched track's clip objects (structural
 * sharing in domain/operations), so untouched clips skip re-rendering. */
export default memo(ClipView)
