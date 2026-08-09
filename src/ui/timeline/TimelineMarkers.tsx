import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, PointerEvent } from 'react'
import { flushSync } from 'react-dom'
import type {
  FrameRate,
  TimelineMarker,
  TimelineMarkerId,
} from '../../domain/schema'
import {
  createTimelineMarkerId,
  MAX_TIMELINE_MARKER_FRAME,
  MAX_TIMELINE_MARKER_LABEL_CHARACTERS,
  MAX_TIMELINE_MARKER_NOTE_CHARACTERS,
  TIMELINE_MARKER_COLORS,
} from '../../domain/timelineMarkers'
import { formatTimecode } from '../../domain/time'
import { executeEditorCommand } from '../../app/editorCommands'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { planTimelineMarkerClusters } from './timelineMarkerLayout'
import {
  measureTimelineLaneWidth,
  planTimelineAnchor,
} from './timelineViewport'

interface TimelineMarkersProps {
  readonly markers: readonly TimelineMarker[]
  readonly frameRate: FrameRate
  readonly totalFrames: number
  readonly originFrame: number
  readonly zoom: number
  readonly viewLeftPx: number
  readonly viewWidthPx: number
}

interface MarkerEditorProps {
  readonly marker: TimelineMarker
  readonly leftPx: number
  readonly frameRate: FrameRate
}

function stopPointer(event: PointerEvent<HTMLElement>): void {
  event.stopPropagation()
}

