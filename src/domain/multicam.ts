/** Pure validation and logarithmic angle selection for portable multicam intent. */

import type {
  MulticamAngle,
  MulticamDefinition,
  MulticamAngleId,
  TimelineDoc,
  TrackKind,
} from './schema'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

export const MULTICAM_LIMITS = Object.freeze({
  minAngles: 2,
  maxAngles: 8,
  maxSwitchesPerDefinition: 65_536,
})

export interface MulticamSelectedSource {
  readonly angleId: MulticamAngleId
  readonly assetId: string
  readonly sourceFrame: number | null
}

export interface MulticamSelection {
  readonly frame: number
  readonly switchFrame: number
  readonly video: MulticamSelectedSource
  readonly audio: MulticamSelectedSource
  readonly switchComparisons: number
}

export interface MulticamPlanner {
  select(frame: number): MulticamSelection
  videoSegments(startFrame: number, endFrame: number): readonly MulticamAudioSegment[]
  audioSegments(startFrame: number, endFrame: number): readonly MulticamAudioSegment[]
}

export interface MulticamAudioSegment {
  readonly angleId: MulticamAngleId
  readonly assetId: string
  /** Half-open definition-local coverage after policy and angle gaps. */
  readonly startFrame: number
  readonly endFrame: number
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
}

function assertValidDefinition(definition: MulticamDefinition): void {
  const error = multicamDefinitionValidationError(definition)
  if (error) throw new RangeError(error)
}

function identifierError(value: unknown, field: string): string | null {
  return typeof value !== 'string' || value.length === 0
    || value.length > MAX_DOCUMENT_ID_CHARACTERS
    ? `${field} must be a non-empty bounded identifier`
    : null
}

function nameError(value: unknown, field: string): string | null {
  return typeof value !== 'string' || value.trim().length === 0
    || value.length > MAX_PROJECT_NAME_CHARACTERS
    ? `${field} must be a non-empty bounded name`
    : null
}

function angleSourceFrame(angle: MulticamAngle, frame: number): number | null {
  const endFrame = angle.coverage.startFrame + angle.coverage.durationFrames
  return frame < angle.coverage.startFrame || frame >= endFrame
    ? null
    : angle.sourceStartFrame + frame - angle.coverage.startFrame
}

