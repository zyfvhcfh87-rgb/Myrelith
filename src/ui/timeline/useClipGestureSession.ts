/**
 * Owns one ClipView's transient pointer/keyboard gesture session.
 *
 * Pointer movement publishes only rAF-coalesced transport previews. Pointer-up
 * validates the immutable pointer-down document reference, dispatches at most
 * one document action, and clears the preview. Rendering stays in ClipView.
 */

import { useEffect, useRef } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  ClipId,
  TimelineDoc,
  TrackId,
  TrackKind,
} from '../../domain/schema'
import { findClip, trackOfClip } from '../../domain/selectors'
import { microsecondsDurationToFrames } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import {
  linkedGestureBounds,
  type GestureMode,
} from './gestureBounds'
import { useScrubScheduler } from './useScrubScheduler'

interface ClipGestureSessionOptions {
  clipId: ClipId
  trackId: TrackId
  trackKind: TrackKind
  zoom: number
  timelineOriginFrame: number
}

/** Live drag-session values; refs, so moves never re-render anything extra. */
interface GestureSession {
  mode: GestureMode
  pointerStartX: number
  /** Exact immutable document snapshot this gesture was opened against. */
  document: TimelineDoc
  originFrame: number
  /** Link identity from the same fresh document snapshot as the bounds. */
  linkGroupId?: string
  /** Current same-kind lane under the pointer during a move gesture. */
  targetTrackId: TrackId
  /** Target-lane top minus source-lane top, for the vertical ghost. */
  trackOffsetY: number
  /** Live clamp for the signed frame delta (source/timeline floors). */
  minDelta: number
  maxDelta: number
}

