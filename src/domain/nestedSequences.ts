/** Pure graph validation and exact-frame expansion for live sequence refs. */

import type {
  Clip,
  SequenceInstance,
  SequenceInstanceId,
  TimelineDoc,
  Track,
  TrackId,
  TrackKind,
} from './schema'
import type { SequenceProject } from './projectSequences'
import { audibleTracks, docDurationFrames } from './selectors'
import { rangeEnd } from './time'

export const MAX_NESTED_SEQUENCE_DEPTH = 8
export const MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME = 4_096

export interface NestedSequenceGraphAnalysis {
  readonly rootSequenceId: string
  readonly sequenceCount: number
  readonly referenceCount: number
  readonly reachableSequenceCount: number
  readonly maxDepth: number
  readonly topologicalOrder: readonly string[]
}

export interface NestedSequenceClipLeaf {
  readonly kind: 'clip'
  readonly sequenceId: string
  readonly trackId: TrackId
  readonly clipId: string
  readonly frame: number
  readonly instancePath: readonly SequenceInstanceId[]
}

export interface NestedSequenceFrameExpansion {
  readonly rootSequenceId: string
  readonly rootFrame: number
  readonly mediaKind: TrackKind
  readonly leaves: readonly NestedSequenceClipLeaf[]
  readonly visitedSequenceInstances: number
  readonly maxDepth: number
}

export function sequenceInstances(track: Track): readonly SequenceInstance[] {
  return track.sequenceInstances ?? []
}

function sequenceById(
  project: SequenceProject,
  sequenceId: string,
): TimelineDoc | null {
  return project.sequences.find((sequence) => sequence.id === sequenceId) ?? null
}

function sequenceSettingsEqual(left: TimelineDoc, right: TimelineDoc): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.audioSampleRate === right.audioSampleRate
    && left.frameRate.num * right.frameRate.den
      === right.frameRate.num * left.frameRate.den
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new RangeError(`${label} must contain 1..256 non-whitespace characters`)
  }
}

function assertInstanceRange(instance: SequenceInstance): void {
  const start = instance.timelineRange.startFrame
  const duration = instance.timelineRange.durationFrames
  const end = start + duration
  const sourceEnd = instance.sourceStartFrame + duration
  if (
    !Number.isSafeInteger(start)
    || start < 0
    || !Number.isSafeInteger(duration)
    || duration <= 0
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(instance.sourceStartFrame)
    || instance.sourceStartFrame < 0
    || !Number.isSafeInteger(sourceEnd)
  ) {
    throw new RangeError(`sequence instance "${instance.id}" has an invalid source range`)
  }
}

function overlaps(
  left: { startFrame: number; durationFrames: number },
  right: { startFrame: number; durationFrames: number },
): boolean {
  return left.startFrame < rangeEnd(right) && right.startFrame < rangeEnd(left)
}

function validateTrackInstances(
  project: SequenceProject,
  parent: TimelineDoc,
  track: Track,
  ids: Set<string>,
): number {
  const instances = sequenceInstances(track)
  let previousEnd = -1
  const occupied = [
    ...track.clips.map((item) => item.timelineRange),
    ...(track.adjustments ?? []).map((item) => item.timelineRange),
  ]
  for (const instance of instances) {
    assertIdentifier(instance.id, 'sequence instance id')
    if (ids.has(instance.id)) {
      throw new RangeError(`duplicate timeline item id "${instance.id}"`)
    }
    ids.add(instance.id)
    if (instance.kind !== 'sequence') {
      throw new RangeError(`sequence instance "${instance.id}" has an invalid kind`)
    }
    assertIdentifier(instance.name, `sequence instance "${instance.id}" name`)
    assertIdentifier(instance.sequenceId, `sequence instance "${instance.id}" sequenceId`)
    assertInstanceRange(instance)
    if (instance.timelineRange.startFrame < previousEnd) {
      throw new RangeError(`sequence instance "${instance.id}" overlaps another instance`)
    }
    if (occupied.some((range) => overlaps(instance.timelineRange, range))) {
      throw new RangeError(`sequence instance "${instance.id}" overlaps another item`)
    }
    const child = sequenceById(project, instance.sequenceId)
    if (!child) {
      throw new RangeError(
        `sequence instance "${instance.id}" references missing sequence "${instance.sequenceId}"`,
      )
    }
    if (!sequenceSettingsEqual(parent, child)) {
      throw new RangeError(
        `sequence instance "${instance.id}" crosses the same-settings nesting contract`,
      )
    }
    previousEnd = rangeEnd(instance.timelineRange)
    occupied.push(instance.timelineRange)
  }
  return instances.length
}

