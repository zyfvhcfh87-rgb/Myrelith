/**
 * Bounded playback meter telemetry. The app controller is the sole writer;
 * UI surfaces subscribe to this serializable snapshot and never touch audio.
 */

import { create } from 'zustand'
import type { TrackId } from '../domain/schema'
import {
  AUDIO_METER_FFT_SIZE,
  AUDIO_METER_FLOOR_DB,
  type AudioMeterReadout,
} from '../domain/audioMeter'

export type AudioMeterStatus =
  | 'idle'
  | 'priming'
  | 'active'
  | 'unavailable'

export interface AudioMeterSnapshot {
  readonly status: AudioMeterStatus
  readonly reason: string
  readonly readout: AudioMeterReadout
  readonly trackReadouts: Readonly<Record<TrackId, AudioMeterReadout>>
  readonly sequence: number
  readonly updatedAtMs: number
  readonly sampleWindowSize: number
}

export interface AudioMeterState extends AudioMeterSnapshot {
  publishAudioMeter(snapshot: AudioMeterSnapshot): void
  resetAudioMeter(): void
}

const CLEAR_FLAGS = Object.freeze({
  left: false,
  right: false,
  master: false,
})

export const SILENT_AUDIO_METER_READOUT: AudioMeterReadout = Object.freeze({
  db: Object.freeze({
    left: AUDIO_METER_FLOOR_DB,
    right: AUDIO_METER_FLOOR_DB,
    master: AUDIO_METER_FLOOR_DB,
  }),
  overloadHeld: CLEAR_FLAGS,
  overloadLatched: CLEAR_FLAGS,
})

export const INITIAL_AUDIO_METER_STATE = Object.freeze({
  status: 'idle' as AudioMeterStatus,
  reason: 'Playback is paused',
  readout: SILENT_AUDIO_METER_READOUT,
  trackReadouts: Object.freeze({}),
  sequence: 0,
  updatedAtMs: 0,
  sampleWindowSize: AUDIO_METER_FFT_SIZE,
})

export const useAudioMeterStore = create<AudioMeterState>()((set) => ({
  ...INITIAL_AUDIO_METER_STATE,
  publishAudioMeter: (snapshot) => set(snapshot),
  resetAudioMeter: () => set({ ...INITIAL_AUDIO_METER_STATE }),
}))
