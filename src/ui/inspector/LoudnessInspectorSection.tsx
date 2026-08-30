import {
  DEFAULT_NORMALIZE_TARGET_LUFS,
} from '../../domain/audioLoudness'
import {
  cancelLoudnessScan,
  startLoudnessScan,
} from '../../app/loudnessController'
import { useDocumentStore } from '../../state/documentStore'
import { useLoudnessStore } from '../../state/loudnessStore'

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
  const status = useLoudnessStore((state) => state.status)
  const measurement = useLoudnessStore((state) => state.measurement)
  const error = useLoudnessStore((state) => state.error)
  const framesDone = useLoudnessStore((state) => state.framesDone)
  const frameCount = useLoudnessStore((state) => state.frameCount)
  const complete = status === 'complete' && measurement?.coverage === 'complete'
  const canNormalize = complete && measurement?.integratedLufs !== null

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
              <button type="button" onClick={() => { void startLoudnessScan() }}>
                Measure
              </button>
            )}
      </div>
      <span className="inspector-note">
        Measurement is derived from the mixed program. It never writes gain.
        Incomplete coverage cannot claim a complete reading.
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