/** Validate active and dormant definitions, returning frozen graph facts. */
export function analyzeNestedSequenceGraph(
  project: SequenceProject,
): NestedSequenceGraphAnalysis {
  if (!sequenceById(project, project.rootSequenceId)) {
    throw new RangeError(`missing root sequence "${project.rootSequenceId}"`)
  }
  const instanceIds = new Set<string>()
  let referenceCount = 0
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      referenceCount += validateTrackInstances(project, sequence, track, instanceIds)
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const depthBySequence = new Map<string, number>()
  const stack: string[] = []
  const topologicalOrder: string[] = []
  const visit = (sequenceId: string): number => {
    const current = state.get(sequenceId)
    if (current === 'visiting') {
      const start = stack.indexOf(sequenceId)
      throw new RangeError(
        `nested sequence cycle: ${[...stack.slice(start), sequenceId].join(' -> ')}`,
      )
    }
    if (current === 'visited') return depthBySequence.get(sequenceId) ?? 1
    const sequence = sequenceById(project, sequenceId)
    if (!sequence) throw new RangeError(`missing sequence "${sequenceId}"`)
    state.set(sequenceId, 'visiting')
    stack.push(sequenceId)
    let depth = 1
    for (const track of sequence.tracks) {
      for (const instance of sequenceInstances(track)) {
        depth = Math.max(depth, 1 + visit(instance.sequenceId))
      }
    }
    stack.pop()
    if (depth > MAX_NESTED_SEQUENCE_DEPTH) {
      throw new RangeError(
        `nested sequence depth exceeds ${MAX_NESTED_SEQUENCE_DEPTH}`,
      )
    }
    state.set(sequenceId, 'visited')
    depthBySequence.set(sequenceId, depth)
    topologicalOrder.push(sequenceId)
    return depth
  }
  for (const sequence of project.sequences) visit(sequence.id)

  for (const mediaKind of ['video', 'audio'] as const) {
    const maximumLeaves = new Map<string, number>()
    for (const sequenceId of topologicalOrder) {
      const sequence = sequenceById(project, sequenceId)!
      let sequenceMaximum = 0
      for (const track of tracksOfKind(sequence, mediaKind)) {
        let trackMaximum = track.clips.length > 0
          ? mediaKind === 'video' && track.transitions.length > 0 ? 2 : 1
          : 0
        for (const instance of sequenceInstances(track)) {
          trackMaximum = Math.max(
            trackMaximum,
            maximumLeaves.get(instance.sequenceId) ?? 0,
          )
        }
        sequenceMaximum += trackMaximum
        if (sequenceMaximum > MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME) {
          throw new RangeError(
            `nested ${mediaKind} expansion exceeds `
              + `${MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME} leaf requests`,
          )
        }
      }
      maximumLeaves.set(sequenceId, sequenceMaximum)
    }
  }

  const reachable = new Set<string>()
  const queue = [project.rootSequenceId]
  while (queue.length > 0) {
    const sequenceId = queue.shift()!
    if (reachable.has(sequenceId)) continue
    reachable.add(sequenceId)
    const sequence = sequenceById(project, sequenceId)!
    for (const track of sequence.tracks) {
      for (const instance of sequenceInstances(track)) queue.push(instance.sequenceId)
    }
  }

  return Object.freeze({
    rootSequenceId: project.rootSequenceId,
    sequenceCount: project.sequences.length,
    referenceCount,
    reachableSequenceCount: reachable.size,
    maxDepth: Math.max(0, ...depthBySequence.values()),
    topologicalOrder: Object.freeze(topologicalOrder),
  })
}

function activeInstanceAt(track: Track, frame: number): SequenceInstance | null {
  for (const instance of sequenceInstances(track)) {
    if (
      instance.timelineRange.startFrame <= frame
      && frame < rangeEnd(instance.timelineRange)
    ) return instance
    if (instance.timelineRange.startFrame > frame) break
  }
  return null
}

function activeClipAt(track: Track, frame: number): Clip | null {
  for (const clip of track.clips) {
    if (clip.timelineRange.startFrame <= frame && frame < rangeEnd(clip.timelineRange)) {
      return clip
    }
    if (clip.timelineRange.startFrame > frame) break
  }
  return null
}

function tracksOfKind(sequence: TimelineDoc, mediaKind: TrackKind): readonly Track[] {
  return sequence.tracks.filter((track) => track.kind === mediaKind)
}

function tracksForKind(sequence: TimelineDoc, mediaKind: TrackKind): readonly Track[] {
  if (mediaKind === 'video') {
    return sequence.tracks.filter((track) => track.kind === 'video' && !track.hidden)
  }
  return audibleTracks(sequence)
}

/** Expand one exact frame to ordinary media leaves without acquiring resources. */
export function expandNestedSequenceFrame(
  project: SequenceProject,
  rootSequenceId: string,
  frame: number,
  mediaKind: TrackKind,
): NestedSequenceFrameExpansion {
  analyzeNestedSequenceGraph(project)
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError('nested sequence frame must be a non-negative safe integer')
  }
  const root = sequenceById(project, rootSequenceId)
  if (!root) throw new RangeError(`missing root sequence "${rootSequenceId}"`)
  if (frame >= docDurationFrames(root)) {
    throw new RangeError('frame falls outside the requested sequence')
  }
  const leaves: NestedSequenceClipLeaf[] = []
  let visitedSequenceInstances = 0
  let maxDepth = 1

  const expand = (
    sequence: TimelineDoc,
    localFrame: number,
    instancePath: readonly SequenceInstanceId[],
    depth: number,
  ): void => {
    maxDepth = Math.max(maxDepth, depth)
    for (const track of tracksForKind(sequence, mediaKind)) {
      const nested = activeInstanceAt(track, localFrame)
      if (nested) {
        visitedSequenceInstances++
        const child = sequenceById(project, nested.sequenceId)
        if (!child) throw new RangeError(`missing sequence "${nested.sequenceId}"`)
        expand(
          child,
          nested.sourceStartFrame
            + localFrame
            - nested.timelineRange.startFrame,
          [...instancePath, nested.id],
          depth + 1,
        )
        continue
      }
      const clip = activeClipAt(track, localFrame)
      if (!clip) continue
      if (leaves.length >= MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME) {
        throw new RangeError(
          `nested frame exceeds ${MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME} leaf requests`,
        )
      }
      leaves.push(Object.freeze({
        kind: 'clip',
        sequenceId: sequence.id,
        trackId: track.id,
        clipId: clip.id,
        frame: localFrame,
        instancePath: Object.freeze([...instancePath]),
      }))
    }
  }
  expand(root, frame, [], 1)
  return Object.freeze({
    rootSequenceId,
    rootFrame: frame,
    mediaKind,
    leaves: Object.freeze(leaves),
    visitedSequenceInstances,
    maxDepth,
  })
}
