/** Pure, project-atomic editing for live sequence instances. */

import type {
  Clip,
  SequenceInstance,
  SequenceInstanceId,
  TimeRange,
  TimelineDoc,
  Track,
} from './schema'
import {
  duplicateProjectSequence,
  SEQUENCE_PROJECT_LIMITS,
  sequenceById,
  sequenceProjectWithinEditBudget,
  type SequenceEntityKind,
  type SequenceIdFactory,
  type SequenceProject,
} from './projectSequences'
import { defaultMasterAudio } from './audioMixer'
import { MAX_PROJECT_NAME_CHARACTERS } from './projectLimits'
import { MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME } from './nestedSequences'
import { rangeEnd } from './time'

export type SequenceInstanceEditCommand =
  | {
      readonly kind: 'insert'
      readonly trackId: string
      readonly instance: SequenceInstance
    }
  | {
      readonly kind: 'move'
      readonly instanceId: SequenceInstanceId
      readonly startFrame: number
    }
  | {
      readonly kind: 'trim'
      readonly instanceId: SequenceInstanceId
      readonly timelineRange: TimeRange
      readonly sourceStartFrame: number
    }
  | {
      readonly kind: 'split'
      readonly instanceId: SequenceInstanceId
      readonly frame: number
    }
  | {
      readonly kind: 'duplicate'
      readonly instanceId: SequenceInstanceId
      readonly startFrame: number
    }
  | {
      readonly kind: 'delete'
      readonly instanceId: SequenceInstanceId
    }

export type SequenceInstanceEditFailure =
  | 'sequence-not-found'
  | 'instance-not-found'
  | 'track-not-found'
  | 'track-locked'
  | 'invalid-range'
  | 'collision'
  | 'id-generation-failed'
  | 'project-budget'

export interface SequenceInstanceEditResult {
  readonly project: SequenceProject
  readonly instanceId: SequenceInstanceId | null
  readonly failure: SequenceInstanceEditFailure | null
}

export type CreateCompoundSequenceFailure =
  | 'sequence-not-found'
  | 'invalid-name'
  | 'empty-selection'
  | 'selection-limit'
  | 'clip-not-found'
  | 'track-locked'
  | 'partial-link'
  | 'selection-not-bounded'
  | 'boundary-transition'
  | 'video-bus-scope'
  | 'id-generation-failed'
  | 'project-budget'

export interface CreateCompoundSequenceResult {
  readonly project: SequenceProject
  readonly sequenceId: string | null
  readonly instanceId: SequenceInstanceId | null
  readonly failure: CreateCompoundSequenceFailure | null
}

interface LocatedClip {
  readonly track: Track
  readonly clip: Clip
}

function collectAllIds(project: SequenceProject): Set<string> {
  const ids = new Set<string>([project.id])
  for (const definition of project.multicams ?? []) {
    ids.add(definition.id)
    for (const angle of definition.angles) ids.add(angle.id)
  }
  for (const sequence of project.sequences) {
    ids.add(sequence.id)
    for (const effect of sequence.masterVideoEffects ?? []) ids.add(effect.id)
    for (const marker of sequence.markers ?? []) ids.add(marker.id)
    for (const captionTrack of sequence.captionTracks ?? []) {
      ids.add(captionTrack.id)
      for (const item of captionTrack.items) ids.add(item.id)
    }
    for (const track of sequence.tracks) {
      ids.add(track.id)
      for (const effect of track.videoEffects ?? []) ids.add(effect.id)
      for (const clip of track.clips) {
        ids.add(clip.id)
        if (clip.linkGroupId) ids.add(clip.linkGroupId)
        for (const effect of clip.effects) ids.add(effect.id)
        for (const effect of clip.audioEffects ?? []) ids.add(effect.id)
      }
      for (const instance of track.sequenceInstances ?? []) {
        ids.add(instance.id)
        if (instance.linkGroupId) ids.add(instance.linkGroupId)
      }
      for (const instance of track.multicamInstances ?? []) {
        ids.add(instance.id)
        if (instance.linkGroupId) ids.add(instance.linkGroupId)
      }
      for (const adjustment of track.adjustments ?? []) {
        ids.add(adjustment.id)
        for (const effect of adjustment.effects) ids.add(effect.id)
      }
      for (const effect of track.audioEffects ?? []) ids.add(effect.id)
      for (const transition of track.transitions) ids.add(transition.id)
    }
    for (const effect of sequence.masterAudio?.audioEffects ?? []) ids.add(effect.id)
  }
  return ids
}

