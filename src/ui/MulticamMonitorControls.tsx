import { useEffect, useRef } from 'react'
import { registerMulticamMonitorCanvas, setMulticamMonitorEnabled } from '../app/multicamMonitorController'
import { useMulticamMonitorStore } from '../state/multicamMonitorStore'
import type { MulticamDefinition } from '../domain/schema'

export function MulticamAngleCanvas({ angleId, instanceId }: { readonly angleId: string; readonly instanceId: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const state = useMulticamMonitorStore((value) => value.angles[angleId])
  useEffect(() => {
    if (ref.current) return registerMulticamMonitorCanvas(angleId, ref.current)
  }, [angleId, instanceId])
  return <canvas ref={ref} width={0} height={0} className="multicam-angle-canvas" data-live={state === 'live'} aria-hidden="true" />
}

export function MulticamAngleStatus({ angleId, active }: { readonly angleId: string; readonly active: boolean }) {
  const status = useMulticamMonitorStore((value) => value.angles[angleId])
  return <span className="multicam-angle-status">{active ? 'Program' : status === 'live' ? 'Live preview' : status === 'gap' ? 'No coverage' : 'Paused preview'}</span>
}

export default function MulticamMonitorControls({ definition, instanceId, activeAngleId, disabled, onCut }: {
  readonly definition: MulticamDefinition; readonly instanceId: string; readonly activeAngleId: string | null
  readonly disabled: boolean; readonly onCut: (id: string) => void
}) {
  const { enabled, phase, detail } = useMulticamMonitorStore()
  return (
    <div className="multicam-monitor-controls" role="group" aria-label="Live multicam previews" data-phase={phase}>
      <label>
        <input type="checkbox" checked={enabled} onChange={(event) => setMulticamMonitorEnabled(event.currentTarget.checked)} />
        <span>Live angle previews</span>
      </label>
      {enabled && phase === 'paused' && <button type="button" onClick={() => setMulticamMonitorEnabled(true)}>Retry live previews</button>}
      <p role="status" aria-label="Live preview status" aria-live="polite">{detail}</p>
      <div className="multicam-monitor-wall" aria-label="Angle preview grid">
        {definition.angles.map((angle, index) => (
          <button key={`${instanceId}:${angle.id}`} type="button" className="multicam-monitor-tile"
            aria-label={`Switch to ${angle.name}`} aria-pressed={angle.id === activeAngleId}
            disabled={disabled} onClick={() => onCut(angle.id)}>
            <span className="multicam-monitor-image">
              <span aria-hidden="true">{angle.id === activeAngleId ? 'Program' : index + 1}</span>
              <MulticamAngleCanvas angleId={angle.id} instanceId={instanceId} />
            </span>
            <span className="multicam-monitor-name" title={angle.name}>{angle.name}</span>
            <MulticamAngleStatus angleId={angle.id} active={angle.id === activeAngleId} />
          </button>
        ))}
      </div>
    </div>
  )
}
