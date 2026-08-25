/**
 * Composition-root sequence edits: insert, overwrite, lift, extract,
 * replace, and roll. Reads Source Monitor, targeting, and timeline marks,
 * then commits at most one documentStore history entry.
 */

import {
  defaultTrackTargets,
  planSequenceEdit,
  reconcileTrackTargets,
  sequenceEditRejectionMessage,
  type SequenceEditKind,
  type SequenceEditInput,
  type TrackTargets,
} from '../domain/threePointEdit'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'

export function resolvedTrackTargets(): TrackTargets {
  const doc = useDocumentStore.getState().doc
  const transport = useTransportStore.getState()
  const requested = transport.trackTargetsTouched
    ? {
        videoTrackId: transport.videoTargetTrackId,
        audioTrackId: transport.audioTargetTrackId,
      }
    : defaultTrackTargets(doc)
  return reconcileTrackTargets(doc, requested)
}

export function toggleTrackTarget(trackId: string, kind: 'video' | 'audio'): void {
  const current = resolvedTrackTargets()
  if (kind === 'video') {
    useTransportStore.getState().setTrackTargets({
      videoTrackId: current.videoTrackId === trackId ? null : trackId,
      audioTrackId: current.audioTrackId,
    })
    return
  }
  useTransportStore.getState().setTrackTargets({
    videoTrackId: current.videoTrackId,
    audioTrackId: current.audioTrackId === trackId ? null : trackId,
  })
}

export function currentSequenceEditInput(
  kind: SequenceEditKind,
  extras: { rollDeltaFrames?: number } = {},
): SequenceEditInput {
  const document = useDocumentStore.getState()
  const transport = useTransportStore.getState()
  const source = useSourceMonitorStore.getState()
  const media = useMediaStore.getState()
  const session = source.session
  const asset = session
    ? media.assets.get(session.source.assetId) ?? null
    : null
  const compatibility = session
    ? media.compatibility.get(session.source.assetId)
    : undefined
  const targets = resolvedTrackTargets()
  return {
    kind,
    doc: document.doc,
    asset,
    compatibility,
    sourceSession: session,
    playheadFrame: transport.playheadFrame,
    timelineInFrame: transport.timelineInFrame,
    timelineOutExclusive: transport.timelineOutExclusive,
    videoTargetTrackId: targets.videoTrackId,
    audioTargetTrackId: targets.audioTrackId,
    patchVideo: source.patchVideo,
    patchAudio: source.patchAudio,
    selectedClipId: transport.selectedClipId,
    rollDeltaFrames: extras.rollDeltaFrames,
  }
}

export function sequenceEditDisabledReason(
  kind: SequenceEditKind,
  extras: { rollDeltaFrames?: number } = {},
): string | null {
  const plan = planSequenceEdit(currentSequenceEditInput(kind, extras))
  return plan.status === 'reject' ? sequenceEditRejectionMessage(plan.reason) : null
}

export function executeSequenceEdit(
  kind: SequenceEditKind,
  extras: { rollDeltaFrames?: number } = {},
): { executed: boolean; reason: string | null } {
  const input = currentSequenceEditInput(kind, extras)
  const plan = planSequenceEdit(input)
  if (plan.status === 'reject') {
    return { executed: false, reason: sequenceEditRejectionMessage(plan.reason) }
  }
  const before = useDocumentStore.getState().doc
  useDocumentStore.getState().applySequenceEdit(plan, input.asset)
  const after = useDocumentStore.getState().doc
  if (after === before) {
    return {
      executed: false,
      reason: 'The timeline could not accept this edit.',
    }
  }
  return { executed: true, reason: null }
}

export function executeFocusedMarkIn(): void {
  if (
    useTransportStore.getState().focusedMonitor === 'source'
    && useSourceMonitorStore.getState().session
  ) {
    useSourceMonitorStore.getState().setIn()
    return
  }
  useTransportStore.getState().setTimelineIn()
}

export function executeFocusedMarkOut(): void {
  if (
    useTransportStore.getState().focusedMonitor === 'source'
    && useSourceMonitorStore.getState().session
  ) {
    useSourceMonitorStore.getState().setOut()
    return
  }
  useTransportStore.getState().setTimelineOut()
}

export function executeFocusedClearIn(): void {
  if (
    useTransportStore.getState().focusedMonitor === 'source'
    && useSourceMonitorStore.getState().session
  ) {
    useSourceMonitorStore.getState().clearIn()
    return
  }
  useTransportStore.getState().clearTimelineIn()
}

export function executeFocusedClearOut(): void {
  if (
    useTransportStore.getState().focusedMonitor === 'source'
    && useSourceMonitorStore.getState().session
  ) {
    useSourceMonitorStore.getState().clearOut()
    return
  }
  useTransportStore.getState().clearTimelineOut()
}

export function focusProgramMonitor(): void {
  useTransportStore.getState().setFocusedMonitor('program')
}

export function focusSourceMonitor(): void {
  useTransportStore.getState().setFocusedMonitor('source')
}
