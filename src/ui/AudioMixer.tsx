/**
 * Timeline-docked mixer: one strip per audio track plus master.
 * Faders commit on pointerup / keyboard; React never reads audio-rate data.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AUDIO_METER_CEILING_DB,
  AUDIO_METER_FLOOR_DB,
  type AudioMeterReadout,
} from '../domain/audioMeter'
import {
  masterAudioSettings,
  mixerAudioTracks,
  trackBalance,
  trackVolume,
} from '../domain/audioMixer'
import { useDocumentStore } from '../state/documentStore'
import {
  SILENT_AUDIO_METER_READOUT,
  useAudioMeterStore,
} from '../state/audioMeterStore'

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

function MixerMeterLane({
  label,
  accessibleLabel,
  db,
  overloaded,
}: {
  label: string
  accessibleLabel: string
  db: number
  overloaded: boolean
}) {
  return (
    <div className="mixer-meter-lane">
      <div
        className="mixer-meter-track"
        role="meter"
        aria-label={accessibleLabel}
        aria-valuemin={AUDIO_METER_FLOOR_DB}
        aria-valuemax={AUDIO_METER_CEILING_DB}
        aria-valuenow={Number(db.toFixed(1))}
        aria-valuetext={dbText(db)}
        data-overload={overloaded || undefined}
      >
        <span
          className="mixer-meter-fill"
          style={{ transform: `scaleY(${meterScale(db)})` }}
          aria-hidden="true"
        />
      </div>
      <span className="mixer-meter-label" aria-hidden="true">{label}</span>
    </div>
  )
}

function MixerRange({
  label,
  value,
  min,
  max,
  step,
  disabled,
  vertical = false,
  testId,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  vertical?: boolean
  testId: string
  onCommit: (value: number) => void
}) {
  const dragging = useRef(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (!dragging.current) setDraft(value)
  }, [value])

  const decimals = String(step).split('.')[1]?.length ?? 0
  const commit = (next: number): void => {
    const bounded = Math.min(max, Math.max(min, next))
    const rounded = Number(bounded.toFixed(decimals))
    setDraft(rounded)
    onCommit(rounded)
  }

  return (
    <input
      type="range"
      className={vertical ? 'mixer-fader' : 'mixer-pan'}
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-testid={testId}
      onPointerDown={(event) => {
        dragging.current = true
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }}
      onPointerUp={(event) => {
        dragging.current = false
        if (typeof event.currentTarget.hasPointerCapture === 'function'
          && event.currentTarget.hasPointerCapture(event.pointerId)
          && typeof event.currentTarget.releasePointerCapture === 'function') {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        commit(Number(event.currentTarget.value))
      }}
      onChange={(event) => {
        const next = Number(event.currentTarget.value)
        setDraft(next)
        if (!dragging.current) commit(next)
      }}
    />
  )
}

function MixerMeters({
  name,
  readout,
}: {
  name: string
  readout: AudioMeterReadout
}) {
  return (
    <div className="mixer-meters" aria-hidden={false}>
      <MixerMeterLane
        label="L"
        accessibleLabel={`${name} left level`}
        db={readout.db.left}
        overloaded={readout.overloadLatched.left}
      />
      <MixerMeterLane
        label="R"
        accessibleLabel={`${name} right level`}
        db={readout.db.right}
        overloaded={readout.overloadLatched.right}
      />
    </div>
  )
}

export default function AudioMixer() {
  const doc = useDocumentStore((state) => state.doc)
  const tracks = mixerAudioTracks(doc)
  const master = masterAudioSettings(doc)
  const trackReadouts = useAudioMeterStore((state) => state.trackReadouts)
  const masterReadout = useAudioMeterStore((state) => state.readout)

  return (
    <section className="audio-mixer" aria-label="Audio mixer">
      {tracks.map((track) => {
        const readout = trackReadouts[track.id] ?? SILENT_AUDIO_METER_READOUT
        const locked = track.locked
        return (
          <article
            key={track.id}
            className="mixer-strip"
            data-testid={`mixer-strip-${track.id}`}
          >
            <span className="mixer-strip-name">{track.name}</span>
            <div className="mixer-strip-body">
              <MixerRange
                label={`${track.name} volume`}
                value={trackVolume(track)}
                min={0}
                max={2}
                step={0.01}
                disabled={locked}
                vertical
                testId={`mixer-volume-${track.id}`}
                onCommit={(volume) =>
                  useDocumentStore.getState().setTrackMixer(track.id, { volume })
                }
              />
              <MixerMeters name={track.name} readout={readout} />
            </div>
            <MixerRange
              label={`${track.name} balance`}
              value={trackBalance(track)}
              min={-1}
              max={1}
              step={0.01}
              disabled={locked}
              testId={`mixer-balance-${track.id}`}
              onCommit={(balance) =>
                useDocumentStore.getState().setTrackMixer(track.id, { balance })
              }
            />
            <div className="mixer-strip-toggles">
              <button
                type="button"
                className={`mixer-toggle${track.solo ? ' active' : ''}`}
                aria-pressed={track.solo}
                aria-label={`solo track ${track.name}`}
                onClick={() =>
                  useDocumentStore.getState().setTrackFlags(track.id, {
                    solo: !track.solo,
                  })
                }
              >
                S
              </button>
              <button
                type="button"
                className={`mixer-toggle${track.muted ? ' active' : ''}`}
                aria-pressed={track.muted}
                aria-label={`mute track ${track.name}`}
                onClick={() =>
                  useDocumentStore.getState().setTrackFlags(track.id, {
                    muted: !track.muted,
                  })
                }
              >
                M
              </button>
            </div>
          </article>
        )
      })}
      <article
        className="mixer-strip mixer-strip-master"
        data-testid="mixer-strip-master"
      >
        <span className="mixer-strip-name">Master</span>
        <div className="mixer-strip-body">
          <MixerRange
            label="Master volume"
            value={master.volume}
            min={0}
            max={2}
            step={0.01}
            disabled={false}
            vertical
            testId="mixer-volume-master"
            onCommit={(volume) =>
              useDocumentStore.getState().setMasterAudio({ volume })
            }
          />
          <MixerMeters name="Master" readout={masterReadout} />
        </div>
        <MixerRange
          label="Master balance"
          value={master.balance}
          min={-1}
          max={1}
          step={0.01}
          disabled={false}
          testId="mixer-balance-master"
          onCommit={(balance) =>
            useDocumentStore.getState().setMasterAudio({ balance })
          }
        />
        <div className="mixer-strip-toggles">
          <button
            type="button"
            className={`mixer-toggle${master.muted ? ' active' : ''}`}
            aria-pressed={master.muted}
            aria-label="mute master"
            data-testid="mixer-mute-master"
            onClick={() =>
              useDocumentStore.getState().setMasterAudio({
                muted: !master.muted,
              })
            }
          >
            M
          </button>
        </div>
      </article>
    </section>
  )
}
