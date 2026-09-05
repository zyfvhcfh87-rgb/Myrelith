import { useEffect, useState } from 'react'
import type { MulticamDefinition } from '../domain/schema'
import { analyzeMulticam, applyMulticamAlignment, cancelMulticamAlignment } from '../app/multicamAlignmentController'
import { useMulticamAlignmentStore } from '../state/multicamAlignmentStore'

export default function MulticamAlignmentControls({ definition }: { readonly definition: MulticamDefinition }) {
  const status = useMulticamAlignmentStore()
  const [method, setMethod] = useState<'audio' | 'timecode'>('audio')
  const [reference, setReference] = useState(definition.angles[0].id)
  const [targets, setTargets] = useState(definition.angles.slice(1).map((angle) => angle.id))
  const [starts, setStarts] = useState<Record<string, string>>({})
  const [duration, setDuration] = useState('10')
  const [search, setSearch] = useState('5')
  const [confirmed, setConfirmed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [accepted, setAccepted] = useState<string[]>([])
  const visible = status.definitionId === definition.id
  const running = visible && status.phase === 'running'
  const ready = visible && status.phase === 'ready'
  useEffect(() => {
    setDrafts(Object.fromEntries(status.rows.filter((row) => row.proposedFrame !== null)
      .map((row) => [row.angleId, String(row.proposedFrame)])))
    setAccepted(status.rows.filter((row) => row.state === 'aligned').map((row) => row.angleId))
  }, [status.rows])
  useEffect(() => () => { void cancelMulticamAlignment() }, [definition.id])
  const invalidate = () => { if (ready) void cancelMulticamAlignment() }
  return (
    <details className="multicam-alignment">
      <summary>Align by audio or timecode</summary>
      <p>Choose a reference and review suggested start offsets before applying. Manual angle edits remain available.</p>
      <fieldset disabled={running}>
        <legend>Alignment settings</legend>
        <label><span>Method</span><select aria-label="Alignment method" value={method} onChange={(event) => {
          invalidate(); setMethod(event.currentTarget.value as 'audio' | 'timecode')
        }}><option value="audio">Local audio</option><option value="timecode">Source timecode</option></select></label>
        <label><span>Reference angle</span><select value={reference} onChange={(event) => {
          invalidate(); const id = event.currentTarget.value
          setReference(id); setTargets(definition.angles.filter((angle) => angle.id !== id).map((angle) => angle.id))
        }}>{definition.angles.map((angle) => <option key={angle.id} value={angle.id}>{angle.name}</option>)}</select></label>
        {method === 'audio' ? <>
          <p>A constant offset near one shared event. Select 5–30 seconds of distinct audio; the search covers up to ±5 seconds.</p>
          <div className="multicam-alignment-fields">
            <label><span>Window duration (seconds)</span><input type="number" min={5} max={30} step={0.005} value={duration}
              onChange={(event) => { invalidate(); setDuration(event.currentTarget.value) }} /></label>
            <label><span>Search either side (seconds)</span><input type="number" min={1} max={5} step={0.005} value={search}
              onChange={(event) => { invalidate(); setSearch(event.currentTarget.value) }} /></label>
          </div>
        </> : <>
          <p>Supports continuous non-drop QuickTime timecode with matching source and project rates. Unsupported metadata gives a reason below.</p>
          <label className="multicam-alignment-check"><input type="checkbox" checked={confirmed}
            onChange={(event) => { invalidate(); setConfirmed(event.currentTarget.checked) }} />
            <span>These recordings share a timecode clock and calendar day, with no midnight crossing.</span></label>
        </>}
        {definition.angles.map((angle) => {
          const selected = angle.id === reference || targets.includes(angle.id)
          return <div key={angle.id} className="multicam-alignment-source">
            <label className="multicam-alignment-check"><input type="checkbox" checked={selected} disabled={angle.id === reference}
              aria-label={`Analyze ${angle.name}`} onChange={(event) => {
                invalidate(); setTargets(event.currentTarget.checked ? [...targets, angle.id] : targets.filter((id) => id !== angle.id))
              }} /><span>{angle.name}{angle.id === reference ? ' · reference' : ''}</span></label>
            {method === 'audio' && selected && <label><span>Window start for {angle.name} (seconds)</span>
              <input type="number" min={0} max={86395} step={0.005} value={starts[angle.id] ?? '1'}
                onChange={(event) => { invalidate(); setStarts({ ...starts, [angle.id]: event.currentTarget.value }) }} /></label>}
          </div>
        })}
      </fieldset>
      <div className="multicam-alignment-actions">
        <button type="button" disabled={running || targets.length === 0 || (method === 'timecode' && !confirmed)} onClick={() => {
          const bins = (value: string) => {
            const scaled = value.trim() ? Number(value) * 200 : Number.NaN
            const rounded = Math.round(scaled)
            return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6 ? rounded : Number.NaN
          }
          void analyzeMulticam({ definitionId: definition.id, referenceAngleId: reference, targetAngleIds: targets,
            method, binCount: bins(duration), maxLagBins: bins(search), commonClockAndDay: confirmed,
            startBins: Object.fromEntries(definition.angles.map((angle) => [angle.id, bins(starts[angle.id] ?? '1')])) })
        }}>Analyze alignment</button>
        {(running || ready) && <button type="button" onClick={() => { void cancelMulticamAlignment() }}>Cancel alignment</button>}
      </div>
      {visible && <div className="multicam-alignment-status" role="status" aria-live="polite">
        {running && <progress aria-label="Alignment progress" max={1} value={status.progress} />}
        <p>{status.detail}</p>
        {status.cacheHits > 0 && <p>{status.cacheHits} source {status.cacheHits === 1 ? 'window' : 'windows'} reused from local cache.</p>}
        {status.cacheWarning && <p>{status.cacheWarning}</p>}
      </div>}
      {ready && <div className="multicam-alignment-review" aria-label="Review alignment proposals">
        {status.rows.map((row) => <article key={row.angleId}>
          <strong>{row.name}</strong><span>Current offset: {row.currentFrame}f</span>
          <p>{row.detail}</p>
          {row.facts && <p>Correlation {row.facts.score?.toFixed(3) ?? 'unavailable'} · gap {row.facts.margin?.toFixed(3) ?? 'unavailable'} · shared {(row.facts.overlapBins / 200).toFixed(2)}s</p>}
          {row.state === 'aligned' && <>
            <label className="multicam-alignment-check"><input type="checkbox" checked={accepted.includes(row.angleId)}
              onChange={(event) => setAccepted(event.currentTarget.checked ? [...accepted, row.angleId] : accepted.filter((id) => id !== row.angleId))} />
              <span>Apply {row.name}</span></label>
            <label><span>Proposed offset for {row.name} (frames)</span><input type="number" step={1} value={drafts[row.angleId] ?? ''}
              onChange={(event) => setDrafts({ ...drafts, [row.angleId]: event.currentTarget.value })} /></label>
          </>}
        </article>)}
        <p>Offsets must fit the existing multicam duration. Correct any proposed frame value before Apply.</p>
        <button type="button" disabled={accepted.length === 0} onClick={() => applyMulticamAlignment(accepted.map((angleId) => ({
          angleId, coverageStartFrame: drafts[angleId]?.trim() ? Number(drafts[angleId]) : Number.NaN,
        })))}>Apply reviewed offsets</button>
      </div>}
    </details>
  )
}
