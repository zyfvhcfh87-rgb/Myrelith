import { describe, expect, test } from 'vitest'
import type { Clip, SequenceInstance, TimelineDoc, Track } from './schema'
import type { SequenceProject } from './projectSequences'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { createProjectVideoCompositionPlanner } from './projectVideoCompositionPlan'
import { videoCompositionRequests } from './videoCompositionPlan'

function clip(id: string, startFrame = 0, durationFrames = 20): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    sourceTimeMap: defaultSourceTimeMap(0, durationFrames),
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function nested(id: string, sequenceId: string, startFrame = 0): SequenceInstance {
  return {
    kind: 'sequence',
    id,
    name: id,
    sequenceId,
    sourceStartFrame: 3,
    timelineRange: { startFrame, durationFrames: 10 },
  }
}

function track(
  id: string,
  clips: Clip[] = [],
  instances: SequenceInstance[] = [],
): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    sequenceInstances: instances,
    adjustments: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function sequence(id: string, tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 19,
    id,
    name: id,
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks,
    markers: [],
    captionTracks: [],
  }
}

function project(...sequences: TimelineDoc[]): SequenceProject {
  return {
    id: 'project',
    name: 'Project',
    rootSequenceId: sequences[0].id,
    sequences,
  }
}

describe('project video composition planner seam', () => {
  test('flattens exact child frames at the parent track position', () => {
    const child = sequence('child', [track('child-V1', [clip('child-clip', 3)])])
    const root = sequence('root', [
      track('root-V1', [clip('lower', 0)]),
      track('root-V2', [], [nested('nested-child', 'child', 10)]),
    ])

    const plan = createProjectVideoCompositionPlanner(
      project(root, child),
      'root',
      new Map(),
    ).planFrame(12)

    expect(plan.items.map((item) => item.kind)).toEqual([
      'clip',
      'sequence-background',
      'clip',
    ])
    expect(plan.items[2]).toMatchObject({
      kind: 'clip',
      frame: 5,
      request: { clip: { id: 'child-clip' }, sourceFrame: 2 },
    })
  })

  test('keeps uncovered child output explicit as black', () => {
    const child = sequence('child', [track('child-V1')])
    const root = sequence('root', [track('root-V1', [], [nested('nested-child', 'child')])])

    const plan = createProjectVideoCompositionPlanner(
      project(root, child),
      'root',
      new Map(),
    ).planFrame(2)

    expect(plan.items).toEqual([{
      kind: 'sequence-background',
      trackId: 'root-V1',
      frame: 2,
      instanceId: 'nested-child',
      sequenceId: 'child',
      instancePath: ['nested-child'],
    }])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.items)).toBe(true)
  })

  test('a child edit updates every live instance through the same planner', () => {
    const child = sequence('child', [track('child-V1', [clip('before', 3)])])
    const root = sequence('root', [
      track('root-V1', [], [nested('first', 'child', 0)]),
      track('root-V2', [], [nested('second', 'child', 20)]),
    ])
    const initial = project(root, child)
    const editedChild = {
      ...child,
      tracks: [{ ...child.tracks[0], clips: [clip('after', 3)] }],
    }
    const edited = { ...initial, sequences: [root, editedChild] }
    const planner = createProjectVideoCompositionPlanner(edited, 'root', new Map())

    expect(planner.planFrame(0).items.at(-1)).toMatchObject({
      kind: 'clip',
      request: { clip: { id: 'after' } },
    })
    expect(planner.planFrame(20).items.at(-1)).toMatchObject({
      kind: 'clip',
      request: { clip: { id: 'after' } },
    })
  })

  test('gives simultaneous uses of one leaf distinct decode identities', () => {
    const child = sequence('child', [track('child-V1', [clip('shared-leaf', 0, 20)])])
    const root = sequence('root', [
      track('root-V1', [], [{ ...nested('first', 'child'), sourceStartFrame: 1 }]),
      track('root-V2', [], [{ ...nested('second', 'child'), sourceStartFrame: 7 }]),
    ])

    const plan = createProjectVideoCompositionPlanner(
      project(root, child),
      'root',
      new Map(),
    ).planFrame(0)
    const requests = videoCompositionRequests(plan)

    expect(requests.map((request) => request.sourceFrame)).toEqual([1, 7])
    const requestKeys = requests.map((request) => request.requestKey)
    expect(requestKeys.every((key) => typeof key === 'string')).toBe(true)
    expect(new Set(requestKeys).size).toBe(2)
    expect(Object.isFrozen(plan.items.at(-1))).toBe(true)
    expect(Object.isFrozen(requests.at(-1))).toBe(true)
  })
})