function allocateUniqueId(
  used: Set<string>,
  factory: SequenceIdFactory,
  kind: SequenceEntityKind,
  sourceId?: string,
): string | null {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = factory(kind, sourceId)
    if (id.length > 0 && id.length <= 256 && !used.has(id)) {
      used.add(id)
      return id
    }
  }
  return null
}

function locateClip(document: TimelineDoc, clipId: string): LocatedClip | null {
  for (const track of document.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

function rejectedCompound(
  project: SequenceProject,
  failure: CreateCompoundSequenceFailure,
): CreateCompoundSequenceResult {
  return { project, sequenceId: null, instanceId: null, failure }
}

interface LocatedInstance {
  readonly track: Track
  readonly instance: SequenceInstance
}

function locateInstance(
  document: TimelineDoc,
  instanceId: SequenceInstanceId,
): LocatedInstance | null {
  for (const track of document.tracks) {
    const instance = (track.sequenceInstances ?? []).find((item) => (
      item.id === instanceId
    ))
    if (instance) return { track, instance }
  }
  return null
}

function linkedInstances(
  document: TimelineDoc,
  primary: LocatedInstance,
): LocatedInstance[] {
  const linkGroupId = primary.instance.linkGroupId
  if (!linkGroupId) return [primary]
  const members: LocatedInstance[] = []
  for (const track of document.tracks) {
    for (const instance of track.sequenceInstances ?? []) {
      if (instance.linkGroupId === linkGroupId) members.push({ track, instance })
    }
  }
  return members
}

function validRange(range: TimeRange, sourceStartFrame: number): boolean {
  const end = range.startFrame + range.durationFrames
  const sourceEnd = sourceStartFrame + range.durationFrames
  return Number.isSafeInteger(range.startFrame)
    && range.startFrame >= 0
    && Number.isSafeInteger(range.durationFrames)
    && range.durationFrames > 0
    && Number.isSafeInteger(end)
    && Number.isSafeInteger(sourceStartFrame)
    && sourceStartFrame >= 0
    && Number.isSafeInteger(sourceEnd)
}

function overlaps(left: TimeRange, right: TimeRange): boolean {
  return left.startFrame < rangeEnd(right) && right.startFrame < rangeEnd(left)
}

function collides(track: Track, candidate: SequenceInstance): boolean {
  return track.clips.some((item) => overlaps(item.timelineRange, candidate.timelineRange))
    || (track.adjustments ?? []).some((item) => (
      overlaps(item.timelineRange, candidate.timelineRange)
    ))
    || (track.sequenceInstances ?? []).some((item) => (
      item.id !== candidate.id
      && overlaps(item.timelineRange, candidate.timelineRange)
    ))
    || (track.multicamInstances ?? []).some((item) => (
      overlaps(item.timelineRange, candidate.timelineRange)
    ))
}

function withTrackInstances(
  document: TimelineDoc,
  byTrack: ReadonlyMap<string, readonly SequenceInstance[]>,
): TimelineDoc {
  return {
    ...document,
    tracks: document.tracks.map((track) => {
      const instances = byTrack.get(track.id)
      return instances === undefined
        ? track
        : {
            ...track,
            sequenceInstances: [...instances].sort((left, right) => (
              left.timelineRange.startFrame - right.timelineRange.startFrame
              || left.id.localeCompare(right.id)
            )),
          }
    }),
  }
}

function replaceDocument(
  project: SequenceProject,
  document: TimelineDoc,
): SequenceProject | null {
  const candidate = {
    ...project,
    sequences: project.sequences.map((sequence) => (
      sequence.id === document.id ? document : sequence
    )),
  }
  return sequenceProjectWithinEditBudget(candidate) ? candidate : null
}

function rejected(
  project: SequenceProject,
  failure: SequenceInstanceEditFailure,
): SequenceInstanceEditResult {
  return { project, instanceId: null, failure }
}

function generatedId(
  project: SequenceProject,
  factory: SequenceIdFactory,
  sourceId: string,
  reserved: Set<string>,
): string | null {
  const used = new Set<string>(reserved)
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) used.add(clip.id)
      for (const instance of track.sequenceInstances ?? []) used.add(instance.id)
      for (const instance of track.multicamInstances ?? []) used.add(instance.id)
      for (const adjustment of track.adjustments ?? []) used.add(adjustment.id)
    }
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = factory('sequence-instance', sourceId)
    if (id.length > 0 && id.length <= 256 && !used.has(id)) {
      reserved.add(id)
      return id
    }
  }
  return null
}

