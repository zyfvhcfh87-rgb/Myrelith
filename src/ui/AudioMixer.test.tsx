import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../domain/projectSettings'
import { AUDIO_METER_FLOOR_DB } from '../domain/audioMeter'
import { useDocumentStore } from '../state/documentStore'
import { useAudioMeterStore } from '../state/audioMeterStore'
import { resetDocumentStoreForTest } from '../test/storeFixtures'
import AudioMixer from './AudioMixer'

beforeEach(() => {
  resetDocumentStoreForTest(
    createTimelineDoc('Mixer', DEFAULT_PROJECT_SETTINGS, 'mixer-doc'),
  )
  useAudioMeterStore.getState().resetAudioMeter()
})

describe('AudioMixer', () => {
  test('renders one strip per audio track plus master', () => {
    render(<AudioMixer />)
    expect(screen.getByRole('region', { name: 'Audio mixer' })).toBeInTheDocument()
    expect(screen.getByTestId('mixer-strip-A1')).toBeInTheDocument()
    expect(screen.getByTestId('mixer-strip-A4')).toBeInTheDocument()
    expect(screen.getByTestId('mixer-strip-master')).toBeInTheDocument()
    expect(screen.queryByTestId('mixer-strip-V1')).toBeNull()
    expect(screen.getByRole('slider', { name: 'A1 volume' })).toHaveValue('1')
    expect(screen.getByRole('meter', { name: 'A1 left level' }))
      .toHaveAttribute('aria-valuenow', String(AUDIO_METER_FLOOR_DB))
  })

  test('volume fader commits one history entry on pointerup', () => {
    render(<AudioMixer />)
    const fader = screen.getByRole('slider', { name: 'A1 volume' })
    fireEvent.pointerDown(fader)
    fireEvent.change(fader, { target: { value: '0.4' } })
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.volume)
      .toBe(1)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    fireEvent.pointerUp(fader)
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.volume)
      .toBe(0.4)
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })

  test('pointer cancellation discards the draft and restores keyboard commits', () => {
    render(<AudioMixer />)
    const fader = screen.getByRole('slider', { name: 'A1 volume' })
    fireEvent.pointerDown(fader, { pointerId: 7 })
    fireEvent.change(fader, { target: { value: '0.4' } })
    fireEvent.pointerCancel(fader, { pointerId: 7 })

    expect(fader).toHaveValue('1')
    expect(useDocumentStore.getState().past).toHaveLength(0)

    fireEvent.change(fader, { target: { value: '0.75' } })
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.volume)
      .toBe(0.75)
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })

  test('mute reuses track flags and master mute is its own edit', () => {
    render(<AudioMixer />)
    fireEvent.click(screen.getByRole('button', { name: 'mute track A1' }))
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.muted)
      .toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'mute master' }))
    expect(useDocumentStore.getState().doc.masterAudio?.muted).toBe(true)
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })

  test('keyboard on a fader commits immediately', () => {
    render(<AudioMixer />)
    const fader = screen.getByRole('slider', { name: 'Master volume' })
    fireEvent.change(fader, { target: { value: '0.25' } })
    expect(useDocumentStore.getState().doc.masterAudio?.volume).toBe(0.25)
  })

  test('reads per-strip meters from the store only', () => {
    render(<AudioMixer />)
    act(() => {
      useAudioMeterStore.getState().publishAudioMeter({
        ...useAudioMeterStore.getState(),
        status: 'active',
        reason: 'Live playback levels',
        readout: {
          db: { left: -6, right: -8, master: -6 },
          overloadHeld: { left: false, right: false, master: false },
          overloadLatched: { left: false, right: false, master: false },
        },
        trackReadouts: {
          A1: {
            db: { left: -12, right: -18, master: -12 },
            overloadHeld: { left: false, right: false, master: false },
            overloadLatched: { left: false, right: false, master: false },
          },
        },
        sequence: 1,
        updatedAtMs: 100,
        sampleWindowSize: 256,
      })
    })
    expect(screen.getByRole('meter', { name: 'A1 left level' }))
      .toHaveAttribute('aria-valuenow', '-12')
    expect(screen.getByRole('meter', { name: 'Master left level' }))
      .toHaveAttribute('aria-valuenow', '-6')
  })
})
