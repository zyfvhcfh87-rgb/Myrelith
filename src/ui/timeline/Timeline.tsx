/**
 * ui/timeline/Timeline.tsx — Timeline container. Phase 3.2+3.3; header
 * gutter + track display order since the timeline tracks upgrade.
 *
 * Two sticky-aligned columns inside the horizontal scroll container:
 *   [ headers gutter | lanes ]
 * The GUTTER (position: sticky, left: 0) holds a TrackHeader per track and
 * the add-track buttons; the LANES column hosts Ruler, Track lanes and
 * Playhead as before — its left edge is the x-origin for frame 0, so all
 * px→frame math (ruler seeks, drops, clip drags) is untouched by the
 * gutter's existence.
 *
 * Tracks render in domain tracksInDisplayOrder: video tracks TOP-DOWN from
 * the topmost composite layer (V2 above V1 — doc order is compositing
 * order, tracks[0] = bottom), then audio tracks below. Both columns map
 * the same ordered array, so header row i always faces lane row i.
 *
 * Subscribes to the doc, active tool, authoritative zoom, and the rare
 * bounded-surface origin. It never subscribes to playhead movement (Phase 3
 * gate) or drag previews; those stay inside their narrow consumers until
 * commit. memo'd TrackHeader/Track rows plus structural sharing mean an edit
 * re-renders just the affected row pair.
 */

import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import './timeline.css'
import { useDocumentStore } from '../../state/documentStore'
import {
  getTransportResetRevision,
  useTransportStore,
} from '../../state/transportStore'
import {
  timelineDisplayDurationFrames,
  tracksInDisplayOrder,
} from '../../domain/selectors'
import Ruler from './Ruler'
import Track from './Track'
import TrackHeader from './TrackHeader'
import Playhead from './Playhead'
import AlignmentGuide from './AlignmentGuide'
import { timelineRunwayFrames } from './timelineZoom'
import {
  calculateTimelineViewport,
  measureTimelineLaneWidth,
  planTimelineEdgeRebase,
} from './timelineViewport'
import { setMediaVisualTimelineViewport } from '../../app/mediaVisualsController'
import SelectionMarquee from './SelectionMarquee'
import { useTimelineMarqueeSelection } from './useTimelineMarqueeSelection'
import { focusProgramMonitor } from '../../app/sequenceEditController'

