import { describe, expect, test } from 'vitest'
import type {
  AssetId,
  Clip,
  FrameRate,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from './schema'
import {
  createCrossfadeAudioWindowIndex,
  crossfadeFrameGroupAt,
  evaluateCrossfadeDraft,
  evaluateCrossfadeUpdate,
  resolveCrossfadePlan,
  type SourceBoundsCatalog,
} from './crossfadePlan'

const F30: FrameRate = { num: 30, den: 1 }

function clip(
  id: string,
  assetId: AssetId,
  timelineStart: number,
  duration: number,
  sourceStart: number,
  options: {
    linkGroupId?: string
    sourceMode?: Clip['sourceMode']
    opacity?: number
    volume?: number
  } = {},
): Clip {
  const sourceMode = options.sourceMode ?? 'timed'
  return {
    id,
    assetId,
    name: id,
    sourceMode,
    sourceRange: sourceMode === 'still'
      ? { startFrame: 0, durationFrames: 1 }
      : { startFrame: sourceStart, durationFrames: duration },
    timelineRange: { startFrame: timelineStart, durationFrames: duration },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: options.opacity ?? 1,
    volume: options.volume ?? 1,
    effects: [],
    ...(options.linkGroupId ? { linkGroupId: options.linkGroupId } : {}),
  }
}

function transition(
  id: string,
  fromClipId: string,
  toClipId: string,
  durationFrames: number,
  enabled = true,
): Transition {
  return {
    id,
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled, curve: 'equal-power' },
  }
}

