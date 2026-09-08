import './colorGrading.css'
import { useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent } from 'react'
import type { EffectDescriptor } from '../domain/schema'
import {
  COLOR_LUT_TYPE, COLOR_CURVES_TYPE, COLOR_WHEELS_TYPE, COLOR_CURVE_CHANNELS, COLOR_CURVE_LIMITS,
  COLOR_WHEEL_GROUPS, COLOR_WHEEL_LIMITS, COLOR_RGB, colorCurvesParams, parseColorCurve, compileColorCurve,
  colorWheelsParams, colorWheelAtPosition, colorWheelBrightness, colorWheelPosition, isColorLutV1,
  effectParamsValidationError,
  type ColorCurve, type ColorCurveChannel, type ColorWheelGroup,
} from '../state/editorUi'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { beginColorGradingEdit, type ColorGradingEditSession, type ColorGradingPatch, type ColorGradingTarget } from '../app/colorGradingController'
import ColorLutPicker from './ColorLutPicker'

export function GradingNumber({ label, value, min, max, step = 0.01, disabled = false, onCommit, onBegin, onCancel }: {
  label: string; value: number; min: number; max: number; step?: number; disabled?: boolean
  onCommit(value: number): void; onBegin?(): void; onCancel?(): void
}) {
  const [draft, setDraft] = useState(String(value)), cancelled = useRef(false)
  useEffect(() => setDraft(String(value)), [value])
  return <label className="inspector-field grading-number"><span>{label}</span><input type="number" value={draft} min={min} max={max} step={step} disabled={disabled}
    onFocus={() => { cancelled.current = false; onBegin?.() }} onChange={(event) => setDraft(event.target.value)}
    onBlur={() => {
      const number = Number(draft)
      if (!cancelled.current && draft.trim() && Number.isFinite(number) && number >= min && number <= max) onCommit(number)
      else onCancel?.()
      cancelled.current = false; setDraft(String(value))
    }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraft(String(value)); event.currentTarget.blur() }
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    }} /></label>
}

function useGradingEdit(target: ColorGradingTarget, effectId: string) {
  const session = useRef<ColorGradingEditSession | null>(null), pending = useRef<ColorGradingPatch | null>(null), frame = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const stopFrame = () => { cancelAnimationFrame(frame.current); frame.current = 0; pending.current = null }
  const cancel = () => { stopFrame(); session.current?.cancel(); session.current = null }
  const targetKey = JSON.stringify(target)
  useEffect(() => cancel, [targetKey, effectId]) // Each mounted control owns only its own gesture.
  const begin = () => {
    cancel(); setError(null)
    try { session.current = beginColorGradingEdit(target, effectId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start grading.') }
  }
  const preview = (patch: ColorGradingPatch) => {
    pending.current = patch
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (pending.current && session.current) setError(session.current.preview(pending.current))
    })
  }
  const commit = (patch: ColorGradingPatch) => {
    stopFrame()
    if (!session.current) begin()
    const owner = session.current; session.current = null
    if (owner) setError(owner.commit(patch))
  }
  return { begin, preview, commit, cancel, error }
}

type Edit = ReturnType<typeof useGradingEdit>
type Animation = (parameter: string, value: number) => ReactNode
export default function ColorGradingFields({ target, effect, disabled, animation }: { target: ColorGradingTarget; effect: EffectDescriptor; disabled: boolean; animation?: Animation }) {
  const edit = useGradingEdit(target, effect.id)
  const preview = useTransportStore((state) => state.colorGradingPreview)
  const catalog = useDocumentStore((state) => state.project.colorLuts)
  if (effect.version !== 1 || ![COLOR_LUT_TYPE, COLOR_CURVES_TYPE, COLOR_WHEELS_TYPE].includes(effect.type)) return null
  const params = { ...effect.params, ...(preview?.effectId === effect.id && preview.sequenceId === target.sequenceId ? preview.params : {}) }
  const invalid = effectParamsValidationError({ ...effect, params })
  const table = catalog?.find((table) => table.id === params.lutId)
  return <div className="grading-fields" aria-label={`${effect.type === COLOR_LUT_TYPE ? 'LUT' : effect.type === COLOR_CURVES_TYPE ? 'RGB curves' : 'Color wheels'} controls`}>
    {effect.type === COLOR_LUT_TYPE && <>
      <p>{table ? String(table.name ?? table.id) : 'Embedded table is missing.'}</p>
      {table && isColorLutV1(table) && <p className="inspector-note">{table.kind.toUpperCase()} · {table.size}{table.kind === '3d' ? '³ · tetrahedral' : ' samples · linear'} · domain {table.domainMin.join(', ')} → {table.domainMax.join(', ')}</p>}
      <ColorLutPicker target={target} effectId={effect.id} disabled={disabled} />
    </>}
    {invalid ? <p role="status">{invalid} Reset restores valid defaults.</p> : <>
      {effect.type === COLOR_CURVES_TYPE && <CurveFields params={colorCurvesParams(params)} edit={edit} disabled={disabled} />}
      {effect.type === COLOR_WHEELS_TYPE && <WheelFields params={colorWheelsParams(params)} edit={edit} disabled={disabled} animation={animation} />}
      <GradingNumber label="Strength" value={Number(params.strength ?? 1)} min={0} max={1} disabled={disabled} onBegin={edit.begin} onCancel={edit.cancel} onCommit={(strength) => edit.commit({ strength })} />
      {animation?.('strength', Number(params.strength ?? 1))}
    </>}
    {edit.error && <p role="alert">{edit.error}</p>}
  </div>
}

