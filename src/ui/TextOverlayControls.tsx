import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { Clip, TextProps, TimelineDoc, Transform } from '../domain/schema'
import { rangeEnd } from '../domain/time'
import { TEXT_OVERLAY_LIMITS } from '../domain/textOverlay'
import { useDocumentStore } from '../state/documentStore'
import {
  useTransportStore,
  type TextOverlayPreview,
} from '../state/transportStore'

interface Viewport {
  left: number
  top: number
  width: number
  height: number
}

interface Gesture {
  clipId: string
  document: TimelineDoc
  kind: 'move' | 'resize'
  startClientX: number
  startClientY: number
  viewport: Viewport
  transform: Transform
  text: TextProps
  latest: TextOverlayPreview
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function measureViewport(
  canvas: HTMLCanvasElement | null,
  panel: HTMLDivElement | null,
): Viewport | null {
  if (!canvas || !panel) return null
  const canvasRect = canvas.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return null
  return {
    left: canvasRect.left - panelRect.left,
    top: canvasRect.top - panelRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
  }
}

function overlayAtFrame(doc: TimelineDoc, frame: number): Array<{ clip: Clip; locked: boolean }> {
  const overlays: Array<{ clip: Clip; locked: boolean }> = []
  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (
        clip.text
        && clip.opacity > 0
        && frame >= clip.timelineRange.startFrame
        && frame < rangeEnd(clip.timelineRange)
      ) overlays.push({ clip, locked: track.locked })
    }
  }
  return overlays
}

