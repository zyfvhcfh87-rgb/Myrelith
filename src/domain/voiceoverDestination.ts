/** Pinned capture intent and live destination checks; no media or project mutation. */
import { planMediaAssetPlacement, type MediaPlacementRejection } from './mediaPlacement'
import type { FrameRate, TimelineDoc } from './schema'
import { rateEquals } from './time'

export interface VoiceoverDestinationContext {
  readonly projectId: string
  readonly projectGeneration: number
  /** App-owned monotonic revision, including edits, undo/redo and navigation. */
  readonly editRevision: number
  /** The currently active sequence. */
  readonly doc: TimelineDoc
}

export interface VoiceoverDestination {
  readonly projectId: string
  readonly projectGeneration: number
  readonly editRevision: number
  readonly sequenceId: string
  readonly trackId: string
  readonly startFrame: number
  readonly frameRate: Readonly<FrameRate>
  readonly audioSampleRate: number
}

export type VoiceoverDestinationRejection = MediaPlacementRejection
  | 'invalid-destination' | 'stale-project' | 'stale-sequence' | 'stale-edit' | 'changed-rate'

export type VoiceoverDestinationCheck =
  | { readonly status: 'valid' }
  | { readonly status: 'reject'; readonly reason: VoiceoverDestinationRejection }

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validRate(rate: Readonly<FrameRate>): boolean {
  return Number.isSafeInteger(rate.num) && rate.num > 0 &&
    Number.isSafeInteger(rate.den) && rate.den > 0
}

/** Unknown duration checks the insertion frame; recheck the full take after import. */
export function checkVoiceoverDestination(
  pinned: VoiceoverDestination,
  live: VoiceoverDestinationContext,
  durationFrames = 1,
): VoiceoverDestinationCheck {
  const reject = (reason: VoiceoverDestinationRejection): VoiceoverDestinationCheck => ({ status: 'reject', reason })
  if (!pinned.projectId || !pinned.sequenceId || !pinned.trackId || !live.projectId ||
    !nonNegativeInteger(pinned.projectGeneration) || !nonNegativeInteger(live.projectGeneration) ||
    !nonNegativeInteger(pinned.editRevision) || !nonNegativeInteger(live.editRevision) ||
    !nonNegativeInteger(pinned.startFrame)) return reject('invalid-destination')
  if (pinned.projectId !== live.projectId || pinned.projectGeneration !== live.projectGeneration) {
    return reject('stale-project')
  }
  if (pinned.sequenceId !== live.doc.id) return reject('stale-sequence')
  if (!validRate(pinned.frameRate) || !validRate(live.doc.frameRate) ||
    !Number.isSafeInteger(pinned.audioSampleRate) || pinned.audioSampleRate <= 0 ||
    !Number.isSafeInteger(live.doc.audioSampleRate) || live.doc.audioSampleRate <= 0) return reject('invalid-destination')
  if (!rateEquals(pinned.frameRate, live.doc.frameRate) || pinned.audioSampleRate !== live.doc.audioSampleRate) {
    return reject('changed-rate')
  }
  if (pinned.editRevision !== live.editRevision) return reject('stale-edit')
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 ||
    !Number.isSafeInteger(pinned.startFrame + durationFrames)) return reject('invalid-duration')
  const plan = planMediaAssetPlacement({
    doc: live.doc,
    asset: { kind: 'audio', hasAudio: true, durationFrames },
    trackId: pinned.trackId,
    startFrame: pinned.startFrame,
    timelineCompatible: true,
  })
  return plan.status === 'reject' ? plan : { status: 'valid' }
}

export function pinVoiceoverDestination(
  live: VoiceoverDestinationContext,
  trackId: string,
  startFrame: number,
): { readonly status: 'pinned'; readonly destination: VoiceoverDestination }
  | Extract<VoiceoverDestinationCheck, { status: 'reject' }> {
  const destination: VoiceoverDestination = Object.freeze({
    projectId: live.projectId,
    projectGeneration: live.projectGeneration,
    editRevision: live.editRevision,
    sequenceId: live.doc.id,
    trackId,
    startFrame,
    frameRate: Object.freeze({ ...live.doc.frameRate }),
    audioSampleRate: live.doc.audioSampleRate,
  })
  const check = checkVoiceoverDestination(destination, live)
  return check.status === 'reject' ? check : { status: 'pinned', destination }
}

export type VoiceoverKeepDestination =
  | { readonly status: 'retain-draft'; readonly reason: 'stale-project' }
  | { readonly status: 'pool-only'; readonly reason: VoiceoverDestinationRejection | null }
  | { readonly status: 'place'; readonly trackId: string; readonly startFrame: number }

/**
 * A replaced project cannot receive the take. Other placement failures keep it
 * available in the same project's Pool. This is destination policy only: the
 * app must verify/import the file and recheck currentness before each commit.
 */
export function resolveVoiceoverKeepDestination(
  pinned: VoiceoverDestination,
  live: VoiceoverDestinationContext,
  durationFrames: number,
  placeOnTimeline: boolean,
): VoiceoverKeepDestination {
  if (pinned.projectId !== live.projectId || pinned.projectGeneration !== live.projectGeneration) {
    return { status: 'retain-draft', reason: 'stale-project' }
  }
  if (!placeOnTimeline) return { status: 'pool-only', reason: null }
  const check = checkVoiceoverDestination(pinned, live, durationFrames)
  return check.status === 'reject'
    ? { status: 'pool-only', reason: check.reason }
    : { status: 'place', trackId: pinned.trackId, startFrame: pinned.startFrame }
}