export function multicamDefinitionValidationError(
  definition: MulticamDefinition,
): string | null {
  const idError = identifierError(definition.id, 'multicam id')
  if (idError) return idError
  const definitionNameError = nameError(definition.name, 'multicam name')
  if (definitionNameError) return definitionNameError
  if (!Number.isSafeInteger(definition.durationFrames) || definition.durationFrames < 1) {
    return 'multicam duration must be a positive safe integer'
  }
  if (
    !Array.isArray(definition.angles)
    || definition.angles.length < MULTICAM_LIMITS.minAngles
    || definition.angles.length > MULTICAM_LIMITS.maxAngles
  ) return 'multicam must contain 2..8 angles'
  const angles = new Set<string>()
  for (const angle of definition.angles) {
    const angleIdError = identifierError(angle.id, 'multicam angle id')
    if (angleIdError) return angleIdError
    if (angles.has(angle.id)) return `duplicate multicam angle "${angle.id}"`
    angles.add(angle.id)
    const angleNameError = nameError(angle.name, `multicam angle "${angle.id}" name`)
    if (angleNameError) return angleNameError
    const assetIdError = identifierError(angle.assetId, `multicam angle "${angle.id}" asset id`)
    if (assetIdError) return assetIdError
    if (
      !Number.isSafeInteger(angle.coverage.startFrame)
      || angle.coverage.startFrame < 0
      || !Number.isSafeInteger(angle.coverage.durationFrames)
      || angle.coverage.durationFrames < 1
    ) return `multicam angle "${angle.id}" coverage must be a positive safe range`
    const coverageEnd = angle.coverage.startFrame + angle.coverage.durationFrames
    if (!Number.isSafeInteger(coverageEnd) || coverageEnd > definition.durationFrames) {
      return `multicam angle "${angle.id}" coverage exceeds the definition duration`
    }
    if (!Number.isSafeInteger(angle.sourceStartFrame) || angle.sourceStartFrame < 0) {
      return `multicam angle "${angle.id}" source start must be a non-negative safe integer`
    }
    if (!Number.isSafeInteger(angle.sourceStartFrame + angle.coverage.durationFrames)) {
      return `multicam angle "${angle.id}" source end must be a safe integer`
    }
  }
  if (
    !Array.isArray(definition.switches)
    || definition.switches.length < 1
    || definition.switches.length > MULTICAM_LIMITS.maxSwitchesPerDefinition
  ) return `multicam must contain 1..${MULTICAM_LIMITS.maxSwitchesPerDefinition} switches`
  let previousFrame = -1
  for (const item of definition.switches) {
    if (
      !Number.isSafeInteger(item.frame)
      || item.frame <= previousFrame
      || item.frame >= definition.durationFrames
    ) return 'multicam switches must be strictly increasing and in range'
    if (!angles.has(item.videoAngleId)) {
      return `multicam switch references missing angle "${item.videoAngleId}"`
    }
    previousFrame = item.frame
  }
  if (definition.switches[0].frame !== 0) {
    return 'the first multicam switch must begin at frame zero'
  }
  if (
    definition.audioPolicy.kind !== 'follow-video'
    && (
      definition.audioPolicy.kind !== 'fixed'
      || !angles.has(definition.audioPolicy.angleId)
    )
  ) return 'multicam fixed audio references a missing angle'
  return null
}

interface LinkedTimelineMember {
  readonly kind: 'clip' | 'sequence' | 'multicam'
  readonly trackKind: TrackKind
  readonly id: string
  readonly linkGroupId: string
  readonly multicamId?: string
  readonly sourceStartFrame?: number
  readonly timelineRange: { readonly startFrame: number; readonly durationFrames: number }
}

/** Multicam A/V links are always one exact video/audio pair, never a mixed group. */
export function multicamLinkedPairValidationError(
  sequence: TimelineDoc,
): string | null {
  const groups = new Map<string, LinkedTimelineMember[]>()
  const add = (member: LinkedTimelineMember): void => {
    const values = groups.get(member.linkGroupId) ?? []
    values.push(member)
    groups.set(member.linkGroupId, values)
  }
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.linkGroupId) add({
        kind: 'clip',
        trackKind: track.kind,
        id: clip.id,
        linkGroupId: clip.linkGroupId,
        timelineRange: clip.timelineRange,
      })
    }
    for (const instance of track.sequenceInstances ?? []) {
      if (instance.linkGroupId) add({
        kind: 'sequence',
        trackKind: track.kind,
        id: instance.id,
        linkGroupId: instance.linkGroupId,
        timelineRange: instance.timelineRange,
      })
    }
    for (const instance of track.multicamInstances ?? []) {
      if (instance.linkGroupId) add({
        kind: 'multicam',
        trackKind: track.kind,
        id: instance.id,
        linkGroupId: instance.linkGroupId,
        multicamId: instance.multicamId,
        sourceStartFrame: instance.sourceStartFrame,
        timelineRange: instance.timelineRange,
      })
    }
  }
  for (const [linkGroupId, members] of groups) {
    if (!members.some((member) => member.kind === 'multicam')) continue
    if (
      members.length !== 2
      || members.some((member) => member.kind !== 'multicam')
      || new Set(members.map((member) => member.trackKind)).size !== 2
      || !members.some((member) => member.trackKind === 'video')
      || !members.some((member) => member.trackKind === 'audio')
    ) return `multicam link group "${linkGroupId}" must be one video/audio pair`
    const first = members[0]
    if (members.some((member) => (
      member.multicamId !== first.multicamId
      || member.sourceStartFrame !== first.sourceStartFrame
      || member.timelineRange.startFrame !== first.timelineRange.startFrame
      || member.timelineRange.durationFrames !== first.timelineRange.durationFrames
    ))) return `multicam link group "${linkGroupId}" must share exact geometry`
  }
  return null
}

