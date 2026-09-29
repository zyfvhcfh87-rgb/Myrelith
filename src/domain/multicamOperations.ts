/** Atomic project edits for project-owned multicam definitions and items. */

import type {
  MulticamAudioPolicy,
  MulticamDefinition,
  MulticamInstance,
  TimeRange,
  TimelineDoc,
  Track,
} from './schema'
import {
  MULTICAM_LIMITS,
  multicamDefinitionValidationError,
  rollMulticamCut,
  setMulticamCut,
} from './multicam'
import {
  createProjectIdAllocator,
  sequenceById,
  sequenceProjectWithinEditBudget,
  type SequenceIdFactory,
  type SequenceProject,
} from './projectSequences'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'
import { overlapsAny } from './operations/operationInternals'

export interface CreateMulticamAngleInput {
  readonly assetId: string
  readonly name: string
  /** Complete document-rate source duration available to this angle. */
  readonly durationFrames: number
  /** Source frame containing the common clap/event. */
  readonly syncFrame: number
}

export type CreateMulticamAudioPolicy =
  | { readonly kind: 'fixed'; readonly angleIndex: number }
  | { readonly kind: 'follow-video' }

export interface CreateMulticamCommand {
  readonly name: string
  readonly startFrame: number
  readonly videoTrackId: string
  readonly audioTrackId: string | null
  readonly angles: readonly CreateMulticamAngleInput[]
  readonly audioPolicy: CreateMulticamAudioPolicy
}

export type CreateMulticamFailure =
  | 'sequence-not-found'
  | 'invalid-name'
  | 'invalid-angle'
  | 'invalid-placement'
  | 'track-not-found'
  | 'track-kind'
  | 'track-locked'
  | 'overlap'
  | 'id-generation-failed'
  | 'project-budget'

export interface CreateMulticamResult {
  readonly project: SequenceProject
  readonly definitionId: string | null
  readonly videoInstanceId: string | null
  readonly audioInstanceId: string | null
  readonly failure: CreateMulticamFailure | null
}

export type MulticamInstanceEditCommand =
  | {
      readonly kind: 'move'
      readonly instanceId: string
      readonly startFrame: number
    }
  | {
      readonly kind: 'trim'
      readonly instanceId: string
      readonly timelineRange: TimeRange
      readonly sourceStartFrame: number
    }
  | {
      readonly kind: 'split'
      readonly instanceId: string
      readonly frame: number
    }
  | {
      readonly kind: 'duplicate'
      readonly instanceId: string
      readonly startFrame: number
    }
  | {
      readonly kind: 'delete'
      readonly instanceId: string
    }

export type MulticamInstanceEditFailure =
  | 'sequence-not-found'
  | 'instance-not-found'
  | 'invalid-linked-pair'
  | 'invalid-range'
  | 'track-locked'
  | 'overlap'
  | 'id-generation-failed'
  | 'project-budget'

export interface MulticamInstanceEditResult {
  readonly project: SequenceProject
  readonly failure: MulticamInstanceEditFailure | null
}

export type MulticamDefinitionEditCommand =
  | {
      readonly kind: 'set-offsets'
      readonly definitionId: string
      /** Fresh immutable definition captured by the app review owner. */
      readonly expectedDefinition: MulticamDefinition
      readonly offsets: readonly { readonly angleId: string; readonly coverageStartFrame: number }[]
    }
  | {
      readonly kind: 'cut'
      readonly definitionId: string
      readonly frame: number
      readonly angleId: string
    }
  | {
      readonly kind: 'roll-cut'
      readonly definitionId: string
      readonly frame: number
      readonly toFrame: number
    }
  | {
      readonly kind: 'set-audio-policy'
      readonly definitionId: string
      readonly audioPolicy: MulticamAudioPolicy
    }
  | {
      readonly kind: 'set-angle'
      readonly definitionId: string
      readonly angleId: string
      readonly name: string
      readonly coverageStartFrame: number
    }

