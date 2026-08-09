import type { CSSProperties } from 'react'
import {
  AUDIO_METER_CEILING_DB,
  AUDIO_METER_FLOOR_DB,
} from '../domain/audioMeter'
import { resetAudioMeterOverload } from '../app/transportController'
import { useAudioMeterStore } from '../state/audioMeterStore'

interface MeterLaneProps {
  label: 'L' | 'R' | 'M'
  accessibleLabel: string
  db: number
  overloaded: boolean
  master?: boolean
}

function meterScale(db: number): number {
  return Math.max(
    0,
    Math.min(
      1,
      (db - AUDIO_METER_FLOOR_DB)
        / (AUDIO_METER_CEILING_DB - AUDIO_METER_FLOOR_DB),
    ),
  )
}

function dbText(db: number): string {
  if (db <= AUDIO_METER_FLOOR_DB) return 'silent, below minus 60 dBFS'
  return `${db >= 0 ? 'plus ' : 'minus '}${Math.abs(db).toFixed(1)} dBFS`
}

function MeterLane({
  label,
  accessibleLabel,
  db,
  overloaded,
  master = false,
}: MeterLaneProps) {
  return (
    <div className={`audio-meter-lane${master ? ' master' : ''}`}>
      <span className="audio-meter-label" aria-hidden="true">{label}</span>
      <div
        className="audio-meter-track"
        role="meter"
        aria-label={accessibleLabel}
        aria-valuemin={AUDIO_METER_FLOOR_DB}
        aria-valuemax={AUDIO_METER_CEILING_DB}
        aria-valuenow={Number(db.toFixed(1))}
        aria-valuetext={dbText(db)}
        data-overload={overloaded || undefined}
      >
        <span
          className="audio-meter-fill"
          style={{ transform: `scaleX(${meterScale(db)})` } as CSSProperties}
          aria-hidden="true"
        />
        <span className="audio-meter-overload-zone" aria-hidden="true" />
      </div>
    </div>
  )
}

export default function AudioMeter() {
  const readout = useAudioMeterStore((state) => state.readout)
  const status = useAudioMeterStore((state) => state.status)
  const reason = useAudioMeterStore((state) => state.reason)
  const overloaded = readout.overloadLatched.master

  return (
    <section
      className="audio-meter"
      aria-label="Playback audio levels"
      data-status={status}
      title={reason}
    >
      <span className="visually-hidden" aria-live="polite">
        {status === 'active' ? 'Playback audio meter active' : reason}
      </span>
      <div className="audio-meter-channels">
        <MeterLane
          label="L"
          accessibleLabel="Left playback level"
          db={readout.db.left}
          overloaded={readout.overloadLatched.left}
        />
        <MeterLane
          label="R"
          accessibleLabel="Right playback level"
          db={readout.db.right}
          overloaded={readout.overloadLatched.right}
        />
        <MeterLane
          label="M"
          accessibleLabel="Master playback level"
          db={readout.db.master}
          overloaded={readout.overloadLatched.master}
          master
        />
      </div>
      <button
        type="button"
        className="audio-meter-reset"
        aria-label="Reset audio overload warning"
        title={overloaded ? 'Reset overload warning' : 'No overload detected'}
        disabled={!overloaded}
        onClick={resetAudioMeterOverload}
      >
        {overloaded ? 'CLIP' : '0'}
      </button>
    </section>
  )
}
