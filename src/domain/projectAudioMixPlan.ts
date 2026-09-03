/** Shared immutable audio plan for one project sequence, including nesting. */

import type {
  SequenceInstanceId,
  TimelineDoc,
  TrackId,
} from './schema'
import type { SourceBoundsCatalog } from './crossfadePlan'
import type { SequenceProject } from './projectSequences'
import { sequenceById } from './projectSequences'
import {
  createTimelineAudioMixPlan,
  isRampedAudioClipPlan,
  isStretchedAudioClipPlan,
  type TimelineAudioClipPlan,
  type TimelineAudioMixPlan,
  type TimelineAudioMutedClip,
  type TimelineAudioTrackBus,
} from './audioMixPlan'
import {
  MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME,
  analyzeNestedSequenceGraph,
  sequenceInstances,
} from './nestedSequences'
import { timelineAudioMixerGraph } from './audioMixer'
import { audibleTracks, docDurationFrames } from './selectors'
import {
  SOURCE_TIME_TICKS_PER_FRAME,
  sourceTicksAtTimelineOffset,
} from './sourceTimeMap'
import { rangeEnd } from './time'

interface BusDraft {
  readonly depth: number
  readonly bus: TimelineAudioTrackBus
}

function scopedId(
  kind: 'clip' | 'track' | 'master',
  path: readonly SequenceInstanceId[],
  durableId: string,
): string {
  if (path.length === 0 && kind !== 'master') return durableId
  return `nested:${JSON.stringify([kind, ...path, durableId])}`
}

function stretchedTickAt(
  plan: Extract<TimelineAudioClipPlan, { stretch: object }>,
  localFrame: number,
): number {
  const frameOffset = BigInt(localFrame - plan.timelineStartFrame)
  const numerator = BigInt(plan.stretch.rate.numerator)
  const denominator = BigInt(plan.stretch.rate.denominator)
  const tickOffset = frameOffset * BigInt(SOURCE_TIME_TICKS_PER_FRAME) * numerator
    / denominator
  const value = BigInt(plan.stretch.sourceStartTicks) + tickOffset
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`nested audio clip "${plan.clipId}" source ticks overflow`)
  }
  return result
}

function sourceTicksAt(
  plan: TimelineAudioClipPlan,
  localFrame: number,
): number {
  if (isRampedAudioClipPlan(plan)) {
    return sourceTicksAtTimelineOffset(
      plan.ramp.sourceTimeMap,
      localFrame - plan.clipTimelineStartFrame,
    )
  }
  if (isStretchedAudioClipPlan(plan)) return stretchedTickAt(plan, localFrame)
  return (plan.sourceStartFrame + localFrame - plan.timelineStartFrame)
    * SOURCE_TIME_TICKS_PER_FRAME
}

function mappedClipPlan(
  plan: TimelineAudioClipPlan,
  localStartFrame: number,
  localEndFrame: number,
  rootOffset: number,
  path: readonly SequenceInstanceId[],
  trackId: TrackId,
): TimelineAudioClipPlan | null {
  const startFrame = Math.max(plan.timelineStartFrame, localStartFrame)
  const endFrame = Math.min(plan.timelineEndFrame, localEndFrame)
  if (startFrame >= endFrame) return null
  const sourceStartTicks = sourceTicksAt(plan, startFrame)
  const sourceEndTicks = sourceTicksAt(plan, endFrame)
  const sourceStartFrame = Math.floor(
    sourceStartTicks / SOURCE_TIME_TICKS_PER_FRAME,
  )
  const sourceEndFrame = Math.ceil(
    sourceEndTicks / SOURCE_TIME_TICKS_PER_FRAME,
  )
  const common = {
    ...plan,
    clipId: scopedId('clip', path, plan.clipId),
    trackId,
    timelineStartFrame: startFrame + rootOffset,
    timelineEndFrame: endFrame + rootOffset,
    clipTimelineStartFrame: plan.clipTimelineStartFrame + rootOffset,
    sourceStartFrame,
    sourceEndFrame,
    envelopes: plan.envelopes
      .filter((envelope) => (
        envelope.startFrame < endFrame && startFrame < envelope.endFrame
      ))
      .map((envelope) => ({
        ...envelope,
        startFrame: envelope.startFrame + rootOffset,
        endFrame: envelope.endFrame + rootOffset,
      })),
  }
  if (isRampedAudioClipPlan(plan)) {
    return {
      ...common,
      stretch: undefined,
      ramp: {
        ...plan.ramp,
        sourceStartTicks,
        sourceEndTicks,
        silenceRanges: plan.ramp.silenceRanges
          .filter((range) => range.startFrame < endFrame && startFrame < range.endFrame)
          .map((range) => ({
            startFrame: Math.max(range.startFrame, startFrame) + rootOffset,
            endFrame: Math.min(range.endFrame, endFrame) + rootOffset,
          })),
      },
    }
  }
  if (isStretchedAudioClipPlan(plan)) {
    return {
      ...common,
      ramp: undefined,
      stretch: {
        ...plan.stretch,
        sourceStartTicks,
        sourceEndTicks,
      },
    }
  }
  return { ...common, stretch: undefined, ramp: undefined }
}

