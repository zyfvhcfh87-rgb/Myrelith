/**
 * DaVinci-style three-mode timeline zoom controls.
 *
 * All persistent geometry still flows through transportStore.zoom, the one
 * authoritative pixels-per-frame value already consumed by the ruler,
 * clips, playhead, transitions, filmstrips, and waveforms. DOM measurement
 * and scroll anchoring stay here in UI/session space; documentStore is never
 * read or written by an interaction.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowsOutLineHorizontal,
  MagnifyingGlassPlus,
  Minus,
  Plus,
  SlidersHorizontal,
} from '@phosphor-icons/react'
import { timelineDisplayDurationFrames } from '../../domain/selectors'
import { useDocumentStore } from '../../state/documentStore'
import {
  getTransportResetRevision,
  useTransportStore,
} from '../../state/transportStore'
import {
  ZOOM_STEP,
  calculateTimelineZoomGeometry,
  clampTimelineZoom,
  sliderPositionForZoom,
  timelineRunwayFrames,
  zoomAtSliderPosition,
} from './timelineZoom'
import type { TimelineZoomGeometry } from './timelineZoom'
import {
  findTimelineScroller,
  measureTimelineLaneWidth,
  planTimelineAnchor,
  planTimelineStart,
} from './timelineViewport'

type ScrollAnchor = 'start' | 'playhead'

function sameGeometry(
  left: TimelineZoomGeometry,
  right: TimelineZoomGeometry,
): boolean {
  return (
    left.laneWidth === right.laneWidth &&
    left.minZoom === right.minZoom &&
    left.maxZoom === right.maxZoom &&
    left.fullZoom === right.fullZoom &&
    left.detailZoom === right.detailZoom
  )
}

export default function TimelineZoomControls() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sliderRafRef = useRef(0)
  const anchorRafRef = useRef(0)
  const pendingSliderPositionRef = useRef<number | null>(null)
  const pendingSliderResetRevisionRef = useRef(0)

  const zoom = useTransportStore((state) => state.zoom)
  const zoomMode = useTransportStore((state) => state.zoomMode)
  const customZoom = useTransportStore((state) => state.customZoom)
  const frameRate = useDocumentStore((state) => state.doc.frameRate)
  const durationFrames = useDocumentStore((state) =>
    timelineDisplayDurationFrames(state.doc),
  )

  const [geometry, setGeometry] = useState(() =>
    calculateTimelineZoomGeometry(1, durationFrames, frameRate),
  )
  const geometryRef = useRef(geometry)

  const updateGeometryState = useCallback((next: TimelineZoomGeometry) => {
    geometryRef.current = next
    setGeometry((current) => (sameGeometry(current, next) ? current : next))
  }, [])

  const scheduleScroll = useCallback(
    (newZoom: number, anchor: ScrollAnchor): void => {
      if (anchorRafRef.current) cancelAnimationFrame(anchorRafRef.current)
      const scroller = findTimelineScroller(rootRef.current)
      if (!scroller) return

      const laneWidth = measureTimelineLaneWidth(scroller)
      const doc = useDocumentStore.getState().doc
      const totalFrames = timelineRunwayFrames(
        timelineDisplayDurationFrames(doc),
        doc.frameRate,
      )
      const transport = useTransportStore.getState()
      const initialPlan =
        anchor === 'start'
          ? planTimelineStart()
          : planTimelineAnchor(
              totalFrames,
              newZoom,
              laneWidth,
              transport.playheadFrame,
            )
      transport.setTimelineOriginFrame(initialPlan.originFrame)
      const resetRevision = getTransportResetRevision()

      // The origin + zoom render commits before this frame. Only then read the
      // new native width and apply the bounded physical scroll position.
      anchorRafRef.current = requestAnimationFrame(() => {
        anchorRafRef.current = 0
        if (resetRevision !== getTransportResetRevision()) return
        const liveScroller = findTimelineScroller(rootRef.current)
        if (!liveScroller) return
        const liveDoc = useDocumentStore.getState().doc
        const liveTransport = useTransportStore.getState()
        const livePlan =
          anchor === 'start'
            ? planTimelineStart()
            : planTimelineAnchor(
                timelineRunwayFrames(
                  timelineDisplayDurationFrames(liveDoc),
                  liveDoc.frameRate,
                ),
                newZoom,
                measureTimelineLaneWidth(liveScroller),
                liveTransport.playheadFrame,
              )
        if (liveTransport.timelineOriginFrame !== livePlan.originFrame) {
          flushSync(() =>
            liveTransport.setTimelineOriginFrame(livePlan.originFrame),
          )
        }
        const maximumScrollLeft = Math.max(
          0,
          liveScroller.scrollWidth - liveScroller.clientWidth,
        )
        liveScroller.scrollLeft = Math.min(
          maximumScrollLeft,
          Math.max(0, livePlan.scrollLeft),
        )
      })
    },
    [],
  )

  const readCurrentGeometry = useCallback((): TimelineZoomGeometry => {
    const scroller = findTimelineScroller(rootRef.current)
    if (!scroller) return geometryRef.current
    const doc = useDocumentStore.getState().doc
    const next = calculateTimelineZoomGeometry(
      measureTimelineLaneWidth(scroller),
      timelineDisplayDurationFrames(doc),
      doc.frameRate,
    )
    updateGeometryState(next)
    return next
  }, [updateGeometryState])

  const cancelPendingSlider = (): void => {
    pendingSliderPositionRef.current = null
    if (sliderRafRef.current) {
      cancelAnimationFrame(sliderRafRef.current)
      sliderRafRef.current = 0
    }
  }

  const applyPreset = (mode: 'full' | 'detail'): void => {
    cancelPendingSlider()
    const current = readCurrentGeometry()
    const nextZoom = mode === 'full' ? current.fullZoom : current.detailZoom
    useTransportStore.getState().setPresetZoom(mode, nextZoom)
    scheduleScroll(nextZoom, mode === 'full' ? 'start' : 'playhead')
  }

  const applyCustom = (nextZoom: number): void => {
    useTransportStore.getState().setZoom(nextZoom)
    scheduleScroll(nextZoom, 'playhead')
  }

  const restoreCustom = (): void => {
    cancelPendingSlider()
    applyCustom(useTransportStore.getState().customZoom)
  }

  const stepCustom = (direction: -1 | 1): void => {
    cancelPendingSlider()
    const current = readCurrentGeometry()
    const renderedZoom = useTransportStore.getState().zoom
    const nextZoom = clampTimelineZoom(
      direction > 0 ? renderedZoom * ZOOM_STEP : renderedZoom / ZOOM_STEP,
      current.minZoom,
      current.maxZoom,
    )
    if (nextZoom === renderedZoom) return
    applyCustom(nextZoom)
  }

  const onSliderInput = (event: FormEvent<HTMLInputElement>): void => {
    // If a preset was chosen earlier in this same frame, its old anchor must
    // not paint before the slider's Custom commit and replacement anchor.
    if (anchorRafRef.current) {
      cancelAnimationFrame(anchorRafRef.current)
      anchorRafRef.current = 0
    }
    const position = Number(event.currentTarget.value)
    pendingSliderPositionRef.current = position
    pendingSliderResetRevisionRef.current = getTransportResetRevision()
    if (sliderRafRef.current) return
    sliderRafRef.current = requestAnimationFrame(() => {
      sliderRafRef.current = 0
      const nextPosition = pendingSliderPositionRef.current
      const resetRevision = pendingSliderResetRevisionRef.current
      pendingSliderPositionRef.current = null
      if (
        nextPosition === null ||
        resetRevision !== getTransportResetRevision()
      ) {
        return
      }

      // Endpoints can change while a range event is waiting for its frame
      // (ResizeObserver or a Full-mode duration update). Convert the latest
      // slider position only after re-reading the live viewport geometry.
      const current = readCurrentGeometry()
      applyCustom(
        zoomAtSliderPosition(
          nextPosition,
          current.minZoom,
          current.maxZoom,
        ),
      )
    })
  }

  // The scroller is the responsive viewport owner. Re-measure the real
  // sticky header on every notification, then reapply only active presets;
  // Custom retains its exact remembered/rendered value through resizes.
  useLayoutEffect(() => {
    const scroller = findTimelineScroller(rootRef.current)
    if (!scroller) return

    const recompute = () => {
      const next = readCurrentGeometry()
      const state = useTransportStore.getState()
      if (state.zoomMode === 'full') {
        state.setPresetZoom('full', next.fullZoom)
        scheduleScroll(next.fullZoom, 'start')
      } else if (state.zoomMode === 'detail') {
        state.setPresetZoom('detail', next.detailZoom)
        scheduleScroll(next.detailZoom, 'playhead')
      }
    }

    recompute()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(recompute)
    observer.observe(scroller)
    const header = scroller.querySelector<HTMLElement>('[data-timeline-headers]')
    if (header) observer.observe(header)
    return () => observer.disconnect()
  }, [durationFrames, frameRate, readCurrentGeometry, scheduleScroll])

  useEffect(
    () => () => {
      cancelPendingSlider()
      if (anchorRafRef.current) cancelAnimationFrame(anchorRafRef.current)
    },
    [],
  )

  const sliderPosition = sliderPositionForZoom(
    customZoom,
    geometry.minZoom,
    geometry.maxZoom,
  )
  const epsilon = 1e-9
  const atMinimum = zoom <= geometry.minZoom * (1 + epsilon)
  const atMaximum = zoom >= geometry.maxZoom * (1 - epsilon)

  return (
    <div
      ref={rootRef}
      className="timeline-zoom-controls"
      role="group"
      aria-label="Timeline zoom controls"
    >
      <button
        type="button"
        className={`timeline-zoom-button${zoomMode === 'full' ? ' active' : ''}`}
        title="Full Extent Zoom"
        aria-label="Full Extent Zoom"
        aria-pressed={zoomMode === 'full'}
        onClick={() => applyPreset('full')}
      >
        <ArrowsOutLineHorizontal aria-hidden="true" size={16} weight="bold" />
      </button>
      <button
        type="button"
        className={`timeline-zoom-button${zoomMode === 'detail' ? ' active' : ''}`}
        title="Detail Zoom"
        aria-label="Detail Zoom"
        aria-pressed={zoomMode === 'detail'}
        onClick={() => applyPreset('detail')}
      >
        <MagnifyingGlassPlus aria-hidden="true" size={16} weight="bold" />
      </button>
      <button
        type="button"
        className={`timeline-zoom-button${zoomMode === 'custom' ? ' active' : ''}`}
        title="Custom Zoom"
        aria-label="Custom Zoom"
        aria-pressed={zoomMode === 'custom'}
        onClick={restoreCustom}
      >
        <SlidersHorizontal aria-hidden="true" size={16} weight="bold" />
      </button>
      <button
        type="button"
        className="timeline-zoom-button timeline-zoom-step"
        title="Zoom Out"
        aria-label="Zoom Out"
        disabled={atMinimum}
        onClick={() => stepCustom(-1)}
      >
        <Minus aria-hidden="true" size={15} weight="bold" />
      </button>
      <input
        className="timeline-zoom-slider"
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={sliderPosition}
        aria-label="Custom timeline zoom"
        onInput={onSliderInput}
      />
      <button
        type="button"
        className="timeline-zoom-button timeline-zoom-step"
        title="Zoom In"
        aria-label="Zoom In"
        disabled={atMaximum}
        onClick={() => stepCustom(1)}
      >
        <Plus aria-hidden="true" size={15} weight="bold" />
      </button>
    </div>
  )
}
