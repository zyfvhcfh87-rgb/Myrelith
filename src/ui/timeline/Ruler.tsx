/**
 * ui/timeline/Ruler.tsx — Timecode ruler + seek surface. Phase 3.2;
 * 12-hour virtualized runway since 4.0.6.
 *
 * Subscribes to zoom (transport) and frameRate/duration (document) — NOT to
 * playheadFrame, so scrubbing never re-renders the ruler (Phase 3 gate).
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
import type { PointerEvent as ReactPointerEvent } from 'react'
import { docDurationFrames } from '../../domain/selectors'
import { formatTimecode, secondsToFrames } from '../../domain/time'
import type { FrameRate } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { useScrubScheduler } from './useScrubScheduler'
import { timelineRunwayFrames } from './timelineZoom'
import {
  calculateTimelineViewport,
  frameAtTimelineLocalPx,
  frameToTimelineLocalPx,
} from './timelineViewport'

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

export default function Ruler() {
  const zoom = useTransportStore((s) => s.zoom)
  const timelineOriginFrame = useTransportStore((s) => s.timelineOriginFrame)
  const setIsScrubbing = useTransportStore((s) => s.setIsScrubbing)
  const setPlayheadFrame = useTransportStore((s) => s.setPlayheadFrame)
  const frameRate = useDocumentStore((s) => s.doc.frameRate)
  const durationFrames = useDocumentStore((s) => docDurationFrames(s.doc))

  const schedule = useScrubScheduler(setPlayheadFrame)
  /** Our own gesture flag — capture status is NOT the source of truth. */
  const scrubbingRef = useRef(false)

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
        const widthPx = scroller.clientWidth || FALLBACK_VIEWPORT_PX
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
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
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
    return frameAtTimelineLocalPx(
      e.clientX - rect.left,
      viewport.originFrame,
      zoom,
    )
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

  return (
    <div
      ref={rootRef}
      className="timeline-ruler"
      data-testid="ruler"
      style={{ width: viewport.surfaceWidth }}
      onPointerDown={(e) => {
        scrubbingRef.current = true
        setIsScrubbing(true)
        schedule(frameFromPointer(e))
        capturePointer(e)
      }}
      onPointerMove={(e) => {
        if (scrubbingRef.current) {
          schedule(frameFromPointer(e))
        }
      }}
      onPointerUp={(e) => {
        scrubbingRef.current = false
        releasePointer(e)
        schedule(frameFromPointer(e))
        setIsScrubbing(false)
      }}
      onPointerLeave={(e) => {
        // Capture failed and the pointer left: end the scrub cleanly.
        if (scrubbingRef.current && !e.currentTarget.hasPointerCapture(e.pointerId)) {
          scrubbingRef.current = false
          setIsScrubbing(false)
        }
      }}
    >
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
    </div>
  )
}
