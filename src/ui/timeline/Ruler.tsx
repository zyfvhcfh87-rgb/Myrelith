/**
 * ui/timeline/Ruler.tsx — Timecode ruler + seek surface. Phase 3.2;
 * 12-hour virtualized runway since 4.0.6.
 *
 * Subscribes to zoom/marker selection (transport) and frameRate/display extent
 * (document) — NOT to playheadFrame, so scrubbing never re-renders the ruler
 * (Phase 3 gate).
 * Clicking/dragging the ruler IS scrubbing: pointer capture + the
 * rAF-coalescing scheduler write transportStore.playheadFrame; nothing here
 * touches documentStore.
 *
 * Virtualization: one browser-safe ruler surface spans a bounded frame window
 * of the logical runway, while tick DIVs exist only for the stretch near the
 * viewport. A 12h runway at 1px/frame would otherwise be ~8,600 nodes, and at
 * maximum zoom its DOM width would exceed browser layout limits. The
 * scrollable ancestor is found via the
 * [data-timeline-scroll] attribute (app shell marks it); scroll updates are
 * rAF-coalesced local state, so scrolling re-renders the ruler alone and
 * store-driven isolation is untouched. Without a marked ancestor (bare
 * component tests) a fixed fallback window from frame 0 applies.
 *
 * The runway's final frame always gets a tick, its label anchored inside
 * the right edge (and a would-be-crowded neighbor tick is dropped), so
 * scrolling all the way right ends on a clean labeled mark.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { timelineDisplayDurationFrames } from '../../domain/selectors'
import { formatTimecode, secondsToFrames } from '../../domain/time'
import { timelineMarkers } from '../../domain/timelineMarkers'
import {
  resolveTimelineSnap,
  timelineSnapCandidates,
  type TimelineSnapCandidate,
  type TimelineSnapGuide,
} from '../../domain/timelineSnapping'
import type { FrameRate } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { usePreferencesStore } from '../../state/preferencesStore'
import { useTransportStore } from '../../state/transportStore'
import { isPrimaryEditingPointer } from '../pointerButtons'
import { useScrubScheduler } from './useScrubScheduler'
import { timelineRunwayFrames } from './timelineZoom'
import {
  calculateTimelineViewport,
  frameAtTimelineClientX,
  frameToTimelineLocalPx,
  measureTimelineLaneWidth,
} from './timelineViewport'
import TimelineMarkers from './TimelineMarkers'
import { editorContextMenuIdentity } from '../../app/editorContextMenuCommands'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from '../editorContextMenuController'

/** Ticks want at least this much horizontal room per label. */
const MIN_LABEL_PX = 90
/** Window width assumed when no scrollable ancestor exists (bare tests). */
const FALLBACK_VIEWPORT_PX = 4000

/** Smallest "nice" frame interval that keeps labels at least MIN_LABEL_PX apart. */
function pickTickIntervalFrames(zoom: number, rate: FrameRate): number {
  const seconds = [
    1,
    2,
    5,
    10,
    30,
    60,
    300,
    600,
    1800,
    3600,
    7200,
    21600,
    43200,
  ]
  const candidates = [
    ...new Set([
      1,
      2,
      5,
      10,
      ...seconds.map((value) => secondsToFrames(value, rate)),
    ]),
  ].sort((a, b) => a - b)
  for (const candidate of candidates) {
    if (candidate * zoom >= MIN_LABEL_PX) return candidate
  }
  let interval = candidates[candidates.length - 1]
  while (
    interval * zoom < MIN_LABEL_PX &&
    interval <= Number.MAX_SAFE_INTEGER / 2
  ) {
    interval *= 2
  }
  return interval
}

/** The horizontal slice of the scroll viewport the ruler must cover. */
interface ViewWindow {
  leftPx: number
  widthPx: number
}

interface RulerSnapUpdate {
  frame: number
  guide: TimelineSnapGuide | null
}

