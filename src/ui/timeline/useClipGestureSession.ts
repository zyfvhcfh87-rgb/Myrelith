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
  Clip,
  ClipId,
  TimelineDoc,
  TrackId,
  TrackKind,
} from '../../domain/schema'
import { linkedPartners } from '../../domain/linking'
import { findClip, trackOfClip } from '../../domain/selectors'
import { microsecondsDurationToFrames } from '../../domain/time'
import {
  resolveTimelineSnap,
  timelineSnapCandidates,
  type TimelineSnapCandidate,
  type TimelineSnapGuide,
  type TimelineSnapMovingPoint,
} from '../../domain/timelineSnapping'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { usePreferencesStore } from '../../state/preferencesStore'
import { useTransportStore } from '../../state/transportStore'
import {
  gestureBoundsForClip,
  linkedGestureBounds,
  type GestureMode,
} from './gestureBounds'
import { useScrubScheduler } from './useScrubScheduler'
import { isPrimaryEditingPointer } from '../pointerButtons'
import { frameAtTimelineClientX } from './timelineViewport'

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
  origin: 'pointer' | 'keyboard'
  /** Exact pointer owner; keyboard sessions use null. */
  pointerId: number | null
  pointerStartX: number
  /** Exact immutable document snapshot this gesture was opened against. */
  document: TimelineDoc
  originFrame: number
  /** Link identity from the same fresh document snapshot as the bounds. */
  linkGroupId?: string
  /** Selected roots committed by a multi-clip move; owner-only otherwise. */
  moveRootClipIds: readonly ClipId[]
  /** Exact owner/link closure used by bounds, snapping, and live preview. */
  memberClipIds: readonly ClipId[]
  /** Current same-kind lane under the pointer during a move gesture. */
  targetTrackId: TrackId
  /** Target-lane top minus source-lane top, for the vertical ghost. */
  trackOffsetY: number
  /** Live clamp for the signed frame delta (source/timeline floors). */
  minDelta: number
  maxDelta: number
  /** Stable targets from the same immutable pointer-down document. */
  snapCandidates: readonly TimelineSnapCandidate[]
  /** Keyboard-edit delta; unused for pointer sessions. */
  currentDelta: number
}

interface SnapPreviewUpdate {
  deltaFrames: number
  guide: TimelineSnapGuide | null
}

function gestureMembers(
  doc: TimelineDoc,
  rootClipIds: readonly ClipId[],
): readonly Clip[] {
  const members: Clip[] = []
  const seen = new Set<ClipId>()
  for (const rootClipId of rootClipIds) {
    const owner = findClip(doc, rootClipId)
    if (!owner) continue
    for (const member of [owner, ...linkedPartners(doc, rootClipId)]) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      members.push(member)
    }
  }
  return members
}