export type MulticamDefinitionEditFailure =
  | 'definition-not-found'
  | 'invalid-definition'
  | 'track-locked'
  | 'project-budget'

export interface MulticamDefinitionEditResult {
  readonly project: SequenceProject
  readonly failure: MulticamDefinitionEditFailure | null
}

function rejected(
  project: SequenceProject,
  failure: CreateMulticamFailure,
): CreateMulticamResult {
  return {
    project,
    definitionId: null,
    videoInstanceId: null,
    audioInstanceId: null,
    failure,
  }
}

function validName(value: string): boolean {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_PROJECT_NAME_CHARACTERS
}

function validId(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DOCUMENT_ID_CHARACTERS
}

/** Lane order: start frame, then id for a deterministic tie-break. */
function sortedInstances(instances: MulticamInstance[]): MulticamInstance[] {
  return instances.sort((left, right) => (
    left.timelineRange.startFrame - right.timelineRange.startFrame
    || left.id.localeCompare(right.id)
  ))
}

function withInstance(track: Track, instance: MulticamInstance): Track {
  return {
    ...track,
    multicamInstances: sortedInstances([...(track.multicamInstances ?? []), instance]),
  }
}

/**
 * Rebuild only the lanes holding a linked member; every other track keeps
 * its identity (and its absent optional instance list).
 */
function withMemberLanes(
  sequence: TimelineDoc,
  members: readonly LocatedMulticamInstance[],
  update: (instances: readonly MulticamInstance[], trackIndex: number) => MulticamInstance[],
): TimelineDoc {
  const memberTracks = new Set(members.map(({ trackIndex }) => trackIndex))
  return {
    ...sequence,
    tracks: sequence.tracks.map((track, trackIndex) => (
      memberTracks.has(trackIndex)
        ? { ...track, multicamInstances: update(track.multicamInstances ?? [], trackIndex) }
        : track
    )),
  }
}

function commitInstanceEdit(
  project: SequenceProject,
  sequenceId: string,
  nextSequence: TimelineDoc,
): MulticamInstanceEditResult {
  const candidate = {
    ...project,
    sequences: project.sequences.map((item) => (
      item.id === sequenceId ? nextSequence : item
    )),
  }
  return sequenceProjectWithinEditBudget(candidate)
    ? { project: candidate, failure: null }
    : { project, failure: 'project-budget' }
}

interface LocatedMulticamInstance {
  readonly trackIndex: number
  readonly instance: MulticamInstance
}

function locateMulticamInstances(
  tracks: readonly Track[],
  instanceId: string,
): LocatedMulticamInstance[] | null {
  const matches: LocatedMulticamInstance[] = []
  let selected: LocatedMulticamInstance | null = null
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    for (const instance of tracks[trackIndex].multicamInstances ?? []) {
      const located = { trackIndex, instance }
      if (instance.id === instanceId) {
        if (selected) return null
        selected = located
      }
    }
  }
  if (!selected) return null
  if (!selected.instance.linkGroupId) return [selected]
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    for (const instance of tracks[trackIndex].multicamInstances ?? []) {
      if (instance.linkGroupId === selected.instance.linkGroupId) {
        matches.push({ trackIndex, instance })
      }
    }
  }
  return matches.length >= 2 ? matches : null
}

function linkedGeometryMatches(members: readonly LocatedMulticamInstance[]): boolean {
  const first = members[0]?.instance
  if (!first) return false
  return members.every(({ instance }) => (
    instance.multicamId === first.multicamId
    && instance.sourceStartFrame === first.sourceStartFrame
    && instance.timelineRange.startFrame === first.timelineRange.startFrame
    && instance.timelineRange.durationFrames === first.timelineRange.durationFrames
  ))
}

/** Overlap against the lane without the moving multicam members (timeline item ids are project-unique). */
function overlapsWithout(
  track: Track,
  range: TimeRange,
  excludedIds: ReadonlySet<string>,
): boolean {
  return overlapsAny({
    ...track,
    multicamInstances: (track.multicamInstances ?? [])
      .filter((instance) => !excludedIds.has(instance.id)),
  }, range)
}