export default function Ruler() {
  const contextMenu = useEditorContextMenu()
  const zoom = useTransportStore((s) => s.zoom)
  const timelineOriginFrame = useTransportStore((s) => s.timelineOriginFrame)
  const setIsScrubbing = useTransportStore((s) => s.setIsScrubbing)
  const setPlayheadFrame = useTransportStore((s) => s.setPlayheadFrame)
  const setSnapGuide = useTransportStore((s) => s.setSnapGuide)
  const frameRate = useDocumentStore((s) => s.doc.frameRate)
  const durationFrames = useDocumentStore((s) => timelineDisplayDurationFrames(s.doc))
  const markers = useDocumentStore((s) => timelineMarkers(s.doc))
  const timelineInFrame = useTransportStore((s) => s.timelineInFrame)
  const timelineOutExclusive = useTransportStore((s) => s.timelineOutExclusive)

  const [seekFocused, setSeekFocused] = useState(false)
  const playheadFrame = useTransportStore((s) => (
    seekFocused ? s.playheadFrame : -1
  ))
  const scrubbingRef = useRef(false)
  const scrubbingPointerIdRef = useRef<number | null>(null)
  const seekOriginFrameRef = useRef(0)
  const snapCandidatesRef = useRef<readonly TimelineSnapCandidate[]>([])
  const schedule = useScrubScheduler((update: RulerSnapUpdate) => {
    setPlayheadFrame(update.frame)
    setSnapGuide(scrubbingRef.current ? update.guide : null)
  })
  /** Our own gesture flag — capture status is NOT the source of truth. */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<ViewWindow>({
    leftPx: 0,
    widthPx: FALLBACK_VIEWPORT_PX,
  })

  // Track the scrollable ancestor's window; rAF-coalesced so a scroll
  // gesture costs at most one ruler re-render per animation frame.
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest('[data-timeline-scroll]')
    if (!(scroller instanceof HTMLElement)) return

    const read = () =>
      setView((prev) => {
        const leftPx = scroller.scrollLeft
        const widthPx = measureTimelineLaneWidth(scroller) || FALLBACK_VIEWPORT_PX
        return prev.leftPx === leftPx && prev.widthPx === widthPx
          ? prev
          : { leftPx, widthPx }
      })

    let rafId = 0
    const onScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        read()
      })
    }
    read()
    // Lazy editor CSS can settle after the first layout effect. Observe the
    // real scroller/header so marker edge feedback never uses the pre-style
    // full width and lands behind the sticky gutter or browser scrollbar.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onScroll)
      observer.observe(scroller)
      const header = scroller.querySelector<HTMLElement>('[data-timeline-headers]')
      if (header) observer.observe(header)
    }
    onScroll()
    // The in-app browser intentionally omits ResizeObserver. Re-read after a
    // painted frame as a deterministic fallback for lazy CSS/header sizing.
    let settleRafId = requestAnimationFrame(() => {
      settleRafId = requestAnimationFrame(() => {
        settleRafId = 0
        read()
      })
    })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      observer?.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
      if (settleRafId) cancelAnimationFrame(settleRafId)
    }
  }, [timelineOriginFrame, zoom])

  const totalFrames = timelineRunwayFrames(durationFrames, frameRate)
  const viewport = calculateTimelineViewport(
    totalFrames,
    zoom,
    timelineOriginFrame,
  )
  const interval = pickTickIntervalFrames(zoom, frameRate)

  // Ticks for the viewport plus one viewport of overscan on each side.
  const windowStartPx = Math.max(0, view.leftPx - view.widthPx)
  const windowEndPx = view.leftPx + view.widthPx * 2
  const firstWindowFrame = viewport.originFrame + windowStartPx / zoom
  const firstTick =
    Math.max(0, Math.floor(firstWindowFrame / interval)) * interval
  const lastWindowFrame = Math.min(
    viewport.endFrame,
    viewport.originFrame + Math.ceil(windowEndPx / zoom),
  )

  const ticks: number[] = []
  for (let frame = firstTick; frame <= lastWindowFrame; frame += interval) {
    ticks.push(frame)
  }
  // The runway ends ON a labeled mark: force the final tick, dropping a
  // neighbor that would sit closer than one label width to it.
  if (lastWindowFrame === totalFrames) {
    while (ticks.length > 0) {
      const last = ticks[ticks.length - 1]
      if (
        last === totalFrames ||
        (totalFrames - last) * zoom >= MIN_LABEL_PX
      )
        break
      ticks.pop()
    }
    if (ticks[ticks.length - 1] !== totalFrames) ticks.push(totalFrames)
  }

  const frameFromPointer = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return frameAtTimelineClientX(
      e.clientX,
      rect.left,
      viewport.originFrame,
      zoom,
      0,
      viewport.totalFrames,
    )
  }

  const snapFromPointer = (
    e: ReactPointerEvent<HTMLDivElement>,
  ): RulerSnapUpdate => {
    const frame = frameFromPointer(e)
    if (e.altKey || !usePreferencesStore.getState().snappingEnabled) {
      return { frame, guide: null }
    }
    const resolution = resolveTimelineSnap({
      candidates: snapCandidatesRef.current,
      movingPoints: [{
        id: 'playhead',
        kind: 'cursor',
        frame,
        deltaDirection: 1,
        trackKind: null,
        trackIndex: -1,
      }],
      rawDeltaFrames: frame,
      minDeltaFrames: 0,
      maxDeltaFrames: viewport.totalFrames,
      zoom,
    })
    return { frame: resolution.deltaFrames, guide: resolution.guide }
  }

  const endScrub = (): void => {
    scrubbingRef.current = false
    scrubbingPointerIdRef.current = null
    snapCandidatesRef.current = []
    setIsScrubbing(false)
    setSnapGuide(null)
  }

  // Capture can throw (inactive/synthetic pointer, detached node) — the
  // seek itself must never depend on it, so it runs first and capture is
  // best-effort.
  const capturePointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* keep scrubbing off the capture path */
    }
  }
  const releasePointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* nothing to release */
    }
  }

  const lastSeekFrame = Math.max(0, totalFrames)
  const announcedPlayhead = playheadFrame >= 0
    ? playheadFrame
    : useTransportStore.getState().playheadFrame

  const snapSeekFrame = (frame: number, bypassSnapping: boolean): RulerSnapUpdate => {
    const bounded = Math.min(lastSeekFrame, Math.max(0, frame))
    if (bypassSnapping || !usePreferencesStore.getState().snappingEnabled) {
      return { frame: bounded, guide: null }
    }
    const resolution = resolveTimelineSnap({
      candidates: snapCandidatesRef.current,
      movingPoints: [{
        id: 'playhead',
        kind: 'cursor',
        frame: bounded,
        deltaDirection: 1,
        trackKind: null,
        trackIndex: -1,
      }],
      rawDeltaFrames: bounded,
      minDeltaFrames: 0,
      maxDeltaFrames: viewport.totalFrames,
      zoom,
    })
    return { frame: resolution.deltaFrames, guide: resolution.guide }
  }

  const seekTo = (frame: number, bypassSnapping: boolean): void => {
    snapCandidatesRef.current = timelineSnapCandidates(
      useDocumentStore.getState().doc,
    )
    const update = snapSeekFrame(frame, bypassSnapping)
    setPlayheadFrame(update.frame)
    setSnapGuide(update.guide)
  }

  const handleSeekKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = useTransportStore.getState().playheadFrame
    const second = secondsToFrames(1, frameRate)
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = current - (event.shiftKey ? 10 : 1)
    else if (event.key === 'ArrowRight') next = current + (event.shiftKey ? 10 : 1)
    else if (event.key === 'PageUp') next = current - second
    else if (event.key === 'PageDown') next = current + second
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = lastSeekFrame
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setPlayheadFrame(seekOriginFrameRef.current)
      setSnapGuide(null)
      setIsScrubbing(false)
      return
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    seekTo(next, event.altKey)
  }

  return (
    <div
      ref={rootRef}
      className="timeline-ruler"
      data-testid="ruler"
      style={{ width: viewport.surfaceWidth }}
      onContextMenu={(event) => {
        if (
          event.target instanceof Element
          && event.target.closest(
            '.timeline-marker, .timeline-marker-offscreen, .timeline-marker-editor',
          )
        ) return
        const rect = event.currentTarget.getBoundingClientRect()
        const frame = event.clientX === 0 && event.clientY === 0
          ? useTransportStore.getState().playheadFrame
          : frameAtTimelineClientX(
              event.clientX,
              rect.left,
              useTransportStore.getState().timelineOriginFrame,
              useTransportStore.getState().zoom,
              0,
              viewport.totalFrames,
            )
        openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'ruler',
            frame,
          },
          restoreFocusTo: event.target instanceof HTMLElement
            ? event.target
            : event.currentTarget,
        })
      }}
      onPointerDown={(e) => {
        if (!isPrimaryEditingPointer(e)) return
        scrubbingRef.current = true
        scrubbingPointerIdRef.current = e.pointerId
        snapCandidatesRef.current = timelineSnapCandidates(
          useDocumentStore.getState().doc,
        )
        setIsScrubbing(true)
        schedule(snapFromPointer(e))
        capturePointer(e)
      }}
      onPointerMove={(e) => {
        if (
          scrubbingRef.current
          && scrubbingPointerIdRef.current === e.pointerId
        ) {
          schedule(snapFromPointer(e))
        }
      }}
      onPointerUp={(e) => {
        if (
          scrubbingPointerIdRef.current !== e.pointerId
          || !isPrimaryEditingPointer(e)
        ) return
        scrubbingRef.current = false
        scrubbingPointerIdRef.current = null
        releasePointer(e)
        schedule(snapFromPointer(e))
        snapCandidatesRef.current = []
        setIsScrubbing(false)
        setSnapGuide(null)
      }}
      onPointerCancel={(e) => {
        if (scrubbingPointerIdRef.current === e.pointerId) endScrub()
      }}
      onLostPointerCapture={(e) => {
        if (
          scrubbingRef.current
          && scrubbingPointerIdRef.current === e.pointerId
        ) endScrub()
      }}
      onPointerLeave={(e) => {
        // Capture failed and the pointer left: end the scrub cleanly.
        if (scrubbingRef.current && !e.currentTarget.hasPointerCapture(e.pointerId)) {
          endScrub()
        }
      }}
    >
      <div
        className="timeline-ruler-seek"
        role="slider"
        tabIndex={0}
        data-testid="ruler-seek"
        aria-label="Timeline playhead"
        aria-valuemin={0}
        aria-valuemax={lastSeekFrame}
        aria-valuenow={announcedPlayhead}
        aria-valuetext={formatTimecode(announcedPlayhead, frameRate)}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End PageUp PageDown"
        aria-describedby="timeline-ruler-seek-help"
        onFocus={() => {
          seekOriginFrameRef.current = useTransportStore.getState().playheadFrame
          setSeekFocused(true)
        }}
        onBlur={() => {
          setSeekFocused(false)
          setSnapGuide(null)
          setIsScrubbing(false)
        }}
        onKeyDown={handleSeekKeyDown}
      />
      <span id="timeline-ruler-seek-help" className="visually-hidden">
        Arrow keys move one frame, Shift+arrow moves ten, Page Up and Page Down
        move one second, Home and End jump to the bounds, Escape restores the
        playhead from when this ruler received focus, and Alt bypasses snapping.
      </span>
      {ticks.map((frame) => (
        <div
          key={frame}
          className="ruler-tick"
          style={{
            transform: `translateX(${frameToTimelineLocalPx(frame, viewport.originFrame, zoom)}px)`,
          }}
        >
          <span
            className={
              frame === totalFrames ? 'ruler-label ruler-label-end' : 'ruler-label'
            }
          >
            {formatTimecode(frame, frameRate)}
          </span>
        </div>
      ))}
      {(timelineInFrame !== null || timelineOutExclusive !== null) ? (
        <div className="timeline-in-out" data-testid="timeline-in-out" aria-hidden="true">
          {timelineInFrame !== null
            && timelineOutExclusive !== null
            && timelineOutExclusive > timelineInFrame
            ? (
              <div
                className="timeline-in-out-range"
                style={{
                  transform: `translateX(${frameToTimelineLocalPx(
                    timelineInFrame,
                    viewport.originFrame,
                    zoom,
                  )}px)`,
                  width: (timelineOutExclusive - timelineInFrame) * zoom,
                }}
              />
            )
            : null}
          {timelineInFrame !== null ? (
            <div
              className="timeline-in-out-mark timeline-in-out-mark-in"
              style={{
                transform: `translateX(${frameToTimelineLocalPx(
                  timelineInFrame,
                  viewport.originFrame,
                  zoom,
                )}px)`,
              }}
            >
              <span className="timeline-in-out-mark-label">I</span>
            </div>
          ) : null}
          {timelineOutExclusive !== null ? (
            <div
              className="timeline-in-out-mark timeline-in-out-mark-out"
              style={{
                transform: `translateX(${frameToTimelineLocalPx(
                  timelineOutExclusive,
                  viewport.originFrame,
                  zoom,
                )}px)`,
              }}
            >
              <span className="timeline-in-out-mark-label">O</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <TimelineMarkers
        markers={markers}
        frameRate={frameRate}
        totalFrames={totalFrames}
        originFrame={viewport.originFrame}
        zoom={zoom}
        viewLeftPx={view.leftPx}
        viewWidthPx={view.widthPx}
      />
    </div>
  )
}
