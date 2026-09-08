import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { beginMaskEdit, commitMaskParams, type MaskEditSession } from '../app/maskEditingController'
import { focusProgramMonitor } from '../app/sequenceEditController'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { editMaskBezierPath, maskEditingTarget, maskPathPartPoint, maskPointToProject, monitorPointToProject, moveMaskBox, parseMaskBezierPath, projectPointToMonitor, resizeMaskBox, type MaskBoxCorner, type MaskEditPatch, type MaskMonitorViewport, type MaskPathPart } from '../state/maskEditor'
import type { MaskParams } from '../domain/effectStack'

type Handle = { kind: 'move' } | { kind: 'resize'; corner: MaskBoxCorner } | { kind: 'point'; part: MaskPathPart }
interface Viewport { canvas: MaskMonitorViewport; panelLeft: number; panelTop: number }
interface Gesture {
  pointerId: number
  session: MaskEditSession
  element: HTMLButtonElement
  handle: Handle
  base: MaskParams
  start: { x: number; y: number }
  viewport: Viewport
  latest: MaskEditPatch
  disposeEvents(): void
}
const corners: readonly MaskBoxCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const partKey = (part: MaskPathPart) => part.kind === 'anchor' ? `anchor:${part.index}` : `control:${part.segment}:${part.control}`
const partLabel = (part: MaskPathPart) => part.kind === 'anchor' ? `Point ${part.index + 1}` : `Control ${part.segment + 1}.${part.control}`

