import { beforeEach, describe, expect, test } from 'vitest'
import { AUDIO_METER_FLOOR_DB } from '../domain/audioMeter'
import {
  INITIAL_AUDIO_METER_STATE,
  useAudioMeterStore,
} from './audioMeterStore'

beforeEach(() => useAudioMeterStore.getState().resetAudioMeter())

describe('audioMeterStore', () => {
  test('publishes one app-owned serializable snapshot', () => {
    useAudioMeterStore.getState().publishAudioMeter({
      status: 'active',
      reason: 'Live playback levels',
      readout: {
        db: { left: -6, right: -12, master: -6 },
        overloadHeld: { left: false, right: false, master: false },
        overloadLatched: { left: false, right: false, master: false },
      },
      sequence: 7,
      updatedAtMs: 700,
      sampleWindowSize: 256,
    })

    expect(useAudioMeterStore.getState()).toMatchObject({
      status: 'active',
      sequence: 7,
      readout: { db: { left: -6, right: -12, master: -6 } },
    })
  })

  test('reset removes levels, overload, and stale sequencing', () => {
    useAudioMeterStore.setState({
      status: 'unavailable',
      sequence: 9,
      readout: {
        db: { left: 1, right: -2, master: 1 },
        overloadHeld: { left: true, right: false, master: true },
        overloadLatched: { left: true, right: false, master: true },
      },
    })

    useAudioMeterStore.getState().resetAudioMeter()

    expect(useAudioMeterStore.getState()).toMatchObject(INITIAL_AUDIO_METER_STATE)
    expect(useAudioMeterStore.getState().readout.db.master).toBe(
      AUDIO_METER_FLOOR_DB,
    )
  })
})