/** Apply one bounded definition edit without touching browser resources. */
export function applyMulticamDefinitionEdit(
  project: SequenceProject,
  command: MulticamDefinitionEditCommand,
): MulticamDefinitionEditResult {
  const definitionIndex = (project.multicams ?? []).findIndex(
    (definition) => definition.id === command.definitionId,
  )
  if (definitionIndex < 0) return { project, failure: 'definition-not-found' }
  const definition = project.multicams![definitionIndex]
  let edited: MulticamDefinition
  try {
    if (command.kind === 'set-offsets') {
      if (command.expectedDefinition !== definition || command.offsets.length < 1
        || command.offsets.length > MULTICAM_LIMITS.maxAngles
        || new Set(command.offsets.map((offset) => offset.angleId)).size !== command.offsets.length
        || command.offsets.some((offset) => !Number.isSafeInteger(offset.coverageStartFrame)
          || offset.coverageStartFrame < 0 || !definition.angles.some((angle) => angle.id === offset.angleId))) {
        return { project, failure: 'invalid-definition' }
      }
      const angles = definition.angles.map((angle) => {
        const offset = command.offsets.find((item) => item.angleId === angle.id)
        return !offset || offset.coverageStartFrame === angle.coverage.startFrame ? angle
          : { ...angle, coverage: { ...angle.coverage, startFrame: offset.coverageStartFrame } }
      })
      // Preserve source ranges, switches, definition duration and every instance.
      edited = angles.every((angle, index) => angle === definition.angles[index]) ? definition : { ...definition, angles }
    } else if (command.kind === 'cut') {
      edited = setMulticamCut(definition, command.frame, command.angleId)
    } else if (command.kind === 'roll-cut') {
      edited = rollMulticamCut(definition, command.frame, command.toFrame)
    } else if (command.kind === 'set-audio-policy') {
      const unchanged = definition.audioPolicy.kind === command.audioPolicy.kind
        && (definition.audioPolicy.kind === 'follow-video'
          || command.audioPolicy.kind === 'follow-video'
          || definition.audioPolicy.angleId === command.audioPolicy.angleId)
      edited = unchanged
        ? definition
        : { ...definition, audioPolicy: command.audioPolicy }
    } else {
      const name = command.name.trim()
      const target = definition.angles.find((angle) => angle.id === command.angleId)
      if (!target) return { project, failure: 'invalid-definition' }
      if (
        target.name === name
        && target.coverage.startFrame === command.coverageStartFrame
      ) return { project, failure: null }
      const angles = definition.angles.map((angle) => (
        angle.id === command.angleId
          ? {
              ...angle,
              name,
              coverage: {
                ...angle.coverage,
                startFrame: command.coverageStartFrame,
              },
            }
          : angle
      ))
      edited = {
        ...definition,
        angles,
        durationFrames: Math.max(
          definition.durationFrames,
          ...angles.map((angle) => (
            angle.coverage.startFrame + angle.coverage.durationFrames
          )),
        ),
      }
    }
  } catch {
    return { project, failure: 'invalid-definition' }
  }
  if (edited === definition) return { project, failure: null }
  if (multicamDefinitionValidationError(edited)) {
    return { project, failure: 'invalid-definition' }
  }
  if (project.sequences.some((sequence) => sequence.tracks.some((track) => (
    track.locked
    && (track.multicamInstances ?? []).some((instance) => (
      instance.multicamId === definition.id
    ))
  )))) return { project, failure: 'track-locked' }
  const multicams = [...project.multicams!]
  multicams[definitionIndex] = edited
  const candidate = { ...project, multicams }
  return sequenceProjectWithinEditBudget(candidate)
    ? { project: candidate, failure: null }
    : { project, failure: 'project-budget' }
}

