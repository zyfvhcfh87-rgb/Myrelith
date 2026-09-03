import { describe, expect, test } from 'vitest'
import type { Clip, SequenceInstance, TimelineDoc, Track } from './schema'
import type { SequenceProject } from './projectSequences'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { createProjectTimelineAudioMixPlan } from './projectAudioMixPlan'

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

function nested(
  id: string,
  sequenceId: string,
  startFrame: number,
  sourceStartFrame: number,
  durationFrames = 10,
): SequenceInstance {
  return {
    kind: 'sequence',
    id,
    name: id,
    sequenceId,
    sourceStartFrame,
    timelineRange: { startFrame, durationFrames },
  }
}

function audioTrack(
  id: string,
  clips: Clip[] = [],
  instances: SequenceInstance[] = [],
): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    clips,
    sequenceInstances: instances,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
    audioEffects: [],
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

describe('project audio mix plan', () => {
  test('maps child source frames onto the parent range through child then parent buses', () => {
    const child = sequence('child', [audioTrack('child-A1', [clip('leaf', 2)])])
    const root = sequence('root', [
      audioTrack('root-A1', [], [nested('child-use', 'child', 10, 4, 6)]),
    ])

    const plan = createProjectTimelineAudioMixPlan(
      project(root, child),
      'root',
      new Map(),
    )

    expect(plan.clips).toHaveLength(1)
    expect(plan.clips[0]).toMatchObject({
      assetId: 'asset-leaf',
      timelineStartFrame: 10,
      timelineEndFrame: 16,
      sourceStartFrame: 2,
      sourceEndFrame: 8,
    })
    expect(plan.clips[0].clipId).not.toBe('leaf')
    const leafBus = plan.tracks.find((track) => track.trackId === plan.clips[0].trackId)
    expect(leafBus?.parentTrackId).toBeDefined()
    const childMaster = plan.tracks.find(
      (track) => track.trackId === leafBus?.parentTrackId,
    )
    expect(childMaster?.parentTrackId).toBe('root-A1')
  })

  test('an uncovered child range contributes silence', () => {
    const child = sequence('child', [audioTrack('child-A1', [clip('leaf', 0, 2)])])
    const root = sequence('root', [
      audioTrack('root-A1', [], [nested('child-use', 'child', 0, 5, 4)]),
    ])

    const plan = createProjectTimelineAudioMixPlan(
      project(root, child),
      'root',
      new Map(),
    )

    expect(plan.clips).toEqual([])
  })
})
