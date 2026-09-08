import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { animationCurvePoints, animationLaneKey, type AnimationLaneRow } from '../../state/animationEditor'
import { useTransportStore } from '../../state/transportStore'
import type { ClipAnimationEasing } from '../../domain/schema'
import { animationEditorController } from '../../app/animationEditorController'
import { animationCommandResult } from '../../app/animationWorkspaceController'

export default function AnimationCurve({ row, frame, start, end, width, height }: { row: AnimationLaneRow | undefined; frame: number | null; start: number; end: number; width: number; height: number }) {
  const [scale, setScale] = useState(1), [pan, setPan] = useState(0)
  const gesture = useRef<ReturnType<typeof animationEditorController.begin> | null>(null)
  const preview = useTransportStore((state) => state.animationPreview)
  const draft = preview?.selection?.some((key) => key.frame === frame && animationLaneKey(key.lane) === row?.id) ? preview.easing : undefined
  const keyIndex = frame === null ? -1 : row?.frames.indexOf(frame) ?? -1
  const key = row?.track?.keyframes[keyIndex], next = row?.track?.keyframes[keyIndex + 1]
  const scalarKey = key && typeof key.value === 'number' ? key : null
  const scalarNext = next && typeof next.value === 'number' ? next : null
  const viewRow = useMemo(() => {
    if (!row || !draft || !row.track || keyIndex < 0) return row
    return { ...row, track: { ...row.track, keyframes: row.track.keyframes.map((key, index) => index === keyIndex ? { ...key, easing: draft } : key) } } as AnimationLaneRow
  }, [row, draft, keyIndex])
  const samples = useMemo(() => viewRow ? animationCurvePoints(viewRow, start, end) : { points: [], dense: false }, [viewRow, start, end])
  const bounds = useMemo(() => {
    const values = row?.track?.keyframes.flatMap((key) => typeof key.value === 'number' ? [key.value] : []) ?? []
    if (row?.scalar.status === 'available') values.push(row.scalar.fallback)
    const minimum = values.length ? Math.min(...values) : 0, maximum = values.length ? Math.max(...values) : 1
    const span = Math.max(maximum - minimum, Math.max(1, Math.abs(minimum)) * .1)
    return { center: (minimum + maximum) / 2, span: span * 1.2 }
  }, [row])
  useEffect(() => { setScale(1); setPan(0) }, [row?.id])
  useEffect(() => () => { gesture.current?.cancel() }, [row, start, end, scale, pan])
  const innerHeight = Math.max(1, height - 44), visibleSpan = bounds.span / scale, center = bounds.center + pan
  const x = (frame: number) => (frame - start) / Math.max(1e-9, end - start) * width
  const y = (value: number) => 28 + (center + visibleSpan / 2 - value) / visibleSpan * innerHeight
  const path = samples.points.map((point) => `${point.move ? 'M' : 'L'} ${x(point.frame).toFixed(3)} ${y(point.value).toFixed(3)}`).join(' ')
  const easing = draft ?? key?.easing
  const pointer = useRef<{ id: number; handle: '1' | '2'; rect: DOMRect; easing: Extract<ClipAnimationEasing, { type: 'cubic-bezier' }> } | null>(null)
  function handleValue(event: PointerEvent<SVGCircleElement>): ClipAnimationEasing | null {
    const active = pointer.current
    if (!active || !scalarKey || !scalarNext || !row) return null
    const span = scalarNext.frame - scalarKey.frame, values = scalarNext.value as number - (scalarKey.value as number)
    const localX = event.clientX - active.rect.left, localY = event.clientY - active.rect.top
    const progressX = ((start + localX / width * (end - start)) - row.owner.item.timelineRange.startFrame - scalarKey.frame) / span
    const value = center + visibleSpan / 2 - (localY - 28) / innerHeight * visibleSpan
    const progressY = values === 0 ? active.easing[active.handle === '1' ? 'y1' : 'y2'] : (value - (scalarKey.value as number)) / values
    return { ...active.easing, [`x${active.handle}`]: Math.max(0, Math.min(1, progressX)), [`y${active.handle}`]: Math.max(0, Math.min(1, progressY)) }
  }
  return <div className="animation-curve-view">
    <div className="animation-curve-actions"><span>{row?.scalar.status === 'available' ? row.scalar.spec.unit : 'Choose an available scalar lane'}</span>
      <button type="button" aria-label="Vertical zoom in" onClick={() => setScale((value) => Math.min(1000, value * 1.25))}>Y+</button>
      <button type="button" aria-label="Vertical zoom out" onClick={() => setScale((value) => Math.max(.001, value / 1.25))}>Y−</button>
      <button type="button" aria-label="Pan curve up" onClick={() => setPan((value) => value + visibleSpan / 4)}>↑</button>
      <button type="button" aria-label="Pan curve down" onClick={() => setPan((value) => value - visibleSpan / 4)}>↓</button>
      <button type="button" onClick={() => { setScale(1); setPan(0) }}>Fit values</button></div>
    <svg width={width} height={height} role="img" aria-label={`${row?.label ?? 'Animation'} scalar curve`} data-curve-samples={samples.points.length}>
      <line x1={0} x2={width} y1={y(center)} y2={y(center)} className="animation-axis" />
      <path d={path} className="animation-curve-path" fill="none" />
      {row?.status === 'scalar' && !row.owner.track.locked && scalarKey && scalarNext && easing?.type === 'cubic-bezier' && (['1', '2'] as const).map((handle) => {
        const frame = row.owner.item.timelineRange.startFrame + scalarKey.frame + (scalarNext.frame - scalarKey.frame) * easing[handle === '1' ? 'x1' : 'x2']
        const value = (scalarKey.value as number) + ((scalarNext.value as number) - (scalarKey.value as number)) * easing[handle === '1' ? 'y1' : 'y2']
        return <circle key={handle} cx={x(frame)} cy={y(value)} r={6} className="animation-bezier-handle" role="button" aria-label={`Drag Bézier handle ${handle}; numeric alternatives in key controls`} tabIndex={-1}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault(); event.stopPropagation()
            const target = event.currentTarget, id = event.pointerId
            try {
              gesture.current?.cancel()
              gesture.current = animationEditorController.begin(() => { gesture.current = null; pointer.current = null; if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id) })
              pointer.current = { id, handle, rect: target.ownerSVGElement!.getBoundingClientRect(), easing }
              target.setPointerCapture?.(id)
            } catch (cause) { animationCommandResult(cause instanceof Error ? cause.message : 'Cannot edit this handle.', '') }
          }}
          onPointerMove={(event) => { if (pointer.current?.id !== event.pointerId) return; const next = handleValue(event); if (next) gesture.current?.preview({ kind: 'set-easing', easing: next }) }}
          onPointerUp={(event) => { if (pointer.current?.id !== event.pointerId) return; const next = handleValue(event); if (next && gesture.current) animationCommandResult(gesture.current.commit({ kind: 'set-easing', easing: next }), 'Bézier handles updated.') }}
          onPointerCancel={() => gesture.current?.cancel()} onLostPointerCapture={() => gesture.current?.cancel()} />
      })}
    </svg>
    {samples.dense && <small className="animation-dense-note">Dense curve: zoom in for individual transitions. Exact key navigation stays available.</small>}
  </div>
}