export default function MaskOverlayControls({ canvasRef, panelRef }: { canvasRef: RefObject<HTMLCanvasElement | null>; panelRef: RefObject<HTMLDivElement | null> }) {
  const doc = useDocumentStore((state) => state.doc)
  const target = useTransportStore((state) => state.maskEditorTarget)
  const frame = useTransportStore((state) => state.playheadFrame)
  const selection = useTransportStore((state) => state.selectedClipId)
  const playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const [draft, setDraft] = useState<MaskParams | null>(null)
  const [error, setError] = useState('')
  const [part, setPart] = useState<MaskPathPart>({ kind: 'anchor', index: 0 })
  const [pointX, setPointX] = useState('0'), [pointY, setPointY] = useState('0')
  const gesture = useRef<Gesture | null>(null)
  const raf = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    const old = gesture.current
    gesture.current = null
    old?.disposeEvents()
    old?.session.cancel()
    if (old?.element.hasPointerCapture?.(old.pointerId)) old.element.releasePointerCapture(old.pointerId)
    setDraft(null)
  }, [])

  useEffect(() => {
    cancel()
    if (target && (target.sequenceId !== doc.id || target.clipId !== selection)) useTransportStore.getState().setMaskEditorTarget(null)
    return cancel
  }, [cancel, doc, frame, playing, selection, target])

  useEffect(() => {
    if (!target) return
    const measure = () => {
      const canvas = canvasRef.current?.getBoundingClientRect(), panel = panelRef.current?.getBoundingClientRect()
      const next = canvas && panel && canvas.width > 0 && canvas.height > 0
        ? { canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height }, panelLeft: panel.left, panelTop: panel.top } : null
      if (JSON.stringify(next) !== JSON.stringify(viewportRef.current)) { cancel(); viewportRef.current = next; setViewport(next) }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (canvasRef.current) observer?.observe(canvasRef.current)
    if (panelRef.current) observer?.observe(panelRef.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); cancel() }
  }, [cancel, canvasRef, panelRef, target])

  let params: MaskParams | null = null, unavailable = ''
  if (target) {
    try { params = maskEditingTarget(doc, target, frame).params }
    catch (cause) { unavailable = cause instanceof Error ? cause.message : 'This mask is unavailable.' }
  }
  if (playing) unavailable = 'Pause playback before editing this mask.'
  const shown = draft ?? params
  const path = shown?.shape === 'bezier' ? parseMaskBezierPath(shown.path) : null
  const parts: MaskPathPart[] = path ? path.segments.flatMap((_segment, index): MaskPathPart[] => [
    { kind: 'anchor', index }, { kind: 'control', segment: index, control: 1 }, { kind: 'control', segment: index, control: 2 },
  ]) : []
  const selected = path ? maskPathPartPoint(path, part) : null
  const selectedX = selected?.x, selectedY = selected?.y
  const selectionMissing = !!path && !selected
  useEffect(() => {
    if (selectionMissing) setPart({ kind: 'anchor', index: 0 })
    if (selectedX !== undefined && selectedY !== undefined) { setPointX(String(selectedX * 100)); setPointY(String(selectedY * 100)) }
  }, [selectionMissing, selectedX, selectedY]) // Parts are ephemeral; topology changes reconcile selection.

  function patchFor(handle: Handle, base: MaskParams, delta: { x: number; y: number }): MaskEditPatch {
    if (handle.kind === 'move') return moveMaskBox(base, delta, doc)
    if (handle.kind === 'resize') return resizeMaskBox(base, handle.corner, delta, doc)
    const result = editMaskBezierPath(base.path, { kind: 'move-point', part: handle.part, delta: { x: delta.x / (base.width * doc.width), y: delta.y / (base.height * doc.height) } })
    if (!result.ok) throw new Error(result.reason)
    return { path: result.path }
  }

  function start(event: PointerEvent<HTMLButtonElement>, handle: Handle) {
    if (event.button !== 0 || !target || !shown || !viewport || unavailable) return
    event.preventDefault(); event.stopPropagation(); cancel(); setError('')
    event.currentTarget.focus(); focusProgramMonitor()
    if (handle.kind === 'point') setPart(handle.part)
    try {
      const session = beginMaskEdit(target)
      const interrupted = (event: globalThis.PointerEvent) => { if (gesture.current?.pointerId === event.pointerId) cancel() }
      const disposeEvents = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', interrupted)
        window.removeEventListener('blur', cancel)
      }
      gesture.current = { pointerId: event.pointerId, session, element: event.currentTarget, handle, base: shown, start: monitorPointToProject({ x: event.clientX, y: event.clientY }, viewport.canvas, doc), viewport, latest: {}, disposeEvents }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', interrupted)
      window.addEventListener('blur', cancel)
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* The explicit session remains authoritative. */ }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start mask editing.') }
  }

  function update(event: globalThis.PointerEvent): Gesture | null {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return null
    try {
      const point = monitorPointToProject({ x: event.clientX, y: event.clientY }, active.viewport.canvas, doc)
      active.latest = patchFor(active.handle, active.base, { x: point.x - active.start.x, y: point.y - active.start.y })
      return active
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid mask movement.'); cancel(); return null }
  }

  function move(event: globalThis.PointerEvent) {
    if (!update(event) || raf.current !== null) return
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      const active = gesture.current
      if (!active) return
      const failure = active.session.preview(active.latest)
      if (failure) { setError(failure); cancel() }
      else setDraft({ ...active.base, ...active.latest } as MaskParams)
    })
  }

  function finish(event: globalThis.PointerEvent) {
    const active = update(event)
    if (!active) return
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    gesture.current = null
    active.disposeEvents()
    const failure = active.session.commit(active.latest)
    if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    setDraft(null); setError(failure ?? '')
  }

  function keyboard(event: KeyboardEvent<HTMLButtonElement>, handle: Handle) {
    if (!target || !shown || unavailable || !event.key.startsWith('Arrow')) return
    event.preventDefault(); event.stopPropagation(); cancel()
    const step = event.shiftKey ? 10 : 1
    const delta = { x: event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0, y: event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0 }
    try { setError(commitMaskParams(target, patchFor(handle, shown, delta)) ?? '') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid mask movement.') }
  }

  function changePath(edit: Parameters<typeof editMaskBezierPath>[1]) {
    if (!target || !shown) return
    cancel()
    const result = editMaskBezierPath(shown.path, edit)
    if (!result.ok) { setError(result.reason); return }
    const failure = commitMaskParams(target, { path: result.path })
    setError(failure ?? '')
    if (!failure) setPart(result.selected)
  }

  function stop() {
    cancel(); useTransportStore.getState().setMaskEditorTarget(null)
    if (target) document.getElementById(`mask-editor-toggle-${target.effectId}`)?.focus()
  }

  if (!target) return null
  if (!shown || !viewport || unavailable) return <div className="mask-editor-toolbar" role="status">{unavailable || 'The Program canvas is not visible.'}<button onClick={stop}>Close mask editor</button></div>
  const displayPosition = (point: { x: number; y: number }) => {
    const client = projectPointToMonitor(maskPointToProject(point, shown, doc), viewport.canvas, doc)
    return { left: client.x - viewport.panelLeft, top: client.y - viewport.panelTop }
  }
  const handle = (label: string, value: Handle, point: { x: number; y: number }) => <button key={label} type="button"
    className={`mask-editor-handle ${value.kind === 'point' && value.part.kind === 'control' ? 'mask-editor-control' : ''}`}
    style={displayPosition(point)} aria-label={label}
    tabIndex={value.kind !== 'point' || partKey(value.part) === partKey(part) ? 0 : -1}
    onFocus={() => { if (value.kind === 'point') setPart(value.part) }}
    onPointerDown={(event) => start(event, value)}
    onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId) cancel() }} onKeyDown={(event) => keyboard(event, value)} />
  const x = shown.x * doc.width, y = shown.y * doc.height, width = shown.width * doc.width, height = shown.height * doc.height
  return <div className="mask-editor-overlay" aria-label="Direct mask editor" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (gesture.current) cancel(); else stop() }
  }}>
    <svg className="mask-editor-outline" style={{ left: viewport.canvas.left - viewport.panelLeft, top: viewport.canvas.top - viewport.panelTop, width: viewport.canvas.width, height: viewport.canvas.height }} viewBox={`0 0 ${doc.width} ${doc.height}`} aria-hidden="true">
      {shown.shape === 'rectangle' ? <rect x={x} y={y} width={width} height={height} /> : shown.shape === 'ellipse' ? <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} /> : <path d={shown.path} transform={`translate(${x} ${y}) scale(${width} ${height})`} vectorEffect="non-scaling-stroke" />}
    </svg>
    {handle('Move mask', { kind: 'move' }, { x: 0.5, y: 0.5 })}
    {corners.map((corner) => handle(`Resize mask ${corner}`, { kind: 'resize', corner }, { x: corner.endsWith('left') ? 0 : 1, y: corner.startsWith('top') ? 0 : 1 }))}
    {path && parts.map((point) => handle(`Mask ${partLabel(point).toLowerCase()}`, { kind: 'point', part: point }, maskPathPartPoint(path, point)!))}
    <div className="mask-editor-toolbar">
      <span>Mask · arrows move 1 px · Shift 10 px · Esc cancels</span>
      {path && <>
        <label>Mask point<select value={partKey(part)} onChange={(event) => { const next = parts.find((part) => partKey(part) === event.target.value); if (next) setPart(next) }}>{parts.map((part) => <option key={partKey(part)} value={partKey(part)}>{partLabel(part)}</option>)}</select></label>
        <form onSubmit={(event) => { event.preventDefault(); changePath({ kind: 'set-point', part, point: { x: pointX.trim() ? Number(pointX) / 100 : NaN, y: pointY.trim() ? Number(pointY) / 100 : NaN } }) }}>
          <label>Point X (%)<input type="number" min="0" max="100" step="any" value={pointX} onChange={(event) => setPointX(event.target.value)} /></label>
          <label>Point Y (%)<input type="number" min="0" max="100" step="any" value={pointY} onChange={(event) => setPointY(event.target.value)} /></label>
          <button type="submit">Set point</button>
        </form>
        <button type="button" disabled={path.segments.length >= 8} onClick={() => changePath({ kind: 'split-segment', segment: part.kind === 'anchor' ? part.index : part.segment })}>Add point</button>
        <button type="button" disabled={path.segments.length <= 1 || part.kind !== 'anchor'} onClick={() => { if (part.kind === 'anchor') changePath({ kind: 'delete-anchor', index: part.index }) }}>Delete point</button>
      </>}
      <button type="button" onClick={stop}>Close mask editor</button>
      {error && <span role="alert">{error}</span>}
    </div>
  </div>
}
