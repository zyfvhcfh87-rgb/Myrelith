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
import type { TimelineDoc } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import Playhead from './Playhead'
import Ruler from './Ruler'
import Timeline from './Timeline'
import { useScrubScheduler } from './useScrubScheduler'

/** Empty 30fps doc, optionally with one clip to pin the doc duration. */
function makeDoc(durationFrames = 0): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc-ruler',
    name: 'ruler fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1',
        clips:
          durationFrames > 0
            ? [
                {
                  id: 'clipA',
                  assetId: 'asset-1',
                  name: 'clipA',
                  sourceRange: { startFrame: 0, durationFrames },
                  timelineRange: { startFrame: 0, durationFrames },
                  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
                  opacity: 1,
                  volume: 1,
                  effects: [],
                },
              ]
            : [],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
}

beforeEach(() => {
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
  })
  useDocumentStore.getState().setDoc(makeDoc())
})

/** 12h at 30fps — the minimum ruler runway in frames. */
const RUNWAY_FRAMES = 12 * 3600 * 30

/**
 * Render a Ruler inside a marked scroll container and put its viewport at
 * `scrollLeft`. jsdom has no layout, so clientWidth is stubbed.
 */
async function renderScrolled(scrollLeft: number, clientWidth = 1000) {
  const { container } = render(
    <div data-timeline-scroll>
      <Ruler />
    </div>,
  )
  const scroller = container.firstElementChild as HTMLElement
  Object.defineProperty(scroller, 'clientWidth', {
    value: clientWidth,
    configurable: true,
  })
  scroller.scrollLeft = scrollLeft
  fireEvent.scroll(scroller)
  await nextFrame() // flush the rAF-coalesced window read
  await nextFrame()
  return scroller
}

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
    expect(screen.getByText('00:01:00:00')).toBeInTheDocument() // still inside the fallback window
    expect(screen.queryByText('00:00:00:15')).not.toBeInTheDocument() // no sub-second labels at this zoom
  })

  test('runway spans 12 hours even for an empty project', () => {
    render(<Ruler />)
    expect(screen.getByTestId('ruler')).toHaveStyle({
      width: `${RUNWAY_FRAMES}px`, // zoom 1
    })
  })

  test('virtualization: only ticks near the scroll viewport exist', async () => {
    await renderScrolled(600_000) // ~5h33m in, zoom 1
    const ticks = document.querySelectorAll('.ruler-tick')
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThan(60) // NOT all ~8,640 runway ticks
    expect(screen.getByText('05:33:20:00')).toBeInTheDocument() // frame 600000
    expect(screen.queryByText('00:00:00:00')).not.toBeInTheDocument() // start is far away
  })

  test('scrolled to the far right, the runway ends on an inside-anchored 12h label', async () => {
    await renderScrolled(RUNWAY_FRAMES - 1000)
    const endLabel = screen.getByText('12:00:00:00')
    expect(endLabel).toHaveClass('ruler-label-end')
  })

  test('a doc slightly longer than the runway ends on ITS last frame, dropping a crowded neighbor', async () => {
    // 1,296,050 frames: 50px past the aligned 12h tick at zoom 1 — too
    // close for two labels, so the aligned tick yields to the end tick.
    act(() => {
      useDocumentStore.getState().setDoc(makeDoc(RUNWAY_FRAMES + 50))
    })
    await renderScrolled(RUNWAY_FRAMES - 1000)
    expect(screen.getByText('12:00:01:20')).toHaveClass('ruler-label-end')
    expect(screen.queryByText('12:00:00:00')).not.toBeInTheDocument()
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