/** Exact timeline points changed by one signed edit delta. */
function movingSnapPoints(
  doc: TimelineDoc,
  memberClipIds: readonly ClipId[],
  mode: GestureMode,
  deltaFrames: number,
): readonly TimelineSnapMovingPoint[] {
  const points: TimelineSnapMovingPoint[] = []
  for (const member of gestureMembers(doc, memberClipIds)) {
    const track = trackOfClip(doc, member.id)
    if (!track) continue
    const trackIndex = doc.tracks.findIndex((candidate) => candidate.id === track.id)
    const start = member.timelineRange.startFrame
    const end = start + member.timelineRange.durationFrames
    const add = (
      kind: 'start' | 'end',
      frame: number,
      deltaDirection: 1 | -1,
    ) => points.push({
      id: `${member.id}:${kind}`,
      kind,
      frame,
      deltaDirection,
      trackKind: track.kind,
      trackIndex,
    })
    switch (mode) {
      case 'move':
      case 'slide':
        add('start', start + deltaFrames, 1)
        add('end', end + deltaFrames, 1)
        break
      case 'trim-start':
        add('start', start + deltaFrames, 1)
        break
      case 'trim-end':
      case 'ripple-end':
        add('end', end + deltaFrames, 1)
        break
      case 'ripple-start':
        add('end', end - deltaFrames, -1)
        break
      case 'slip':
        break
    }
  }
  return points
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
  const setSnapGuide = useTransportStore((s) => s.setSnapGuide)
  const session = useRef<GestureSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const announceRef = useRef<HTMLSpanElement | null>(null)
  const keyboardGuideTimer = useRef<number | null>(null)

  const announce = (message: string): void => {
    const region = announceRef.current
    if (!region) return
    region.textContent = ''
    region.textContent = message
  }

  const editLabel = (mode: GestureMode): string => {
    switch (mode) {
      case 'trim-start': return 'Trim start'
      case 'trim-end': return 'Trim end'
      case 'ripple-start': return 'Ripple trim start'
      case 'ripple-end': return 'Ripple trim end'
      case 'slip': return 'Slip'
      case 'slide': return 'Slide'
      case 'move': return 'Move'
    }
  }

  // If a gesture owner disappears before pointerup, clear only its preview.
  useEffect(
    () => () => {
      const transport = useTransportStore.getState()
      const ownsPreview = transport.dragPreview?.clipId === clipId
        || transport.editPreview?.clipId === clipId
      if (transport.dragPreview?.clipId === clipId) {
        transport.setDragPreview(null)
      }
      if (transport.editPreview?.clipId === clipId) {
        transport.setEditPreview(null)
      }
      if (keyboardGuideTimer.current !== null) {
        window.clearTimeout(keyboardGuideTimer.current)
      }
      if (ownsPreview || keyboardGuideTimer.current !== null) {
        transport.setSnapGuide(null)
      }
    },
    [clipId],
  )

  const scheduleMovePreview = useScrubScheduler((update: SnapPreviewUpdate) => {
    // A late rAF flush must never restore a preview after pointerup cleared it.
    const active = session.current
    if (active?.mode === 'move') {
      const crossTrack = active.targetTrackId !== trackId
      setDragPreview({
        clipId,
        deltaFrames: update.deltaFrames,
        linkGroupId: active.linkGroupId,
        ...(active.moveRootClipIds.length > 1
          ? { clipIds: active.memberClipIds }
          : {}),
        ...(crossTrack
          ? {
              targetTrackId: active.targetTrackId,
              trackOffsetY: active.trackOffsetY,
            }
          : {}),
      })
      setSnapGuide(update.guide)
    }
  })
  const scheduleEditPreview = useScrubScheduler((update: SnapPreviewUpdate) => {
    const active = session.current
    if (active && active.mode !== 'move') {
      setEditPreview({
        clipId,
        kind: active.mode,
        deltaFrames: update.deltaFrames,
        linkGroupId: active.linkGroupId,
      })
      setSnapGuide(update.guide)
    }
  })

  /** Intersect linked timeline/source intervals from fresh pointer-down state. */
  const boundsFor = (
    currentDoc: TimelineDoc,
    mode: GestureMode,
    memberClipIds?: readonly ClipId[],
  ): { minDelta: number; maxDelta: number } => {
    const media = useMediaStore.getState()
    const durationFor = (member: Clip): number => {
      const connected = media.assets.get(member.assetId)
      if (connected) return connected.durationFrames
      const descriptor = media.descriptors.get(member.assetId)
      return descriptor
        ? microsecondsDurationToFrames(
            descriptor.durationMicroseconds,
            currentDoc.frameRate,
          )
        : 0
    }
    if (!memberClipIds) {
      return linkedGestureBounds(currentDoc, clipId, mode, durationFor)
    }
    let minDelta = Number.NEGATIVE_INFINITY
    let maxDelta = Number.POSITIVE_INFINITY
    for (const member of gestureMembers(currentDoc, memberClipIds)) {
      const bounds = gestureBoundsForClip(member, mode, durationFor(member))
      minDelta = Math.max(minDelta, bounds.minDelta)
      maxDelta = Math.min(maxDelta, bounds.maxDelta)
    }
    return minDelta <= maxDelta
      ? { minDelta, maxDelta }
      : { minDelta: 0, maxDelta: 0 }
  }

  const rawDeltaFromEvent = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const active = session.current as GestureSession
    const raw = Math.round((event.clientX - active.pointerStartX) / zoom)
    return Math.min(active.maxDelta, Math.max(active.minDelta, raw))
  }

  const snapUpdate = (
    active: GestureSession,
    rawDeltaFrames: number,
    bypassSnapping: boolean,
  ): SnapPreviewUpdate => {
    if (
      rawDeltaFrames === 0
      || active.mode === 'slip'
      || bypassSnapping
      || !usePreferencesStore.getState().snappingEnabled
    ) return { deltaFrames: rawDeltaFrames, guide: null }
    const resolution = resolveTimelineSnap({
      candidates: active.snapCandidates,
      movingPoints: movingSnapPoints(
        active.document,
        active.memberClipIds,
        active.mode,
        rawDeltaFrames,
      ),
      rawDeltaFrames,
      minDeltaFrames: active.minDelta,
      maxDeltaFrames: active.maxDelta,
      zoom,
    })
    return {
      deltaFrames: resolution.deltaFrames,
      guide: resolution.guide,
    }
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
      if (lane.dataset.trackLocked === 'true' || lane.dataset.trackHidden === 'true') {
        continue
      }
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
    if (!isPrimaryEditingPointer(event)) return false
    const currentDoc = useDocumentStore.getState().doc
    const currentClip = findClip(currentDoc, clipId)
    const currentTrack = trackOfClip(currentDoc, clipId)
    // A capture-phase edit can make this rendered ClipView stale before its
    // own pointer handler runs. Fail closed instead of mixing snapshots.
    if (!currentClip || currentTrack?.id !== trackId) return false
    if (currentTrack.locked || currentTrack.hidden) return false

    const selectedClipIds = useTransportStore.getState().selectedClipIds
    const moveRootClipIds = mode === 'move'
      && selectedClipIds.length > 1
      && selectedClipIds.includes(clipId)
      ? selectedClipIds
      : [clipId]
    const members = gestureMembers(currentDoc, moveRootClipIds)
    if (members.length === 0) return false
    if (mode === 'move' && members.some((member) => {
      const memberTrack = trackOfClip(currentDoc, member.id)
      return !memberTrack || memberTrack.locked || memberTrack.hidden
    })) return false
    const excludedClipIds = new Set(members.map((member) => member.id))

    session.current = {
      mode,
      origin: 'pointer',
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      document: currentDoc,
      originFrame: currentClip.timelineRange.startFrame,
      linkGroupId: currentClip.linkGroupId,
      moveRootClipIds,
      memberClipIds: [...excludedClipIds],
      targetTrackId: trackId,
      trackOffsetY: 0,
      ...boundsFor(currentDoc, mode, [...excludedClipIds]),
      snapCandidates: timelineSnapCandidates(currentDoc, {
        playheadFrame: useTransportStore.getState().playheadFrame,
        excludedClipIds,
      }),
      currentDelta: 0,
    }
    if (keyboardGuideTimer.current !== null) {
      window.clearTimeout(keyboardGuideTimer.current)
      keyboardGuideTimer.current = null
    }
    setSnapGuide(null)
    if (mode === 'move') {
      setDragPreview({
        clipId,
        deltaFrames: 0,
        linkGroupId: currentClip.linkGroupId,
        ...(moveRootClipIds.length > 1
          ? { clipIds: [...excludedClipIds] }
          : {}),
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
    setSnapGuide(null)
  }

  const commitGesture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = session.current as GestureSession
    const store = useDocumentStore.getState()
    // Never retarget a stale delta onto a replacement immutable document.
    if (store.doc !== active.document) {
      endGesture()
      return
    }
    const delta = snapUpdate(
      active,
      rawDeltaFromEvent(event),
      event.altKey,
    ).deltaFrames
    const multiClipMove = active.moveRootClipIds.length > 1
    const moveTarget =
      active.mode === 'move' && !multiClipMove
        ? trackTargetAt(event.clientX, event.clientY)
        : null
    // Commit exactly once, and only when something actually changed.
    if (delta !== 0 || moveTarget?.trackId !== trackId) {
      switch (active.mode) {
        case 'move':
          if (multiClipMove) store.moveClips(active.moveRootClipIds, delta)
          else {
            store.moveClip(
              clipId,
              moveTarget?.trackId ?? trackId,
              active.originFrame + delta,
            )
          }
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

  const applyEditDelta = (active: GestureSession, delta: number): void => {
    const store = useDocumentStore.getState()
    if (delta === 0) return
    switch (active.mode) {
      case 'move':
        if (active.moveRootClipIds.length > 1) {
          store.moveClips(active.moveRootClipIds, delta)
        } else {
          store.moveClip(clipId, trackId, active.originFrame + delta)
        }
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

  const startKeyboardGesture = (mode: GestureMode): boolean => {
    const currentDoc = useDocumentStore.getState().doc
    const currentClip = findClip(currentDoc, clipId)
    const currentTrack = trackOfClip(currentDoc, clipId)
    if (!currentClip || currentTrack?.id !== trackId) return false
    if (currentTrack.locked || currentTrack.hidden) return false
    if (mode === 'slip' && currentClip.sourceMode === 'still') return false
    const members = gestureMembers(currentDoc, [clipId])
    session.current = {
      mode,
      origin: 'keyboard',
      pointerId: null,
      pointerStartX: 0,
      document: currentDoc,
      originFrame: currentClip.timelineRange.startFrame,
      linkGroupId: currentClip.linkGroupId,
      moveRootClipIds: [clipId],
      memberClipIds: members.map((member) => member.id),
      targetTrackId: trackId,
      trackOffsetY: 0,
      ...boundsFor(currentDoc, mode, members.map((member) => member.id)),
      snapCandidates: timelineSnapCandidates(currentDoc, {
        playheadFrame: useTransportStore.getState().playheadFrame,
        excludedClipIds: new Set(members.map((member) => member.id)),
      }),
      currentDelta: 0,
    }
    if (keyboardGuideTimer.current !== null) {
      window.clearTimeout(keyboardGuideTimer.current)
      keyboardGuideTimer.current = null
    }
    setSnapGuide(null)
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
    useTransportStore.getState().setSelectedClip(clipId)
    announce(
      `${editLabel(mode)} started. Use arrow keys to adjust, Enter to apply, Escape to cancel.`,
    )
    return true
  }

  const nudgeKeyboardGesture = (step: number, bypassSnapping: boolean): void => {
    const active = session.current
    if (!active || active.origin !== 'keyboard') return
    // One-frame keyboard nudges stay exact. Neighbor/marker snaps would
    // otherwise swallow the first arrow press when an edge already sits
    // on a snap candidate.
    const raw = Math.min(active.maxDelta, Math.max(active.minDelta, active.currentDelta + step))
    const update = snapUpdate(active, raw, true)
    active.currentDelta = update.deltaFrames
    if (active.mode === 'move') {
      setDragPreview({
        clipId,
        deltaFrames: update.deltaFrames,
        linkGroupId: active.linkGroupId,
      })
    } else {
      setEditPreview({
        clipId,
        kind: active.mode,
        deltaFrames: update.deltaFrames,
        linkGroupId: active.linkGroupId,
      })
    }
    setSnapGuide(bypassSnapping ? null : snapUpdate(active, raw, false).guide)
    const signed = update.deltaFrames > 0
      ? `plus ${update.deltaFrames}`
      : update.deltaFrames < 0
        ? `minus ${Math.abs(update.deltaFrames)}`
        : '0'
    announce(
      `${editLabel(active.mode)} preview ${signed} frames. Press Enter to apply or Escape to cancel.`,
    )
  }

  const commitKeyboardGesture = (): void => {
    const active = session.current
    if (!active || active.origin !== 'keyboard') return
    const store = useDocumentStore.getState()
    if (store.doc !== active.document) {
      endGesture()
      announce(`${editLabel(active.mode)} cancelled because the timeline changed.`)
      return
    }
    const delta = active.currentDelta
    applyEditDelta(active, delta)
    endGesture()
    announce(
      delta === 0
        ? `${editLabel(active.mode)} cancelled. No frames changed.`
        : `${editLabel(active.mode)} applied.`,
    )
  }

  const cancelKeyboardGesture = (): void => {
    const active = session.current
    if (!active || active.origin !== 'keyboard') return
    const label = editLabel(active.mode)
    endGesture()
    announce(`${label} cancelled.`)
  }

  const onBodyPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (!isPrimaryEditingPointer(event)) return
    // Route by the current store tool, not a potentially stale render closure.
    const transport = useTransportStore.getState()
    switch (transport.tool) {
      case 'razor': {
        const currentDoc = useDocumentStore.getState().doc
        const currentClip = findClip(currentDoc, clipId)
        if (!currentClip || trackOfClip(currentDoc, clipId)?.id !== trackId) return
        const rect = event.currentTarget.getBoundingClientRect()
        const frame = frameAtTimelineClientX(
          event.clientX,
          rect.left,
          Math.max(currentClip.timelineRange.startFrame, timelineOriginFrame),
          zoom,
          currentClip.timelineRange.startFrame,
          currentClip.timelineRange.startFrame
            + currentClip.timelineRange.durationFrames,
        )
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
        if (startGesture(event, 'move')) {
          if (
            transport.selectedClipIds.length > 1
            && transport.selectedClipIds.includes(clipId)
          ) transport.promoteContextClipSelection(clipId)
          else transport.setSelectedClip(clipId)
        }
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
    if (!isPrimaryEditingPointer(event)) return
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
    const active = session.current
    if (active?.origin === 'keyboard') {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelKeyboardGesture()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        commitKeyboardGesture()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        nudgeKeyboardGesture(event.key === 'ArrowLeft' ? -1 : 1, event.altKey)
        return
      }
    }

    if (event.key === '[' || event.key === ']') {
      event.preventDefault()
      event.stopPropagation()
      const tool = useTransportStore.getState().tool
      const edge = event.key === '[' ? 'start' : 'end'
      const mode: GestureMode = tool === 'trim' ? `ripple-${edge}` : `trim-${edge}`
      if (active?.origin === 'keyboard') endGesture()
      startKeyboardGesture(mode)
      return
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && !event.ctrlKey
      && !event.metaKey
    ) {
      const tool = useTransportStore.getState().tool
      if (tool === 'slip' || tool === 'slide') {
        event.preventDefault()
        event.stopPropagation()
        if (!active) startKeyboardGesture(tool)
        nudgeKeyboardGesture(event.key === 'ArrowLeft' ? -1 : 1, event.altKey)
        return
      }
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && (event.ctrlKey || event.metaKey)
      && useTransportStore.getState().tool === 'select'
    ) {
      event.preventDefault()
      event.stopPropagation()
      const currentDoc = useDocumentStore.getState().doc
      const currentClip = findClip(currentDoc, clipId)
      const currentTrack = trackOfClip(currentDoc, clipId)
      if (
        !currentClip
        || currentTrack?.id !== trackId
        || currentTrack.locked
        || currentTrack.hidden
      ) return
      const rawDelta = event.key === 'ArrowLeft' ? -1 : 1
      const selectedClipIds = useTransportStore.getState().selectedClipIds
      const moveRootClipIds = selectedClipIds.length > 1
        && selectedClipIds.includes(clipId)
        ? selectedClipIds
        : [clipId]
      const members = gestureMembers(currentDoc, moveRootClipIds)
      if (members.some((member) => {
        const memberTrack = trackOfClip(currentDoc, member.id)
        return !memberTrack || memberTrack.locked || memberTrack.hidden
      })) return
      const memberClipIds = members.map((member) => member.id)
      const bounds = boundsFor(currentDoc, 'move', memberClipIds)
      const active: GestureSession = {
        mode: 'move',
        origin: 'keyboard',
        pointerId: null,
        pointerStartX: 0,
        document: currentDoc,
        originFrame: currentClip.timelineRange.startFrame,
        linkGroupId: currentClip.linkGroupId,
        moveRootClipIds,
        memberClipIds,
        targetTrackId: trackId,
        trackOffsetY: 0,
        ...bounds,
        snapCandidates: timelineSnapCandidates(currentDoc, {
          playheadFrame: useTransportStore.getState().playheadFrame,
          excludedClipIds: new Set(memberClipIds),
        }),
        currentDelta: 0,
      }
      const update = snapUpdate(active, rawDelta, event.altKey)
      const store = useDocumentStore.getState()
      const before = store.doc
      if (update.deltaFrames !== 0) {
        if (moveRootClipIds.length > 1) {
          store.moveClips(moveRootClipIds, update.deltaFrames)
        } else {
          store.moveClip(
            clipId,
            trackId,
            currentClip.timelineRange.startFrame + update.deltaFrames,
          )
        }
      }
      const committed = useDocumentStore.getState().doc !== before
      const heldAtExistingSnap = update.deltaFrames === 0
        && update.guide !== null
      if ((committed || heldAtExistingSnap) && update.guide !== null) {
        setSnapGuide(update.guide)
        if (keyboardGuideTimer.current !== null) {
          window.clearTimeout(keyboardGuideTimer.current)
        }
        const keyboardGuide = update.guide
        keyboardGuideTimer.current = window.setTimeout(() => {
          keyboardGuideTimer.current = null
          const transport = useTransportStore.getState()
          if (
            transport.snapGuide?.frame === keyboardGuide.frame
            && transport.snapGuide.candidateId === keyboardGuide.candidateId
          ) {
            transport.setSnapGuide(null)
          }
        }, 900)
      } else {
        setSnapGuide(null)
      }
      return
    }

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
    // Gate on a pointer session, not capture status: capture can fail while
    // move events remain usable. Keyboard edits share this ref.
    const active = session.current
    if (
      !active
      || active.origin !== 'pointer'
      || active.pointerId !== event.pointerId
    ) return
    if (active.mode === 'move') {
      const target = active.moveRootClipIds.length > 1
        ? { trackId, offsetY: 0 }
        : trackTargetAt(event.clientX, event.clientY)
      active.targetTrackId = target.trackId
      active.trackOffsetY = target.offsetY
      scheduleMovePreview(snapUpdate(
        active,
        rawDeltaFromEvent(event),
        event.altKey,
      ))
    } else {
      scheduleEditPreview(snapUpdate(
        active,
        rawDeltaFromEvent(event),
        event.altKey,
      ))
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      session.current?.origin !== 'pointer'
      || session.current.pointerId !== event.pointerId
      || !isPrimaryEditingPointer(event)
    ) return
    commitGesture(event)
    try {
      rootRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      /* nothing captured */
    }
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      session.current?.origin === 'keyboard'
      || session.current?.pointerId !== event.pointerId
    ) return
    endGesture()
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // If capture failed and the pointer leaves, cancel instead of wedging.
    if (
      session.current?.origin === 'pointer' &&
      session.current.pointerId === event.pointerId &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      endGesture()
    }
  }

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      session.current?.origin === 'pointer'
      && session.current.pointerId === event.pointerId
    ) endGesture()
  }

  return {
    rootRef,
    announceRef,
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
