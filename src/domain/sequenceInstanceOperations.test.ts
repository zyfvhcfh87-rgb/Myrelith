import { describe, expect, test } from 'vitest'
import type { Clip, SequenceInstance, TimelineDoc, Track } from './schema'
import { defaultSourceTimeMap } from './sourceTimeMap'
import type { SequenceProject, SequenceEntityKind } from './projectSequences'
import {
  applySequenceInstanceEdit,
  createCompoundSequenceFromClips,
  makeSequenceInstanceIndependent,
} from './sequenceInstanceOperations'

function instance(
  id: string,
  sequenceId: string,
  startFrame: number,
  durationFrames: number,
  sourceStartFrame: number,
  linkGroupId?: string,
): SequenceInstance {
  return {
    kind: 'sequence',
    id,
    name: id,
    sequenceId,
    sourceStartFrame,
    timelineRange: { startFrame, durationFrames },
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function track(
  id: string,
  kind: Track['kind'],
  instances: SequenceInstance[] = [],
): Track {
  return {
    id,
    kind,
    name: id,
    clips: [],
    sequenceInstances: instances,
    adjustments: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function clip(id: string, startFrame: number, linkGroupId?: string): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 10 },
    sourceTimeMap: defaultSourceTimeMap(0, 10),
    timelineRange: { startFrame, durationFrames: 10 },
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
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function sequence(id: string, tracks: Track[] = []): TimelineDoc {
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

function factory() {
  let next = 0
  return (kind: SequenceEntityKind, sourceId?: string) => (
    `${kind}-${sourceId ?? 'new'}-${++next}`
  )
}

describe('sequence-instance edit seam', () => {
  test('creates one live compound definition and linked parent instances atomically', () => {
    const video = { ...track('V1', 'video'), clips: [clip('video-clip', 12, 'av')] }
    const audio = { ...track('A1', 'audio'), clips: [clip('audio-clip', 12, 'av')] }
    const initial = project(sequence('root', [video, audio]))

    const result = createCompoundSequenceFromClips(
      initial,
      'root',
      ['video-clip', 'audio-clip'],
      'Scene one',
      factory(),
    )

    expect(result.failure).toBeNull()
    expect(result.project.sequences).toHaveLength(2)
    const parent = result.project.sequences[0]
    expect(parent.tracks.flatMap((item) => item.clips)).toEqual([])
    expect(parent.tracks.map((item) => item.sequenceInstances?.[0])).toMatchObject([
      { sequenceId: result.sequenceId, timelineRange: { startFrame: 12, durationFrames: 10 } },
      { sequenceId: result.sequenceId, timelineRange: { startFrame: 12, durationFrames: 10 } },
    ])
    expect(new Set(parent.tracks.map(
      (item) => item.sequenceInstances?.[0].linkGroupId,
    )).size).toBe(1)
    const child = result.project.sequences[1]
    expect(child.name).toBe('Scene one')
    expect(child.tracks.flatMap((item) => item.clips).map((item) => (
      item.timelineRange.startFrame
    ))).toEqual([0, 0])
  })

  test('rejects a partial linked selection and preserves the project identity', () => {
    const video = { ...track('V1', 'video'), clips: [clip('video-clip', 12, 'av')] }
    const audio = { ...track('A1', 'audio'), clips: [clip('audio-clip', 12, 'av')] }
    const initial = project(sequence('root', [video, audio]))

    const result = createCompoundSequenceFromClips(
      initial,
      'root',
      ['video-clip'],
      'Broken scene',
      factory(),
    )

    expect(result.failure).toBe('partial-link')
    expect(result.project).toBe(initial)
  })

  test('moves, trims, splits, and duplicates an A/V pair atomically', () => {
    const child = sequence('child')
    const root = sequence('root', [
      track('V1', 'video', [instance('video', 'child', 10, 20, 3, 'pair')]),
      track('A1', 'audio', [instance('audio', 'child', 10, 20, 3, 'pair')]),
    ])
    const initial = project(root, child)

    const moved = applySequenceInstanceEdit(initial, 'root', {
      kind: 'move',
      instanceId: 'video',
      startFrame: 30,
    }, factory())
    expect(moved.failure).toBeNull()
    expect(moved.project.sequences[0].tracks.map((item) => (
      item.sequenceInstances?.[0].timelineRange.startFrame
    ))).toEqual([30, 30])

    const trimmed = applySequenceInstanceEdit(moved.project, 'root', {
      kind: 'trim',
      instanceId: 'audio',
      timelineRange: { startFrame: 34, durationFrames: 12 },
      sourceStartFrame: 7,
    }, factory())
    expect(trimmed.project.sequences[0].tracks.map((item) => (
      item.sequenceInstances?.[0]
    ))).toMatchObject([
      { sourceStartFrame: 7, timelineRange: { startFrame: 34, durationFrames: 12 } },
      { sourceStartFrame: 7, timelineRange: { startFrame: 34, durationFrames: 12 } },
    ])

    const split = applySequenceInstanceEdit(trimmed.project, 'root', {
      kind: 'split',
      instanceId: 'video',
      frame: 40,
    }, factory())
    expect(split.failure).toBeNull()
    expect(split.project.sequences[0].tracks[0].sequenceInstances).toMatchObject([
      { id: 'video', sourceStartFrame: 7, timelineRange: { startFrame: 34, durationFrames: 6 } },
      { sourceStartFrame: 13, timelineRange: { startFrame: 40, durationFrames: 6 } },
    ])
    expect(split.project.sequences[0].tracks[1].sequenceInstances).toHaveLength(2)

    const duplicated = applySequenceInstanceEdit(split.project, 'root', {
      kind: 'duplicate',
      instanceId: 'video',
      startFrame: 50,
    }, factory())
    expect(duplicated.failure).toBeNull()
    expect(duplicated.project.sequences[0].tracks[0].sequenceInstances).toHaveLength(3)
    expect(duplicated.project.sequences[0].tracks[1].sequenceInstances).toHaveLength(3)
  })

  test('rejects a collision without changing the project', () => {
    const child = sequence('child')
    const root = sequence('root', [track('V1', 'video', [
      instance('first', 'child', 0, 10, 0),
      instance('second', 'child', 20, 10, 0),
    ])])
    const initial = project(root, child)

    const result = applySequenceInstanceEdit(initial, 'root', {
      kind: 'move',
      instanceId: 'second',
      startFrame: 5,
    }, factory())

    expect(result.failure).toBe('collision')
    expect(result.project).toBe(initial)
  })

  test('makes one linked instance pair independent by cloning its whole subgraph', () => {
    const grandchild = sequence('grandchild')
    const child = sequence('child', [
      track('child-V1', 'video', [instance('child-grandchild', 'grandchild', 0, 20, 0)]),
    ])
    const root = sequence('root', [
      track('V1', 'video', [
        instance('shared', 'child', 0, 20, 0),
        instance('selected-video', 'child', 30, 20, 0, 'selected-pair'),
      ]),
      track('A1', 'audio', [
        instance('selected-audio', 'child', 30, 20, 0, 'selected-pair'),
      ]),
    ])
    const initial = project(root, child, grandchild)

    const result = makeSequenceInstanceIndependent(
      initial,
      'root',
      'selected-video',
      factory(),
    )

    expect(result.failure).toBeNull()
    expect(result.project.sequences).toHaveLength(5)
    const nextRoot = result.project.sequences[0]
    const selectedTarget = nextRoot.tracks[0].sequenceInstances?.[1].sequenceId
    expect(selectedTarget).not.toBe('child')
    expect(nextRoot.tracks[1].sequenceInstances?.[0].sequenceId).toBe(selectedTarget)
    expect(nextRoot.tracks[0].sequenceInstances?.[0].sequenceId).toBe('child')
    const clonedChild = result.project.sequences.find((item) => item.id === selectedTarget)!
    const clonedGrandchildId = clonedChild.tracks[0].sequenceInstances?.[0].sequenceId
    expect(clonedGrandchildId).not.toBe('grandchild')
    expect(result.project.sequences.some((item) => item.id === clonedGrandchildId)).toBe(true)
    expect(clonedChild.tracks[0].sequenceInstances?.[0].id).not.toBe('child-grandchild')
    expect(initial.sequences).toHaveLength(3)
  })
})
