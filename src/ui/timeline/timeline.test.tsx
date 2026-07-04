/**
 * ui/timeline/timeline.test.tsx — Phase 3.2.
 *
 * The headline test is render isolation: moving the playhead re-renders
 * Playhead ONLY — Ruler must stay untouched. That is the deterministic
 * version of the plan's "verify with React DevTools Profiler" gate check,
 * enforced with React's <Profiler> so it can never silently regress.
 */

import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useTransportStore } from '../../state/transportStore'
import Playhead from './Playhead'
import Ruler from './Ruler'
import Timeline from './Timeline'
import { useScrubScheduler } from './useScrubScheduler'

beforeEach(() => {
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
  })
})

const nextFrame = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      }),
  )

describe('Playhead', () => {
  test('positions itself at playheadFrame × zoom', () => {
    act(() => {
      useTransportStore.getState().setZoom(2)
      useTransportStore.getState().setPlayheadFrame(50)
    })
    render(<Playhead />)
    expect(screen.getByTestId('playhead')).toHaveStyle({
      transform: 'translateX(100px)',
    })
  })

  test('GATE: scrubbing re-renders Playhead only, never Ruler', () => {
    const rulerRenders = vi.fn()
    const playheadRenders = vi.fn()
    render(
      <>
        <Profiler id="ruler" onRender={rulerRenders}>
          <Ruler />
        </Profiler>
        <Profiler id="playhead" onRender={playheadRenders}>
          <Playhead />
        </Profiler>
      </>,
    )
    const rulerBefore = rulerRenders.mock.calls.length
    const playheadBefore = playheadRenders.mock.calls.length

    act(() => {
      useTransportStore.getState().setPlayheadFrame(42)
    })
    act(() => {
      useTransportStore.getState().setPlayheadFrame(43)
    })

    expect(playheadRenders.mock.calls.length).toBe(playheadBefore + 2)
    expect(rulerRenders.mock.calls.length).toBe(rulerBefore) // untouched!
  })
})

describe('Ruler', () => {
  test('draws timecode labels at a zoom-appropriate interval', () => {
    act(() => {
      useTransportStore.getState().setZoom(3) // 30f * 3px = 90px → 1s ticks
    })
    render(<Ruler />)
    expect(screen.getByText('00:00:00:00')).toBeInTheDocument()
    expect(screen.getByText('00:00:01:00')).toBeInTheDocument()
    expect(screen.getByText('00:01:00:00')).toBeInTheDocument() // 60s runway
    expect(screen.queryByText('00:00:00:15')).not.toBeInTheDocument() // no sub-second labels at this zoom
  })

  test('click + drag seeks the playhead (rAF-coalesced, scrub flag toggles)', async () => {
    act(() => {
      useTransportStore.getState().setZoom(2)
    })
    render(<Ruler />)
    const ruler = screen.getByTestId('ruler')

    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 100 })
    expect(useTransportStore.getState().isScrubbing).toBe(true)
    await waitFor(() =>
      expect(useTransportStore.getState().playheadFrame).toBe(50),
    )

    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 300 })
    await waitFor(() =>
      expect(useTransportStore.getState().playheadFrame).toBe(150),
    )

    fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 302 })
    await waitFor(() =>
      expect(useTransportStore.getState().playheadFrame).toBe(151),
    )
    expect(useTransportStore.getState().isScrubbing).toBe(false)
  })

  test('pointer moves without capture (hover) do not seek', async () => {
    render(<Ruler />)
    fireEvent.pointerMove(screen.getByTestId('ruler'), {
      pointerId: 1,
      clientX: 400,
    })
    await nextFrame()
    expect(useTransportStore.getState().playheadFrame).toBe(0)
  })
})

describe('Timeline container', () => {
  test('hosts ruler, track area and playhead as siblings', () => {
    render(<Timeline />)
    const root = screen.getByTestId('timeline-root')
    expect(root.querySelector('.timeline-ruler')).not.toBeNull()
    expect(root.querySelector('.timeline-tracks')).not.toBeNull()
    expect(root.querySelector('.playhead')).not.toBeNull()
  })
})

describe('useScrubScheduler', () => {
  test('many schedules in one frame collapse to ONE commit with the latest value', async () => {
    const commits: number[] = []
    function Harness() {
      const schedule = useScrubScheduler((v) => commits.push(v))
      return (
        <button
          data-testid="fire"
          onClick={() => {
            schedule(1)
            schedule(2)
            schedule(3)
          }}
        />
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByTestId('fire'))
    await nextFrame()
    await nextFrame()
    expect(commits).toEqual([3])
  })
})