export function createMulticamPlanner(
  definition: MulticamDefinition,
): MulticamPlanner {
  assertValidDefinition(definition)
  const angles = new Map(definition.angles.map((angle) => [angle.id, angle]))
  const switches = definition.switches
  return Object.freeze({
    select(frame: number): MulticamSelection {
      if (
        !Number.isSafeInteger(frame)
        || frame < 0
        || frame >= definition.durationFrames
      ) throw new RangeError('multicam frame falls outside the definition')
      let lower = 0
      let upper = switches.length
      let switchComparisons = 0
      while (lower < upper) {
        switchComparisons++
        const middle = lower + Math.floor((upper - lower) / 2)
        if (switches[middle].frame <= frame) lower = middle + 1
        else upper = middle
      }
      const selectedSwitch = switches[lower - 1]
      const videoAngle = angles.get(selectedSwitch.videoAngleId)!
      const audioAngle = definition.audioPolicy.kind === 'fixed'
        ? angles.get(definition.audioPolicy.angleId)!
        : videoAngle
      return Object.freeze({
        frame,
        switchFrame: selectedSwitch.frame,
        video: Object.freeze({
          angleId: videoAngle.id,
          assetId: videoAngle.assetId,
          sourceFrame: angleSourceFrame(videoAngle, frame),
        }),
        audio: Object.freeze({
          angleId: audioAngle.id,
          assetId: audioAngle.assetId,
          sourceFrame: angleSourceFrame(audioAngle, frame),
        }),
        switchComparisons,
      })
    },
    videoSegments(startFrame: number, endFrame: number): readonly MulticamAudioSegment[] {
      return resolveMulticamSegments(
        definition,
        angles,
        switches,
        null,
        startFrame,
        endFrame,
      )
    },
    audioSegments(startFrame: number, endFrame: number): readonly MulticamAudioSegment[] {
      return resolveMulticamSegments(
        definition,
        angles,
        switches,
        definition.audioPolicy.kind === 'fixed'
          ? definition.audioPolicy.angleId
          : null,
        startFrame,
        endFrame,
      )
    },
  })
}

/**
 * Resolve the exact non-silent audio windows for a definition-local range.
 * Fixed-master output is independent of video switches; follow-video output
 * changes only at authored switches. Missing selected-angle coverage remains
 * absent, which the shared mixer renders as silence.
 */