function generatedLinkGroupId(
  project: SequenceProject,
  factory: SequenceIdFactory,
  sourceId: string,
): string | null {
  const used = new Set<string>()
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (clip.linkGroupId) used.add(clip.linkGroupId)
      }
      for (const instance of track.sequenceInstances ?? []) {
        if (instance.linkGroupId) used.add(instance.linkGroupId)
      }
      for (const instance of track.multicamInstances ?? []) {
        if (instance.linkGroupId) used.add(instance.linkGroupId)
      }
    }
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = factory('link-group', sourceId)
    if (id.length > 0 && id.length <= 256 && !used.has(id)) return id
  }
  return null
}

/** A shared child picture cannot retain separate enclosing video-track buses. */
export function compoundVideoBusScopeError(parent: TimelineDoc, selectedClipIds: readonly string[]): string | null {
  const selected = new Set(selectedClipIds)
  const videoTracks = parent.tracks.filter((track) => track.kind === 'video' && track.clips.some((clip) => selected.has(clip.id)))
  return videoTracks.length > 1 && videoTracks.some((track) => track.videoEffects?.length)
    ? 'These video tracks have separate effects. Create a compound for each video track to keep their processing order.'
    : null
}

/** Replace one bounded clip selection with live instances of one new definition. */
export function createCompoundSequenceFromClips(
  project: SequenceProject,
  parentSequenceId: string,
  selectedClipIds: readonly string[],
  name: string,
  factory: SequenceIdFactory,
): CreateCompoundSequenceResult {
  const parent = sequenceById(project, parentSequenceId)
  if (!parent) return rejectedCompound(project, 'sequence-not-found')
  const boundedName = name.trim()
  if (boundedName.length === 0 || boundedName.length > MAX_PROJECT_NAME_CHARACTERS) {
    return rejectedCompound(project, 'invalid-name')
  }
  const selection = [...new Set(selectedClipIds)]
  if (selection.length === 0) return rejectedCompound(project, 'empty-selection')
  if (selection.length > MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME) {
    return rejectedCompound(project, 'selection-limit')
  }
  const selected = new Set(selection)
  const located: LocatedClip[] = []
  for (const clipId of selection) {
    const value = locateClip(parent, clipId)
    if (!value) return rejectedCompound(project, 'clip-not-found')
    located.push(value)
  }
  if (located.some(({ track }) => track.locked)) {
    return rejectedCompound(project, 'track-locked')
  }
  if (compoundVideoBusScopeError(parent, selection)) return rejectedCompound(project, 'video-bus-scope')
  for (const { clip } of located) {
    if (!clip.linkGroupId) continue
    const linked = parent.tracks.flatMap((track) => track.clips)
      .filter((candidate) => candidate.linkGroupId === clip.linkGroupId)
    if (linked.some((candidate) => !selected.has(candidate.id))) {
      return rejectedCompound(project, 'partial-link')
    }
  }
  const startFrame = Math.min(...located.map(({ clip }) => (
    clip.timelineRange.startFrame
  )))
  const endFrame = Math.max(...located.map(({ clip }) => rangeEnd(clip.timelineRange)))
  const range = { startFrame, durationFrames: endFrame - startFrame }
  const selectedTracks = new Set(located.map(({ track }) => track.id))
  for (const track of parent.tracks) {
    if (!selectedTracks.has(track.id)) continue
    if (track.clips.some((clip) => (
      !selected.has(clip.id) && overlaps(clip.timelineRange, range)
    )) || (track.adjustments ?? []).some((item) => (
      overlaps(item.timelineRange, range)
    )) || (track.sequenceInstances ?? []).some((item) => (
      overlaps(item.timelineRange, range)
    )) || (track.multicamInstances ?? []).some((item) => (
      overlaps(item.timelineRange, range)
    ))) return rejectedCompound(project, 'selection-not-bounded')
    if (track.transitions.some((transition) => (
      selected.has(transition.fromClipId) !== selected.has(transition.toClipId)
    ))) return rejectedCompound(project, 'boundary-transition')
  }

  const used = collectAllIds(project)
  const sequenceId = allocateUniqueId(used, factory, 'sequence', parent.id)
  if (!sequenceId) return rejectedCompound(project, 'id-generation-failed')
  const linkGroupId = selectedTracks.size > 1
    ? allocateUniqueId(used, factory, 'link-group', sequenceId)
    : null
  if (selectedTracks.size > 1 && !linkGroupId) {
    return rejectedCompound(project, 'id-generation-failed')
  }
  const childTracks: Track[] = []
  const parentTracks: Track[] = []
  let primaryInstanceId: string | null = null
  for (const track of parent.tracks) {
    if (!selectedTracks.has(track.id)) {
      parentTracks.push(track)
      continue
    }
    const childTrackId = allocateUniqueId(used, factory, 'track', track.id)
    const instanceId = allocateUniqueId(used, factory, 'sequence-instance', track.id)
    if (!childTrackId || !instanceId) {
      return rejectedCompound(project, 'id-generation-failed')
    }
    primaryInstanceId ??= instanceId
    childTracks.push({
      ...track,
      id: childTrackId,
      // Track buses stay on the parent, just as the enclosing audio mix does.
      videoEffects: [],
      clips: track.clips
        .filter((clip) => selected.has(clip.id))
        .map((clip) => ({
          ...clip,
          timelineRange: {
            ...clip.timelineRange,
            startFrame: clip.timelineRange.startFrame - startFrame,
          },
        })),
      sequenceInstances: [],
      multicamInstances: [],
      adjustments: [],
      transitions: track.transitions.filter((transition) => (
        selected.has(transition.fromClipId) && selected.has(transition.toClipId)
      )),
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
      ...(track.kind === 'audio'
        ? { volume: 1, balance: 0, audioEffects: [] }
        : {}),
    })
    parentTracks.push({
      ...track,
      clips: track.clips.filter((clip) => !selected.has(clip.id)),
      transitions: track.transitions.filter((transition) => (
        !selected.has(transition.fromClipId) && !selected.has(transition.toClipId)
      )),
      sequenceInstances: [
        ...(track.sequenceInstances ?? []),
        {
          kind: 'sequence' as const,
          id: instanceId,
          name: boundedName,
          sequenceId,
          sourceStartFrame: 0,
          timelineRange: { ...range },
          ...(linkGroupId ? { linkGroupId } : {}),
        },
      ].sort((left, right) => (
        left.timelineRange.startFrame - right.timelineRange.startFrame
        || left.id.localeCompare(right.id)
      )),
    })
  }
  const child: TimelineDoc = {
    schemaVersion: parent.schemaVersion,
    id: sequenceId,
    name: boundedName,
    frameRate: { ...parent.frameRate },
    width: parent.width,
    height: parent.height,
    audioSampleRate: parent.audioSampleRate,
    tracks: childTracks,
    markers: [],
    captionTracks: [],
    masterAudio: defaultMasterAudio(),
    masterVideoEffects: [],
  }
  const nextParent = { ...parent, tracks: parentTracks }
  const candidate = {
    ...project,
    sequences: project.sequences.map((sequence) => (
      sequence.id === parent.id ? nextParent : sequence
    )).concat(child),
  }
  if (!sequenceProjectWithinEditBudget(candidate)) {
    return rejectedCompound(project, 'project-budget')
  }
  return {
    project: candidate,
    sequenceId,
    instanceId: primaryInstanceId,
    failure: null,
  }
}

