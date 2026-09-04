import { describe, expect, test } from 'vitest'
import type {
  Clip,
  MulticamDefinition,
  MulticamInstance,
  SequenceInstance,
  TimelineDoc,
  Track,
} from './schema'
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

function multicam(id: string, startFrame = 100): MulticamInstance {
  return {
    kind: 'multicam',
    id,
    name: id,
    multicamId: 'concert',
    sourceStartFrame: 0,
    timelineRange: { startFrame, durationFrames: 50 },
  }
}

function multicamDefinition(
  audioPolicy: MulticamDefinition['audioPolicy'],
): MulticamDefinition {
  return {
    id: 'concert',
    name: 'Concert',
    durationFrames: 50,
    angles: [
      {
        id: 'wide',
        name: 'Wide',
        assetId: 'asset-wide',
        coverage: { startFrame: 10, durationFrames: 40 },
        sourceStartFrame: 0,
      },
      {
        id: 'close',
        name: 'Close',
        assetId: 'asset-close',
        coverage: { startFrame: 0, durationFrames: 50 },
        sourceStartFrame: 0,
      },
    ],
    switches: [
      { frame: 0, videoAngleId: 'wide' },
      { frame: 20, videoAngleId: 'close' },
    ],
    audioPolicy,
  }
}

function audioTrack(
  id: string,
  clips: Clip[] = [],
  instances: SequenceInstance[] = [],
  multicams: MulticamInstance[] = [],
): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    clips,
    sequenceInstances: instances,
    multicamInstances: multicams,
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
    schemaVersion: 20,
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

  test('keeps fixed audio continuous and follow-video audio exact across gaps', () => {
    const root = sequence('root', [
      audioTrack('root-A1', [], [], [multicam('concert-audio')]),
    ])
    const fixed = createProjectTimelineAudioMixPlan({
      ...project(root),
      multicams: [multicamDefinition({ kind: 'fixed', angleId: 'close' })],
    }, 'root', new Map())

    expect(fixed.clips).toEqual([expect.objectContaining({
      assetId: 'asset-close',
      timelineStartFrame: 100,
      timelineEndFrame: 150,
      sourceStartFrame: 0,
      sourceEndFrame: 50,
    })])

    const follow = createProjectTimelineAudioMixPlan({
      ...project(root),
      multicams: [multicamDefinition({ kind: 'follow-video' })],
    }, 'root', new Map())
    expect(follow.clips).toEqual([
      expect.objectContaining({
        assetId: 'asset-wide',
        timelineStartFrame: 110,
        timelineEndFrame: 120,
        sourceStartFrame: 0,
        sourceEndFrame: 10,
      }),
      expect.objectContaining({
        assetId: 'asset-close',
        timelineStartFrame: 120,
        timelineEndFrame: 150,
        sourceStartFrame: 20,
        sourceEndFrame: 50,
      }),
    ])
  })

  test('maps follow-video multicam segments through a nested sequence exactly once', () => {
    const child = sequence('child', [
      audioTrack('child-A1', [], [], [multicam('nested-concert', 0)]),
    ])
    const root = sequence('root', [audioTrack('root-A1', [], [
      nested('child-use', 'child', 10, 0, 40),
    ])])
    const plan = createProjectTimelineAudioMixPlan({
      ...project(root, child),
      multicams: [multicamDefinition({ kind: 'follow-video' })],
    }, 'root', new Map())

    expect(plan.clips.map((clip) => ({
      assetId: clip.assetId,
      timelineStartFrame: clip.timelineStartFrame,
      timelineEndFrame: clip.timelineEndFrame,
      sourceStartFrame: clip.sourceStartFrame,
      sourceEndFrame: clip.sourceEndFrame,
    }))).toEqual([
      {
        assetId: 'asset-wide',
        timelineStartFrame: 20,
        timelineEndFrame: 30,
        sourceStartFrame: 0,
        sourceEndFrame: 10,
      },
      {
        assetId: 'asset-close',
        timelineStartFrame: 30,
        timelineEndFrame: 50,
        sourceStartFrame: 20,
        sourceEndFrame: 40,
      },
    ])
  })
})
