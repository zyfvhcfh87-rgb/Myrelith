/** Pure timeline-audio planning shared by live playback and finite export. */

import type {
  AssetId,
  Clip,
  ClipAnimationTrack,
  ClipId,
  TimelineDoc,
  TrackId,
  TransitionAudioCurve,
  TransitionId,
} from './schema'
import {
  resolveCrossfadePlan,
  type CrossfadeLegRole,
  type SourceBoundsCatalog,
} from './crossfadePlan'
import { clipAnimationTrack, evaluateAnimationTrack } from './clipAnimation'
import { audibleTracks, clipContributesAudioOutput } from './selectors'
import {
  timelineAudioMixerGraph,
  type TimelineAudioMasterBus,
  type TimelineAudioTrackBus,
} from './audioMixer'
import { rangeEnd } from './time'
import {
  clipAudioSettings,
  clipAudioSettingsValidationError,
  stereoBalanceGains,
} from './clipInspector'
import {
  clipSourceTimeMap,
  sourceFrameAtTimelineOffset,
  sourceTicksAtTimelineOffset,
  sourceTimeAudioPolicy,
  SOURCE_TIME_TICKS_PER_FRAME,
  type ConstantAudioStretchRate,
  type SourceTimeAudioPolicy,
} from './sourceTimeMap'

export interface TimelineAudioEnvelope {
  transitionId: TransitionId
  startFrame: number
  endFrame: number
  role: CrossfadeLegRole
  curve: TransitionAudioCurve
}

export interface TimelineAudioClipFields {
  clipId: ClipId
  trackId: TrackId
  assetId: AssetId
  timelineStartFrame: number
  timelineEndFrame: number
  /** Authored clip start; animation origin even after crossfade handle expansion. */
  clipTimelineStartFrame: number
  sourceStartFrame: number
  sourceEndFrame: number
  volume: number
  balance: number
  leftGain: number
  rightGain: number
  volumeAnimation: ClipAnimationTrack | null
  balanceAnimation: ClipAnimationTrack | null
  fadeInFrames: number
  fadeOutFrames: number
  envelopes: TimelineAudioEnvelope[]
}

export interface ClipAudioGains {
  readonly volume: number
  readonly balance: number
  readonly leftGain: number
  readonly rightGain: number
}

export function clipAudioGainsAtLocalFrame(
  plan: Pick<
    TimelineAudioClipFields,
    'volume' | 'balance' | 'volumeAnimation' | 'balanceAnimation'
  >,
  localFrame: number,
): ClipAudioGains {
  const volume = plan.volumeAnimation
    ? evaluateAnimationTrack(plan.volumeAnimation, localFrame, plan.volume)
    : plan.volume
  const balance = plan.balanceAnimation
    ? evaluateAnimationTrack(plan.balanceAnimation, localFrame, plan.balance)
    : plan.balance
  const [leftGain, rightGain] = stereoBalanceGains(balance)
  return { volume, balance, leftGain, rightGain }
}

export interface ConstantRateAudioStretch {
  readonly rate: ConstantAudioStretchRate
  readonly sourceStartTicks: number
  readonly sourceEndTicks: number
}

export interface TimelineAudioDirectClipPlan extends TimelineAudioClipFields {
  stretch?: never
}

export interface TimelineAudioStretchedClipPlan extends TimelineAudioClipFields {
  stretch: ConstantRateAudioStretch
}

export type TimelineAudioClipPlan =
  | TimelineAudioDirectClipPlan
  | TimelineAudioStretchedClipPlan

export interface TimelineAudioMixPlan {
  clips: TimelineAudioClipPlan[]
  mutedClips: TimelineAudioMutedClip[]
  tracks: TimelineAudioTrackBus[]
  master: TimelineAudioMasterBus
}

export type { TimelineAudioMasterBus, TimelineAudioTrackBus } from './audioMixer'

export interface TimelineAudioMutedClip {
  clipId: ClipId
  trackId: TrackId
  reason: Extract<SourceTimeAudioPolicy, { status: 'muted' }>['reason']
}

interface PlannedCrossfadeAudio {
  transitionId: TransitionId
  startFrame: number
  endFrame: number
  curve: TransitionAudioCurve
  fromClipId: ClipId
  toClipId: ClipId
}

type AudioContributorDraft =
  | {
      kind: 'direct'
      clip: Clip
      plan: TimelineAudioClipFields
    }
  | {
      kind: 'stretched'
      clip: Clip
      rate: ConstantAudioStretchRate
      plan: TimelineAudioClipFields
    }