function CurveFields({ params, edit, disabled }: { params: ReturnType<typeof colorCurvesParams>; edit: Edit; disabled: boolean }) {
  const [channel, setChannel] = useState<ColorCurveChannel>('master')
  const points = parseColorCurve(params[channel]), evaluate = compileColorCurve(points)
  const dragging = useRef<{ points: ColorCurve; index: number } | null>(null)
  const patch = (next: ColorCurve): ColorGradingPatch => ({ [channel]: JSON.stringify(next) })
  const move = (base: ColorCurve, index: number, x: number, y: number): ColorCurve => base.map((point, i) => i === index
    ? [index === 0 ? 0 : index === base.length - 1 ? 1 : Math.min(base[index + 1][0] - COLOR_CURVE_LIMITS.minimumGap, Math.max(base[index - 1][0] + COLOR_CURVE_LIMITS.minimumGap, x)), Math.min(1, Math.max(0, y))] : point)
  const pointer = (event: PointerEvent<SVGCircleElement>, commit = false) => {
    const drag = dragging.current
    if (!drag) return
    const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
    const next = patch(move(drag.points, drag.index, (event.clientX - box.left) / box.width, 1 - (event.clientY - box.top) / box.height))
    if (commit) { dragging.current = null; edit.commit(next) } else edit.preview(next)
  }
  const keyPoint = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    const step = event.shiftKey ? 0.1 : 0.01, delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key]
    if (event.key === 'Escape') { dragging.current = null; edit.cancel() }
    if (!delta || disabled) return
    event.preventDefault(); event.stopPropagation(); edit.begin()
    edit.commit(patch(move(points, index, points[index][0] + delta[0], points[index][1] + delta[1])))
  }
  return <div className="grading-curves">
    <label className="inspector-field"><span>Curve channel</span><select value={channel} disabled={disabled} onChange={(event) => { edit.cancel(); setChannel(event.target.value as ColorCurveChannel) }}>
      {COLOR_CURVE_CHANNELS.map((key) => <option key={key} value={key}>{key[0].toUpperCase() + key.slice(1)}</option>)}
    </select></label>
    <svg className={`grading-curve-graph is-${channel}`} viewBox="0 0 240 240" aria-label={`${channel} curve graph`}>
      <path d="M0 240L240 0 M0 180H240 M0 120H240 M0 60H240 M60 0V240 M120 0V240 M180 0V240" className="grading-curve-grid" />
      <path d={Array.from({ length: 129 }, (_, i) => `${i ? 'L' : 'M'}${i / 128 * 240},${(1 - evaluate(i / 128)) * 240}`).join(' ')} className="grading-curve-line" />
      {points.map(([x, y], index) => <circle key={index} cx={x * 240} cy={(1 - y) * 240} r="5" role="button" tabIndex={disabled ? -1 : 0}
        aria-label={`${channel} point ${index + 1}, input ${x.toFixed(3)}, output ${y.toFixed(3)}`} aria-disabled={disabled}
        onKeyDown={(event) => keyPoint(event, index)} onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = { points, index }; edit.begin()
        }} onPointerMove={(event) => pointer(event)} onPointerUp={(event) => pointer(event, true)}
        onPointerCancel={() => { dragging.current = null; edit.cancel() }} onLostPointerCapture={() => { if (dragging.current) { dragging.current = null; edit.cancel() } }} />)}
    </svg>
    <p className="inspector-note">Input → output, 0–1. Drag points or use arrow keys; Shift moves farther. Master runs before RGB channels.</p>
    <ol className="grading-point-list" aria-label={`${channel} curve points`}>
      {points.map(([x, y], index) => <li key={index}>
        <GradingNumber label={`Point ${index + 1} input`} value={x} min={index ? points[index - 1][0] + COLOR_CURVE_LIMITS.minimumGap : 0}
          max={index < points.length - 1 ? points[index + 1][0] - COLOR_CURVE_LIMITS.minimumGap : 1} disabled={disabled || index === 0 || index === points.length - 1}
          onBegin={edit.begin} onCancel={edit.cancel} onCommit={(value) => edit.commit(patch(move(points, index, value, y)))} />
        <GradingNumber label={`Point ${index + 1} output`} value={y} min={0} max={1} disabled={disabled} onBegin={edit.begin} onCancel={edit.cancel} onCommit={(value) => edit.commit(patch(move(points, index, x, value)))} />
        <button type="button" aria-label={`Remove point ${index + 1}`} disabled={disabled || index === 0 || index === points.length - 1} onClick={() => { edit.begin(); edit.commit(patch(points.filter((_, i) => i !== index))) }}>Remove</button>
      </li>)}
    </ol>
    <button type="button" disabled={disabled || points.length >= COLOR_CURVE_LIMITS.points} onClick={() => {
      let at = 0
      for (let i = 1; i < points.length - 1; i++) if (points[i + 1][0] - points[i][0] > points[at + 1][0] - points[at][0]) at = i
      const x = (points[at][0] + points[at + 1][0]) / 2
      edit.begin(); edit.commit(patch([...points.slice(0, at + 1), [x, evaluate(x)], ...points.slice(at + 1)]))
    }}>Add curve point</button>
  </div>
}