export function applyMulticamInstanceEdit(
  project: SequenceProject,
  sequenceId: string,
  command: MulticamInstanceEditCommand,
  factory: SequenceIdFactory,
): MulticamInstanceEditResult {
  const sequence = sequenceById(project, sequenceId)
  if (!sequence) return { project, failure: 'sequence-not-found' }
  const members = locateMulticamInstances(sequence.tracks, command.instanceId)
  if (!members) return { project, failure: 'instance-not-found' }
  if (!linkedGeometryMatches(members)) return { project, failure: 'invalid-linked-pair' }
  if (members.some(({ trackIndex }) => sequence.tracks[trackIndex].locked)) {
    return { project, failure: 'track-locked' }
  }
  const first = members[0].instance
  const memberIds = new Set(members.map(({ instance }) => instance.id))
  if (command.kind === 'delete') {
    return commitInstanceEdit(project, sequenceId, withMemberLanes(
      sequence,
      members,
      (instances) => instances.filter((instance) => !memberIds.has(instance.id)),
    ))
  }
  if (command.kind === 'duplicate') {
    const range = {
      startFrame: command.startFrame,
      durationFrames: first.timelineRange.durationFrames,
    }
    if (!Number.isSafeInteger(range.startFrame) || range.startFrame < 0) {
      return { project, failure: 'invalid-range' }
    }
    for (const { trackIndex } of members) {
      if (overlapsAny(sequence.tracks[trackIndex], range)) {
        return { project, failure: 'overlap' }
      }
    }
    const allocate = createProjectIdAllocator(project, factory)
    const copyLinkGroupId = members.length > 1
      ? allocate('link-group', first.linkGroupId)
      : null
    if (members.length > 1 && !copyLinkGroupId) {
      return { project, failure: 'id-generation-failed' }
    }
    const copyByTrack = new Map<number, MulticamInstance>()
    for (const member of members) {
      const copyId = allocate('multicam-instance', member.instance.id)
      if (!copyId) return { project, failure: 'id-generation-failed' }
      copyByTrack.set(member.trackIndex, {
        ...member.instance,
        id: copyId,
        timelineRange: range,
        ...(copyLinkGroupId ? { linkGroupId: copyLinkGroupId } : {}),
      })
    }
    return commitInstanceEdit(project, sequenceId, withMemberLanes(
      sequence,
      members,
      (instances, trackIndex) => sortedInstances([
        ...instances,
        ...(copyByTrack.has(trackIndex) ? [copyByTrack.get(trackIndex)!] : []),
      ]),
    ))
  }
  if (command.kind === 'split') {
    const startFrame = first.timelineRange.startFrame
    const endFrame = startFrame + first.timelineRange.durationFrames
    if (
      !Number.isSafeInteger(command.frame)
      || command.frame <= startFrame
      || command.frame >= endFrame
    ) return { project, failure: 'invalid-range' }
    const allocate = createProjectIdAllocator(project, factory)
    const rightLinkGroupId = members.length > 1
      ? allocate('link-group', first.linkGroupId)
      : null
    if (members.length > 1 && !rightLinkGroupId) {
      return { project, failure: 'id-generation-failed' }
    }
    const splitOffset = command.frame - startFrame
    const rightByTrack = new Map<number, MulticamInstance>()
    for (const member of members) {
      const rightId = allocate('multicam-instance', member.instance.id)
      if (!rightId) return { project, failure: 'id-generation-failed' }
      rightByTrack.set(member.trackIndex, {
        ...member.instance,
        id: rightId,
        sourceStartFrame: member.instance.sourceStartFrame + splitOffset,
        timelineRange: {
          startFrame: command.frame,
          durationFrames: endFrame - command.frame,
        },
        ...(rightLinkGroupId ? { linkGroupId: rightLinkGroupId } : {}),
      })
    }
    return commitInstanceEdit(project, sequenceId, withMemberLanes(
      sequence,
      members,
      (instances, trackIndex) => sortedInstances([
        ...instances.map((instance) => (
          memberIds.has(instance.id)
            ? {
                ...instance,
                timelineRange: {
                  ...instance.timelineRange,
                  durationFrames: splitOffset,
                },
              }
            : instance
        )),
        ...(rightByTrack.has(trackIndex) ? [rightByTrack.get(trackIndex)!] : []),
      ]),
    ))
  }
  const range = command.kind === 'move'
    ? {
        ...first.timelineRange,
        startFrame: command.startFrame,
      }
    : command.timelineRange
  const sourceStartFrame = command.kind === 'move'
    ? first.sourceStartFrame
    : command.sourceStartFrame
  if (
    !Number.isSafeInteger(range.startFrame)
    || range.startFrame < 0
    || !Number.isSafeInteger(range.durationFrames)
    || range.durationFrames < 1
    || !Number.isSafeInteger(sourceStartFrame)
    || sourceStartFrame < 0
    || !Number.isSafeInteger(sourceStartFrame + range.durationFrames)
  ) return { project, failure: 'invalid-range' }
  const definition = (project.multicams ?? []).find(
    (item) => item.id === first.multicamId,
  )
  if (!definition || sourceStartFrame + range.durationFrames > definition.durationFrames) {
    return { project, failure: 'invalid-range' }
  }
  if (
    range.startFrame === first.timelineRange.startFrame
    && range.durationFrames === first.timelineRange.durationFrames
    && sourceStartFrame === first.sourceStartFrame
  ) return { project, failure: null }
  for (const { trackIndex } of members) {
    if (overlapsWithout(sequence.tracks[trackIndex], range, memberIds)) {
      return { project, failure: 'overlap' }
    }
  }
  return commitInstanceEdit(project, sequenceId, withMemberLanes(
    sequence,
    members,
    (instances) => sortedInstances(instances.map((instance) => (
      memberIds.has(instance.id)
        ? {
            ...instance,
            timelineRange: { ...range },
            sourceStartFrame,
          }
        : instance
    ))),
  ))
}