export function createConstantRateAudioStretch(
  rate: ConstantAudioStretchRate,
  sourceStartTicks: number,
  sourceEndTicks: number,
): ConstantRateAudioStretch {
  if (rate.numerator === rate.denominator) {
    throw new RangeError('Constant audio stretch rate must not be unity')
  }
  if (
    !Number.isSafeInteger(sourceStartTicks)
    || !Number.isSafeInteger(sourceEndTicks)
  ) {
    throw new RangeError('Constant audio stretch ticks must be safe integers')
  }
  if (sourceStartTicks < 0) {
    throw new RangeError('Constant audio stretch start must be non-negative')
  }
  if (sourceEndTicks <= sourceStartTicks) {
    throw new RangeError('Constant audio stretch range must be non-empty and ordered')
  }
  return { rate, sourceStartTicks, sourceEndTicks }
}

export function isStretchedAudioClipPlan(
  plan: TimelineAudioClipPlan,
): plan is TimelineAudioStretchedClipPlan {
  return plan.stretch !== undefined
}

function assertVirtualSourceRange(plan: TimelineAudioClipFields): void {
  if (
    !Number.isSafeInteger(plan.sourceStartFrame)
    || plan.sourceStartFrame < 0
    || !Number.isSafeInteger(plan.sourceEndFrame)
    || plan.sourceEndFrame <= plan.sourceStartFrame
  ) {
    throw new RangeError(
      `Audio clip "${plan.clipId}" has an invalid virtual source range`,
    )
  }
}

function finishDirectContributor(
  draft: TimelineAudioClipFields,
  clip: Clip,
): TimelineAudioDirectClipPlan {
  const timelinePhase = sourceFrameAtTimelineOffset(clipSourceTimeMap(clip), 0)
    - clip.timelineRange.startFrame
  const plan: TimelineAudioDirectClipPlan = {
    ...draft,
    sourceStartFrame: draft.timelineStartFrame + timelinePhase,
    sourceEndFrame: draft.timelineEndFrame + timelinePhase,
  }
  assertVirtualSourceRange(plan)
  return plan
}

function finishStretchedContributor(
  draft: TimelineAudioClipFields,
  clip: Clip,
  rate: ConstantAudioStretchRate,
): TimelineAudioStretchedClipPlan {
  const map = clipSourceTimeMap(clip)
  const localStart = draft.timelineStartFrame - clip.timelineRange.startFrame
  const localEnd = draft.timelineEndFrame - clip.timelineRange.startFrame
  const sourceStartTicks = sourceTicksAtTimelineOffset(map, localStart)
  const sourceEndTicks = sourceTicksAtTimelineOffset(map, localEnd)
  const ticksPerFrame = BigInt(SOURCE_TIME_TICKS_PER_FRAME)
  const plan: TimelineAudioStretchedClipPlan = {
    ...draft,
    sourceStartFrame: Number(BigInt(sourceStartTicks) / ticksPerFrame),
    sourceEndFrame: Number(
      (BigInt(sourceEndTicks) + ticksPerFrame - 1n) / ticksPerFrame,
    ),
    stretch: createConstantRateAudioStretch(
      rate,
      sourceStartTicks,
      sourceEndTicks,
    ),
  }
  assertVirtualSourceRange(plan)
  return plan
}

function windowsOverlap(
  left: { startFrame: number; endFrame: number },
  right: { startFrame: number; endFrame: number },
): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}

/**
 * Canonical gain at one absolute crossfade phase. Callers derive `progress`
 * from the complete transition window, never from a local decode/mix block.
 */
export function crossfadeAudioGain(
  curve: TransitionAudioCurve,
  role: CrossfadeLegRole,
  progress: number,
): number {
  if (!Number.isFinite(progress)) {
    throw new RangeError('Crossfade audio progress must be finite')
  }
  const bounded = Math.min(1, Math.max(0, progress))
  if (curve === 'linear') return role === 'from' ? 1 - bounded : bounded
  const angle = bounded * Math.PI / 2
  return role === 'from' ? Math.cos(angle) : Math.sin(angle)
}

/**
 * Build the immutable audible contributor set. Valid linked crossfades extend
 * their existing audio clips into real source handles; invalid, disabled, or
 * unavailable audio plans retain the historical ordinary hard cut.
 */
