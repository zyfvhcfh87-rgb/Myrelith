/** Pure graph validation and lane lookups for live sequence refs. */

import type {
  MulticamDefinition,
  MulticamInstance,
  SequenceInstance,
  TimelineDoc,
  TimeRange,
  Track,
  TrackKind,
} from './schema'
import type { SequenceProject } from './projectSequences'
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

export function sequenceInstances(track: Track): readonly SequenceInstance[] {
  return track.sequenceInstances ?? []
}

export function multicamInstances(track: Track): readonly MulticamInstance[] {
  return track.multicamInstances ?? []
}

/** The start-sorted lane item covering `frame`, or null. */
function activeLaneItemAt<T extends { readonly timelineRange: TimeRange }>(
  items: readonly T[],
  frame: number,
): T | null {
  for (const item of items) {
    if (
      item.timelineRange.startFrame <= frame
      && frame < rangeEnd(item.timelineRange)
    ) return item
    if (item.timelineRange.startFrame > frame) break
  }
  return null
}

export function activeSequenceInstanceAt(track: Track, frame: number): SequenceInstance | null {
  return activeLaneItemAt(sequenceInstances(track), frame)
}

export function activeMulticamInstanceAt(track: Track, frame: number): MulticamInstance | null {
  return activeLaneItemAt(multicamInstances(track), frame)
}

export function sequenceById(
  project: SequenceProject,
  sequenceId: string,
): TimelineDoc | null {
  return project.sequences.find((sequence) => sequence.id === sequenceId) ?? null
}

/** Nesting and project membership require identical canvas, audio rate, and exact frame rate. */
export function sequenceSettingsEqual(left: TimelineDoc, right: TimelineDoc): boolean {
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

function assertInstanceRange(
  instance: Pick<SequenceInstance, 'id' | 'sourceStartFrame' | 'timelineRange'>,
): void {
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
  if (instances.length === 0) return 0
  let previousEnd = -1
  const occupied = [
    ...track.clips.map((item) => item.timelineRange),
    ...(track.adjustments ?? []).map((item) => item.timelineRange),
    ...multicamInstances(track).map((item) => item.timelineRange),
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

function validateTrackMulticams(
  definitions: ReadonlyMap<string, MulticamDefinition>,
  track: Track,
  ids: Set<string>,
): void {
  const instances = multicamInstances(track)
  if (instances.length === 0) return
  let previousEnd = -1
  const occupied = [
    ...track.clips.map((item) => item.timelineRange),
    ...(track.adjustments ?? []).map((item) => item.timelineRange),
    ...sequenceInstances(track).map((item) => item.timelineRange),
  ]
  for (const instance of instances) {
    assertIdentifier(instance.id, 'multicam instance id')
    if (ids.has(instance.id)) {
      throw new RangeError(`duplicate timeline item id "${instance.id}"`)
    }
    ids.add(instance.id)
    assertInstanceRange(instance)
    if (instance.timelineRange.startFrame < previousEnd) {
      throw new RangeError(`multicam instance "${instance.id}" overlaps another instance`)
    }
    if (occupied.some((range) => overlaps(instance.timelineRange, range))) {
      throw new RangeError(`multicam instance "${instance.id}" overlaps another item`)
    }
    const definition = definitions.get(instance.multicamId)
    if (
      !definition
      || instance.sourceStartFrame + instance.timelineRange.durationFrames
        > definition.durationFrames
    ) {
      throw new RangeError(
        `multicam instance "${instance.id}" references a missing or uncovered definition`,
      )
    }
    previousEnd = rangeEnd(instance.timelineRange)
    occupied.push(instance.timelineRange)
  }
}

/** Validate active and dormant definitions, returning frozen graph facts. */
export function analyzeNestedSequenceGraph(
  project: SequenceProject,
): NestedSequenceGraphAnalysis {
  if (!sequenceById(project, project.rootSequenceId)) {
    throw new RangeError(`missing root sequence "${project.rootSequenceId}"`)
  }
  const instanceIds = new Set<string>()
  const multicamDefinitions = new Map((project.multicams ?? []).map((item) => [item.id, item]))
  let referenceCount = 0
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      referenceCount += validateTrackInstances(project, sequence, track, instanceIds)
      validateTrackMulticams(multicamDefinitions, track, instanceIds)
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
        if (multicamInstances(track).length > 0) trackMaximum = Math.max(trackMaximum, 1)
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

function tracksOfKind(sequence: TimelineDoc, mediaKind: TrackKind): readonly Track[] {
  return sequence.tracks.filter((track) => track.kind === mediaKind)
}
