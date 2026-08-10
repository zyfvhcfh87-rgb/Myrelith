/** Pure timeline-audio planning shared by live playback and finite export. */

import type {
  AssetId,
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
import { audibleTracks } from './selectors'
import { rangeEnd } from './time'
import {
  clipAudioSettings,
  clipAudioSettingsValidationError,
  stereoBalanceGains,
} from './clipInspector'
import {
  clipSourceTimeMap,
  sourceFrameAtTimelineOffset,
  sourceTimeAudioPolicy,
} from './sourceTimeMap'

export interface TimelineAudioEnvelope {
  transitionId: TransitionId
  startFrame: number
  endFrame: number
  role: CrossfadeLegRole
  curve: TransitionAudioCurve
}

export interface TimelineAudioClipPlan {
  clipId: ClipId
  trackId: TrackId
  assetId: AssetId
  timelineStartFrame: number
  timelineEndFrame: number
  sourceStartFrame: number
  sourceEndFrame: number
  volume: number
  balance: number
  leftGain: number
  rightGain: number
  fadeInFrames: number
  fadeOutFrames: number
  envelopes: TimelineAudioEnvelope[]
}

export interface TimelineAudioMixPlan {
  clips: TimelineAudioClipPlan[]
  mutedClips: TimelineAudioMutedClip[]
}

export interface TimelineAudioMutedClip {
  clipId: ClipId
  trackId: TrackId
  reason: 'constant-speed-audio-unsupported'
}

interface PlannedCrossfadeAudio {
  transitionId: TransitionId
  startFrame: number
  endFrame: number
  curve: TransitionAudioCurve
  fromClipId: ClipId
  toClipId: ClipId
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
  const plans = new Map<ClipId, TimelineAudioClipPlan>()
  const mutedClips: TimelineAudioMutedClip[] = []
  const sourceTimelinePhases = new Map<ClipId, number>()
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
      if (clip.volume <= 0 || !audio.enabled) continue
      const [leftGain, rightGain] = stereoBalanceGains(audio.balance)
      sourceTimelinePhases.set(
        clip.id,
        sourceFrameAtTimelineOffset(clipSourceTimeMap(clip), 0)
          - clip.timelineRange.startFrame,
      )
      plans.set(clip.id, {
        clipId: clip.id,
        trackId: track.id,
        assetId: clip.assetId,
        timelineStartFrame: clip.timelineRange.startFrame,
        timelineEndFrame,
        sourceStartFrame: sourceFrameAtTimelineOffset(clipSourceTimeMap(clip), 0),
        sourceEndFrame,
        volume: clip.volume,
        balance: audio.balance,
        leftGain,
        rightGain,
        fadeInFrames: audio.fadeInFrames,
        fadeOutFrames: audio.fadeOutFrames,
        envelopes: [],
      })
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
      const plan = plans.get(leg.clipId)
      if (!plan) continue
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

  for (const plan of plans.values()) {
    const timelinePhase = sourceTimelinePhases.get(plan.clipId)
    if (timelinePhase === undefined) {
      throw new Error(`Audio clip "${plan.clipId}" lost its source phase`)
    }
    plan.sourceStartFrame = plan.timelineStartFrame + timelinePhase
    plan.sourceEndFrame = plan.timelineEndFrame + timelinePhase
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
    plan.envelopes.sort((left, right) =>
      left.startFrame - right.startFrame
      || left.endFrame - right.endFrame
      || left.transitionId.localeCompare(right.transitionId),
    )
  }

  return {
    clips: [...plans.values()].sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.trackId.localeCompare(right.trackId)
      || left.clipId.localeCompare(right.clipId),
    ),
    mutedClips: mutedClips.sort((left, right) =>
      left.trackId.localeCompare(right.trackId)
      || left.clipId.localeCompare(right.clipId),
    ),
  }
}
