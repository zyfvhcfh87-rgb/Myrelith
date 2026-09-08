import { useState } from 'react'
import type { ClipAnimationEasing } from '../../domain/schema'
import type { AnimationLaneRow, AnimationBatchCommand } from '../../state/animationEditor'
import { NumberField } from '../inspector/InspectorFields'
import { useTransportStore } from '../../state/transportStore'

const ANIMATION_EASING_PRESETS: Readonly<Record<string, ClipAnimationEasing>> = {
  Linear: { type: 'linear' }, Hold: { type: 'hold' },
  'Ease in': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'Ease out': { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'Ease in/out': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
}
export default function AnimationKeyControls({ row, frame, selectedCount, disabled, edit, add, bind }: {
  row: AnimationLaneRow | undefined; frame: number | null; selectedCount: number; disabled: boolean
  edit: (command: AnimationBatchCommand, success: string) => void; add: () => void; bind: () => void
}) {
  const key = frame === null ? undefined : row?.track?.keyframes.find((key) => key.frame === frame)
  const resetRevision = useTransportStore((state) => state.animationStatus.revision)
  const [delta, setDelta] = useState(1)
  const easing = key?.easing ?? { type: 'linear' as const }
  const scalar = row?.scalar.status === 'available' && row.status === 'scalar' ? row.scalar : null
  return <aside className="animation-key-controls" aria-label="Animation key controls">
    <strong>{row?.label ?? 'Choose a property'}</strong>
    <small>{row?.group}</small>
    {row?.reason && <p className="animation-unavailable">{row.reason}</p>}
    {row?.owner.track.locked && <p>Track locked. Unlock it to edit keys.</p>}
    {row?.address.kind === 'effect' && row.reason?.includes('unverified') && <button type="button" onClick={bind}>Bind to current plugin declaration</button>}
    <button type="button" disabled={disabled || !scalar} onClick={add}>Set key at playhead</button>
    {key && <>
      <NumberField resetRevision={resetRevision} label="Key local frame" testId="animation-key-frame" value={key.frame} min={-1e9} max={1e9} step={1} disabled={disabled}
        onCommit={(next) => edit({ kind: 'move', deltaFrames: next - key.frame }, 'Selected keys moved.')} />
      {typeof key.value === 'number' && <NumberField resetRevision={resetRevision} label={`Key value${scalar ? ` (${scalar.spec.unit})` : ''}`} testId="animation-key-value" value={key.value}
        min={scalar?.spec.min} max={scalar?.spec.max} step={scalar?.spec.step ?? 1} disabled={disabled || !scalar}
        onCommit={(value) => edit({ kind: 'set-value', value }, 'Selected key values updated.')} />}
      <label>Outgoing easing<select aria-label="Key easing" value={easing.type === 'cubic-bezier' ? 'Custom Bézier' : easing.type === 'hold' ? 'Hold' : 'Linear'} disabled={disabled || !scalar}
        onChange={(event) => { const next = ANIMATION_EASING_PRESETS[event.target.value] ?? { type: 'cubic-bezier' as const, x1: .25, y1: .1, x2: .25, y2: 1 }; edit({ kind: 'set-easing', easing: next }, 'Selected key easing updated.') }}>
        {Object.keys(ANIMATION_EASING_PRESETS).map((preset) => <option key={preset}>{preset}</option>)}<option>Custom Bézier</option>
      </select></label>
      {easing.type === 'cubic-bezier' && <div className="animation-bezier-fields">{(['x1', 'y1', 'x2', 'y2'] as const).map((property) => <NumberField key={property} resetRevision={resetRevision}
        label={`Bézier ${property}`} testId={`animation-bezier-${property}`} value={easing[property]} min={0} max={1} step={.01} disabled={disabled || !scalar}
        onCommit={(value) => { const next = { ...easing, [property]: value }; edit({ kind: 'set-easing', easing: next }, 'Bézier handles updated.') }} />)}</div>}
    </>}
    <NumberField label="Offset frames" testId="animation-offset" value={delta} step={1} min={-1e9} max={1e9} onCommit={setDelta} />
    <div className="animation-inline-actions"><button type="button" disabled={disabled || !selectedCount} onClick={() => edit({ kind: 'move', deltaFrames: delta }, 'Selected keys moved.')}>Move</button>
      <button type="button" disabled={disabled || !selectedCount} onClick={() => edit({ kind: 'duplicate', deltaFrames: delta }, 'Selected keys duplicated.')}>Duplicate</button></div>
  </aside>
}