/** Apply one command to the whole linked A/V group and return one project. */
export function applySequenceInstanceEdit(
  project: SequenceProject,
  parentSequenceId: string,
  command: SequenceInstanceEditCommand,
  factory: SequenceIdFactory,
): SequenceInstanceEditResult {
  const document = sequenceById(project, parentSequenceId)
  if (!document) return rejected(project, 'sequence-not-found')

  if (command.kind === 'insert') {
    const track = document.tracks.find((item) => item.id === command.trackId)
    if (!track) return rejected(project, 'track-not-found')
    if (track.locked) return rejected(project, 'track-locked')
    if (!validRange(command.instance.timelineRange, command.instance.sourceStartFrame)) {
      return rejected(project, 'invalid-range')
    }
    if (collides(track, command.instance)) return rejected(project, 'collision')
    const next = withTrackInstances(document, new Map([[track.id, [
      ...(track.sequenceInstances ?? []),
      { ...command.instance, timelineRange: { ...command.instance.timelineRange } },
    ]]]))
    const candidate = replaceDocument(project, next)
    return candidate
      ? { project: candidate, instanceId: command.instance.id, failure: null }
      : rejected(project, 'project-budget')
  }

  const located = locateInstance(document, command.instanceId)
  if (!located) return rejected(project, 'instance-not-found')
  const members = linkedInstances(document, located)
  if (members.some((member) => member.track.locked)) {
    return rejected(project, 'track-locked')
  }
  const memberIds = new Set(members.map((member) => member.instance.id))
  const byTrack = new Map<string, SequenceInstance[]>()
  for (const member of members) {
    if (!byTrack.has(member.track.id)) {
      byTrack.set(member.track.id, [...(member.track.sequenceInstances ?? [])])
    }
  }
  const replaceMember = (
    member: LocatedInstance,
    replacement: SequenceInstance | null,
    extra?: SequenceInstance,
  ): void => {
    const list = byTrack.get(member.track.id)!
    const index = list.findIndex((item) => item.id === member.instance.id)
    if (replacement === null) list.splice(index, 1)
    else list.splice(index, 1, replacement, ...(extra ? [extra] : []))
  }

  if (command.kind === 'delete') {
    for (const member of members) replaceMember(member, null)
  } else if (command.kind === 'move') {
    const delta = command.startFrame - located.instance.timelineRange.startFrame
    for (const member of members) {
      const startFrame = member.instance.timelineRange.startFrame + delta
      const replacement = {
        ...member.instance,
        timelineRange: { ...member.instance.timelineRange, startFrame },
      }
      if (!validRange(replacement.timelineRange, replacement.sourceStartFrame)) {
        return rejected(project, 'invalid-range')
      }
      replaceMember(member, replacement)
    }
  } else if (command.kind === 'trim') {
    if (!validRange(command.timelineRange, command.sourceStartFrame)) {
      return rejected(project, 'invalid-range')
    }
    const timelineDelta = command.timelineRange.startFrame
      - located.instance.timelineRange.startFrame
    const durationDelta = command.timelineRange.durationFrames
      - located.instance.timelineRange.durationFrames
    const sourceDelta = command.sourceStartFrame - located.instance.sourceStartFrame
    for (const member of members) {
      const replacement = {
        ...member.instance,
        sourceStartFrame: member.instance.sourceStartFrame + sourceDelta,
        timelineRange: {
          startFrame: member.instance.timelineRange.startFrame + timelineDelta,
          durationFrames: member.instance.timelineRange.durationFrames + durationDelta,
        },
      }
      if (!validRange(replacement.timelineRange, replacement.sourceStartFrame)) {
        return rejected(project, 'invalid-range')
      }
      replaceMember(member, replacement)
    }
  } else if (command.kind === 'split') {
    const offset = command.frame - located.instance.timelineRange.startFrame
    if (offset <= 0 || offset >= located.instance.timelineRange.durationFrames) {
      return rejected(project, 'invalid-range')
    }
    const ids = new Set<string>()
    const nextLinkGroupId = members.length > 1
      ? generatedLinkGroupId(project, factory, located.instance.linkGroupId ?? located.instance.id)
      : null
    if (members.length > 1 && !nextLinkGroupId) {
      return rejected(project, 'id-generation-failed')
    }
    for (const member of members) {
      if (offset >= member.instance.timelineRange.durationFrames) {
        return rejected(project, 'invalid-range')
      }
      const rightId = generatedId(project, factory, member.instance.id, ids)
      if (!rightId) return rejected(project, 'id-generation-failed')
      const left = {
        ...member.instance,
        timelineRange: {
          ...member.instance.timelineRange,
          durationFrames: offset,
        },
      }
      const right = {
        ...member.instance,
        id: rightId,
        sourceStartFrame: member.instance.sourceStartFrame + offset,
        timelineRange: {
          startFrame: member.instance.timelineRange.startFrame + offset,
          durationFrames: member.instance.timelineRange.durationFrames - offset,
        },
        ...(nextLinkGroupId ? { linkGroupId: nextLinkGroupId } : {}),
      }
      replaceMember(member, left, right)
    }
  } else {
    const delta = command.startFrame - located.instance.timelineRange.startFrame
    const ids = new Set<string>()
    const nextLinkGroupId = members.length > 1
      ? generatedLinkGroupId(project, factory, located.instance.linkGroupId ?? located.instance.id)
      : null
    if (members.length > 1 && !nextLinkGroupId) {
      return rejected(project, 'id-generation-failed')
    }
    for (const member of members) {
      const id = generatedId(project, factory, member.instance.id, ids)
      if (!id) return rejected(project, 'id-generation-failed')
      const duplicate = {
        ...member.instance,
        id,
        timelineRange: {
          ...member.instance.timelineRange,
          startFrame: member.instance.timelineRange.startFrame + delta,
        },
        ...(nextLinkGroupId ? { linkGroupId: nextLinkGroupId } : {}),
      }
      if (!validRange(duplicate.timelineRange, duplicate.sourceStartFrame)) {
        return rejected(project, 'invalid-range')
      }
      const list = byTrack.get(member.track.id)!
      list.push(duplicate)
    }
  }

  const next = withTrackInstances(document, byTrack)
  for (const track of next.tracks) {
    for (const instance of track.sequenceInstances ?? []) {
      if (memberIds.has(instance.id)) continue
      const editedTrack = byTrack.has(track.id)
      if (editedTrack && collides(track, instance)) return rejected(project, 'collision')
    }
    const instances = track.sequenceInstances ?? []
    for (let index = 0; index < instances.length; index++) {
      const candidate = instances[index]
      if (track.clips.some((item) => overlaps(item.timelineRange, candidate.timelineRange))) {
        return rejected(project, 'collision')
      }
      if ((track.adjustments ?? []).some((item) => (
        overlaps(item.timelineRange, candidate.timelineRange)
      ))) return rejected(project, 'collision')
      if ((track.multicamInstances ?? []).some((item) => (
        overlaps(item.timelineRange, candidate.timelineRange)
      ))) return rejected(project, 'collision')
      if (index > 0 && overlaps(instances[index - 1].timelineRange, candidate.timelineRange)) {
        return rejected(project, 'collision')
      }
    }
  }
  const candidate = replaceDocument(project, next)
  return candidate
    ? { project: candidate, instanceId: located.instance.id, failure: null }
    : rejected(project, 'project-budget')
}

