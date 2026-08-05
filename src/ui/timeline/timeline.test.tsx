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
import { formatTimecode } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import Playhead from './Playhead'
import Ruler from './Ruler'
import Timeline from './Timeline'
import { MAX_TIMELINE_SURFACE_PX } from './timelineViewport'
import { useScrubScheduler } from './useScrubScheduler'

/** Empty 30fps doc, optionally with one clip to pin the doc duration. */
function makeDoc(durationFrames = 0): TimelineDoc {
  return {
    schemaVersion: 6,
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
                  sourceMode: 'timed',
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
    zoomMode: 'custom',
    customZoom: 1,
    timelineOriginFrame: 0,
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

function translatedX(element: HTMLElement): number {
  const match = element.style.transform.match(/translateX\(([-\d.]+)px\)/)
  return Number(match?.[1] ?? 0)
}

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

  test('positions a far playhead from the bounded timeline origin', () => {
    act(() => {
      useTransportStore.getState().setZoom(2)
      useTransportStore.getState().setTimelineOriginFrame(1_000_000)
      useTransportStore.getState().setPlayheadFrame(1_000_050)
    })
    render(<Playhead timelineWindowEndFrame={1_100_000} />)
    expect(screen.getByTestId('playhead')).toHaveStyle({
      transform: 'translateX(100px)',
    })
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

  test('very wide visible ranges keep ruler labels sparse and virtualized', async () => {
    act(() => {
      useTransportStore.getState().setZoom(1000 / (33_000 * 30))
    })
    await renderScrolled(0, 1000)
    const ticks = [...document.querySelectorAll<HTMLElement>('.ruler-tick')]
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThan(40)

    const positions = ticks.map((tick) => {
      const match = tick.style.transform.match(/translateX\(([-\d.]+)px\)/)
      return Number(match?.[1] ?? 0)
    })
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index] - positions[index - 1]).toBeGreaterThanOrEqual(90)
    }
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

  test('seek mapping adds a nonzero virtual timeline origin', async () => {
    act(() => {
      useDocumentStore.getState().setDoc(makeDoc(10_000_000))
      useTransportStore.getState().setZoom(2)
      useTransportStore.getState().setTimelineOriginFrame(1_000_000)
    })
    render(<Ruler />)
    fireEvent.pointerDown(screen.getByTestId('ruler'), {
      pointerId: 7,
      clientX: 100,
    })
    await waitFor(() =>
      expect(useTransportStore.getState().playheadFrame).toBe(1_000_050),
    )
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

  test('keeps a far max-zoom project inside the bounded physical surface', () => {
    act(() => {
      useDocumentStore.getState().setDoc(makeDoc(2_000_000))
      useTransportStore.getState().setZoom(50)
      useTransportStore.getState().setTimelineOriginFrame(1_000_000)
    })
    render(<Timeline />)

    const root = screen.getByTestId('timeline-root')
    const ruler = screen.getByTestId('ruler')
    expect(root).toHaveAttribute('data-timeline-origin-frame', '1000000')
    expect(Number.parseFloat(ruler.style.width)).toBeLessThanOrEqual(
      MAX_TIMELINE_SURFACE_PX,
    )
    expect(screen.getByTestId('clip-clipA')).toHaveStyle({
      transform: 'translateX(0px)',
      width: `${MAX_TIMELINE_SURFACE_PX}px`,
    })
  })

  test('mounted edge rebases preserve screen geometry in both directions and reset cleanly', async () => {
    const base = makeDoc(10)
    const template = base.tracks[0].clips[0]
    const nearA = {
      ...template,
      id: 'nearA',
      name: 'nearA',
      sourceRange: { startFrame: 0, durationFrames: 10 },
      timelineRange: { startFrame: 319_980, durationFrames: 10 },
    }
    const nearB = {
      ...template,
      id: 'nearB',
      name: 'nearB',
      sourceRange: { startFrame: 0, durationFrames: 1_680_010 },
      timelineRange: { startFrame: 319_990, durationFrames: 1_680_010 },
    }
    act(() => {
      useDocumentStore.getState().setDoc({
        ...base,
        tracks: [{ ...base.tracks[0], clips: [nearA, nearB] }],
      })
      useTransportStore.getState().setZoom(50)
      useTransportStore.getState().setPlayheadFrame(319_990)
    })

    const { container } = render(
      <div data-timeline-scroll>
        <Timeline />
      </div>,
    )
    const scroller = container.firstElementChild as HTMLElement
    const header = screen.getByTestId('timeline-headers')
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      right: 200,
      top: 0,
      bottom: 100,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(scroller, 'clientWidth', {
      value: 1200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollWidth', {
      configurable: true,
      get: () =>
        200 + Number.parseFloat(screen.getByTestId('ruler').style.width),
    })

    const rightEdgeScroll = MAX_TIMELINE_SURFACE_PX - 1000 - 100
    scroller.scrollLeft = rightEdgeScroll
    const clipScreenBefore =
      translatedX(screen.getByTestId('clip-nearA')) - rightEdgeScroll
    const playheadScreenBefore =
      translatedX(screen.getByTestId('playhead')) - rightEdgeScroll
    const seamScreenBefore =
      Number.parseFloat(
        screen.getByTestId('transition-seam-nearA-nearB').style.left,
      ) - rightEdgeScroll
    const visibleStartBefore = rightEdgeScroll / 50

    fireEvent.scroll(scroller)
    await nextFrame()
    await nextFrame()

    const rebasedOrigin = useTransportStore.getState().timelineOriginFrame
    expect(rebasedOrigin).toBeGreaterThan(0)
    expect(rebasedOrigin + scroller.scrollLeft / 50).toBeCloseTo(
      visibleStartBefore,
      8,
    )
    expect(
      translatedX(screen.getByTestId('clip-nearA')) - scroller.scrollLeft,
    ).toBeCloseTo(clipScreenBefore, 8)
    expect(
      translatedX(screen.getByTestId('playhead')) - scroller.scrollLeft,
    ).toBeCloseTo(playheadScreenBefore, 8)
    expect(
      Number.parseFloat(
        screen.getByTestId('transition-seam-nearA-nearB').style.left,
      ) - scroller.scrollLeft,
    ).toBeCloseTo(seamScreenBefore, 8)
    expect(
      screen.getByText(formatTimecode(319_990, base.frameRate)),
    ).toBeInTheDocument()

    scroller.scrollLeft = 100
    const leftVisibleStart = rebasedOrigin + scroller.scrollLeft / 50
    fireEvent.scroll(scroller)
    await nextFrame()

    expect(useTransportStore.getState().timelineOriginFrame).toBeLessThan(
      rebasedOrigin,
    )
    expect(
      useTransportStore.getState().timelineOriginFrame +
        scroller.scrollLeft / 50,
    ).toBeCloseTo(leftVisibleStart, 8)

    act(() => useTransportStore.getState().resetTransport())
    expect(useTransportStore.getState().timelineOriginFrame).toBe(0)
    expect(scroller.scrollLeft).toBe(0)
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
