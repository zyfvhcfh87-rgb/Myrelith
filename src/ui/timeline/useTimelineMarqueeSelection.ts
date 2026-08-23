import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TimelineDoc } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { isPrimaryEditingPointer } from '../pointerButtons'
import {
  marqueeRectFromPoints,
  selectedClipIdsInMarquee,
  type MarqueePoint,
  type MarqueeRect,
} from './timelineMarquee'
import { useScrubScheduler } from './useScrubScheduler'

interface MarqueeSession {
  pointerId: number
  document: TimelineDoc
  start: MarqueePoint
}

function pointInSurface(
  surface: HTMLElement,
  clientX: number,
  clientY: number,
): MarqueePoint {
  const rect = surface.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
  }
}

function clipIdsInside(surface: HTMLElement, marquee: MarqueeRect): string[] {
  const surfaceRect = surface.getBoundingClientRect()
  return selectedClipIdsInMarquee(
    marquee,
    [...surface.querySelectorAll<HTMLElement>('[data-clip-id]')].map((clip) => {
      const rect = clip.getBoundingClientRect()
      const lane = clip.closest<HTMLElement>('[data-track-id]')
      return {
        clipId: clip.dataset.clipId ?? '',
        selectable:
          clip.dataset.virtualGestureHost !== 'true'
          && lane?.dataset.trackLocked !== 'true'
          && lane?.dataset.trackHidden !== 'true',
        rect: {
          left: rect.left - surfaceRect.left,
          top: rect.top - surfaceRect.top,
          right: rect.right - surfaceRect.left,
          bottom: rect.bottom - surfaceRect.top,
        },
      }
    }).filter((candidate) => candidate.clipId !== ''),
  )
}

function previewAt(
  surface: HTMLElement,
  start: MarqueePoint,
  current: MarqueePoint,
) {
  const rect = marqueeRectFromPoints(start, current)
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    clipIds: clipIdsInside(surface, rect),
  }
}

/** Owns the empty-lane pointer session; document geometry remains untouched. */
export function useTimelineMarqueeSelection() {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const session = useRef<MarqueeSession | null>(null)
  const removeWindowListeners = useRef<() => void>(() => {})
  const schedulePreview = useScrubScheduler((preview: ReturnType<typeof previewAt>) => {
    const active = session.current
    if (!active || useDocumentStore.getState().doc !== active.document) return
    useTransportStore.getState().setSelectionMarquee(preview)
  })

  const clear = (): void => {
    session.current = null
    removeWindowListeners.current()
    useTransportStore.getState().setSelectionMarquee(null)
  }

  useEffect(() => () => {
    session.current = null
    removeWindowListeners.current()
    useTransportStore.getState().setSelectionMarquee(null)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isPrimaryEditingPointer(event)) return
    const surface = surfaceRef.current
    const target = event.target instanceof Element ? event.target : null
    const lane = target?.closest<HTMLElement>('[data-track-id]')
    // Only the lane's empty body opens a marquee. Clips, seams, and other
    // interactive children keep their established pointer ownership.
    if (!surface || !lane || target !== lane) return
    const transport = useTransportStore.getState()
    if (transport.tool !== 'select') return

    const start = pointInSurface(surface, event.clientX, event.clientY)
    session.current = {
      pointerId: event.pointerId,
      document: useDocumentStore.getState().doc,
      start,
    }
    transport.setSelectedClip(null)
    transport.setSelectionMarquee(previewAt(surface, start, start))
    const windowPointerMove = (nativeEvent: PointerEvent): void => {
      updatePointer(nativeEvent)
    }
    const windowPointerUp = (nativeEvent: PointerEvent): void => {
      finishPointer(nativeEvent)
    }
    const windowPointerCancel = (nativeEvent: PointerEvent): void => {
      if (session.current?.pointerId === nativeEvent.pointerId) clear()
    }
    removeWindowListeners.current = () => {
      window.removeEventListener('pointermove', windowPointerMove)
      window.removeEventListener('pointerup', windowPointerUp)
      window.removeEventListener('pointercancel', windowPointerCancel)
      removeWindowListeners.current = () => {}
    }
    window.addEventListener('pointermove', windowPointerMove)
    window.addEventListener('pointerup', windowPointerUp)
    window.addEventListener('pointercancel', windowPointerCancel)
    event.preventDefault()
    try {
      surface.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic/inactive pointer; direct move/up events still work */
    }
  }

  const updatePointer = (event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>): void => {
    const active = session.current
    const surface = surfaceRef.current
    if (!active || !surface || active.pointerId !== event.pointerId) return
    if (useDocumentStore.getState().doc !== active.document) {
      clear()
      return
    }
    schedulePreview(previewAt(
      surface,
      active.start,
      pointInSurface(surface, event.clientX, event.clientY),
    ))
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    updatePointer(event.nativeEvent)
  }

  const finishPointer = (event: Pick<
    PointerEvent,
    'pointerId' | 'clientX' | 'clientY' | 'button' | 'ctrlKey'
  >): void => {
    const active = session.current
    const surface = surfaceRef.current
    if (
      !active
      || !surface
      || active.pointerId !== event.pointerId
      || !isPrimaryEditingPointer(event)
    ) return
    if (useDocumentStore.getState().doc === active.document) {
      const preview = previewAt(
        surface,
        active.start,
        pointInSurface(surface, event.clientX, event.clientY),
      )
      useTransportStore.getState().setClipSelection(preview.clipIds)
    }
    clear()
    try {
      surface.releasePointerCapture(event.pointerId)
    } catch {
      /* nothing captured */
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    finishPointer(event.nativeEvent)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (session.current?.pointerId === event.pointerId) clear()
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      session.current?.pointerId === event.pointerId
      && !event.currentTarget.hasPointerCapture(event.pointerId)
    ) clear()
  }

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (session.current?.pointerId === event.pointerId) clear()
  }

  return {
    surfaceRef,
    marqueePointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      onLostPointerCapture,
    },
  }
}