export function useClipGestureSession({
  clipId,
  trackId,
  trackKind,
  zoom,
  timelineOriginFrame,
}: ClipGestureSessionOptions) {
  const setDragPreview = useTransportStore((s) => s.setDragPreview)
  const setEditPreview = useTransportStore((s) => s.setEditPreview)
  const session = useRef<GestureSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // If a gesture owner disappears before pointerup, clear only its preview.
  useEffect(
    () => () => {
      const transport = useTransportStore.getState()
      if (transport.dragPreview?.clipId === clipId) {
        transport.setDragPreview(null)
      }
      if (transport.editPreview?.clipId === clipId) {
        transport.setEditPreview(null)
      }
    },
    [clipId],
  )

  const scheduleMovePreview = useScrubScheduler((deltaFrames: number) => {
    // A late rAF flush must never restore a preview after pointerup cleared it.
    const active = session.current
    if (active?.mode === 'move') {
      const crossTrack = active.targetTrackId !== trackId
      setDragPreview({
        clipId,
        deltaFrames,
        linkGroupId: active.linkGroupId,
        ...(crossTrack
          ? {
              targetTrackId: active.targetTrackId,
              trackOffsetY: active.trackOffsetY,
            }
          : {}),
      })
    }
  })
  const scheduleEditPreview = useScrubScheduler((deltaFrames: number) => {
    const active = session.current
    if (active && active.mode !== 'move') {
      setEditPreview({
        clipId,
        kind: active.mode,
        deltaFrames,
        linkGroupId: active.linkGroupId,
      })
    }
  })

  /** Intersect linked timeline/source intervals from fresh pointer-down state. */
  const boundsFor = (
    currentDoc: TimelineDoc,
    mode: GestureMode,
  ): { minDelta: number; maxDelta: number } => {
    const media = useMediaStore.getState()
    return linkedGestureBounds(currentDoc, clipId, mode, (member) => {
      const connected = media.assets.get(member.assetId)
      if (connected) return connected.durationFrames
      const descriptor = media.descriptors.get(member.assetId)
      return descriptor
        ? microsecondsDurationToFrames(
            descriptor.durationMicroseconds,
            currentDoc.frameRate,
          )
        : 0
    })
  }

  const deltaFromEvent = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const active = session.current as GestureSession
    const raw = Math.round((event.clientX - active.pointerStartX) / zoom)
    return Math.min(active.maxDelta, Math.max(active.minDelta, raw))
  }

  /** Resolve the same-kind lane under a captured pointer from lane rectangles. */
  const trackTargetAt = (clientX: number, clientY: number): {
    trackId: TrackId
    offsetY: number
  } => {
    const sourceLane = rootRef.current?.closest<HTMLElement>('[data-track-id]')
    const laneContainer = sourceLane?.parentElement
    if (!sourceLane || !laneContainer) return { trackId, offsetY: 0 }

    const sourceRect = sourceLane.getBoundingClientRect()
    const lanes = laneContainer.querySelectorAll<HTMLElement>('[data-track-id]')
    for (const lane of lanes) {
      if (lane.dataset.trackKind !== trackKind) continue
      const rect = lane.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (
        clientX >= rect.left &&
        clientX < rect.right &&
        clientY >= rect.top &&
        clientY < rect.bottom
      ) {
        const targetTrackId = lane.dataset.trackId
        if (targetTrackId) {
          return {
            trackId: targetTrackId,
            offsetY: rect.top - sourceRect.top,
          }
        }
      }
    }
    return { trackId, offsetY: 0 }
  }

  const startGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    mode: GestureMode,
  ): boolean => {
    const currentDoc = useDocumentStore.getState().doc
    const currentClip = findClip(currentDoc, clipId)
    const currentTrack = trackOfClip(currentDoc, clipId)
    // A capture-phase edit can make this rendered ClipView stale before its
    // own pointer handler runs. Fail closed instead of mixing snapshots.
    if (!currentClip || currentTrack?.id !== trackId) return false

    session.current = {
      mode,
      pointerStartX: event.clientX,
      document: currentDoc,
      originFrame: currentClip.timelineRange.startFrame,
      linkGroupId: currentClip.linkGroupId,
      targetTrackId: trackId,
      trackOffsetY: 0,
      ...boundsFor(currentDoc, mode),
    }
    if (mode === 'move') {
      setDragPreview({
        clipId,
        deltaFrames: 0,
        linkGroupId: currentClip.linkGroupId,
      })
    } else {
      setEditPreview({
        clipId,
        kind: mode,
        deltaFrames: 0,
        linkGroupId: currentClip.linkGroupId,
      })
    }
    try {
      rootRef.current?.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic/inactive pointer - move events can still drive the drag */
    }
    return true
  }

  const endGesture = (): void => {
    session.current = null
    setDragPreview(null)
    setEditPreview(null)
  }

  const commitGesture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = session.current as GestureSession
    const store = useDocumentStore.getState()
    // Never retarget a stale delta onto a replacement immutable document.
    if (store.doc !== active.document) {
      endGesture()
      return
    }
    const delta = deltaFromEvent(event)
    const moveTarget =
      active.mode === 'move'
        ? trackTargetAt(event.clientX, event.clientY)
        : null
    // Commit exactly once, and only when something actually changed.
    if (delta !== 0 || moveTarget?.trackId !== trackId) {
      switch (active.mode) {
        case 'move':
          store.moveClip(
            clipId,
            moveTarget?.trackId ?? trackId,
            active.originFrame + delta,
          )
          break
        case 'trim-start':
          store.trimClip(clipId, 'start', delta)
          break
        case 'trim-end':
          store.trimClip(clipId, 'end', delta)
          break
        case 'ripple-start':
          store.rippleTrim(clipId, 'start', delta)
          break
        case 'ripple-end':
          store.rippleTrim(clipId, 'end', delta)
          break
        case 'slip':
          store.slipClip(clipId, delta)
          break
        case 'slide':
          store.slideClip(clipId, delta)
          break
      }
    }
    endGesture()
  }

  const onBodyPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    // Route by the current store tool, not a potentially stale render closure.
    const transport = useTransportStore.getState()
    switch (transport.tool) {
      case 'razor': {
        const currentDoc = useDocumentStore.getState().doc
        const currentClip = findClip(currentDoc, clipId)
        if (!currentClip || trackOfClip(currentDoc, clipId)?.id !== trackId) return
        const rect = event.currentTarget.getBoundingClientRect()
        const frame =
          Math.max(currentClip.timelineRange.startFrame, timelineOriginFrame) +
          Math.round((event.clientX - rect.left) / zoom)
        useDocumentStore.getState().splitClipAt(clipId, frame)
        if (findClip(useDocumentStore.getState().doc, clipId)) {
          transport.setSelectedClip(clipId)
        }
        return
      }
      case 'select':
        // Modifier selection is discrete and never starts a move gesture.
        if (event.ctrlKey || event.metaKey) {
          if (findClip(useDocumentStore.getState().doc, clipId)) {
            transport.toggleClipSelection(clipId)
          }
          return
        }
        if (startGesture(event, 'move')) transport.setSelectedClip(clipId)
        return
      case 'trim':
        if (findClip(useDocumentStore.getState().doc, clipId)) {
          transport.setSelectedClip(clipId)
        }
        return
      case 'slip': {
        const currentClip = findClip(useDocumentStore.getState().doc, clipId)
        if (!currentClip) return
        if (currentClip.sourceMode === 'still') {
          transport.setSelectedClip(clipId)
          return
        }
        if (startGesture(event, 'slip')) transport.setSelectedClip(clipId)
        return
      }
      case 'slide':
        if (startGesture(event, 'slide')) transport.setSelectedClip(clipId)
        return
    }
  }

  const onEdgePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    edge: 'start' | 'end',
  ): void => {
    event.stopPropagation()
    const transport = useTransportStore.getState()
    // Modifier activation on the handle toggles selection instead of trimming.
    if (transport.tool === 'select' && (event.ctrlKey || event.metaKey)) {
      if (findClip(useDocumentStore.getState().doc, clipId)) {
        transport.toggleClipSelection(clipId)
      }
      return
    }
    if (
      startGesture(
        event,
        transport.tool === 'trim' ? `ripple-${edge}` : `trim-${edge}`,
      )
    ) {
      transport.setSelectedClip(clipId)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    event.stopPropagation()
    const transport = useTransportStore.getState()
    if (!findClip(useDocumentStore.getState().doc, clipId)) return
    if (event.ctrlKey || event.metaKey) {
      transport.toggleClipSelection(clipId)
    } else {
      transport.setSelectedClip(clipId)
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Gate on our session, not capture status: capture can fail while move
    // events remain usable.
    const active = session.current
    if (!active) return
    if (active.mode === 'move') {
      const target = trackTargetAt(event.clientX, event.clientY)
      active.targetTrackId = target.trackId
      active.trackOffsetY = target.offsetY
      scheduleMovePreview(deltaFromEvent(event))
    } else {
      scheduleEditPreview(deltaFromEvent(event))
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!session.current) return
    commitGesture(event)
    try {
      rootRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      /* nothing captured */
    }
  }

  const onPointerCancel = (): void => {
    endGesture()
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // If capture failed and the pointer leaves, cancel instead of wedging.
    if (
      session.current &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      endGesture()
    }
  }

  const onLostPointerCapture = (): void => {
    if (session.current) endGesture()
  }

  return {
    rootRef,
    onBodyPointerDown,
    onEdgePointerDown,
    onKeyDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onLostPointerCapture,
  }
}