function resolveMulticamSegments(
  definition: MulticamDefinition,
  angles: ReadonlyMap<MulticamAngleId, MulticamAngle>,
  switches: readonly MulticamDefinition['switches'][number][],
  fixedAngleId: MulticamAngleId | null,
  startFrame: number,
  endFrame: number,
): readonly MulticamAudioSegment[] {
  if (
    !Number.isSafeInteger(startFrame)
    || !Number.isSafeInteger(endFrame)
    || startFrame < 0
    || endFrame > definition.durationFrames
    || startFrame > endFrame
  ) throw new RangeError('multicam audio window falls outside the definition')
  if (startFrame === endFrame) return Object.freeze([])
  const result: MulticamAudioSegment[] = []
  const append = (angle: MulticamAngle, segmentStart: number, segmentEnd: number): void => {
    const start = Math.max(segmentStart, startFrame, angle.coverage.startFrame)
    const end = Math.min(
      segmentEnd,
      endFrame,
      angle.coverage.startFrame + angle.coverage.durationFrames,
    )
    if (start >= end) return
    const sourceStartFrame = angle.sourceStartFrame + start - angle.coverage.startFrame
    const previous = result.at(-1)
    if (
      previous
      && previous.angleId === angle.id
      && previous.endFrame === start
      && previous.sourceEndFrame === sourceStartFrame
    ) {
      result[result.length - 1] = {
        ...previous,
        endFrame: end,
        sourceEndFrame: sourceStartFrame + end - start,
      }
      return
    }
    result.push({
      angleId: angle.id,
      assetId: angle.assetId,
      startFrame: start,
      endFrame: end,
      sourceStartFrame,
      sourceEndFrame: sourceStartFrame + end - start,
    })
  }
  if (fixedAngleId !== null) {
    append(
      angles.get(fixedAngleId)!,
      startFrame,
      endFrame,
    )
    return Object.freeze(result.map((segment) => Object.freeze(segment)))
  }
  let lower = 0
  let upper = switches.length
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if (switches[middle].frame <= startFrame) lower = middle + 1
    else upper = middle
  }
  for (let index = Math.max(0, lower - 1); index < switches.length; index++) {
    const item = switches[index]
    const segmentEnd = switches[index + 1]?.frame ?? definition.durationFrames
    if (item.frame >= endFrame) break
    append(angles.get(item.videoAngleId)!, item.frame, segmentEnd)
  }
  return Object.freeze(result.map((segment) => Object.freeze(segment)))
}

/** One-shot convenience wrapper; hot paths compile and reuse a planner. */
export function multicamAudioSegments(
  definition: MulticamDefinition,
  startFrame: number,
  endFrame: number,
): readonly MulticamAudioSegment[] {
  return createMulticamPlanner(definition).audioSegments(startFrame, endFrame)
}

/** Insert or replace one exact video cut and canonicalize equal neighbours. */
export function setMulticamCut(
  definition: MulticamDefinition,
  frame: number,
  videoAngleId: MulticamAngleId,
): MulticamDefinition {
  assertValidDefinition(definition)
  if (
    !Number.isSafeInteger(frame)
    || frame < 0
    || frame >= definition.durationFrames
  ) throw new RangeError('multicam cut frame falls outside the definition')
  if (!definition.angles.some((angle) => angle.id === videoAngleId)) {
    throw new RangeError(`multicam cut references missing angle "${videoAngleId}"`)
  }
  const switches = definition.switches
    .filter((item) => item.frame !== frame)
    .concat({ frame, videoAngleId })
    .sort((left, right) => left.frame - right.frame)
  const canonical = switches.filter((item, index) => (
    index === 0 || switches[index - 1].videoAngleId !== item.videoAngleId
  ))
  if (
    canonical.length === definition.switches.length
    && canonical.every((item, index) => (
      item.frame === definition.switches[index].frame
      && item.videoAngleId === definition.switches[index].videoAngleId
    ))
  ) return definition
  const next = { ...definition, switches: canonical }
  assertValidDefinition(next)
  return next
}

/** Move one authored cut while preserving strict ordering and frame-zero intent. */
export function rollMulticamCut(
  definition: MulticamDefinition,
  cutFrame: number,
  nextFrame: number,
): MulticamDefinition {
  assertValidDefinition(definition)
  const index = definition.switches.findIndex((item) => item.frame === cutFrame)
  if (index <= 0) throw new RangeError('multicam roll requires a non-zero existing cut')
  const lower = definition.switches[index - 1].frame
  const upper = definition.switches[index + 1]?.frame ?? definition.durationFrames
  if (
    !Number.isSafeInteger(nextFrame)
    || nextFrame <= lower
    || nextFrame >= upper
  ) throw new RangeError('multicam roll must stay between neighbouring cuts')
  if (nextFrame === cutFrame) return definition
  const switches = definition.switches.map((item, itemIndex) => (
    itemIndex === index ? { ...item, frame: nextFrame } : item
  ))
  const next = { ...definition, switches }
  assertValidDefinition(next)
  return next
}