function WheelFields({ params, edit, disabled, animation }: { params: ReturnType<typeof colorWheelsParams>; edit: Edit; disabled: boolean; animation?: Animation }) {
  return <div className="grading-wheels">{COLOR_WHEEL_GROUPS.map((group) => <Wheel key={group} group={group} params={params} edit={edit} disabled={disabled} animation={animation} />)}</div>
}
function Wheel({ group, params, edit, disabled, animation }: { group: ColorWheelGroup; params: ReturnType<typeof colorWheelsParams>; edit: Edit; disabled: boolean; animation?: Animation }) {
  const values = COLOR_RGB.map((channel) => Number(params[`${group}${channel}`])) as [number, number, number]
  const position = colorWheelPosition(values, group), limit = COLOR_WHEEL_LIMITS[group], label = group[0].toUpperCase() + group.slice(1)
  const dragging = useRef<readonly [number, number, number] | null>(null)
  const patch = (values: readonly number[]) => Object.fromEntries(COLOR_RGB.map((channel, index) => [`${group}${channel}`, values[index]]))
  const pointer = (event: PointerEvent<HTMLDivElement>, commit = false) => {
    if (!dragging.current) return
    const box = event.currentTarget.getBoundingClientRect()
    const next = patch(colorWheelAtPosition(dragging.current, group, (event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2))
    if (commit) { dragging.current = null; edit.commit(next) } else edit.preview(next)
  }
  return <fieldset className="grading-wheel-group" disabled={disabled}><legend>{label}</legend>
    <div className="grading-wheel" role="slider" tabIndex={disabled ? -1 : 0} aria-label={`${label} hue wheel`} aria-valuemin={-1} aria-valuemax={1}
      aria-valuenow={position.x} aria-valuetext={`x ${position.x.toFixed(3)}, y ${position.y.toFixed(3)}; R ${values[0].toFixed(3)}, G ${values[1].toFixed(3)}, B ${values[2].toFixed(3)}`} aria-disabled={disabled}
      onPointerDown={(event) => { if (disabled) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); dragging.current = values; edit.begin(); pointer(event) }}
      onPointerMove={(event) => pointer(event)} onPointerUp={(event) => pointer(event, true)}
      onPointerCancel={() => { dragging.current = null; edit.cancel() }} onLostPointerCapture={() => { if (dragging.current) { dragging.current = null; edit.cancel() } }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); dragging.current = null; edit.cancel(); return }
        if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
        event.preventDefault(); edit.begin()
        const step = event.shiftKey ? 0.1 : 0.01
        const x = event.key === 'Home' ? 0 : position.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)
        const y = event.key === 'Home' ? 0 : position.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)
        edit.commit(patch(colorWheelAtPosition(values, group, x, y)))
      }}>
      <span className="grading-wheel-marker" style={{ left: `${(position.x + 1) * 50}%`, top: `${(1 - position.y) * 50}%` }} />
    </div>
    <GradingNumber label={`${label} brightness`} value={position.mean} min={limit.min} max={limit.max} disabled={disabled} onBegin={edit.begin} onCancel={edit.cancel} onCommit={(mean) => edit.commit(patch(colorWheelBrightness(values, group, mean)))} />
    {COLOR_RGB.map((channel, index) => <div key={channel}>
      <GradingNumber label={`${label} ${channel}`} value={values[index]} min={limit.min} max={limit.max} disabled={disabled} onBegin={edit.begin} onCancel={edit.cancel} onCommit={(value) => edit.commit({ [`${group}${channel}`]: value })} />
      {animation?.(`${group}${channel}`, values[index])}
    </div>)}
    <p className="inspector-note">Arrows adjust hue; Shift ×10. Home centers hue. Brightness keeps channel differences.</p>
  </fieldset>
}