export default function TextOverlayControls({
  canvasRef,
  panelRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  panelRef: RefObject<HTMLDivElement | null>
}) {
  const doc = useDocumentStore((state) => state.doc)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const selectedClipId = useTransportStore((state) => state.selectedClipId)
  const draft = useTransportStore((state) => state.textOverlayPreview)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const previewFrameRef = useRef<number | null>(null)
  const pendingPreviewRef = useRef<TextOverlayPreview | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const panel = panelRef.current
    if (!canvas || !panel) return
    const measure = (): void => {
      setViewport(measureViewport(canvas, panel))
    }
    measure()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null
    observer?.observe(canvas)
    observer?.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [canvasRef, panelRef, doc.width, doc.height])

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current)
    useTransportStore.getState().setTextOverlayPreview(null)
  }, [])

  const publishPreview = (preview: TextOverlayPreview): void => {
    pendingPreviewRef.current = preview
    if (previewFrameRef.current !== null) return
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null
      const pending = pendingPreviewRef.current
      if (pending) useTransportStore.getState().setTextOverlayPreview(pending)
    })
  }

  const flushPreview = (): void => {
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    const pending = pendingPreviewRef.current
    if (pending) useTransportStore.getState().setTextOverlayPreview(pending)
  }

  const startGesture = (
    event: PointerEvent<HTMLButtonElement>,
    clip: Clip,
    kind: Gesture['kind'],
    locked: boolean,
  ): void => {
    useTransportStore.getState().setSelectedClip(clip.id)
    const measured = measureViewport(canvasRef.current, panelRef.current)
    if (locked || !clip.text || !measured) return
    setViewport(measured)
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const latest: TextOverlayPreview = {
      clipId: clip.id,
      transform: { ...clip.transform },
      text: { ...clip.text },
    }
    gestureRef.current = {
      clipId: clip.id,
      document: doc,
      kind,
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewport: measured,
      transform: { ...clip.transform },
      text: { ...clip.text },
      latest,
    }
    pendingPreviewRef.current = latest
  }

  const moveGesture = (event: PointerEvent<HTMLButtonElement>): void => {
    const gesture = gestureRef.current
    if (!gesture) return
    const dx = (event.clientX - gesture.startClientX)
      * gesture.document.width / gesture.viewport.width
    const dy = (event.clientY - gesture.startClientY)
      * gesture.document.height / gesture.viewport.height
    let preview: TextOverlayPreview
    if (gesture.kind === 'move') {
      preview = {
        clipId: gesture.clipId,
        transform: {
          ...gesture.transform,
          x: gesture.transform.x + dx,
          y: gesture.transform.y + dy,
        },
        text: { ...gesture.text },
      }
    } else {
      const angle = gesture.transform.rotation * Math.PI / 180
      const localX = (Math.cos(angle) * dx + Math.sin(angle) * dy)
        / Math.max(Math.abs(gesture.transform.scaleX), 0.0001)
      const localY = (-Math.sin(angle) * dx + Math.cos(angle) * dy)
        / Math.max(Math.abs(gesture.transform.scaleY), 0.0001)
      const minimum = Math.max(
        TEXT_OVERLAY_LIMITS.minBoxSizePx,
        gesture.text.paddingPx * 2 + 1,
      )
      preview = {
        clipId: gesture.clipId,
        transform: { ...gesture.transform },
        text: {
          ...gesture.text,
          boxWidthPx: clamp(
            gesture.text.boxWidthPx + localX,
            minimum,
            TEXT_OVERLAY_LIMITS.maxBoxSizePx,
          ),
          boxHeightPx: clamp(
            gesture.text.boxHeightPx + localY,
            minimum,
            TEXT_OVERLAY_LIMITS.maxBoxSizePx,
          ),
        },
      }
    }
    gesture.latest = preview
    publishPreview(preview)
  }

  const finishGesture = (event: PointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const gesture = gestureRef.current
    if (!gesture) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    flushPreview()
    gestureRef.current = null
    pendingPreviewRef.current = null
    const latestDoc = useDocumentStore.getState().doc
    if (commit && latestDoc === gesture.document) {
      if (gesture.kind === 'move' && gesture.latest.transform) {
        useDocumentStore.getState().updateClipTransform(gesture.clipId, {
          transform: gesture.latest.transform,
        })
      } else if (gesture.kind === 'resize' && gesture.latest.text) {
        useDocumentStore.getState().updateTextClip(gesture.clipId, {
          boxWidthPx: gesture.latest.text.boxWidthPx,
          boxHeightPx: gesture.latest.text.boxHeightPx,
        })
      }
    }
    useTransportStore.getState().setTextOverlayPreview(null)
  }

  const keyboardMove = (event: KeyboardEvent<HTMLButtonElement>, clip: Clip, locked: boolean): void => {
    if (locked || !event.key.startsWith('Arrow')) return
    const amount = event.shiftKey ? 10 : 1
    const deltaX = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    const deltaY = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    useDocumentStore.getState().updateClipTransform(clip.id, {
      transform: { x: clip.transform.x + deltaX, y: clip.transform.y + deltaY },
    })
  }

  const keyboardResize = (event: KeyboardEvent<HTMLButtonElement>, clip: Clip, locked: boolean): void => {
    if (locked || !clip.text || !event.key.startsWith('Arrow')) return
    const amount = event.shiftKey ? 10 : 1
    const minimum = Math.max(TEXT_OVERLAY_LIMITS.minBoxSizePx, clip.text.paddingPx * 2 + 1)
    const width = clamp(
      clip.text.boxWidthPx + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0),
      minimum,
      TEXT_OVERLAY_LIMITS.maxBoxSizePx,
    )
    const height = clamp(
      clip.text.boxHeightPx + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0),
      minimum,
      TEXT_OVERLAY_LIMITS.maxBoxSizePx,
    )
    if (width === clip.text.boxWidthPx && height === clip.text.boxHeightPx) return
    event.preventDefault()
    useDocumentStore.getState().updateTextClip(clip.id, { boxWidthPx: width, boxHeightPx: height })
  }

  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null
  const scaleX = viewport.width / doc.width
  const scaleY = viewport.height / doc.height

  return (
    <div className="text-overlay-controls" aria-label="Text overlay canvas controls">
      <span id="text-overlay-control-help" className="visually-hidden">
        Use arrow keys to move one pixel. Hold Shift to move ten pixels. Use the resize handle arrow keys to change the text box.
      </span>
      {overlayAtFrame(doc, playheadFrame).map(({ clip: committedClip, locked }) => {
        const preview = draft?.clipId === committedClip.id ? draft : null
        const transform = preview?.transform ?? committedClip.transform
        const text = preview?.text ?? committedClip.text
        if (!text) return null
        const selected = selectedClipId === committedClip.id
        const style: CSSProperties = {
          left: viewport.left + ((doc.width - text.boxWidthPx) / 2 + transform.x) * scaleX,
          top: viewport.top + ((doc.height - text.boxHeightPx) / 2 + transform.y) * scaleY,
          width: text.boxWidthPx * scaleX,
          height: text.boxHeightPx * scaleY,
          transform: `rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`,
          transformOrigin: `${transform.anchorX * 100}% ${transform.anchorY * 100}%`,
        }
        return (
          <div
            key={committedClip.id}
            className="text-overlay-control"
            data-selected={selected ? 'true' : 'false'}
            data-locked={locked ? 'true' : 'false'}
            style={style}
          >
            <button
              type="button"
              className="text-overlay-control-body"
              aria-label={`${selected ? 'Selected ' : ''}text overlay: ${committedClip.name}`}
              aria-pressed={selected}
              aria-disabled={locked}
              aria-describedby="text-overlay-control-help"
              onClick={() => useTransportStore.getState().setSelectedClip(committedClip.id)}
              onPointerDown={(event) => startGesture(event, committedClip, 'move', locked)}
              onPointerMove={moveGesture}
              onPointerUp={(event) => finishGesture(event, true)}
              onPointerCancel={(event) => finishGesture(event, false)}
              onKeyDown={(event) => keyboardMove(event, committedClip, locked)}
            />
            {selected && (
              <button
                type="button"
                className="text-overlay-resize-handle"
                aria-label={`Resize text overlay: ${committedClip.name}`}
                aria-disabled={locked}
                aria-describedby="text-overlay-control-help"
                onPointerDown={(event) => startGesture(event, committedClip, 'resize', locked)}
                onPointerMove={moveGesture}
                onPointerUp={(event) => finishGesture(event, true)}
                onPointerCancel={(event) => finishGesture(event, false)}
                onKeyDown={(event) => keyboardResize(event, committedClip, locked)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
