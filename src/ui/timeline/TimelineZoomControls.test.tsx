import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimelineDoc } from '../../domain/schema'
import { docDurationFrames } from '../../domain/selectors'
import { useDocumentStore } from '../../state/documentStore'
import {
  INITIAL_TRANSPORT_STATE,
  useTransportStore,
} from '../../state/transportStore'
import TimelineZoomControls from './TimelineZoomControls'
import {
  calculateTimelineZoomGeometry,
  timelineRunwayFrames,
  zoomAtSliderPosition,
} from './timelineZoom'
import {
  MAX_TIMELINE_SURFACE_PX,
  calculateTimelineViewport,
} from './timelineViewport'

const RATE = { num: 30, den: 1 }
const LONG_PROJECT_FRAMES = 100 * 3600 * 30
const FAR_PLAYHEAD_FRAME = 8_000_000

function makeDoc(durationFrames = 6000): TimelineDoc {
  return {
    schemaVersion: 18,
    id: `doc-zoom-${durationFrames}`,
    name: 'zoom fixture',
    frameRate: RATE,
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
                  assetId: 'assetA',
                  name: 'clipA',
                  sourceMode: 'timed',
                  sourceRange: { startFrame: 0, durationFrames },
                  timelineRange: { startFrame: 0, durationFrames },
                  transform: {
                    x: 0,
                    y: 0,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    anchorX: 0.5,
                    anchorY: 0.5,
                  },
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

let nextRafId = 1
let rafCallbacks = new Map<number, FrameRequestCallback>()

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  readonly targets = new Set<Element>()
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  observe = (target: Element) => {
    this.targets.add(target)
  }

  unobserve = (target: Element) => {
    this.targets.delete(target)
  }

  disconnect = () => {
    this.targets.clear()
  }
}

function flushFrame(): void {
  const callbackIds = [...rafCallbacks.keys()]
  act(() => {
    for (const id of callbackIds) {
      const callback = rafCallbacks.get(id)
      if (!callback) continue
      rafCallbacks.delete(id)
      callback(performance.now())
    }
  })
}

function triggerResize(target: Element): void {
  act(() => {
    for (const observer of MockResizeObserver.instances) {
      if (observer.targets.has(target)) {
        observer.callback([], observer as unknown as ResizeObserver)
      }
    }
  })
}

interface HarnessGeometry {
  scrollerWidth: number
  headerWidth: number
}

function renderHarness(initial: HarnessGeometry = {
  scrollerWidth: 1450,
  headerWidth: 250,
}) {
  const measured = { ...initial }
  render(
    <div className="app-shell">
      <section className="area-transport">
        <TimelineZoomControls />
      </section>
      <section data-timeline-scroll data-testid="zoom-scroller">
        <div data-timeline-headers data-testid="zoom-header" />
      </section>
    </div>,
  )

  const scroller = screen.getByTestId('zoom-scroller') as HTMLElement
  const header = screen.getByTestId('zoom-header') as HTMLElement
  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => measured.scrollerWidth,
  })
  Object.defineProperty(scroller, 'scrollWidth', {
    configurable: true,
    get: () => {
      const doc = useDocumentStore.getState().doc
      const transport = useTransportStore.getState()
      const viewport = calculateTimelineViewport(
        timelineRunwayFrames(docDurationFrames(doc), doc.frameRate),
        transport.zoom,
        transport.timelineOriginFrame,
      )
      return Math.max(
        measured.scrollerWidth,
        measured.headerWidth + viewport.surfaceWidth,
      )
    },
  })
  Object.defineProperty(header, 'offsetWidth', {
    configurable: true,
    get: () => measured.headerWidth,
  })
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, measured.headerWidth, 320),
  )
  triggerResize(scroller)

  return { scroller, measured }
}

function readLiveViewport() {
  const doc = useDocumentStore.getState().doc
  const transport = useTransportStore.getState()
  return calculateTimelineViewport(
    timelineRunwayFrames(docDurationFrames(doc), doc.frameRate),
    transport.zoom,
    transport.timelineOriginFrame,
  )
}

