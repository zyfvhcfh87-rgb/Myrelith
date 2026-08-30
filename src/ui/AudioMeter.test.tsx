import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AUDIO_METER_FLOOR_DB } from '../domain/audioMeter'
import { resetAudioMeterOverload } from '../app/transportController'
import { useAudioMeterStore } from '../state/audioMeterStore'
import AudioMeter from './AudioMeter'

vi.mock('../app/transportController', () => ({
  resetAudioMeterOverload: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  useAudioMeterStore.getState().resetAudioMeter()
})

describe('AudioMeter', () => {
  test('exposes quiet channel/master meters and a stable paused announcement', () => {
    render(<AudioMeter />)

    expect(screen.getAllByRole('meter')).toHaveLength(3)
    expect(screen.getByRole('meter', { name: 'Left playback level' }))
      .toHaveAttribute('aria-valuenow', String(AUDIO_METER_FLOOR_DB))
    expect(screen.getByText('Playback is paused')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    expect(screen.getByRole('button', {
      name: 'Reset audio overload warning',
    })).toBeDisabled()
  })

  test('renders bounded live values without putting them in the live region', () => {
    render(<AudioMeter />)
    act(() => useAudioMeterStore.getState().publishAudioMeter({
      status: 'active',
      reason: 'Live playback levels',
      readout: {
        db: { left: -6.0206, right: -12.0412, master: -6.0206 },
        overloadHeld: { left: false, right: false, master: false },
        overloadLatched: { left: false, right: false, master: false },
      },
      trackReadouts: {},
      sequence: 1,
      updatedAtMs: 100,
      sampleWindowSize: 256,
    }))

    expect(screen.getByRole('meter', { name: 'Left playback level' }))
      .toHaveAttribute('aria-valuetext', 'minus 6.0 dBFS')
    expect(screen.getByText('Playback audio meter active')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    expect(screen.queryByText(/6\.0 dBFS/)).toBeNull()
  })

  test('offers an ordinary keyboard button for latched overload reset', () => {
    render(<AudioMeter />)
    act(() => useAudioMeterStore.setState((state) => ({
      readout: {
        ...state.readout,
        overloadLatched: { left: true, right: false, master: true },
      },
    })))

    const reset = screen.getByRole('button', {
      name: 'Reset audio overload warning',
    })
    expect(reset).toBeEnabled()
    expect(reset).toHaveTextContent('CLIP')
    expect(reset).toHaveClass('audio-meter-reset')
    fireEvent.click(reset)
    expect(resetAudioMeterOverload).toHaveBeenCalledOnce()
  })
})
