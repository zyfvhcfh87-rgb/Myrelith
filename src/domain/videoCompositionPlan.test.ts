import { describe, expect, test } from 'vitest'
import type {
  Clip,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from './schema'
import type { SourceBoundsCatalog } from './crossfadePlan'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
} from './videoCompositionPlan'

function clip(
  id: string,
  assetId: string,
  timelineStart: number,
  sourceStart: number,
  opacity = 1,
  sourceMode: Clip['sourceMode'] = 'timed',
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode,
    sourceRange: sourceMode === 'still'
      ? { startFrame: 0, durationFrames: 1 }
      : { startFrame: sourceStart, durationFrames: 10 },
    timelineRange: { startFrame: timelineStart, durationFrames: 10 },
    transform: {
      x: id === 'to' ? 7 : 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity,
    volume: 1,
    effects: [],
  }
}

function crossfade(
  fromClipId: string,
  toClipId: string,
  durationFrames = 4,
): Transition {
  return {
    id: 'xfade',
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled: false, curve: 'equal-power' },
  }
}

function track(
  id: string,
  clips: Clip[],
  transitions: Transition[] = [],
  hidden = false,
): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions,
    hidden,
    muted: false,
    solo: false,
    locked: false,
  }
}

function doc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 3,
    id: 'visual-plan',
    name: 'Visual plan',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

function exact(endFrames = 200): MediaSourceBounds {
  return {
    video: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: Math.ceil(endFrames * 1_000_000 / 30),
    },
    audio: null,
  }
}

function catalog(
  entries: Array<[string, MediaSourceBounds]>,
): SourceBoundsCatalog {
  return new Map(entries)
}

describe('video composition plan', () => {
  test('plans ordinary clips in bottom-to-top track order', () => {
    const lower = clip('lower', 'lower-asset', 0, 30)
    const upper = clip('upper', 'upper-asset', 0, 80)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [lower]), track('V2', [upper])]),
      new Map(),
    )

    const plan = planner.planFrame(4)
    expect(plan.items.map((item) => item.kind === 'clip'
      ? `${item.trackId}:${item.request.clip.id}@${item.request.sourceFrame}`
      : item.kind)).toEqual(['V1:lower@34', 'V2:upper@84'])
  })

  test('emits one explicit group with genuine timed handle requests', () => {
    const from = clip('from', 'from-asset', 0, 20)
    const to = clip('to', 'to-asset', 10, 60, 0.6)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([
        ['from-asset', exact()],
        ['to-asset', exact()],
      ]),
    )

    const plan = planner.planFrame(11)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({
      kind: 'crossfade',
      trackId: 'V1',
      transitionId: 'xfade',
      frame: 11,
      requests: [
        { role: 'from', sourceFrame: 31, opacity: 1 },
        { role: 'to', sourceFrame: 61, opacity: 0.6 },
      ],
    })
    if (plan.items[0].kind !== 'crossfade') return
    expect(plan.items[0].requests[0].weight).toBeCloseTo(0.2)
    expect(plan.items[0].requests[1].weight).toBeCloseTo(0.8)
    expect(plan.items[0].kind === 'crossfade'
      ? plan.items[0].requests[1].clip.transform.x
      : null).toBe(7)
  })

  test('falls back to a hard cut when exact source handles are insufficient', () => {
    const from = clip('from', 'from-asset', 0, 0)
    const to = clip('to', 'to-asset', 10, 10)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([
        ['from-asset', exact(10)],
        ['to-asset', exact(20)],
      ]),
    )

    expect(planner.planFrame(9).items).toMatchObject([
      { kind: 'clip', request: { clip: { id: 'from' }, sourceFrame: 9 } },
    ])
    expect(planner.planFrame(10).items).toMatchObject([
      { kind: 'clip', request: { clip: { id: 'to' }, sourceFrame: 10 } },
    ])
  })

  test('repeats still frame zero while retaining the explicit group', () => {
    const from = clip('from', 'still', 0, 0, 1, 'still')
    const to = clip('to', 'video', 10, 20)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['video', exact()]]),
    )

    expect(videoCompositionRequests(planner.planFrame(11)).map(
      (request) => `${request.clip.id}@${request.sourceFrame}`,
    )).toEqual(['from@0', 'to@21'])
  })

  test('does not request fully transparent legs or hidden tracks', () => {
    const from = clip('from', 'shared', 0, 20, 0)
    const to = clip('to', 'shared', 10, 60)
    const hidden = clip('hidden', 'hidden', 0, 0)
    const planner = createVideoCompositionPlanner(
      doc([
        track('V1', [from, to], [crossfade(from.id, to.id)]),
        track('V2', [hidden], [], true),
      ]),
      catalog([['shared', exact()], ['hidden', exact()]]),
    )

    const plan = planner.planFrame(10)
    expect(plan.items).toHaveLength(1)
    expect(videoCompositionRequests(plan).map((request) => request.clip.id))
      .toEqual(['to'])
  })

  test('keeps two same-asset legs as ordered clip-keyed requests', () => {
    const from = clip('from', 'shared', 0, 20)
    const to = clip('to', 'shared', 10, 60)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['shared', exact()]]),
    )

    expect(videoCompositionRequests(planner.planFrame(10)).map(
      (request) => `${request.clip.id}@${request.sourceFrame}`,
    )).toEqual(['from@30', 'to@60'])
  })
})