export function createTimelineAudioMixPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan {
  const audible = audibleTracks(doc)
  const plans = new Map<ClipId, AudioContributorDraft>()
  const mutedClips: TimelineAudioMutedClip[] = []
  for (const track of audible) {
    for (const clip of track.clips) {
      const timelineEndFrame = rangeEnd(clip.timelineRange)
      const sourceEndFrame = rangeEnd(clip.sourceRange)
      if (
        !Number.isSafeInteger(clip.timelineRange.startFrame)
        || clip.timelineRange.startFrame < 0
        || !Number.isSafeInteger(timelineEndFrame)
        || timelineEndFrame <= clip.timelineRange.startFrame
        || !Number.isSafeInteger(clip.sourceRange.startFrame)
        || clip.sourceRange.startFrame < 0
        || !Number.isSafeInteger(sourceEndFrame)
        || sourceEndFrame <= clip.sourceRange.startFrame
      ) {
        throw new RangeError(`Audio clip "${clip.id}" has an invalid range`)
      }
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 2) {
        throw new RangeError(`Audio clip "${clip.id}" has an invalid volume`)
      }
      const retimePolicy = sourceTimeAudioPolicy(clip)
      if (retimePolicy.status === 'muted') {
        mutedClips.push({
          clipId: clip.id,
          trackId: track.id,
          reason: retimePolicy.reason,
        })
        continue
      }
      const audio = clipAudioSettings(clip)
      const audioError = clipAudioSettingsValidationError(
        audio,
        clip.timelineRange.durationFrames,
      )
      if (audioError) {
        throw new RangeError(`Audio clip "${clip.id}" ${audioError}`)
      }
      if (!clipContributesAudioOutput(clip)) continue
      const [leftGain, rightGain] = stereoBalanceGains(audio.balance)
      const plan: TimelineAudioClipFields = {
        clipId: clip.id,
        trackId: track.id,
        assetId: clip.assetId,
        timelineStartFrame: clip.timelineRange.startFrame,
        timelineEndFrame,
        clipTimelineStartFrame: clip.timelineRange.startFrame,
        sourceStartFrame: sourceFrameAtTimelineOffset(clipSourceTimeMap(clip), 0),
        sourceEndFrame,
        volume: clip.volume,
        balance: audio.balance,
        leftGain,
        rightGain,
        volumeAnimation: clipAnimationTrack(clip, 'volume'),
        balanceAnimation: clipAnimationTrack(clip, 'balance'),
        fadeInFrames: audio.fadeInFrames,
        fadeOutFrames: audio.fadeOutFrames,
        envelopes: [],
      }
      plans.set(clip.id, retimePolicy.kind === 'direct'
        ? { kind: 'direct', clip, plan }
        : { kind: 'stretched', clip, rate: retimePolicy.rate, plan })
    }
  }

  const candidates: PlannedCrossfadeAudio[] = []
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue
    for (const transition of track.transitions) {
      const resolution = resolveCrossfadePlan(
        doc,
        track.id,
        transition.id,
        catalog,
      )
      if (
        resolution.status !== 'available'
        || resolution.plan.audio.status !== 'available'
      ) continue
      candidates.push({
        transitionId: transition.id,
        startFrame: resolution.plan.startFrame,
        endFrame: resolution.plan.endFrame,
        curve: resolution.plan.audio.curve,
        fromClipId: resolution.plan.audio.from.clip.id,
        toClipId: resolution.plan.audio.to.clip.id,
      })
    }
  }

  // Cross-track malformed documents can target one audio clip with overlapping
  // transition windows even though each video lane is valid in isolation.
  // Fail every conflicting candidate closed instead of multiplying envelopes.
  const conflicting = new Set<PlannedCrossfadeAudio>()
  const byClip = new Map<ClipId, PlannedCrossfadeAudio[]>()
  for (const candidate of candidates) {
    for (const clipId of [candidate.fromClipId, candidate.toClipId]) {
      const entries = byClip.get(clipId) ?? []
      entries.push(candidate)
      byClip.set(clipId, entries)
    }
  }
  for (const entries of byClip.values()) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
        const left = entries[leftIndex]
        const right = entries[rightIndex]
        if (left === right || !windowsOverlap(left, right)) continue
        conflicting.add(left)
        conflicting.add(right)
      }
    }
  }

  for (const candidate of candidates) {
    if (conflicting.has(candidate)) continue
    const legs = [
      { clipId: candidate.fromClipId, role: 'from' as const },
      { clipId: candidate.toClipId, role: 'to' as const },
    ]
    for (const leg of legs) {
      const draft = plans.get(leg.clipId)
      if (!draft) continue
      const { plan } = draft
      plan.timelineStartFrame = Math.min(
        plan.timelineStartFrame,
        candidate.startFrame,
      )
      plan.timelineEndFrame = Math.max(
        plan.timelineEndFrame,
        candidate.endFrame,
      )
      plan.envelopes.push({
        transitionId: candidate.transitionId,
        startFrame: candidate.startFrame,
        endFrame: candidate.endFrame,
        role: leg.role,
        curve: candidate.curve,
      })
    }
  }

  const finishedPlans = [...plans.values()].map((draft) => {
    draft.plan.envelopes.sort((left, right) =>
      left.startFrame - right.startFrame
      || left.endFrame - right.endFrame
      || left.transitionId.localeCompare(right.transitionId),
    )
    return draft.kind === 'direct'
      ? finishDirectContributor(draft.plan, draft.clip)
      : finishStretchedContributor(draft.plan, draft.clip, draft.rate)
  })

  const mixer = timelineAudioMixerGraph(doc)
  return {
    clips: finishedPlans.sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.trackId.localeCompare(right.trackId)
      || left.clipId.localeCompare(right.clipId),
    ),
    mutedClips: mutedClips.sort((left, right) =>
      left.trackId.localeCompare(right.trackId)
      || left.clipId.localeCompare(right.clipId),
    ),
    tracks: mixer.tracks,
    master: mixer.master,
  }
}