export default function Timeline() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const doc = useDocumentStore((s) => s.doc)
  // Tool-specific cursors via a root class; changes only on tool switch.
  const tool = useTransportStore((s) => s.tool)
  const zoom = useTransportStore((s) => s.zoom)
  const requestedOriginFrame = useTransportStore(
    (s) => s.timelineOriginFrame,
  )
  const setTimelineOriginFrame = useTransportStore(
    (s) => s.setTimelineOriginFrame,
  )
  const { surfaceRef, marqueePointerHandlers } = useTimelineMarqueeSelection()

  const totalFrames = timelineRunwayFrames(
    timelineDisplayDurationFrames(doc),
    doc.frameRate,
  )
  const viewport = calculateTimelineViewport(
    totalFrames,
    zoom,
    requestedOriginFrame,
  )

  // Duration/zoom changes can reduce the legal origin range. Publish the
  // clamped integer origin before paint; the physical surface stays bounded.
  useLayoutEffect(() => {
    if (requestedOriginFrame !== viewport.originFrame) {
      setTimelineOriginFrame(viewport.originFrame)
    }
  }, [requestedOriginFrame, setTimelineOriginFrame, viewport.originFrame])

  // Native scrolling remains 1:1. Only when an edge of the bounded surface
  // approaches do we move the global frame origin and apply the exact
  // opposite scroll delta in one pre-paint commit.
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest('[data-timeline-scroll]')
    if (!(scroller instanceof HTMLElement)) return

    let resetRevision = getTransportResetRevision()
    const publishVisibleRange = () => {
      const transport = useTransportStore.getState()
      const laneWidth = measureTimelineLaneWidth(scroller)
      const startFrame = transport.timelineOriginFrame
        + scroller.scrollLeft / transport.zoom
      setMediaVisualTimelineViewport({
        startFrame,
        endFrame: startFrame + laneWidth / transport.zoom,
      })
    }
    const onScroll = () => {
      const transport = useTransportStore.getState()
      const liveDoc = useDocumentStore.getState().doc
      const liveTotalFrames = timelineRunwayFrames(
        timelineDisplayDurationFrames(liveDoc),
        liveDoc.frameRate,
      )
      const liveViewport = calculateTimelineViewport(
        liveTotalFrames,
        transport.zoom,
        transport.timelineOriginFrame,
      )
      const plan = planTimelineEdgeRebase(
        liveViewport,
        transport.zoom,
        measureTimelineLaneWidth(scroller),
        scroller.scrollLeft,
      )
      if (plan) {
        scroller.scrollLeft = plan.scrollLeft
        flushSync(() => transport.setTimelineOriginFrame(plan.originFrame))
      }
      publishVisibleRange()
    }

    const unsubscribe = useTransportStore.subscribe((current, previous) => {
      const nextRevision = getTransportResetRevision()
      const resetChanged = nextRevision !== resetRevision
      if (resetChanged) {
        resetRevision = nextRevision
        scroller.scrollLeft = 0
      }
      if (
        resetChanged
        || current.zoom !== previous.zoom
        || current.timelineOriginFrame !== previous.timelineOriginFrame
      ) publishVisibleRange()
    })
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(publishVisibleRange)
      : null
    resizeObserver?.observe(scroller)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    publishVisibleRange()
    return () => {
      unsubscribe()
      resizeObserver?.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      setMediaVisualTimelineViewport(null)
    }
  }, [])

  // Derived per render (cheap): stable Track references keep memo rows idle.
  const ordered = tracksInDisplayOrder(doc)
  // Solo is cross-track state (one solo dims every OTHER audio lane), so
  // the container derives it and hands each lane a boolean; the actual
  // mix rule lives in domain selectors.audibleTracks.
  const anyAudioSolo = doc.tracks.some((t) => t.kind === 'audio' && t.solo)
  const addTrack = (kind: 'video' | 'audio') =>
    useDocumentStore.getState().addTrack(kind)

  return (
    <div
      ref={rootRef}
      className={`timeline-root tool-${tool}`}
      data-testid="timeline-root"
      onPointerDown={focusProgramMonitor}
      data-timeline-origin-frame={viewport.originFrame}
      data-timeline-window-end-frame={viewport.endFrame}
      data-timeline-total-frames={viewport.totalFrames}
    >
      <div
        className="timeline-headers"
        data-timeline-headers
        data-testid="timeline-headers"
      >
        {/* Corner spacer: same height as the ruler so header/lane rows align. */}
        <div className="timeline-headers-corner" />
        {ordered.map((track) => (
          <TrackHeader key={track.id} track={track} />
        ))}
        <div className="track-add-row">
          <button
            type="button"
            className="track-add-button"
            title="Add a video track — composites above the existing video tracks"
            aria-label="add video track"
            onClick={() => addTrack('video')}
          >
            + Video
          </button>
          <button
            type="button"
            className="track-add-button"
            title="Add an audio track"
            aria-label="add audio track"
            onClick={() => addTrack('audio')}
          >
            + Audio
          </button>
        </div>
      </div>
      <div className="timeline-lanes">
        <Ruler />
        <div
          ref={surfaceRef}
          className="timeline-tracks"
          data-testid="timeline-tracks"
          {...marqueePointerHandlers}
        >
          {ordered.map((track) => (
            <Track
              key={track.id}
              track={track}
              documentId={doc.id}
              soloDimmed={anyAudioSolo && track.kind === 'audio' && !track.solo}
              timelineOriginFrame={viewport.originFrame}
              timelineWindowEndFrame={viewport.endFrame}
            />
          ))}
          <SelectionMarquee />
        </div>
        <AlignmentGuide
          timelineOriginFrame={viewport.originFrame}
          timelineWindowEndFrame={viewport.endFrame}
        />
        <Playhead
          timelineOriginFrame={viewport.originFrame}
          timelineWindowEndFrame={viewport.endFrame}
        />
      </div>
    </div>
  )
}
