import { useState } from 'react'
import {
  DEFAULT_NORMALIZE_TARGET_LUFS,
} from '../../domain/audioLoudness'
import { docDurationFrames } from '../../domain/selectors'
import {
  cancelLoudnessScan,
  startLoudnessScan,
} from '../../app/loudnessController'
import { useDocumentStore } from '../../state/documentStore'
import { useLoudnessStore } from '../../state/loudnessStore'
import { useTransportStore } from '../../state/transportStore'

type MeasurementRangeChoice = 'timeline' | 'in-out'

function formatLufs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} LUFS`
}

function formatPeak(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value).toFixed(1)
  return value >= 0 ? `+${abs} dBTP` : `−${abs} dBTP`
}

export default function LoudnessInspectorSection() {
  const [rangeChoice, setRangeChoice] = useState<MeasurementRangeChoice>('timeline')
  const doc = useDocumentStore((state) => state.doc)
  const durationFrames = docDurationFrames(doc)
  const timelineInFrame = useTransportStore((state) => state.timelineInFrame)
  const timelineOutExclusive = useTransportStore((state) => state.timelineOutExclusive)
  const status = useLoudnessStore((state) => state.status)
  const measurement = useLoudnessStore((state) => state.measurement)
  const measuredRange = useLoudnessStore((state) => state.range)
  const error = useLoudnessStore((state) => state.error)
  const framesDone = useLoudnessStore((state) => state.framesDone)
  const frameCount = useLoudnessStore((state) => state.frameCount)
  const complete = status === 'complete' && measurement?.coverage === 'complete'
  const canNormalize = complete && measurement?.integratedLufs !== null
  const inOutRange = timelineInFrame !== null
    && timelineOutExclusive !== null
    && timelineInFrame >= 0
    && timelineOutExclusive > timelineInFrame
    && timelineOutExclusive <= durationFrames
    ? { startFrame: timelineInFrame, endFrame: timelineOutExclusive }
    : null
  const measurementRange = rangeChoice === 'in-out'
    ? inOutRange
    : { startFrame: 0, endFrame: durationFrames }
  const displayedRange = status === 'idle' ? measurementRange : measuredRange
  const rangeLabel = displayedRange
    ? `${displayedRange.startFrame}–${displayedRange.endFrame} (end exclusive)`
    : 'Timeline In/Out is not set to a valid project range'

  return (
    <section className="inspector-section" aria-label="Loudness">
      <div className="inspector-section-bar">
        <h3>Loudness</h3>
        {status === 'running'
          ? (
              <button type="button" onClick={() => cancelLoudnessScan()}>
                Cancel
              </button>
            )
          : (
              <button
                type="button"
                disabled={measurementRange === null}
                onClick={() => {
                  if (measurementRange) void startLoudnessScan(measurementRange)
                }}
              >
                Measure
              </button>
            )}
      </div>
      <label className="inspector-field inspector-field-wide">
        <span className="inspector-field-label">Measurement range</span>
        <select
          aria-label="Loudness measurement range"
          value={rangeChoice}
          disabled={status === 'running'}
          onChange={(event) => setRangeChoice(event.currentTarget.value as MeasurementRangeChoice)}
        >
          <option value="timeline">Full timeline</option>
          <option value="in-out" disabled={inOutRange === null}>Timeline In/Out</option>
        </select>
      </label>
      <span className="inspector-note">
        Measurement is derived from the mixed program. It never writes gain.
        Incomplete coverage cannot claim a complete reading.
      </span>
      <span className="inspector-note">
        {status === 'idle' ? 'Selected range' : 'Job range'}: {rangeLabel}.
      </span>
      {status === 'running' && (
        <span className="inspector-note" role="status">
          Measuring {framesDone} of {frameCount} frames…
        </span>
      )}
      {error && <span className="inspector-note" role="status">{error}</span>}
      {measurement && (
        <div className="inspector-grid">
          <span>Integrated {formatLufs(measurement.integratedLufs)}</span>
          <span>True peak {formatPeak(measurement.truePeakDbtp)}</span>
          <span>
            {measurement.coverage === 'complete' ? 'Complete coverage' : 'Incomplete coverage'}
          </span>
        </div>
      )}
      <button
        type="button"
        disabled={!canNormalize}
        onClick={() => {
          if (measurement?.integratedLufs === null || measurement?.integratedLufs === undefined) {
            return
          }
          useDocumentStore.getState().normalizeMasterLoudness(
            measurement.integratedLufs,
            DEFAULT_NORMALIZE_TARGET_LUFS,
          )
        }}
      >
        {`Normalize master to ${DEFAULT_NORMALIZE_TARGET_LUFS} LUFS`}
      </button>
    </section>
  )
}
