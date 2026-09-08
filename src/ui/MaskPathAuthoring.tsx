import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { beginMaskEdit, type MaskEditSession } from '../app/maskEditingController'
import { focusProgramMonitor } from '../app/sequenceEditController'
import { appendMaskBezierDraftPoint, closeMaskBezierDraft, maskPointToProject, MAX_MASK_BEZIER_SEGMENTS, monitorPointToProject, projectPointToMask, removeLastMaskBezierDraftPoint, type MaskEditTarget, type MaskPoint, type ParsedMaskPath } from '../state/maskEditor'
import type { MaskParams } from '../domain/effectStack'
import type { TimelineDoc } from '../domain/schema'

import { sameMaskEditorViewport, type MaskEditorViewport as Viewport } from './maskMonitorViewport'

/** An open path is only a bounded drawing draft; the existing mask stays rendered. */
export default function MaskPathAuthoring({ doc, target, mask, viewport, readViewport, toolbarHost, onFinish }: {
  doc: TimelineDoc
  target: MaskEditTarget
  mask: MaskParams
  viewport: Viewport
  readViewport(): Viewport | null
  toolbarHost?: HTMLDivElement | null
  onFinish(error: string | null): void
}) {
  const [origin] = useState(() => ({ doc, target, mask }))
  const pinnedViewport = useRef<Viewport | null>(null)
  const [draft, setDraft] = useState<ParsedMaskPath | null>(null)
  const draftRef = useRef<ParsedMaskPath | null>(null)
  const session = useRef<MaskEditSession | null>(null)
  const [error, setError] = useState('')
  const [nextX, setNextX] = useState('50'), [nextY, setNextY] = useState('50')

  useEffect(() => {
    let mounted = true
    try { session.current = beginMaskEdit(origin.target, () => { if (mounted) onFinish(null) }) }
    catch (cause) { onFinish(cause instanceof Error ? cause.message : 'Could not start this path.'); return }
    const cancel = () => session.current?.cancel()
    window.addEventListener('blur', cancel)
    return () => { mounted = false; window.removeEventListener('blur', cancel); cancel(); session.current = null }
  }, [origin, onFinish])

  const current = doc === origin.doc && target === origin.target
  useEffect(() => {
    if (!current || (pinnedViewport.current && !sameMaskEditorViewport(readViewport(), pinnedViewport.current))) session.current?.cancel()
  }, [current, viewport, readViewport])

  function currentViewport(): Viewport | null {
    const measured = readViewport()
    if (!current || !session.current || !measured || (pinnedViewport.current && !sameMaskEditorViewport(measured, pinnedViewport.current))) {
      session.current?.cancel(); return null
    }
    return measured
  }

  function add(point: MaskPoint) {
    const measured = currentViewport()
    if (!measured) return
    const result = appendMaskBezierDraftPoint(draftRef.current, point)
    if (!result.ok) { setError(result.reason); return }
    pinnedViewport.current ??= measured
    draftRef.current = result.draft; setDraft(result.draft); setError('')
    setNextX(String(point.x * 100)); setNextY(String(point.y * 100))
  }
  const numericPoint = () => ({ x: nextX.trim() ? Number(nextX) / 100 : NaN, y: nextY.trim() ? Number(nextY) / 100 : NaN })
  function place(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); focusProgramMonitor()
    // Keyboard activation uses the same numeric cursor as the accessible form.
    if (event.detail === 0) { add(numericPoint()); return }
    const measured = currentViewport()
    if (!measured) return
    try { add(projectPointToMask(monitorPointToProject({ x: event.clientX, y: event.clientY }, measured.canvas, origin.doc), origin.mask, origin.doc)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not place this point.') }
  }
  function remove() {
    if (!currentViewport()) return
    const result = removeLastMaskBezierDraftPoint(draftRef.current)
    if (!result.ok) { setError(result.reason); return }
    draftRef.current = result.draft; setDraft(result.draft); setError('')
  }
  function close() {
    const value = draftRef.current
    if (!currentViewport() || !session.current) return
    if (!value || value.segments.length < 2) { setError('Place at least three points before closing the new path.'); return }
    const result = closeMaskBezierDraft(value)
    if (!result.ok) { setError(result.reason); return }
    onFinish(session.current.commit({ shape: 'bezier', path: result.path }))
  }
  const points = draft ? [draft.start, ...draft.segments.map((segment) => segment.end)] : []
  const projected = points.map((point) => maskPointToProject(point, origin.mask, origin.doc))
  const canvasStyle = { left: viewport.canvas.left - viewport.panelLeft, top: viewport.canvas.top - viewport.panelTop, width: viewport.canvas.width, height: viewport.canvas.height }
  const toolbar = <div className="mask-editor-toolbar mask-path-authoring-toolbar" aria-label="New mask path controls">
    <span role="status">New path · {points.length}/8 points. Close replaces this mask in one undo step.</span>
    <span>Click inside the current mask box, or add coordinates below. Shape curves after closing.</span>
    <form onSubmit={(event) => { event.preventDefault(); add(numericPoint()) }}>
      <label>Next point X (%)<input type="number" min="0" max="100" step="any" value={nextX} onChange={(event) => setNextX(event.target.value)} /></label>
      <label>Next point Y (%)<input type="number" min="0" max="100" step="any" value={nextY} onChange={(event) => setNextY(event.target.value)} /></label>
      <button type="submit" disabled={points.length >= MAX_MASK_BEZIER_SEGMENTS}>Add draft point</button>
    </form>
    <button type="button" disabled={points.length === 0} onClick={remove}>Remove last draft point</button>
    <button type="button" disabled={points.length < 3} onClick={close}>Close path</button>
    <button type="button" onClick={() => session.current?.cancel()}>Cancel new path</button>
    {error && <span role="alert">{error}</span>}
  </div>
  return <div className="mask-editor-overlay" aria-label="Draw a new mask path" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); session.current?.cancel() }
  }}>
    <button type="button" className="mask-path-drawing-surface" style={canvasStyle} aria-label="Add mask path point in Program" onClick={place} onPointerCancel={() => session.current?.cancel()} />
    <svg className="mask-editor-outline mask-path-draft-outline" style={canvasStyle} viewBox={`0 0 ${doc.width} ${doc.height}`} aria-hidden="true">
      <rect className="mask-path-draft-box" x={origin.mask.x * doc.width} y={origin.mask.y * doc.height} width={origin.mask.width * doc.width} height={origin.mask.height * doc.height} />
      <polyline points={projected.map((point) => `${point.x},${point.y}`).join(' ')} />
      {projected.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={3 * doc.width / viewport.canvas.width} />)}
    </svg>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
  </div>
}