export interface MakeSequenceIndependentResult {
  readonly project: SequenceProject
  readonly sequenceId: string | null
  readonly failure: SequenceInstanceEditFailure | 'sequence-limit' | null
}

/** Clone the complete referenced subgraph, then retarget only one linked pair. */
export function makeSequenceInstanceIndependent(
  project: SequenceProject,
  parentSequenceId: string,
  instanceId: SequenceInstanceId,
  factory: SequenceIdFactory,
): MakeSequenceIndependentResult {
  const parent = sequenceById(project, parentSequenceId)
  if (!parent) return { project, sequenceId: null, failure: 'sequence-not-found' }
  const located = locateInstance(parent, instanceId)
  if (!located) return { project, sequenceId: null, failure: 'instance-not-found' }
  if (linkedInstances(parent, located).some((item) => item.track.locked)) {
    return { project, sequenceId: null, failure: 'track-locked' }
  }

  const ordered: string[] = []
  const visited = new Set<string>()
  const collect = (sequenceId: string): void => {
    if (visited.has(sequenceId)) return
    visited.add(sequenceId)
    const sequence = sequenceById(project, sequenceId)
    if (!sequence) return
    for (const track of sequence.tracks) {
      for (const instance of track.sequenceInstances ?? []) collect(instance.sequenceId)
    }
    ordered.push(sequenceId)
  }
  collect(located.instance.sequenceId)
  if (project.sequences.length + ordered.length > SEQUENCE_PROJECT_LIMITS.maxSequences) {
    return { project, sequenceId: null, failure: 'sequence-limit' }
  }

  let candidate = project
  const clones = new Map<string, string>()
  for (const sourceId of ordered) {
    const source = sequenceById(project, sourceId)!
    const suffix = ' independent'
    const name = `${source.name.slice(
      0,
      MAX_PROJECT_NAME_CHARACTERS - suffix.length,
    )}${suffix}`
    const duplicated = duplicateProjectSequence(candidate, sourceId, name, factory)
    if (duplicated.failure || !duplicated.sequenceId) {
      return {
        project,
        sequenceId: null,
        failure: duplicated.failure === 'sequence-limit'
          ? 'sequence-limit'
          : duplicated.failure === 'id-generation-failed'
            ? 'id-generation-failed'
            : 'project-budget',
      }
    }
    candidate = duplicated.project
    clones.set(sourceId, duplicated.sequenceId)
  }

  const independentRootId = clones.get(located.instance.sequenceId)
  if (!independentRootId) {
    return { project, sequenceId: null, failure: 'project-budget' }
  }
  candidate = {
    ...candidate,
    sequences: candidate.sequences.map((sequence) => {
      if ([...clones.values()].includes(sequence.id)) {
        return {
          ...sequence,
          tracks: sequence.tracks.map((track) => ({
            ...track,
            sequenceInstances: (track.sequenceInstances ?? []).map((instance) => ({
              ...instance,
              sequenceId: clones.get(instance.sequenceId) ?? instance.sequenceId,
            })),
          })),
        }
      }
      if (sequence.id !== parentSequenceId) return sequence
      const linkGroupId = located.instance.linkGroupId
      return {
        ...sequence,
        tracks: sequence.tracks.map((track) => ({
          ...track,
          sequenceInstances: (track.sequenceInstances ?? []).map((instance) => (
            instance.id === instanceId
            || (linkGroupId !== undefined && instance.linkGroupId === linkGroupId)
              ? { ...instance, sequenceId: independentRootId }
              : instance
          )),
        })),
      }
    }),
  }
  return sequenceProjectWithinEditBudget(candidate)
    ? { project: candidate, sequenceId: independentRootId, failure: null }
    : { project, sequenceId: null, failure: 'project-budget' }
}