function MarkerEditor({ marker, leftPx, frameRate }: MarkerEditorProps) {
  const formRef = useRef<HTMLFormElement | null>(null)
  const [label, setLabel] = useState(marker.label)
  const [frame, setFrame] = useState(String(marker.frame))
  const [color, setColor] = useState(marker.color)
  const [note, setNote] = useState(marker.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const close = () => useTransportStore.getState().setEditingMarker(null)

  useEffect(() => {
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const save = (event: FormEvent): void => {
    event.preventDefault()
    const nextFrame = Number(frame)
    if (!Number.isSafeInteger(nextFrame) || nextFrame < 0 || nextFrame > MAX_TIMELINE_MARKER_FRAME) {
      setError(`Frame must be a whole number from 0 to ${MAX_TIMELINE_MARKER_FRAME}.`)
      return
    }
    if (label.trim().length === 0) {
      setError('Label cannot be empty.')
      return
    }
    useDocumentStore.getState().updateTimelineMarker(marker.id, {
      label,
      frame: nextFrame,
      color,
      note,
    })
    useTransportStore.getState().setPlayheadFrame(nextFrame)
    close()
  }

  const duplicate = (): void => {
    const document = useDocumentStore.getState()
    const duplicateId = createTimelineMarkerId(document.doc)
    document.duplicateTimelineMarker(marker.id, duplicateId)
    const transport = useTransportStore.getState()
    transport.setSelectedMarker(duplicateId)
    transport.setEditingMarker(duplicateId)
  }

  return (
    <form
      ref={formRef}
      className="timeline-marker-editor"
      style={{ transform: `translateX(${leftPx}px)` }}
      aria-label={`Edit marker ${marker.label}`}
      onSubmit={save}
      onPointerDown={stopPointer}
      onPointerMove={stopPointer}
      onPointerUp={stopPointer}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
        }
      }}
    >
      <div className="timeline-marker-editor-heading">
        <strong>Edit marker</strong>
        <span>{formatTimecode(marker.frame, frameRate)}</span>
      </div>
      <label>
        Label
        <input
          autoFocus
          value={label}
          maxLength={MAX_TIMELINE_MARKER_LABEL_CHARACTERS}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      <div className="timeline-marker-editor-row">
        <label>
          Frame
          <input
            type="number"
            min="0"
            max={MAX_TIMELINE_MARKER_FRAME}
            step="1"
            value={frame}
            onChange={(event) => setFrame(event.currentTarget.value)}
          />
        </label>
        <label>
          Color
          <select
            value={color}
            onChange={(event) => setColor(event.currentTarget.value as TimelineMarker['color'])}
          >
            {TIMELINE_MARKER_COLORS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Note
        <textarea
          value={note}
          maxLength={MAX_TIMELINE_MARKER_NOTE_CHARACTERS}
          rows={3}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      {error ? <p className="timeline-marker-editor-error" role="alert">{error}</p> : null}
      <div className="timeline-marker-editor-actions">
        <button type="submit">Save</button>
        <button type="button" onClick={duplicate}>Duplicate</button>
        <button
          type="button"
          className="danger"
          onClick={() => useDocumentStore.getState().deleteTimelineMarker(marker.id)}
        >
          Delete
        </button>
        <button type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  )
}

export default function TimelineMarkers({
  markers,
  frameRate,
  totalFrames,
  originFrame,
  zoom,
  viewLeftPx,
  viewWidthPx,
}: TimelineMarkersProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const previousSelectedRef = useRef<TimelineMarkerId | null>(null)
  const [edgeViewportPosition, setEdgeViewportPosition] = useState<{
    beforeLeft: number
    afterLeft: number
    top: number
  } | null>(null)
  const selectedMarkerId = useTransportStore((state) => state.selectedMarkerId)
  const editingMarkerId = useTransportStore((state) => state.editingMarkerId)
  const selected = selectedMarkerId
    ? markers.find((marker) => marker.id === selectedMarkerId) ?? null
    : null
  const editing = editingMarkerId
    ? markers.find((marker) => marker.id === editingMarkerId) ?? null
    : null
  const overscanPx = Math.max(32, viewWidthPx / 2)
  const clusters = useMemo(() => planTimelineMarkerClusters(
    markers,
    originFrame,
    zoom,
    Math.max(0, viewLeftPx - overscanPx),
    viewLeftPx + viewWidthPx + overscanPx,
    selectedMarkerId,
  ), [markers, originFrame, overscanPx, selectedMarkerId, viewLeftPx, viewWidthPx, zoom])

  useLayoutEffect(() => {
    const layer = rootRef.current
    const scroller = layer?.closest('[data-timeline-scroll]')
    const ruler = layer?.closest('.timeline-ruler')
    if (!(scroller instanceof HTMLElement) || !(ruler instanceof HTMLElement)) return
    const header = scroller.querySelector<HTMLElement>('[data-timeline-headers]')
    const scrollerRect = scroller.getBoundingClientRect()
    const rulerRect = ruler.getBoundingClientRect()
    const headerRight = header?.getBoundingClientRect().right ?? scrollerRect.left
    setEdgeViewportPosition({
      beforeLeft: headerRight + 4,
      afterLeft: scrollerRect.right - 24,
      top: rulerRect.top + 3,
    })
  }, [viewLeftPx, viewWidthPx])

  const reveal = (marker: TimelineMarker): void => {
    const scroller = rootRef.current?.closest('[data-timeline-scroll]')
    if (!(scroller instanceof HTMLElement)) return
    const transport = useTransportStore.getState()
    const plan = planTimelineAnchor(
      totalFrames,
      zoom,
      measureTimelineLaneWidth(scroller),
      marker.frame,
    )
    if (transport.timelineOriginFrame !== plan.originFrame) {
      flushSync(() => transport.setTimelineOriginFrame(plan.originFrame))
    }
    requestAnimationFrame(() => {
      const liveScroller = rootRef.current?.closest('[data-timeline-scroll]')
      if (liveScroller instanceof HTMLElement) liveScroller.scrollLeft = plan.scrollLeft
    })
  }

  useEffect(() => {
    if (selected && selected.id !== previousSelectedRef.current) {
      const visibleStart = originFrame + viewLeftPx / zoom
      const visibleEnd = visibleStart + viewWidthPx / zoom
      if (selected.frame < visibleStart || selected.frame > visibleEnd) reveal(selected)
    }
    previousSelectedRef.current = selected?.id ?? null
  })

  const selectMarker = (marker: TimelineMarker): void => {
    const transport = useTransportStore.getState()
    transport.setSelectedMarker(marker.id)
    transport.setPlayheadFrame(marker.frame)
  }

  const visibleStart = originFrame + viewLeftPx / zoom
  const visibleEnd = visibleStart + viewWidthPx / zoom
  const selectedDirection = selected
    ? selected.frame < visibleStart
      ? 'before'
      : selected.frame > visibleEnd
        ? 'after'
        : null
    : null
  const editorLeft = editing
    ? Math.max(
        viewLeftPx + 8,
        Math.min(
          viewLeftPx + Math.max(8, viewWidthPx - 292),
          (editing.frame - originFrame) * zoom - 8,
        ),
      )
    : 0

  return (
    <div ref={rootRef} className="timeline-marker-layer" aria-label="Timeline markers">
      {clusters.map((cluster) => {
        const selectedInCluster = cluster.markers.some(({ id }) => id === selectedMarkerId)
        const marker = selectedInCluster && selected
          ? selected
          : cluster.representative
        return (
          <button
            key={cluster.key}
            type="button"
            className={`timeline-marker timeline-marker-${marker.color}${selectedInCluster ? ' selected' : ''}`}
            style={{ transform: `translateX(${cluster.localPx}px)` }}
            aria-pressed={selectedInCluster}
            aria-label={`${marker.label}, ${formatTimecode(marker.frame, frameRate)}${cluster.markers.length > 1 ? `, ${cluster.markers.length} markers at this position` : ''}`}
            title={`${marker.label} · ${formatTimecode(marker.frame, frameRate)}${marker.note ? `\n${marker.note}` : ''}`}
            onPointerDown={stopPointer}
            onPointerMove={stopPointer}
            onPointerUp={stopPointer}
            onClick={() => {
              const currentIndex = cluster.markers.findIndex(({ id }) => id === selectedMarkerId)
              selectMarker(cluster.markers[(currentIndex + 1) % cluster.markers.length])
            }}
            onDoubleClick={() => useTransportStore.getState().setEditingMarker(marker.id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                selectMarker(marker)
                useTransportStore.getState().setEditingMarker(marker.id)
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault()
                useDocumentStore.getState().deleteTimelineMarker(marker.id)
              } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
                event.preventDefault()
                selectMarker(marker)
                executeEditorCommand('marker.duplicate')
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                executeEditorCommand('marker.previous')
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                executeEditorCommand('marker.next')
              }
            }}
          >
            <span aria-hidden="true" />
            {cluster.markers.length > 1
              ? <b aria-hidden="true">{cluster.markers.length}</b>
              : null}
          </button>
        )
      })}
      {selectedDirection && selected ? (
        <button
          type="button"
          className={`timeline-marker-offscreen timeline-marker-offscreen-${selectedDirection}`}
          style={edgeViewportPosition
            ? {
                position: 'fixed',
                left: selectedDirection === 'before'
                  ? edgeViewportPosition.beforeLeft
                  : edgeViewportPosition.afterLeft,
                top: edgeViewportPosition.top,
                transform: 'none',
              }
            : {
                transform: `translateX(${selectedDirection === 'before' ? viewLeftPx + 4 : viewLeftPx + viewWidthPx - 20}px)`,
              }}
          aria-label={`Selected marker ${selected.label} is ${selectedDirection} the visible timeline. Reveal it.`}
          onPointerDown={stopPointer}
          onPointerUp={stopPointer}
          onClick={() => reveal(selected)}
        >
          {selectedDirection === 'before' ? '‹' : '›'}
        </button>
      ) : null}
      {editing ? (
        <MarkerEditor
          key={editing.id}
          marker={editing}
          leftPx={editorLeft}
          frameRate={frameRate}
        />
      ) : null}
    </div>
  )
}