function assertLeafLimit(clips: readonly TimelineAudioClipPlan[]): void {
  const events = clips.flatMap((clip) => [
    { frame: clip.timelineStartFrame, delta: 1 },
    { frame: clip.timelineEndFrame, delta: -1 },
  ]).sort((left, right) => left.frame - right.frame || left.delta - right.delta)
  let active = 0
  for (const event of events) {
    active += event.delta
    if (active > MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME) {
      throw new RangeError(
        `nested frame exceeds ${MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME} audio leaves`,
      )
    }
  }
}

export function createProjectTimelineAudioMixPlan(
  project: SequenceProject,
  rootSequenceId: string,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan {
  analyzeNestedSequenceGraph(project)
  const root = sequenceById(project, rootSequenceId)
  if (!root) throw new RangeError(`missing root sequence "${rootSequenceId}"`)
  const clips: TimelineAudioClipPlan[] = []
  const mutedClips: TimelineAudioMutedClip[] = []
  const buses: BusDraft[] = []

  const append = (
    sequence: TimelineDoc,
    localStartFrame: number,
    localEndFrame: number,
    rootOffset: number,
    path: readonly SequenceInstanceId[],
    parentTrackId: TrackId | null,
  ): void => {
    const localPlan = createTimelineAudioMixPlan(sequence, catalog)
    const mixer = timelineAudioMixerGraph(sequence)
    const depth = path.length * 2
    const masterTrackId = scopedId('master', path, sequence.id)
    const trackIds = new Map<TrackId, TrackId>()
    for (const track of mixer.tracks) {
      const trackId = scopedId('track', path, track.trackId)
      trackIds.set(track.trackId, trackId)
      buses.push({
        depth: depth + 1,
        bus: {
          ...track,
          trackId,
          ...(path.length === 0 ? {} : { parentTrackId: masterTrackId }),
        },
      })
    }
    if (path.length > 0) {
      buses.push({
        depth,
        bus: {
          trackId: masterTrackId,
          ...(parentTrackId === null ? {} : { parentTrackId }),
          volume: mixer.master.muted ? 0 : mixer.master.volume,
          balance: mixer.master.balance,
          leftGain: mixer.master.leftGain,
          rightGain: mixer.master.rightGain,
          audioEffects: mixer.master.audioEffects,
        },
      })
    }
    for (const plan of localPlan.clips) {
      const trackId = trackIds.get(plan.trackId)
      if (!trackId) continue
      const mapped = mappedClipPlan(
        plan,
        localStartFrame,
        localEndFrame,
        rootOffset,
        path,
        trackId,
      )
      if (mapped) clips.push(mapped)
    }
    for (const muted of localPlan.mutedClips) {
      const trackId = trackIds.get(muted.trackId)
      if (!trackId) continue
      mutedClips.push({
        ...muted,
        clipId: scopedId('clip', path, muted.clipId),
        trackId,
      })
    }

    const audibleTrackIds = new Set(audibleTracks(sequence).map((track) => track.id))
    for (const track of sequence.tracks) {
      if (track.kind !== 'audio' || !audibleTrackIds.has(track.id)) continue
      const scopedTrackId = trackIds.get(track.id)
      if (!scopedTrackId) continue
      for (const instance of sequenceInstances(track)) {
        const instanceStart = Math.max(
          localStartFrame,
          instance.timelineRange.startFrame,
        )
        const instanceEnd = Math.min(localEndFrame, rangeEnd(instance.timelineRange))
        if (instanceStart >= instanceEnd) continue
        const child = sequenceById(project, instance.sequenceId)
        if (!child) throw new RangeError(`missing sequence "${instance.sequenceId}"`)
        const childStart = instance.sourceStartFrame
          + instanceStart
          - instance.timelineRange.startFrame
        const childEnd = childStart + instanceEnd - instanceStart
        append(
          child,
          childStart,
          childEnd,
          rootOffset + instance.timelineRange.startFrame - instance.sourceStartFrame,
          [...path, instance.id],
          scopedTrackId,
        )
      }
    }
  }

  append(root, 0, docDurationFrames(root), 0, [], null)
  assertLeafLimit(clips)
  const rootMixer = timelineAudioMixerGraph(root)
  return Object.freeze({
    clips: Object.freeze(clips.toSorted((left, right) => (
      left.timelineStartFrame - right.timelineStartFrame
      || left.trackId.localeCompare(right.trackId)
      || left.clipId.localeCompare(right.clipId)
    ))) as TimelineAudioClipPlan[],
    mutedClips: Object.freeze(mutedClips) as TimelineAudioMutedClip[],
    tracks: Object.freeze(buses
      .toSorted((left, right) => right.depth - left.depth)
      .map(({ bus }) => Object.freeze(bus))) as TimelineAudioTrackBus[],
    master: Object.freeze(rootMixer.master),
  }) as TimelineAudioMixPlan
}
