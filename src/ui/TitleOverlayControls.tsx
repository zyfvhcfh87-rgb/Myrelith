import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useTitleEditorStore, readTitleDefinition, readTitleElement, titleElementBounds, resolveTitleElementAnimation } from '../state/titleEditorStore'
import type { TitleEditCommand } from '../domain/titleEditing'
import { beginTitleEdit, commitTitleEdit, type TitleEditSession } from '../app/titleEditingController'
import { readMaskEditorViewport, sameMaskEditorViewport, type MaskEditorViewport } from './maskMonitorViewport'
import './titleEditor.css'
interface Gesture { readonly pointer: number; readonly startX: number; readonly startY: number; readonly viewport: MaskEditorViewport; readonly session: TitleEditSession; readonly command: Extract<TitleEditCommand, { kind: 'gesture' }>; readonly element: HTMLButtonElement; latest: Extract<TitleEditCommand, { kind: 'gesture' }>; release(): void }
export default function TitleOverlayControls({ canvasRef, panelRef }: { canvasRef: RefObject<HTMLCanvasElement | null>; panelRef: RefObject<HTMLDivElement | null> }) {
  const doc = useDocumentStore((state) => state.doc), generation = useDocumentStore((state) => state.projectGeneration)
  const selectedClipId = useTransportStore((state) => state.selectedClipId), frame = useTransportStore((state) => state.playheadFrame), playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const preview = useTransportStore((state) => state.effectDocumentPreview)
  const ids = useTitleEditorStore((state) => state.ids), selectionClip = useTitleEditorStore((state) => state.clipId), guides = useTitleEditorStore((state) => state.safeGuides)
  const [viewport, setViewport] = useState<MaskEditorViewport | null>(null), [error, setError] = useState('')
  const viewportRef = useRef<MaskEditorViewport | null>(null), gesture = useRef<Gesture | null>(null), raf = useRef<number | null>(null)
  const cancel = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    const old = gesture.current; gesture.current = null
    old?.release(); old?.session.cancel()
    if (old?.element.hasPointerCapture?.(old.pointer)) old.element.releasePointerCapture(old.pointer)
  }, [])
  useEffect(() => { cancel(); return cancel }, [cancel, doc, generation, selectedClipId, frame, playing])
  useEffect(() => {
    const measure = () => {
      const next = readMaskEditorViewport(canvasRef.current, panelRef.current)
      if (!sameMaskEditorViewport(next, viewportRef.current)) { cancel(); viewportRef.current = next; setViewport(next) }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (canvasRef.current) observer?.observe(canvasRef.current)
    if (panelRef.current) observer?.observe(panelRef.current)
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); cancel() }
  }, [cancel, canvasRef, panelRef])
  const shown = preview?.sequenceId === doc.id ? preview.document : doc
  const track = shown.tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId)), clip = track?.clips.find((clip) => clip.id === selectedClipId)
  const parsed = clip?.title ? readTitleDefinition(clip.title) : null
  const visible = !!clip && !!track && !track.hidden && !playing && frame >= clip.timelineRange.startFrame && frame < clip.timelineRange.startFrame + clip.timelineRange.durationFrames
  function start(event: ReactPointerEvent<HTMLButtonElement>, id: string, mode: 'move' | 'resize') {
    if (event.button !== 0 || !clip || !track || track.locked) return
    event.preventDefault(); event.stopPropagation(); cancel(); setError('')
    const measured = readMaskEditorViewport(canvasRef.current, panelRef.current)
    if (!measured) return
    const selected = mode === 'move' && selectionClip === clip.id && ids.includes(id) ? ids : [id]
    if (selected !== ids || selectionClip !== clip.id) useTitleEditorStore.getState().select(clip.id, selected)
    try {
      const session = beginTitleEdit({ sequenceId: doc.id, clipId: clip.id })
      const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }
      const interrupted = (event: PointerEvent) => { if (gesture.current?.pointer === event.pointerId) cancel() }
      const command: Extract<TitleEditCommand, { kind: 'gesture' }> = { kind: 'gesture', ids: selected, mode, dx: 0, dy: 0, frame: frame - clip.timelineRange.startFrame }
      gesture.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, viewport: measured, session, command, latest: command, element: event.currentTarget,
        release: () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', interrupted); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true) } }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', interrupted); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true)
      event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch (cause) { cancel(); setError(String(cause)) }
  }
  function update(event: PointerEvent): Gesture | null {
    const active = gesture.current
    if (!active || event.pointerId !== active.pointer) return null
    if (!sameMaskEditorViewport(active.viewport, readMaskEditorViewport(canvasRef.current, panelRef.current))) { cancel(); return null }
    active.latest = { ...active.command, dx: (event.clientX - active.startX) * doc.width / active.viewport.canvas.width, dy: (event.clientY - active.startY) * doc.height / active.viewport.canvas.height }
    return active
  }
  function move(event: PointerEvent) {
    if (!update(event) || raf.current !== null) return
    raf.current = requestAnimationFrame(() => { raf.current = null; const active = gesture.current; if (active) { const error = active.session.preview(active.latest); if (error) { setError(error); cancel() } } })
  }
  function lostCapture(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = gesture.current
    if (active?.pointer === event.pointerId && active.element === event.currentTarget) cancel()
  }
  function finish(event: PointerEvent) {
    const active = update(event)
    if (!active) return
    if (active.latest.dx === 0 && active.latest.dy === 0) { cancel(); return }
    active.release(); gesture.current = null
    if (raf.current !== null) cancelAnimationFrame(raf.current); raf.current = null
    const failure = active.session.commit(active.latest)
    if (active.element.hasPointerCapture?.(active.pointer)) active.element.releasePointerCapture(active.pointer)
    setError(failure ?? '')
  }
  if (!viewport) return null
  const sx = viewport.canvas.width / doc.width, sy = viewport.canvas.height / doc.height
  const left = viewport.canvas.left - viewport.panelLeft, top = viewport.canvas.top - viewport.panelTop
  return <div className="title-canvas-controls" aria-label="Title canvas controls">
    {guides && [0.9, 0.95].map((ratio) => <div key={ratio} className="title-safe-guide" data-testid={`title-safe-${ratio}`} aria-hidden="true" style={{ left: left + doc.width * (1 - ratio) / 2 * sx, top: top + doc.height * (1 - ratio) / 2 * sy, width: doc.width * ratio * sx, height: doc.height * ratio * sy }} />)}
    {visible && parsed?.status === 'supported' && parsed.title.elements.map((intent) => {
      const parsed = readTitleElement(intent)
      if (parsed.status !== 'supported' || !parsed.element.enabled) return null
      const resolved = resolveTitleElementAnimation(parsed.element, clip!.animation?.titleTracks ?? [], frame - clip!.timelineRange.startFrame)
      if (resolved.unavailable.length || resolved.element.opacity === 0) return null
      let bounds: ReturnType<typeof titleElementBounds>
      try { bounds = titleElementBounds(resolved.element, doc) } catch { return null }
      const selected = selectionClip === clip!.id && ids.includes(intent.id), corner = bounds.points[2]
      return <div key={intent.id}>
        <button type="button" className="title-canvas-element" aria-label={`Move title element ${intent.name}`} aria-pressed={selected} disabled={track!.locked}
          style={{ left: left + bounds.left * sx, top: top + bounds.top * sy, width: (bounds.right - bounds.left) * sx, height: (bounds.bottom - bounds.top) * sy, opacity: selected ? 1 : 0.45 }}
          onPointerDown={(event) => start(event, intent.id, 'move')}
          onLostPointerCapture={lostCapture}
          onClick={() => { if (!ids.includes(intent.id)) useTitleEditorStore.getState().select(clip!.id, [intent.id]) }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault(); event.stopPropagation()
            const amount = event.shiftKey ? 10 : 1
            setError(commitTitleEdit({ sequenceId: doc.id, clipId: clip!.id }, { kind: 'gesture', ids: selected ? ids : [intent.id], mode: 'move', frame: frame - clip!.timelineRange.startFrame,
              dx: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0 }) ?? '')
          }} />
        {selected && ids.length === 1 && <button type="button" className="title-canvas-resize" aria-label={`Resize title element ${intent.name}`} disabled={track!.locked} style={{ left: left + corner.x * sx - 5, top: top + corner.y * sy - 5 }} onPointerDown={(event) => start(event, intent.id, 'resize')} onLostPointerCapture={lostCapture} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const amount = event.shiftKey ? 10 : 1
          setError(commitTitleEdit({ sequenceId: doc.id, clipId: clip!.id }, { kind: 'gesture', ids: [intent.id], mode: 'resize', frame: frame - clip!.timelineRange.startFrame,
            dx: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0 }) ?? '')
        }} />}
      </div>
    })}
    {error && <p role="alert" className="title-canvas-error">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></p>}
  </div>
}
