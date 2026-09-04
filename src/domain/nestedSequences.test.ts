import { describe, expect, test } from 'vitest'
import type {
  Clip,
  SequenceInstance,
  TimelineDoc,
  Track,
  TrackKind,
} from './schema'
import type { SequenceProject } from './projectSequences'
import {
  MAX_NESTED_SEQUENCE_DEPTH,
  MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME,
  analyzeNestedSequenceGraph,
  expandNestedSequenceFrame,
} from './nestedSequences'

function clip(id: string, startFrame = 0, durationFrames = 20): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
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

function instance(
  id: string,
  sequenceId: string,
  startFrame = 0,
  durationFrames = 20,
  sourceStartFrame = 0,
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

function track(
  id: string,
  kind: TrackKind,
  clips: Clip[] = [],
  sequenceInstances: SequenceInstance[] = [],
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    sequenceInstances,
    adjustments: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function sequence(
  id: string,
  tracks: Track[] = [],
): TimelineDoc {
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
    name: 'Nested project',
    rootSequenceId: sequences[0].id,
    sequences,
  }
}

describe('nested sequence graph seam', () => {
  test('validates every definition and maps exact same-rate parent frames', () => {
    const leaf = sequence('leaf', [
      track('leaf-video', 'video', [clip('leaf-clip', 12, 30)]),
    ])
    const child = sequence('child', [
      track('child-video', 'video', [], [instance('child-to-leaf', 'leaf', 4, 20, 10)]),
    ])
    const root = sequence('root', [
      track('root-video', 'video', [], [instance('root-to-child', 'child', 20, 10, 2)]),
    ])
    const value = project(root, child, leaf)

    expect(analyzeNestedSequenceGraph(value)).toMatchObject({
      referenceCount: 2,
      reachableSequenceCount: 3,
      maxDepth: 3,
    })
    expect(expandNestedSequenceFrame(value, 'root', 25, 'video').leaves).toEqual([{
      kind: 'clip',
      sequenceId: 'leaf',
      trackId: 'leaf-video',
      clipId: 'leaf-clip',
      frame: 13,
      instancePath: ['root-to-child', 'child-to-leaf'],
    }])
  })

  test('rejects missing references and dormant cycles before planning', () => {
    const root = sequence('root')
    const missing = sequence('missing-owner', [
      track('missing-track', 'video', [], [instance('missing-ref', 'absent')]),
    ])
    expect(() => analyzeNestedSequenceGraph(project(root, missing)))
      .toThrow(/missing sequence "absent"/u)

    const dormantA = sequence('dormant-a', [
      track('a-track', 'video', [], [instance('a-to-b', 'dormant-b')]),
    ])
    const dormantB = sequence('dormant-b', [
      track('b-track', 'video', [], [instance('b-to-a', 'dormant-a')]),
    ])
    expect(() => analyzeNestedSequenceGraph(project(root, dormantA, dormantB)))
      .toThrow(/cycle.*dormant-a.*dormant-b.*dormant-a/u)
  })

  test('rejects paths deeper than eight and malformed instance ranges', () => {
    const definitions = Array.from(
      { length: MAX_NESTED_SEQUENCE_DEPTH + 1 },
      (_, index) => sequence(`sequence-${index}`, index === MAX_NESTED_SEQUENCE_DEPTH
        ? []
        : [track(`track-${index}`, 'video', [], [
            instance(`instance-${index}`, `sequence-${index + 1}`),
          ])]),
    )
    expect(() => analyzeNestedSequenceGraph(project(...definitions)))
      .toThrow(/depth exceeds 8/u)

    const child = sequence('child')
    const root = sequence('root', [track('root-track', 'video', [], [{
      ...instance('unsafe', 'child'),
      sourceStartFrame: Number.MAX_SAFE_INTEGER,
    }])])
    expect(() => analyzeNestedSequenceGraph(project(root, child)))
      .toThrow(/source range/u)
  })

  test('rejects overlap with another item on the same lane', () => {
    const child = sequence('child')
    const root = sequence('root', [
      track('root-track', 'video', [clip('ordinary', 5, 10)], [
        instance('overlap', 'child', 10, 10),
      ]),
    ])
    expect(() => analyzeNestedSequenceGraph(project(root, child)))
      .toThrow(/overlaps another item/u)
  })

  test('rejects nested fan-out above the per-frame leaf admission bound', () => {
    const child = sequence('child', Array.from(
      { length: 128 },
      (_, index) => track(`child-track-${index}`, 'video', [clip(`clip-${index}`)]),
    ))
    const parentTrackCount = Math.floor(MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME / 128) + 1
    const root = sequence('root', Array.from(
      { length: parentTrackCount },
      (_, index) => track(`root-track-${index}`, 'video', [], [
        instance(`instance-${index}`, 'child'),
      ]),
    ))

    expect(() => analyzeNestedSequenceGraph(project(root, child)))
      .toThrow(/nested video expansion exceeds 4096 leaf requests/u)
  })

  test('counts muted and hidden tracks in the worst-case leaf budget', () => {
    const child = sequence('child', Array.from(
      { length: 128 },
      (_, index) => ({
        ...track(`child-track-${index}`, 'video', [clip(`clip-${index}`)]),
        hidden: true,
      }),
    ))
    const parentTrackCount = Math.floor(MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME / 128) + 1
    const root = sequence('root', Array.from(
      { length: parentTrackCount },
      (_, index) => track(`root-track-${index}`, 'video', [], [
        instance(`instance-${index}`, 'child'),
      ]),
    ))

    expect(() => analyzeNestedSequenceGraph(project(root, child)))
      .toThrow(/nested video expansion exceeds 4096 leaf requests/u)

    const mutedChild = sequence('muted-child', Array.from(
      { length: 128 },
      (_, index) => ({
        ...track(`muted-track-${index}`, 'audio', [clip(`audio-${index}`)]),
        muted: true,
      }),
    ))
    const mutedRoot = sequence('muted-root', Array.from(
      { length: parentTrackCount },
      (_, index) => track(`muted-root-${index}`, 'audio', [], [
        instance(`muted-instance-${index}`, 'muted-child'),
      ]),
    ))
    expect(() => analyzeNestedSequenceGraph(project(mutedRoot, mutedChild)))
      .toThrow(/nested audio expansion exceeds 4096 leaf requests/u)
  })
})