function track(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  transitions: Transition[] = [],
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions,
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function doc(tracks: Track[], rate: FrameRate = F30): TimelineDoc {
  return {
    schemaVersion: 19,
    id: 'crossfade-plan-doc',
    name: 'Crossfade plan',
    frameRate: rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

function exact(
  video: [number, number] | null,
  audio: [number, number] | null = null,
): MediaSourceBounds {
  return {
    video: video
      ? {
          status: 'exact',
          firstTimestampUs: video[0],
          endTimestampUs: video[1],
        }
      : null,
    audio: audio
      ? {
          status: 'exact',
          firstTimestampUs: audio[0],
          endTimestampUs: audio[1],
        }
      : null,
  }
}

function catalog(
  entries: Array<[AssetId, MediaSourceBounds]>,
): SourceBoundsCatalog {
  return new Map(entries)
}

function visualFixture(durationFrames = 7) {
  const from = clip('from', 'from-asset', 10, 10, 100)
  const to = clip('to', 'to-asset', 20, 10, 120)
  const dissolve = transition('dissolve', from.id, to.id, durationFrames, false)
  const project = doc([track('V1', 'video', [from, to], [dissolve])])
  const bounds = catalog([
    ['from-asset', exact([-1_000_000, 3_800_000])], // negative time is not presented
    ['to-asset', exact([3_900_000, 10_000_000])], // first source frame 117
  ])
  return { from, to, dissolve, project, bounds }
}

describe('canonical crossfade planner', () => {
  test('derives the odd maximum and exact grouped requests without endpoint freezing', () => {
    const fixture = visualFixture(7)
    const resolved = resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      fixture.bounds,
    )

    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') throw new Error('fixture unavailable')
    expect(resolved.plan).toMatchObject({
      cutFrame: 20,
      startFrame: 17,
      endFrame: 24,
      maximumDurationFrames: 7,
      audio: { status: 'disabled' },
    })

    const first = crossfadeFrameGroupAt(resolved.plan, 17)
    const last = crossfadeFrameGroupAt(resolved.plan, 23)
    expect(first?.requests.map((request) => request.sourceFrame)).toEqual([
      107,
      117,
    ])
    expect(last?.requests.map((request) => request.sourceFrame)).toEqual([
      113,
      123,
    ])
    expect(first?.requests.map((request) => request.weight)).toEqual([
      0.875,
      0.125,
    ])
    expect(last?.requests.map((request) => request.weight)).toEqual([
      0.125,
      0.875,
    ])
    expect(crossfadeFrameGroupAt(resolved.plan, 24)).toBeNull()
  })

  test.each([
    { duration: 1, start: 20, end: 21, source: [110, 120], weights: [0.5, 0.5] },
    { duration: 4, start: 18, end: 22, source: [108, 118], weights: [0.8, 0.2] },
  ])('keeps $duration-frame centered geometry exact', ({
    duration,
    start,
    end,
    source,
    weights,
  }) => {
    const fixture = visualFixture(duration)
    const resolved = resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      fixture.bounds,
    )
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect([resolved.plan.startFrame, resolved.plan.endFrame]).toEqual([start, end])
    const group = crossfadeFrameGroupAt(resolved.plan, start)
    expect(group?.requests.map((request) => request.sourceFrame)).toEqual(source)
    expect(group?.requests.map((request) => request.weight)).toEqual(weights)
  })

  test('maps retimed transition handles through the same rational source clock', () => {
    const from = {
      ...clip('from', 'from-asset', 10, 10, 100),
      sourceRange: { startFrame: 100, durationFrames: 20 },
      sourceTimeMap: {
        sourceStartTicks: 100_000_000,
        sourceDurationTicks: 20_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    const to = {
      ...clip('to', 'to-asset', 20, 10, 120),
      sourceRange: { startFrame: 120, durationFrames: 20 },
      sourceTimeMap: {
        sourceStartTicks: 120_000_000,
        sourceDurationTicks: 20_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    const dissolve = transition('retimed-dissolve', from.id, to.id, 4, false)
    const project = doc([track('V1', 'video', [from, to], [dissolve])])
    const bounds = catalog([
      ['from-asset', exact([0, 10_000_000])],
      ['to-asset', exact([0, 10_000_000])],
    ])

    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(crossfadeFrameGroupAt(resolved.plan, 18)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([116, 116])
    expect(crossfadeFrameGroupAt(resolved.plan, 21)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([122, 122])
  })

  test('maps speed-ramped transition handles through the shared piecewise clock', () => {
    const from = {
      ...clip('from-ramp', 'from-asset', 10, 10, 100),
      sourceRange: { startFrame: 100, durationFrames: 20 },
      sourceTimeMap: {
        sourceStartTicks: 100_000_000,
        sourceDurationTicks: 20_000_000,
        rate: { numerator: 1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' as const },
            { frame: 8, rate: { numerator: 2, denominator: 1 }, easing: 'hold' as const },
          ],
        },
      },
    }
    const to = {
      ...clip('to-ramp', 'to-asset', 20, 10, 120),
      sourceRange: { startFrame: 120, durationFrames: 20 },
      sourceTimeMap: {
        sourceStartTicks: 120_000_000,
        sourceDurationTicks: 20_000_000,
        rate: { numerator: 1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'linear' as const },
            { frame: 2, rate: { numerator: 2, denominator: 1 }, easing: 'hold' as const },
          ],
        },
      },
    }
    const dissolve = transition('ramped-dissolve', from.id, to.id, 4, false)
    const project = doc([track('V1', 'video', [from, to], [dissolve])])
    const bounds = catalog([
      ['from-asset', exact([0, 10_000_000])],
      ['to-asset', exact([0, 10_000_000])],
    ])

    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(crossfadeFrameGroupAt(resolved.plan, 18)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([108, 118])
    expect(crossfadeFrameGroupAt(resolved.plan, 21)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([114, 121])
  })

  test('reports the exact maximum when real pre/post handles are insufficient', () => {
    const fixture = visualFixture(8)
    expect(resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      fixture.bounds,
    )).toEqual({
      status: 'unavailable',
      reason: 'duration-exceeds-video-capacity',
      leg: null,
      maximumDurationFrames: 7,
    })
  })

  test('recomputes capacity from the current slipped and trimmed source ranges', () => {
    const fixture = visualFixture(4)
    const initial = resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      fixture.bounds,
    )
    expect(initial.status === 'available'
      ? initial.plan.maximumDurationFrames
      : null).toBe(7)

    fixture.project.tracks[0].clips[1] = {
      ...fixture.to,
      sourceRange: { ...fixture.to.sourceRange, startFrame: 118 },
    }
    const slipped = resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      fixture.bounds,
    )
    expect(slipped).toMatchObject({
      status: 'unavailable',
      reason: 'duration-exceeds-video-capacity',
      maximumDurationFrames: 3,
    })

    const trimmedFixture = visualFixture(4)
    trimmedFixture.project.tracks[0].clips[0] = {
      ...trimmedFixture.from,
      timelineRange: { startFrame: 10, durationFrames: 12 },
      sourceRange: { startFrame: 100, durationFrames: 12 },
    }
    trimmedFixture.project.tracks[0].clips[1] = {
      ...trimmedFixture.to,
      timelineRange: { startFrame: 22, durationFrames: 10 },
    }
    const trimmed = resolveCrossfadePlan(
      trimmedFixture.project,
      'V1',
      trimmedFixture.dissolve.id,
      trimmedFixture.bounds,
    )
    expect(trimmed.status).toBe('available')
    if (trimmed.status !== 'available') return
    expect(trimmed.plan.maximumDurationFrames).toBe(4)
  })

  test('supports same-asset clips with independent source ranges', () => {
    const from = clip('from', 'shared', 0, 10, 10)
    const to = clip('to', 'shared', 10, 10, 40)
    const dissolve = transition('same-asset', from.id, to.id, 6, false)
    const project = doc([track('V1', 'video', [from, to], [dissolve])])
    const resolved = resolveCrossfadePlan(
      project,
      'V1',
      dissolve.id,
      catalog([['shared', exact([0, 10_000_000])]]),
    )
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(crossfadeFrameGroupAt(resolved.plan, 7)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([17, 37])
  })

  test('stills repeat frame zero without inventing timed bounds', () => {
    const from = clip('still-a', 'image-a', 0, 5, 0, { sourceMode: 'still' })
    const to = clip('still-b', 'image-b', 5, 5, 0, { sourceMode: 'still' })
    const dissolve = transition('still-dissolve', from.id, to.id, 9, false)
    const project = doc([track('V1', 'video', [from, to], [dissolve])])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, new Map())
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.maximumDurationFrames).toBe(10)
    expect(crossfadeFrameGroupAt(resolved.plan, 1)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([0, 0])
  })

  test.each([
    {
      name: 'missing catalog entry',
      bounds: catalog([['to-asset', exact([0, 10_000_000])]]),
      reason: 'source-catalog-missing',
      leg: 'from',
    },
    {
      name: 'absent video stream',
      bounds: catalog([
        ['from-asset', exact(null, [0, 10_000_000])],
        ['to-asset', exact([0, 10_000_000])],
      ]),
      reason: 'source-stream-absent',
      leg: 'from',
    },
    {
      name: 'legacy unknown bounds',
      bounds: catalog([
        ['from-asset', { video: { status: 'unknown' }, audio: null }],
        ['to-asset', exact([0, 10_000_000])],
      ]),
      reason: 'source-bounds-unknown',
      leg: 'from',
    },
  ])('fails closed for $name', ({ bounds, reason, leg }) => {
    const fixture = visualFixture(4)
    expect(resolveCrossfadePlan(
      fixture.project,
      'V1',
      fixture.dissolve.id,
      bounds,
    )).toEqual({
      status: 'unavailable',
      reason,
      leg,
      maximumDurationFrames: null,
    })
  })

  test('uses rational timestamp boundaries without float frame arithmetic', () => {
    const rate = { num: 30_000, den: 1_001 }
    const from = clip('ntsc-from', 'ntsc-a', 29_990, 10, 29_990)
    const to = clip('ntsc-to', 'ntsc-b', 30_000, 10, 30_000)
    const dissolve = transition('ntsc', from.id, to.id, 3, false)
    const project = doc([track('V1', 'video', [from, to], [dissolve])], rate)
    const bounds = catalog([
      ['ntsc-a', exact([0, 1_001_100_000])],
      ['ntsc-b', exact([1_000_899_900, 1_002_000_000])],
    ])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(crossfadeFrameGroupAt(resolved.plan, 29_999)?.requests.map(
      (request) => request.sourceFrame,
    )).toEqual([29_999, 29_999])
  })

  test('resolves unique aligned linked-audio partners into the same plan', () => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const dissolve = transition('av', from.id, to.id, 5)
    const project = doc([
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ])
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000], [0, 10_000_000])],
      ['asset-b', exact([0, 10_000_000], [0, 10_000_000])],
    ])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio).toMatchObject({
      status: 'available',
      curve: 'equal-power',
      from: { trackId: 'A1', clip: { id: audioFrom.id }, sourceFrameAtCut: 20 },
      to: { trackId: 'A1', clip: { id: audioTo.id }, sourceFrameAtCut: 30 },
    })
  })

  test('makes stretched linked audio available to the crossfade plan', () => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    audioFrom.sourceRange = { startFrame: 10, durationFrames: 20 }
    audioFrom.sourceTimeMap = {
      sourceStartTicks: 10_000_000,
      sourceDurationTicks: 20_000_000,
      rate: { numerator: 2, denominator: 1 },
    }
    const dissolve = transition('av', from.id, to.id, 5)
    const project = doc([
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ])
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000], [0, 10_000_000])],
      ['asset-b', exact([0, 10_000_000], [0, 10_000_000])],
    ])

    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)

    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio).toMatchObject({
      status: 'available',
      from: {
        clip: { id: 'audio-from' },
        sourceFrameAtCut: 30,
      },
      to: {
        clip: { id: 'audio-to' },
        sourceFrameAtCut: 30,
      },
    })
  })

  test('keeps speed-ramped linked audio available', () => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    audioFrom.sourceRange = { startFrame: 10, durationFrames: 20 }
    audioFrom.sourceTimeMap = {
      sourceStartTicks: 10_000_000,
      sourceDurationTicks: 20_000_000,
      rate: { numerator: 2, denominator: 1 },
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
          { frame: 10, rate: { numerator: 2, denominator: 1 }, easing: 'linear' },
        ],
      },
    }
    const dissolve = transition('av', from.id, to.id, 5)
    const project = doc([
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ])
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000], [0, 10_000_000])],
      ['asset-b', exact([0, 10_000_000], [0, 10_000_000])],
    ])

    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)

    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio.status).toBe('available')
    if (resolved.plan.audio.status !== 'available') return
    expect(resolved.plan.audio.maximumDurationFrames).toBe(20)
    expect(resolved.plan.audio.from.clip.id).toBe(audioFrom.id)
    expect(resolved.plan.audio.to.clip.id).toBe(audioTo.id)
  })

  test.each([
    {
      name: 'missing partner',
      mutate: (tracks: Track[]) => {
        tracks[1].clips = tracks[1].clips.filter((item) => item.id !== 'audio-from')
      },
      reason: 'linked-audio-partner-missing',
      leg: 'from',
    },
    {
      name: 'ambiguous partner',
      mutate: (tracks: Track[]) => {
        tracks.push(track('A2', 'audio', [
          { ...tracks[1].clips[0], id: 'audio-from-duplicate' },
        ]))
      },
      reason: 'linked-audio-partner-ambiguous',
      leg: 'from',
    },
    {
      name: 'misaligned partner',
      mutate: (tracks: Track[]) => {
        tracks[1].clips[0] = {
          ...tracks[1].clips[0],
          timelineRange: { startFrame: 1, durationFrames: 10 },
        }
      },
      reason: 'linked-audio-partner-misaligned',
      leg: null,
    },
  ])('keeps visual availability while $name makes audio unavailable', ({
    mutate,
    reason,
    leg,
  }) => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const dissolve = transition('av', from.id, to.id, 5)
    const tracks = [
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ]
    mutate(tracks)
    const project = doc(tracks)
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000], [0, 10_000_000])],
      ['asset-b', exact([0, 10_000_000], [0, 10_000_000])],
    ])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio).toEqual({
      status: 'unavailable',
      reason,
      leg,
      maximumDurationFrames: null,
    })
  })

  test('indexes a maximum-size ambiguous link group without transition rescans', () => {
    const transitionCount = 1_000
    const videoClipCount = transitionCount * 2
    const audioClipCount = 100_000 - videoClipCount
    const videoClips = Array.from({ length: videoClipCount }, (_, index) => (
      clip(
        `mass-video-${index}`,
        `mass-video-asset-${index}`,
        index * 2,
        2,
        0,
        { linkGroupId: 'mass-ambiguous-link' },
      )
    ))
    const transitions = Array.from({ length: transitionCount }, (_, index) => (
      transition(
        `mass-transition-${index}`,
        videoClips[index * 2].id,
        videoClips[index * 2 + 1].id,
        1,
      )
    ))
    const audioClips = Array.from({ length: audioClipCount }, (_, index) => (
      clip(
        `mass-audio-${index}`,
        `mass-audio-asset-${index}`,
        index,
        1,
        0,
        { linkGroupId: 'mass-ambiguous-link' },
      )
    ))
    const project = doc([
      track('V1', 'video', videoClips, transitions),
      track('A1', 'audio', audioClips),
    ])

    expect(createCrossfadeAudioWindowIndex(project).size).toBe(0)
  })

  test('source-aware indexing prunes unavailable candidates before cross-track conflicts', () => {
    const frozenAudio = clip(
      'audio-frozen',
      'asset-frozen',
      0,
      10,
      10,
      { linkGroupId: 'frozen-link' },
    )
    frozenAudio.sourceRange = { startFrame: 10, durationFrames: 20 }
    frozenAudio.sourceTimeMap = {
      sourceStartTicks: 10_000_000,
      sourceDurationTicks: 20_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 10, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    }
    const validAudio = clip(
      'audio-valid',
      'asset-valid',
      10,
      10,
      30,
      { linkGroupId: 'valid-link' },
    )
    const unavailableAudio = clip(
      'audio-unavailable',
      'asset-unavailable',
      10,
      10,
      30,
      { linkGroupId: 'unavailable-link' },
    )
    const videoFrom = (id: string): Clip => ({ ...frozenAudio, id })
    const project = doc([
      track('V-valid', 'video', [
        videoFrom('video-valid-from'),
        { ...validAudio, id: 'video-valid-to' },
      ], [transition('valid-transition', 'video-valid-from', 'video-valid-to', 4)]),
      track('V-unavailable', 'video', [
        videoFrom('video-unavailable-from'),
        { ...unavailableAudio, id: 'video-unavailable-to' },
      ], [transition(
        'unavailable-transition',
        'video-unavailable-from',
        'video-unavailable-to',
        4,
      )]),
      track('A-frozen', 'audio', [frozenAudio]),
      track('A-valid', 'audio', [validAudio]),
      track('A-unavailable', 'audio', [unavailableAudio]),
    ])
    const bounds = catalog([
      ['asset-frozen', exact([0, 100_000_000], [0, 100_000_000])],
      ['asset-valid', exact([0, 100_000_000], [0, 100_000_000])],
      ['asset-unavailable', {
        video: exact([0, 100_000_000]).video,
        audio: { status: 'unknown' },
      }],
    ])

    const sourceAware = createCrossfadeAudioWindowIndex(project, bounds)
    expect(sourceAware.get(frozenAudio.id)).toEqual({
      startFrame: 8,
      endFrame: 12,
    })
    expect(sourceAware.has(validAudio.id)).toBe(true)
    expect(sourceAware.has(unavailableAudio.id)).toBe(false)

    const sourceAgnostic = createCrossfadeAudioWindowIndex(project)
    expect(sourceAgnostic.has(frozenAudio.id)).toBe(true)
    expect(sourceAgnostic.has(validAudio.id)).toBe(true)
    expect(sourceAgnostic.has(unavailableAudio.id)).toBe(true)
  })

  test('reports exact audio capacity independently from visual capacity', () => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const dissolve = transition('av', from.id, to.id, 6)
    const project = doc([
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ])
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000], [0, 766_667])], // audio end frame 24
      ['asset-b', exact([0, 10_000_000], [933_333, 10_000_000])],
    ])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio).toEqual({
      status: 'unavailable',
      reason: 'duration-exceeds-audio-capacity',
      leg: null,
      maximumDurationFrames: 5,
    })
  })

  test('legacy unknown audio bounds preserve the visual plan and fail audio closed', () => {
    const from = clip('video-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const to = clip('video-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const audioFrom = clip('audio-from', 'asset-a', 0, 10, 10, { linkGroupId: 'g-a' })
    const audioTo = clip('audio-to', 'asset-b', 10, 10, 30, { linkGroupId: 'g-b' })
    const dissolve = transition('av', from.id, to.id, 4)
    const project = doc([
      track('V1', 'video', [from, to], [dissolve]),
      track('A1', 'audio', [audioFrom, audioTo]),
    ])
    const bounds = catalog([
      ['asset-a', {
        video: exact([0, 10_000_000]).video,
        audio: { status: 'unknown' },
      }],
      ['asset-b', exact([0, 10_000_000], [0, 10_000_000])],
    ])
    const resolved = resolveCrossfadePlan(project, 'V1', dissolve.id, bounds)
    expect(resolved.status).toBe('available')
    if (resolved.status !== 'available') return
    expect(resolved.plan.audio).toEqual({
      status: 'unavailable',
      reason: 'audio-source-bounds-unknown',
      leg: 'from',
      maximumDurationFrames: null,
    })
  })

  test('rejects malformed duplicate/overlapping definitions deterministically', () => {
    const a = clip('A', 'asset-a', 0, 10, 0)
    const b = clip('B', 'asset-b', 10, 10, 10)
    const c = clip('C', 'asset-c', 20, 10, 20)
    const first = transition('first', a.id, b.id, 15, false)
    const second = transition('second', b.id, c.id, 15, false)
    const project = doc([track('V1', 'video', [a, b, c], [first, second])])
    const bounds = catalog([
      ['asset-a', exact([0, 10_000_000])],
      ['asset-b', exact([0, 10_000_000])],
      ['asset-c', exact([0, 10_000_000])],
    ])
    expect(resolveCrossfadePlan(project, 'V1', first.id, bounds)).toEqual({
      status: 'invalid',
      reason: 'overlapping-transition',
    })

    project.tracks[0].transitions[1] = { ...second, id: first.id }
    expect(resolveCrossfadePlan(project, 'V1', first.id, bounds)).toEqual({
      status: 'invalid',
      reason: 'ambiguous-transition-id',
    })
  })

  test('evaluates authoring without mutation and reports same-seam rejection', () => {
    const fixture = visualFixture(4)
    const before = JSON.stringify(fixture.project)
    expect(evaluateCrossfadeDraft(
      fixture.project,
      'V1',
      fixture.from.id,
      fixture.to.id,
      4,
      fixture.bounds,
    )).toEqual({ status: 'invalid', reason: 'seam-already-has-transition' })
    expect(JSON.stringify(fixture.project)).toBe(before)

    fixture.project.tracks[0].transitions = []
    const withoutTransition = JSON.stringify(fixture.project)
    const unavailable = evaluateCrossfadeDraft(
      fixture.project,
      'V1',
      fixture.from.id,
      fixture.to.id,
      8,
      fixture.bounds,
    )
    expect(unavailable).toEqual({
      status: 'unavailable',
      reason: 'duration-exceeds-video-capacity',
      leg: null,
      maximumDurationFrames: 7,
    })
    expect(JSON.stringify(fixture.project)).toBe(withoutTransition)
  })

  test('evaluates a complete duration/audio replacement without mutation', () => {
    const fixture = visualFixture(4)
    const before = JSON.stringify(fixture.project)
    const updated = evaluateCrossfadeUpdate(
      fixture.project,
      'V1',
      'dissolve',
      3,
      fixture.bounds,
      { enabled: false, curve: 'linear' },
    )

    expect(updated).toMatchObject({
      status: 'available',
      plan: {
        durationFrames: 3,
        transition: {
          id: 'dissolve',
          durationFrames: 3,
          audio: { enabled: false, curve: 'linear' },
        },
        audio: { status: 'disabled' },
      },
    })
    expect(JSON.stringify(fixture.project)).toBe(before)
  })

  test('fails unsafe centered windows closed', () => {
    const from = clip('from', 'a', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const to = clip(
      'to',
      'b',
      Number.MAX_SAFE_INTEGER - 1,
      1,
      0,
    )
    const dissolve = transition(
      'unsafe',
      from.id,
      to.id,
      Number.MAX_SAFE_INTEGER,
      false,
    )
    const project = doc([track('V1', 'video', [from, to], [dissolve])])
    expect(resolveCrossfadePlan(project, 'V1', dissolve.id, new Map())).toEqual({
      status: 'invalid',
      reason: 'unsafe-window',
    })
  })
})
