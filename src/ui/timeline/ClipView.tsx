/**
 * ui/timeline/ClipView.tsx — One clip as a positioned, draggable block.
 * Phase 3.3.
 *
 * The scrubbing-vs-committed pattern, exactly as ARCHITECTURE.md demands:
 * - pointermove writes ONLY transportStore.dragPreview (rAF-coalesced via
 *   useScrubScheduler) — documentStore is never touched mid-gesture;
 * - pointerup commits ONE documentStore.moveClip (→ one undo entry) and
 *   clears the preview. A rejected move (overlap etc.) pushes no history
 *   and the clip visually snaps back to its committed position.
 *
 * Render isolation: this component subscribes to zoom and to ITS OWN slice
 * of dragPreview (a primitive), so dragging clip A never re-renders clip B.
 * Horizontal drags only for now — cross-track dragging arrives in Phase 4.
 */

import { memo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Clip, TrackId } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { useScrubScheduler } from './useScrubScheduler'

interface ClipViewProps {
  clip: Clip
  trackId: TrackId
}

/** Live drag-session values; refs, so moves never re-render anything extra. */
interface DragSession {
  pointerStartX: number
  originFrame: number
}

function ClipView({ clip, trackId }: ClipViewProps) {
  const zoom = useTransportStore((s) => s.zoom)
  // Narrow slice: a primitive that is null unless THIS clip is the one
  // being dragged — other clips' subscriptions never fire during a drag.
  const previewStart = useTransportStore((s) =>
    s.dragPreview && s.dragPreview.clipId === clip.id
      ? s.dragPreview.startFrame
      : null,
  )
  const setDragPreview = useTransportStore((s) => s.setDragPreview)
  const schedulePreview = useScrubScheduler((startFrame) =>
    setDragPreview({ clipId: clip.id, startFrame }),
  )
  const session = useRef<DragSession | null>(null)

  const dragging = previewStart !== null
  const startFrame = previewStart ?? clip.timelineRange.startFrame
  const widthPx = clip.timelineRange.durationFrames * zoom

  const frameFromDelta = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const s = session.current as DragSession
    return Math.max(
      0,
      s.originFrame + Math.round((e.clientX - s.pointerStartX) / zoom),
    )
  }

  return (
    <div
      className={`clip-view${dragging ? ' dragging' : ''}`}
      data-testid={`clip-${clip.id}`}
      style={{
        transform: `translateX(${startFrame * zoom}px)`,
        width: widthPx,
      }}
      onPointerDown={(e) => {
        session.current = {
          pointerStartX: e.clientX,
          originFrame: clip.timelineRange.startFrame,
        }
        setDragPreview({ clipId: clip.id, startFrame: clip.timelineRange.startFrame })
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* synthetic/inactive pointer — drag still works via move events */
        }
      }}
      onPointerMove={(e) => {
        // Gate on OUR session state, never on capture status — capture can
        // fail (and did, in browser verification) while the gesture is
        // perfectly trackable through move events.
        if (session.current) {
          schedulePreview(frameFromDelta(e))
        }
      }}
      onPointerUp={(e) => {
        if (!session.current) return
        const finalFrame = frameFromDelta(e)
        const originFrame = session.current.originFrame
        session.current = null
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* nothing captured */
        }
        // Commit exactly once, and only when the clip actually moved.
        if (finalFrame !== originFrame) {
          useDocumentStore.getState().moveClip(clip.id, trackId, finalFrame)
        }
        setDragPreview(null)
      }}
      onPointerCancel={() => {
        // Gesture aborted (e.g. touch stolen by the OS): revert, commit nothing.
        session.current = null
        setDragPreview(null)
      }}
      onPointerLeave={(e) => {
        // Only relevant when capture FAILED: the pointer left us and events
        // stop arriving, so end the gesture cleanly instead of wedging it.
        if (session.current && !e.currentTarget.hasPointerCapture(e.pointerId)) {
          session.current = null
          setDragPreview(null)
        }
      }}
    >
      <span className="clip-name">{clip.name}</span>
    </div>
  )
}

/** memo: edits rebuild only the touched track's clip objects (structural
 * sharing in domain/operations), so untouched clips skip re-rendering. */
export default memo(ClipView)
