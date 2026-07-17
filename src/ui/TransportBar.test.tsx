/**
 * ui/TransportBar.test.tsx — Phase 4.0.5.
 *
 * The bar is a dumb facade caller: buttons hit the controller, the icon
 * follows isPlaying, and — invariant 6 — playhead movement must NOT
 * re-render it (it subscribes to isPlaying only).
 */

import { Profiler } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useTransportStore } from '../state/transportStore'
import TransportBar from './TransportBar'
import { stepFrame, togglePlayback } from '../app/transportController'

vi.mock('../app/transportController', () => ({
  togglePlayback: vi.fn(),
  stepFrame: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    zoomMode: 'custom',
    customZoom: 1,
    timelineOriginFrame: 0,
    inOut: null,
    dragPreview: null,
  })
})

describe('TransportBar', () => {
  test('buttons call the controller facade', () => {
    render(<TransportBar />)
    fireEvent.click(screen.getByLabelText('one frame back'))
    expect(stepFrame).toHaveBeenCalledWith(-1)
    fireEvent.click(screen.getByLabelText('one frame forward'))
    expect(stepFrame).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByLabelText('play'))
    expect(togglePlayback).toHaveBeenCalledTimes(1)
  })

  test('the center button flips between play and pause with isPlaying', () => {
    render(<TransportBar />)
    expect(screen.getByLabelText('play')).toBeInTheDocument()
    act(() => useTransportStore.getState().setIsPlaying(true))
    expect(screen.getByLabelText('pause')).toBeInTheDocument()
    expect(screen.queryByLabelText('play')).toBeNull()
  })

  test('GATE: playhead movement does not re-render the bar', () => {
    const renders = vi.fn()
    render(
      <Profiler id="bar" onRender={renders}>
        <TransportBar />
      </Profiler>,
    )
    const before = renders.mock.calls.length
    act(() => useTransportStore.getState().setPlayheadFrame(50))
    act(() => useTransportStore.getState().setPlayheadFrame(51))
    act(() => useTransportStore.getState().setPlayheadFrame(52))
    expect(renders.mock.calls.length).toBe(before)
  })

  test('GATE: timeline zoom changes do not re-render the playback controls', () => {
    const renders = vi.fn()
    render(
      <Profiler id="bar" onRender={renders}>
        <TransportBar />
      </Profiler>,
    )
    const before = renders.mock.calls.length
    act(() => useTransportStore.getState().setZoom(2))
    act(() => useTransportStore.getState().setPresetZoom('detail', 3))
    act(() => useTransportStore.getState().setTimelineOriginFrame(1_000_000))
    expect(renders.mock.calls.length).toBe(before)
  })
})
