import { memo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { AdjustmentItem, TrackId } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { adjustmentEditDeltaBounds, rangeEnd } from '../../state/editorUi'
import { useTransportStore } from '../../state/transportStore'
import { isPrimaryEditingPointer } from '../pointerButtons'
import { frameAtTimelineClientX, frameToTimelineLocalPx } from './timelineViewport'
import { useScrubScheduler } from './useScrubScheduler'

interface AdjustmentViewProps {
  adjustment: AdjustmentItem
  trackId: TrackId
  locked: boolean
  timelineOriginFrame: number
  timelineWindowEndFrame: number
}

type GestureKind = 'move' | 'trim-start' | 'trim-end'

interface GestureSession {
  pointerId: number
  startClientX: number
  kind: GestureKind
  minDelta: number
  maxDelta: number
  lastDelta: number
}

function AdjustmentView({
  adjustment,
  trackId,
  locked,
  timelineOriginFrame,
  timelineWindowEndFrame,
}: AdjustmentViewProps) {
  const zoom = useTransportStore((state) => state.zoom)
  const tool = useTransportStore((state) => state.tool)
  const selected = useTransportStore(
    (state) => state.selectedAdjustmentId === adjustment.id,
  )
  const preview = useTransportStore((state) => (
    state.adjustmentEditPreview?.adjustmentId === adjustment.id
      ? state.adjustmentEditPreview
      : null
  ))
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<GestureSession | null>(null)
  const schedulePreview = useScrubScheduler((deltaFrames: number) => {
    const session = sessionRef.current
    if (!session) return
    useTransportStore.getState().setAdjustmentEditPreview({
      adjustmentId: adjustment.id,
      kind: session.kind,
      deltaFrames,
      targetTrackId: trackId,
    })
  })

  const committed = adjustment.timelineRange
  const delta = preview?.deltaFrames ?? 0
  const displayed = preview?.kind === 'move'
    ? { ...committed, startFrame: committed.startFrame + delta }
    : preview?.kind === 'trim-start'
      ? {
          startFrame: committed.startFrame + delta,
          durationFrames: committed.durationFrames - delta,
        }
      : preview?.kind === 'trim-end'
        ? { ...committed, durationFrames: committed.durationFrames + delta }
        : committed
  const displayedEnd = rangeEnd(displayed)
  const visibleStart = Math.max(displayed.startFrame, timelineOriginFrame)
  const visibleEnd = Math.min(displayedEnd, timelineWindowEndFrame)
  if (visibleEnd <= visibleStart && preview === null) return null

  const beginGesture = (
    event: PointerEvent<HTMLDivElement>,
    kind: GestureKind,
  ): void => {
    if (!isPrimaryEditingPointer(event) || locked) return
    event.preventDefault()
    event.stopPropagation()
    const transport = useTransportStore.getState()
    transport.setSelectedAdjustment(adjustment.id)
    if (tool === 'razor' && kind === 'move') {
      const rect = event.currentTarget.getBoundingClientRect()
      const frame = frameAtTimelineClientX(
        event.clientX,
        rect.left,
        visibleStart,
        zoom,
        adjustment.timelineRange.startFrame,
        rangeEnd(adjustment.timelineRange),
      )
      useDocumentStore.getState().splitAdjustmentAt(adjustment.id, frame)
      return
    }
    const bounds = adjustmentEditDeltaBounds(
      useDocumentStore.getState().doc,
      adjustment.id,
      kind,
    )
    if (!bounds) return
    sessionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      kind,
      minDelta: bounds.min,
      maxDelta: bounds.max,
      lastDelta: 0,
    }
    rootRef.current?.setPointerCapture(event.pointerId)
    transport.setAdjustmentEditPreview({
      adjustmentId: adjustment.id,
      kind,
      deltaFrames: 0,
      targetTrackId: trackId,
    })
  }

  const endGesture = (event: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const session = sessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    sessionRef.current = null
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId)
    }
    useTransportStore.getState().setAdjustmentEditPreview(null)
    if (!commit || session.lastDelta === 0) return
    const store = useDocumentStore.getState()
    if (session.kind === 'move') {
      store.moveAdjustment(
        adjustment.id,
        trackId,
        adjustment.timelineRange.startFrame + session.lastDelta,
      )
    } else {
      store.trimAdjustment(
        adjustment.id,
        session.kind === 'trim-start' ? 'start' : 'end',
        session.lastDelta,
      )
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const store = useDocumentStore.getState()
    const transport = useTransportStore.getState()
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      store.removeAdjustment(adjustment.id)
      return
    }
    if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      store.duplicateAdjustment(adjustment.id)
      return
    }
    if (event.key.toLowerCase() === 's') {
      const frame = transport.playheadFrame
      if (frame > committed.startFrame && frame < rangeEnd(committed)) {
        event.preventDefault()
        event.stopPropagation()
        store.splitAdjustmentAt(adjustment.id, frame)
      }
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    if (locked) return
    const deltaFrames = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1)
    if (event.altKey) {
      store.trimAdjustment(adjustment.id, event.ctrlKey || event.metaKey ? 'start' : 'end', deltaFrames)
    } else {
      store.moveAdjustment(
        adjustment.id,
        trackId,
        committed.startFrame + deltaFrames,
      )
    }
  }

  return (
    <div
      ref={rootRef}
      className={`adjustment-view${selected ? ' selected' : ''}${preview ? ' dragging' : ''}${adjustment.enabled ? '' : ' disabled'}`}
      data-testid={`adjustment-${adjustment.id}`}
      data-adjustment-id={adjustment.id}
      role="button"
      tabIndex={0}
      aria-label={`${adjustment.name}, adjustment layer`}
      aria-pressed={selected}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Control+D S Delete"
      title="Adjustment layer — drag to move, drag edges to trim, S splits at playhead"
      style={{
        transform: `translateX(${frameToTimelineLocalPx(visibleStart, timelineOriginFrame, zoom)}px)`,
        width: Math.max(1, (visibleEnd - visibleStart) * zoom),
      }}
      onPointerDown={(event) => beginGesture(event, 'move')}
      onPointerMove={(event) => {
        const session = sessionRef.current
        if (!session || session.pointerId !== event.pointerId) return
        const raw = Math.round((event.clientX - session.startClientX) / zoom)
        const next = Math.max(session.minDelta, Math.min(session.maxDelta, raw))
        session.lastDelta = next
        schedulePreview(next)
      }}
      onPointerUp={(event) => endGesture(event, true)}
      onPointerCancel={(event) => endGesture(event, false)}
      onLostPointerCapture={(event) => endGesture(event, false)}
      onKeyDown={onKeyDown}
    >
      <div
        className="adjustment-edge adjustment-edge-start"
        data-testid={`adjustment-${adjustment.id}-edge-start`}
        onPointerDown={(event) => beginGesture(event, 'trim-start')}
      />
      <span className="adjustment-name">{adjustment.name}</span>
      <span className="adjustment-badge" aria-hidden="true">FX</span>
      <div
        className="adjustment-edge adjustment-edge-end"
        data-testid={`adjustment-${adjustment.id}-edge-end`}
        onPointerDown={(event) => beginGesture(event, 'trim-end')}
      />
    </div>
  )
}

export default memo(AdjustmentView)