/**
 * Normalize manually entered clap/event marks, create one definition, and
 * place its video plus optional audio lane as one immutable project edit.
 */
export function createMulticamFromAssets(
  project: SequenceProject,
  sequenceId: string,
  command: CreateMulticamCommand,
  factory: SequenceIdFactory,
): CreateMulticamResult {
  const sequence = sequenceById(project, sequenceId)
  if (!sequence) return rejected(project, 'sequence-not-found')
  if (!validName(command.name)) return rejected(project, 'invalid-name')
  if (
    !Number.isSafeInteger(command.startFrame)
    || command.startFrame < 0
  ) return rejected(project, 'invalid-placement')
  if (
    command.angles.length < MULTICAM_LIMITS.minAngles
    || command.angles.length > MULTICAM_LIMITS.maxAngles
  ) return rejected(project, 'invalid-angle')
  const sourceAssets = new Set<string>()
  for (const angle of command.angles) {
    if (
      !validId(angle.assetId)
      || !validName(angle.name)
      || sourceAssets.has(angle.assetId)
      || !Number.isSafeInteger(angle.durationFrames)
      || angle.durationFrames < 1
      || !Number.isSafeInteger(angle.syncFrame)
      || angle.syncFrame < 0
      || angle.syncFrame >= angle.durationFrames
    ) return rejected(project, 'invalid-angle')
    sourceAssets.add(angle.assetId)
  }
  if (
    command.audioPolicy.kind === 'fixed'
    && (
      !Number.isSafeInteger(command.audioPolicy.angleIndex)
      || command.audioPolicy.angleIndex < 0
      || command.audioPolicy.angleIndex >= command.angles.length
    )
  ) return rejected(project, 'invalid-angle')
  const videoTrackIndex = sequence.tracks.findIndex(
    (track) => track.id === command.videoTrackId,
  )
  const audioTrackIndex = command.audioTrackId === null
    ? -1
    : sequence.tracks.findIndex((track) => track.id === command.audioTrackId)
  if (videoTrackIndex < 0 || (command.audioTrackId !== null && audioTrackIndex < 0)) {
    return rejected(project, 'track-not-found')
  }
  const videoTrack = sequence.tracks[videoTrackIndex]
  const audioTrack = audioTrackIndex < 0 ? null : sequence.tracks[audioTrackIndex]
  if (videoTrack.kind !== 'video' || (audioTrack && audioTrack.kind !== 'audio')) {
    return rejected(project, 'track-kind')
  }
  if (videoTrack.locked || audioTrack?.locked) return rejected(project, 'track-locked')

  const allocate = createProjectIdAllocator(project, factory)
  const definitionId = allocate('multicam-definition')
  if (!definitionId) return rejected(project, 'id-generation-failed')
  const commonSyncFrame = Math.max(...command.angles.map((angle) => angle.syncFrame))
  const angles: MulticamDefinition['angles'] = []
  for (const source of command.angles) {
    const id = allocate('multicam-angle', source.assetId)
    if (!id) return rejected(project, 'id-generation-failed')
    angles.push({
      id,
      name: source.name.trim(),
      assetId: source.assetId,
      coverage: {
        startFrame: commonSyncFrame - source.syncFrame,
        durationFrames: source.durationFrames,
      },
      sourceStartFrame: 0,
    })
  }
  const durationFrames = Math.max(...angles.map((angle) => (
    angle.coverage.startFrame + angle.coverage.durationFrames
  )))
  const audioPolicy: MulticamAudioPolicy = command.audioPolicy.kind === 'fixed'
    ? { kind: 'fixed', angleId: angles[command.audioPolicy.angleIndex].id }
    : { kind: 'follow-video' }
  const definition: MulticamDefinition = {
    id: definitionId,
    name: command.name.trim(),
    durationFrames,
    angles,
    switches: [{ frame: 0, videoAngleId: angles[0].id }],
    audioPolicy,
  }
  if (multicamDefinitionValidationError(definition)) {
    return rejected(project, 'invalid-angle')
  }
  const timelineRange = { startFrame: command.startFrame, durationFrames }
  if (overlapsAny(videoTrack, timelineRange) || (audioTrack && overlapsAny(audioTrack, timelineRange))) {
    return rejected(project, 'overlap')
  }
  const linkGroupId = audioTrack
    ? allocate('link-group', definitionId)
    : null
  const videoInstanceId = allocate('multicam-instance', definitionId)
  const audioInstanceId = audioTrack
    ? allocate('multicam-instance', definitionId)
    : null
  if (!videoInstanceId || (audioTrack && (!audioInstanceId || !linkGroupId))) {
    return rejected(project, 'id-generation-failed')
  }
  const common = {
    kind: 'multicam' as const,
    name: definition.name,
    multicamId: definition.id,
    sourceStartFrame: 0,
    timelineRange,
    ...(linkGroupId ? { linkGroupId } : {}),
  }
  const videoInstance: MulticamInstance = { ...common, id: videoInstanceId }
  const audioInstance: MulticamInstance | null = audioInstanceId
    ? { ...common, id: audioInstanceId }
    : null
  const nextSequence = {
    ...sequence,
    tracks: sequence.tracks.map((track, index) => (
      index === videoTrackIndex
        ? withInstance(track, videoInstance)
        : index === audioTrackIndex && audioInstance
          ? withInstance(track, audioInstance)
          : track
    )),
  }
  const candidate: SequenceProject = {
    ...project,
    multicams: [...(project.multicams ?? []), definition],
    sequences: project.sequences.map((item) => (
      item.id === sequenceId ? nextSequence : item
    )),
  }
  if (!sequenceProjectWithinEditBudget(candidate)) {
    return rejected(project, 'project-budget')
  }
  return {
    project: candidate,
    definitionId,
    videoInstanceId,
    audioInstanceId,
    failure: null,
  }
}