function expectPlayheadCentered(scroller: HTMLElement, laneWidth: number): void {
  const state = useTransportStore.getState()
  const playheadScreenX =
    (state.playheadFrame - state.timelineOriginFrame) * state.zoom -
    scroller.scrollLeft
  expect(playheadScreenX).toBeCloseTo(laneWidth / 2, 6)
}

beforeEach(() => {
  nextRafId = 1
  rafCallbacks = new Map()
  MockResizeObserver.instances = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id)
  })
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useDocumentStore.setState({ doc: makeDoc(), past: [], future: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TimelineZoomControls', () => {
  test('renders the exact accessible control order', () => {
    renderHarness()
    const controls = screen.getByRole('group', {
      name: 'Timeline zoom controls',
    })

    expect(
      [...controls.querySelectorAll('button, input')].map((element) =>
        element.getAttribute('aria-label'),
      ),
    ).toEqual([
      'Full Extent Zoom',
      'Detail Zoom',
      'Custom Zoom',
      'Zoom Out',
      'Custom timeline zoom',
      'Zoom In',
    ])
  })

  test('Full Extent fits duration with trailing padding and scrolls to zero', () => {
    const { scroller } = renderHarness()
    act(() => useTransportStore.getState().setTimelineOriginFrame(50_000))
    scroller.scrollLeft = 900

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    const state = useTransportStore.getState()
    expect(state.zoomMode).toBe('full')
    expect(state.timelineOriginFrame).toBe(0)
    expect(state.zoom).toBeCloseTo((1200 - 36) / 6000, 12)
    expect(state.zoom * 6000).toBeCloseTo(1200 - 36, 8)
    expect(scroller.scrollLeft).toBe(900)

    flushFrame()
    expect(scroller.scrollLeft).toBe(0)
  })

  test('Full resets a long-project virtual origin and scroll without overwriting Custom', () => {
    useDocumentStore.setState({
      doc: makeDoc(LONG_PROJECT_FRAMES),
      past: [],
      future: [],
    })
    const { scroller } = renderHarness()
    act(() => {
      useTransportStore.getState().setZoom(7.25)
      useTransportStore.getState().setTimelineOriginFrame(6_000_000)
    })
    scroller.scrollLeft = 7_000_000

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))

    expect(useTransportStore.getState()).toMatchObject({
      zoomMode: 'full',
      customZoom: 7.25,
      timelineOriginFrame: 0,
    })
    expect(useTransportStore.getState().zoom).toBeCloseTo(
      (1200 - 36) / LONG_PROJECT_FRAMES,
      12,
    )
    expect(scroller.scrollLeft).toBe(7_000_000)

    flushFrame()
    expect(scroller.scrollLeft).toBe(0)
  })

  test('Detail shows about eleven seconds and centers the playhead', () => {
    const { scroller } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(1000))

    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    const expectedZoom = 1200 / (11 * 30)
    expect(useTransportStore.getState()).toMatchObject({
      zoomMode: 'detail',
      zoom: expectedZoom,
      playheadFrame: 1000,
    })

    flushFrame()
    expect(scroller.scrollLeft).toBeCloseTo(1000 * expectedZoom - 600, 8)
  })

  test('Detail keeps the exact eleven-second scale and centers a far playhead on a bounded surface', () => {
    useDocumentStore.setState({
      doc: makeDoc(LONG_PROJECT_FRAMES),
      past: [],
      future: [],
    })
    const { scroller, measured } = renderHarness()
    act(() =>
      useTransportStore.getState().setPlayheadFrame(FAR_PLAYHEAD_FRAME),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))

    const expectedZoom = 1200 / (11 * 30)
    const state = useTransportStore.getState()
    const viewport = readLiveViewport()
    expect(state.zoom).toBeCloseTo(expectedZoom, 12)
    expect(state.zoomMode).toBe('detail')
    expect(state.timelineOriginFrame).toBeGreaterThan(0)
    expect(viewport.virtualized).toBe(true)
    expect(viewport.surfaceWidth).toBeLessThanOrEqual(
      MAX_TIMELINE_SURFACE_PX,
    )
    expect(scroller.scrollWidth - measured.headerWidth).toBeCloseTo(
      viewport.surfaceWidth,
      6,
    )

    flushFrame()
    expectPlayheadCentered(scroller, 1200)
    expect(scroller.scrollLeft).toBeLessThanOrEqual(
      scroller.scrollWidth - scroller.clientWidth,
    )
  })

  test('playhead anchoring clamps at frame zero', () => {
    const { scroller } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(10))

    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    flushFrame()

    expect(scroller.scrollLeft).toBe(0)
    expect(useTransportStore.getState().playheadFrame).toBe(10)
  })

  test('Full and Detail preserve Custom, and Custom restores it exactly', () => {
    renderHarness()
    act(() => useTransportStore.getState().setZoom(0.75))
    const slider = screen.getByRole('slider', {
      name: 'Custom timeline zoom',
    }) as HTMLInputElement
    const rememberedPosition = slider.value

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    expect(useTransportStore.getState().customZoom).toBe(0.75)
    expect(slider.value).toBe(rememberedPosition)
    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    expect(useTransportStore.getState().customZoom).toBe(0.75)
    expect(slider.value).toBe(rememberedPosition)

    fireEvent.click(screen.getByRole('button', { name: 'Custom Zoom' }))
    expect(useTransportStore.getState()).toMatchObject({
      zoom: 0.75,
      customZoom: 0.75,
      zoomMode: 'custom',
    })
  })

  test('Custom restores its exact value and recenters a far playhead after presets', () => {
    useDocumentStore.setState({
      doc: makeDoc(LONG_PROJECT_FRAMES),
      past: [],
      future: [],
    })
    const { scroller } = renderHarness()
    act(() => {
      useTransportStore.getState().setPlayheadFrame(FAR_PLAYHEAD_FRAME)
      useTransportStore.getState().setZoom(7.25)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    flushFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    flushFrame()

    fireEvent.click(screen.getByRole('button', { name: 'Custom Zoom' }))
    expect(useTransportStore.getState()).toMatchObject({
      zoom: 7.25,
      customZoom: 7.25,
      zoomMode: 'custom',
    })
    expect(useTransportStore.getState().timelineOriginFrame).toBeGreaterThan(0)

    flushFrame()
    expectPlayheadCentered(scroller, 1200)
  })

  test('slider is rAF-coalesced, exponential, and latest-wins', () => {
    const { scroller } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(1000))
    const slider = screen.getByRole('slider', {
      name: 'Custom timeline zoom',
    })
    const geometry = calculateTimelineZoomGeometry(1200, 6000, RATE)
    const zoomCommits: number[] = []
    const unsubscribe = useTransportStore.subscribe((state, previous) => {
      if (state.zoom !== previous.zoom) zoomCommits.push(state.zoom)
    })

    fireEvent.input(slider, { target: { value: '0.2' } })
    fireEvent.input(slider, { target: { value: '0.5' } })
    fireEvent.input(slider, { target: { value: '0.8' } })
    expect(useTransportStore.getState().zoom).toBe(1)

    flushFrame()
    const expected = zoomAtSliderPosition(
      0.8,
      geometry.minZoom,
      geometry.maxZoom,
    )
    expect(useTransportStore.getState()).toMatchObject({
      zoomMode: 'custom',
      zoom: expected,
      customZoom: expected,
    })
    expect(zoomCommits).toEqual([expected])
    flushFrame()
    expect(scroller.scrollLeft).toBeCloseTo(1000 * expected - 600, 8)
    unsubscribe()
  })

  test('the exact 1.8-second maximum centers a far playhead while the physical surface stays bounded', () => {
    useDocumentStore.setState({
      doc: makeDoc(LONG_PROJECT_FRAMES),
      past: [],
      future: [],
    })
    const { scroller, measured } = renderHarness()
    act(() =>
      useTransportStore.getState().setPlayheadFrame(FAR_PLAYHEAD_FRAME),
    )

    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '1' } },
    )
    flushFrame()

    const state = useTransportStore.getState()
    const expectedMaxZoom = 1200 / (1.8 * 30)
    const viewport = readLiveViewport()
    expect(state.zoom).toBeCloseTo(expectedMaxZoom, 12)
    expect(state.customZoom).toBeCloseTo(expectedMaxZoom, 12)
    expect(state.zoomMode).toBe('custom')
    expect(state.timelineOriginFrame).toBeGreaterThan(0)
    expect(viewport.virtualized).toBe(true)
    expect(viewport.surfaceWidth).toBeLessThanOrEqual(
      MAX_TIMELINE_SURFACE_PX,
    )
    expect(scroller.scrollWidth - measured.headerWidth).toBeCloseTo(
      viewport.surfaceWidth,
      6,
    )

    flushFrame()
    expectPlayheadCentered(scroller, 1200)
  })

  test('a queued slider input uses resized endpoints at commit time', () => {
    const { scroller, measured } = renderHarness()
    const slider = screen.getByRole('slider', {
      name: 'Custom timeline zoom',
    })

    fireEvent.input(slider, { target: { value: '0.5' } })
    measured.scrollerWidth = 1050 // 800px lane after the measured header
    triggerResize(scroller)
    flushFrame()

    const resized = calculateTimelineZoomGeometry(800, 6000, RATE)
    expect(useTransportStore.getState().zoom).toBeCloseTo(
      zoomAtSliderPosition(0.5, resized.minZoom, resized.maxZoom),
      12,
    )
  })

  test('deferred Custom anchoring remeasures a resize after zoom commit', () => {
    const { scroller, measured } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(1000))

    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '0.7' } },
    )
    flushFrame() // commits zoom and queues the post-layout anchor
    const committedZoom = useTransportStore.getState().zoom

    measured.scrollerWidth = 1050 // lane changes from 1200px to 800px
    triggerResize(scroller) // Custom intentionally preserves its exact value
    flushFrame()

    expect(useTransportStore.getState().zoom).toBe(committedZoom)
    expectPlayheadCentered(scroller, 800)
  })

  test('minus and plus use 1.25x steps, activate Custom, and clamp', () => {
    const { scroller } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(1000))
    const geometry = calculateTimelineZoomGeometry(1200, 6000, RATE)

    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    const detailZoom = useTransportStore.getState().zoom
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }))
    expect(useTransportStore.getState()).toMatchObject({
      zoomMode: 'custom',
      zoom: detailZoom * 1.25,
      customZoom: detailZoom * 1.25,
    })
    flushFrame()
    expect(scroller.scrollLeft).toBeCloseTo(
      1000 * detailZoom * 1.25 - 600,
      8,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }))
    expect(useTransportStore.getState().zoom).toBeCloseTo(detailZoom, 12)

    const slider = screen.getByRole('slider', {
      name: 'Custom timeline zoom',
    })
    fireEvent.input(slider, { target: { value: '1' } })
    flushFrame()
    const zoomIn = screen.getByRole('button', { name: 'Zoom In' })
    expect(useTransportStore.getState().zoom).toBeCloseTo(geometry.maxZoom, 12)
    expect(zoomIn).toBeDisabled()
    fireEvent.click(zoomIn)
    expect(useTransportStore.getState().zoom).toBeCloseTo(geometry.maxZoom, 12)

    fireEvent.input(slider, { target: { value: '0' } })
    flushFrame()
    const zoomOut = screen.getByRole('button', { name: 'Zoom Out' })
    expect(useTransportStore.getState().zoom).toBeCloseTo(geometry.minZoom, 12)
    expect(zoomOut).toBeDisabled()
  })

  test('empty projects stay finite and clamped', () => {
    useDocumentStore.setState({ doc: makeDoc(0), past: [], future: [] })
    const { scroller } = renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    const geometry = calculateTimelineZoomGeometry(1200, 0, RATE)
    expect(useTransportStore.getState().zoom).toBe(geometry.maxZoom)
    expect(Number.isFinite(useTransportStore.getState().zoom)).toBe(true)
    flushFrame()
    expect(scroller.scrollLeft).toBe(0)
  })

  test('Full recomputes on resize and project-duration changes', () => {
    const { scroller, measured } = renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    flushFrame()

    measured.scrollerWidth = 1050 // 800px lane after the measured 250px header
    triggerResize(scroller)
    expect(useTransportStore.getState().zoom).toBeCloseTo((800 - 32) / 6000, 12)
    flushFrame()
    expect(scroller.scrollLeft).toBe(0)

    act(() => useDocumentStore.getState().setDoc(makeDoc(12_000)))
    expect(useTransportStore.getState().zoom).toBeCloseTo(
      (800 - 32) / 12_000,
      12,
    )
  })

  test('Detail recomputes and recenters on responsive lane changes', () => {
    const { scroller, measured } = renderHarness()
    act(() => useTransportStore.getState().setPlayheadFrame(1000))
    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    flushFrame()

    measured.scrollerWidth = 1250 // 1000px lane after the measured header
    triggerResize(scroller)
    const expectedZoom = 1000 / (11 * 30)
    expect(useTransportStore.getState()).toMatchObject({
      zoom: expectedZoom,
      zoomMode: 'detail',
    })
    flushFrame()
    expect(scroller.scrollLeft).toBeCloseTo(1000 * expectedZoom - 500, 8)
  })

  test('a pending slider frame cannot override a subsequently chosen preset', () => {
    const { scroller } = renderHarness()
    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '0.9' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))

    flushFrame()
    flushFrame()
    expect(useTransportStore.getState().zoomMode).toBe('full')
    expect(scroller.scrollLeft).toBe(0)
  })

  test('slider input cancels a preset anchor queued earlier in the frame', () => {
    const { scroller } = renderHarness()
    scroller.scrollLeft = 375
    act(() => useTransportStore.getState().setPlayheadFrame(1000))

    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '0.7' } },
    )

    flushFrame()
    expect(useTransportStore.getState().zoomMode).toBe('custom')
    expect(scroller.scrollLeft).toBe(375)

    const customZoom = useTransportStore.getState().zoom
    flushFrame()
    expect(scroller.scrollLeft).toBeCloseTo(1000 * customZoom - 600, 8)
  })

  test('resetTransport cancels a pending slider frame even from initial state', () => {
    renderHarness()
    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '0.9' } },
    )

    act(() => useTransportStore.getState().resetTransport())
    flushFrame()

    expect(useTransportStore.getState()).toMatchObject({
      zoom: 1,
      zoomMode: 'custom',
      customZoom: 1,
    })
  })

  test('Custom values survive responsive geometry changes unchanged', () => {
    const { scroller, measured } = renderHarness()
    act(() => useTransportStore.getState().setZoom(0.875))

    measured.scrollerWidth = 1050
    triggerResize(scroller)

    expect(useTransportStore.getState()).toMatchObject({
      zoom: 0.875,
      customZoom: 0.875,
      zoomMode: 'custom',
    })
  })

  test('zoom actions never mutate playhead, document, or undo history', () => {
    const doc = makeDoc()
    const past = [makeDoc(100)]
    const future = [makeDoc(200)]
    useDocumentStore.setState({ doc, past, future })
    act(() => useTransportStore.getState().setPlayheadFrame(123))
    act(() => useTransportStore.getState().setSelectedClip('clipA'))
    renderHarness()

    const before = useDocumentStore.getState()
    fireEvent.click(screen.getByRole('button', { name: 'Full Extent Zoom' }))
    fireEvent.click(screen.getByRole('button', { name: 'Detail Zoom' }))
    fireEvent.click(screen.getByRole('button', { name: 'Custom Zoom' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }))
    fireEvent.input(
      screen.getByRole('slider', { name: 'Custom timeline zoom' }),
      { target: { value: '0.6' } },
    )
    flushFrame()

    const after = useDocumentStore.getState()
    expect(after.doc).toBe(before.doc)
    expect(after.past).toBe(before.past)
    expect(after.future).toBe(before.future)
    expect(useTransportStore.getState().playheadFrame).toBe(123)
    expect(useTransportStore.getState().selectedClipId).toBe('clipA')
  })
})
