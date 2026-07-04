/**
 * ui/timeline/Ruler.tsx — Timecode ruler + seek surface. Phase 3.2.
 *
 * Subscribes to zoom (transport) and frameRate/duration (document) — NOT to
 * playheadFrame, so scrubbing never re-renders the ruler (Phase 3 gate).
 * Clicking/dragging the ruler IS scrubbing: pointer capture + the
 * rAF-coalescing scheduler write transportStore.playheadFrame; nothing here
 * touches documentStore.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { docDurationFrames } from '../../domain/selectors'
import { formatTimecode, secondsToFrames } from '../../domain/time'
import type { FrameRate } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { useScrubScheduler } from './useScrubScheduler'

/** Empty/short projects still show a workable runway of ruler. */
const MIN_RULER_SECONDS = 60
/** Ticks want at least this much horizontal room per label. */
const MIN_LABEL_PX = 90

/** Smallest "nice" frame interval that keeps labels at least MIN_LABEL_PX apart. */
function pickTickIntervalFrames(zoom: number, rate: FrameRate): number {
  const fps = Math.max(1, Math.round(rate.num / rate.den))
  const candidates = [
    ...new Set([1, 2, 5, 10, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60, fps * 300, fps * 600]),
  ].sort((a, b) => a - b)
  for (const candidate of candidates) {
    if (candidate * zoom >= MIN_LABEL_PX) return candidate
  }
  return candidates[candidates.length - 1]
}

export default function Ruler() {
  const zoom = useTransportStore((s) => s.zoom)
  const setIsScrubbing = useTransportStore((s) => s.setIsScrubbing)
  const setPlayheadFrame = useTransportStore((s) => s.setPlayheadFrame)
  const frameRate = useDocumentStore((s) => s.doc.frameRate)
  const durationFrames = useDocumentStore((s) => docDurationFrames(s.doc))

  const schedule = useScrubScheduler(setPlayheadFrame)

  const totalFrames = Math.max(
    durationFrames,
    secondsToFrames(MIN_RULER_SECONDS, frameRate),
  )
  const interval = pickTickIntervalFrames(zoom, frameRate)

  const ticks: number[] = []
  for (let frame = 0; frame <= totalFrames; frame += interval) {
    ticks.push(frame)
  }

  const frameFromPointer = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.round((e.clientX - rect.left) / zoom))
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
      className="timeline-ruler"
      data-testid="ruler"
      style={{ width: totalFrames * zoom }}
      onPointerDown={(e) => {
        setIsScrubbing(true)
        schedule(frameFromPointer(e))
        capturePointer(e)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          schedule(frameFromPointer(e))
        }
      }}
      onPointerUp={(e) => {
        releasePointer(e)
        schedule(frameFromPointer(e))
        setIsScrubbing(false)
      }}
    >
      {ticks.map((frame) => (
        <div
          key={frame}
          className="ruler-tick"
          style={{ transform: `translateX(${frame * zoom}px)` }}
        >
          <span className="ruler-label">{formatTimecode(frame, frameRate)}</span>
        </div>
      ))}
    </div>
  )
}
