/**
 * domain/selectors.test.ts — Phase 3.2.
 */

import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  activeClipAt,
  audibleTracks,
  clipSourceFrame,
  docDurationFrames,
  findClip,
  outputMediaAssetIds,
  trackOfClip,
  tracksInDisplayOrder,
} from './selectors'
import { videoCompositionPlanAtFrame } from './videoCompositionPlan'

function makeClip(id: string, tlStart: number, duration: number, sourceStart = 0): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    ...overrides,
  }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 2,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
  }
}

describe('docDurationFrames', () => {
  test('empty project has zero duration', () => {
    expect(docDurationFrames(makeDoc([makeTrack('V1', 'video', [])]))).toBe(0)
  })

  test('duration is the furthest clip end across ALL tracks', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 100), makeClip('b', 150, 60)]), // ends 210
      makeTrack('A1', 'audio', [makeClip('c', 200, 100)]), // ends 300 ← winner
      makeTrack('V2', 'video', []),
    ])
    expect(docDurationFrames(doc)).toBe(300)
  })

  test('a lone clip starting late still defines the duration', () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 500, 10)])])
    expect(docDurationFrames(doc)).toBe(510)
  })
})

describe('activeClipAt', () => {
  const track = makeTrack('V1', 'video', [
    makeClip('a', 10, 20), // [10, 30)
    makeClip('b', 30, 15), // [30, 45) — touches a
    makeClip('c', 60, 10), // [60, 70) — gap [45, 60)
  ])

  test('start frame is inclusive, end frame is exclusive', () => {
    expect(activeClipAt(track, 10)?.id).toBe('a')
    expect(activeClipAt(track, 29)?.id).toBe('a')
    // 30 is a's exclusive end AND b's inclusive start: b owns it.
    expect(activeClipAt(track, 30)?.id).toBe('b')
    expect(activeClipAt(track, 44)?.id).toBe('b')
  })

  test('gaps, before-first and after-last are null', () => {
    expect(activeClipAt(track, 0)).toBeNull() // before first clip
    expect(activeClipAt(track, 45)).toBeNull() // gap start (b's exclusive end)
    expect(activeClipAt(track, 59)).toBeNull() // gap end
    expect(activeClipAt(track, 70)).toBeNull() // c's exclusive end = past the track
  })

  test('empty track yields null', () => {
    expect(activeClipAt(makeTrack('V2', 'video', []), 5)).toBeNull()
  })
})

describe('findClip', () => {
  test('finds clips on any track; unknown ids yield null', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 10)]),
      makeTrack('A1', 'audio', [makeClip('b', 5, 10)]),
    ])
    expect(findClip(doc, 'b')?.id).toBe('b')
    expect(findClip(doc, 'a')?.id).toBe('a')
    expect(findClip(doc, 'nope')).toBeNull()
  })
})

describe('tracksInDisplayOrder', () => {
  test('videos reversed (top composite layer first), then audios in order', () => {
    const v1 = makeTrack('V1', 'video', [])
    const v2 = makeTrack('V2', 'video', [])
    const a1 = makeTrack('A1', 'audio', [])
    const a2 = makeTrack('A2', 'audio', [])
    const doc = makeDoc([v1, v2, a1, a2])
    // V2 composites ABOVE V1 (later in the array), so it displays on top.
    expect(tracksInDisplayOrder(doc)).toEqual([v2, v1, a1, a2])
    // Same references, pure reordering; the doc array is untouched.
    expect(tracksInDisplayOrder(doc)[0]).toBe(v2)
    expect(doc.tracks).toEqual([v1, v2, a1, a2])
  })

  test('interleaved kinds are grouped: all videos first, then all audios', () => {
    const v1 = makeTrack('V1', 'video', [])
    const a1 = makeTrack('A1', 'audio', [])
    const v2 = makeTrack('V2', 'video', [])
    expect(tracksInDisplayOrder(makeDoc([v1, a1, v2]))).toEqual([v2, v1, a1])
  })

  test('empty doc yields an empty array', () => {
    expect(tracksInDisplayOrder(makeDoc([]))).toEqual([])
  })
})

describe('trackOfClip', () => {
  test('finds the owning track on any lane; unknown clips yield null', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 10)]),
      makeTrack('A1', 'audio', [makeClip('b', 5, 10)]),
    ])
    expect(trackOfClip(doc, 'a')?.id).toBe('V1')
    expect(trackOfClip(doc, 'b')?.kind).toBe('audio')
    expect(trackOfClip(doc, 'nope')).toBeNull()
  })
})

describe('audibleTracks', () => {
  const flagged = (id: string, flags: Partial<Track> = {}): Track => ({
    ...makeTrack(id, 'audio', []),
    ...flags,
  })

  test('with no solo anywhere, every unmuted audio track is audible', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', []),
      flagged('A1'),
      flagged('A2', { muted: true }),
      flagged('A3'),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1', 'A3'])
  })

  test('one solo track silences every non-solo audio track', () => {
    const doc = makeDoc([flagged('A1'), flagged('A2', { solo: true }), flagged('A3')])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A2'])
  })

  test('several solo tracks are audible together', () => {
    const doc = makeDoc([
      flagged('A1', { solo: true }),
      flagged('A2'),
      flagged('A3', { solo: true }),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1', 'A3'])
  })

  test('mute wins over solo on the same track', () => {
    const doc = makeDoc([flagged('A1', { solo: true, muted: true }), flagged('A2')])
    // A1 is solo (so A2 is silenced) but also muted — nothing plays.
    expect(audibleTracks(doc)).toEqual([])
  })

  test('video tracks are never in the mix set, whatever their flags', () => {
    const doc = makeDoc([
      { ...makeTrack('V1', 'video', []), solo: true },
      flagged('A1'),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1'])
  })
})

describe('outputMediaAssetIds', () => {
  test('includes only sources that can contribute to the exported output', () => {
    const visible = { ...makeClip('visible', 0, 10), assetId: 'video-visible' }
    const transparent = {
      ...makeClip('transparent', 10, 10),
      assetId: 'video-transparent',
      opacity: 0,
    }
    const text = {
      ...makeClip('title', 20, 10),
      assetId: 'text-asset',
      text: {
        content: 'Title',
        fontFamily: 'sans-serif',
        fontSizePx: 48,
        color: '#fff',
        align: 'center' as const,
        bold: false,
        italic: false,
      },
    }
    const soloAudio = {
      ...makeClip('solo-audio', 0, 10),
      assetId: 'audio-solo',
    }
    const zeroVolume = {
      ...makeClip('silent', 10, 10),
      assetId: 'audio-silent',
      volume: 0,
    }
    const doc = makeDoc([
      makeTrack('V1', 'video', [visible, transparent, text]),
      makeTrack('V2', 'video', [
        { ...makeClip('hidden', 0, 10), assetId: 'video-hidden' },
      ], { hidden: true }),
      makeTrack('A1', 'audio', [
        { ...makeClip('not-solo', 0, 10), assetId: 'audio-not-solo' },
      ]),
      makeTrack('A2', 'audio', [soloAudio, zeroVolume], { solo: true }),
    ])

    expect([...outputMediaAssetIds(doc)]).toEqual([
      'video-visible',
      'audio-solo',
    ])
    expect([...outputMediaAssetIds(doc, false)]).toEqual([
      'video-visible',
    ])
  })
})

describe('clipSourceFrame', () => {
  test('untrimmed clip maps its start to source frame 0', () => {
    const clip = makeClip('a', 100, 50)
    expect(clipSourceFrame(clip, 100)).toBe(0)
    expect(clipSourceFrame(clip, 149)).toBe(49)
  })

  test('trimmed clip offsets into the source', () => {
    // Clip shows source frames [30, 80) at timeline [100, 150).
    const clip = makeClip('a', 100, 50, 30)
    expect(clipSourceFrame(clip, 100)).toBe(30)
    expect(clipSourceFrame(clip, 110)).toBe(40)
    expect(clipSourceFrame(clip, 149)).toBe(79)
  })

  test('every timeline frame of a still resolves to its sole source frame', () => {
    const clip = {
      ...makeClip('still', 100, 500),
      sourceMode: 'still' as const,
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }
    expect(clipSourceFrame(clip, 100)).toBe(0)
    expect(clipSourceFrame(clip, 350)).toBe(0)
    expect(clipSourceFrame(clip, 599)).toBe(0)
  })
})

describe('videoCompositionPlanAtFrame', () => {
  const from = makeClip('from', 10, 10, 100)
  const to = makeClip('to', 20, 10, 200)
  const transition = {
    id: 'transition',
    type: 'crossfade' as const,
    fromClipId: from.id,
    toClipId: to.id,
    durationFrames: 3,
    audio: { enabled: true, curve: 'equal-power' as const },
  }
  const transitionTrack = makeTrack('V1', 'video', [from, to], {
    transitions: [transition],
  })

  const summary = (doc: TimelineDoc, frame: number) => {
    const catalog = new Map([
      ['asset-1', {
        video: {
          status: 'exact' as const,
          firstTimestampUs: 0,
          endTimestampUs: 1_000_000_000,
        },
        audio: null,
      }],
    ])
    return videoCompositionPlanAtFrame(doc, frame, catalog).items.flatMap<{
      id: string
      sourceFrame: number
      opacity: number
      weight: number | null
    }>(
      (item) => item.kind === 'clip'
        ? [{
            id: item.request.clip.id,
            sourceFrame: item.request.sourceFrame,
            opacity: item.request.opacity,
            weight: null,
          }]
        : item.requests
            .filter((request) => request.opacity > 0 && request.weight > 0)
            .map((request) => ({
              id: request.clip.id,
              sourceFrame: request.sourceFrame,
              opacity: request.opacity,
              weight: request.weight,
            })),
    )
  }

  test('uses one centered real-handle render plan across the full boundary', () => {
    const doc = makeDoc([transitionTrack])

    expect(summary(doc, 18)).toEqual([
      { id: 'from', sourceFrame: 108, opacity: 1, weight: null },
    ])
    expect(summary(doc, 19)).toEqual([
      { id: 'from', sourceFrame: 109, opacity: 1, weight: 0.75 },
      { id: 'to', sourceFrame: 199, opacity: 1, weight: 0.25 },
    ])
    expect(summary(doc, 20)).toEqual([
      { id: 'from', sourceFrame: 110, opacity: 1, weight: 0.5 },
      { id: 'to', sourceFrame: 200, opacity: 1, weight: 0.5 },
    ])
    expect(summary(doc, 21)).toEqual([
      { id: 'from', sourceFrame: 111, opacity: 1, weight: 0.25 },
      { id: 'to', sourceFrame: 201, opacity: 1, weight: 0.75 },
    ])
    expect(summary(doc, 22)).toEqual([
      { id: 'to', sourceFrame: 202, opacity: 1, weight: null },
    ])
  })

  test('a one-frame transition produces one exact midpoint blend', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [{ ...transition, durationFrames: 1 }],
      }),
    ])

    expect(summary(doc, 20)).toEqual([
      { id: 'from', sourceFrame: 110, opacity: 1, weight: 0.5 },
      { id: 'to', sourceFrame: 200, opacity: 1, weight: 0.5 },
    ])
  })

  test('stills hold source frame 0 through both sides of a transition window', () => {
    const stillFrom = {
      ...from,
      sourceMode: 'still' as const,
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }
    const stillTo = {
      ...to,
      sourceMode: 'still' as const,
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }
    const doc = makeDoc([
      makeTrack('V1', 'video', [stillFrom, stillTo], {
        transitions: [transition],
      }),
    ])

    expect(summary(doc, 19)).toEqual([
      { id: 'from', sourceFrame: 0, opacity: 1, weight: 0.75 },
      { id: 'to', sourceFrame: 0, opacity: 1, weight: 0.25 },
    ])
    expect(summary(doc, 20)).toEqual([
      { id: 'from', sourceFrame: 0, opacity: 1, weight: 0.5 },
      { id: 'to', sourceFrame: 0, opacity: 1, weight: 0.5 },
    ])
    expect(summary(doc, 21)).toEqual([
      { id: 'from', sourceFrame: 0, opacity: 1, weight: 0.25 },
      { id: 'to', sourceFrame: 0, opacity: 1, weight: 0.75 },
    ])
  })

  test('keeps intrinsic opacities separate from transition weights', () => {
    const fadedFrom = { ...from, opacity: 0.5 }
    const fadedTo = { ...to, opacity: 0.25 }
    const doc = makeDoc([
      makeTrack('V1', 'video', [fadedFrom, fadedTo], {
        transitions: [{ ...transition, durationFrames: 1 }],
      }),
    ])
    expect(summary(doc, 20)).toEqual([
      { id: 'from', sourceFrame: 110, opacity: 0.5, weight: 0.5 },
      { id: 'to', sourceFrame: 200, opacity: 0.25, weight: 0.5 },
    ])
  })

  test('skips hidden, audio, text, and zero-opacity media in the canonical plan', () => {
    const text = {
      content: 'title',
      fontFamily: 'sans-serif',
      fontSizePx: 40,
      color: '#fff',
      align: 'center' as const,
      bold: false,
      italic: false,
    }
    const doc = makeDoc([
      makeTrack('hidden', 'video', [from], { hidden: true }),
      makeTrack('audio', 'audio', [from]),
      makeTrack('text', 'video', [{ ...from, text }]),
      makeTrack('zero', 'video', [{ ...from, opacity: 0 }]),
    ])

    expect(summary(doc, 15)).toEqual([])
  })

  test('malformed or ambiguous transitions deterministically fall back to the hard cut', () => {
    const middle = makeClip('middle', 20, 5, 300)
    const later = makeClip('later', 25, 10, 400)
    const cases: Array<{ track: Track; frame: number }> = [
      {
        track: makeTrack('V1', 'video', [from, to], {
          transitions: [{ ...transition, durationFrames: 0 }],
        }),
        frame: 20,
      },
      {
        track: makeTrack('V1', 'video', [from, to], {
          transitions: [{ ...transition, toClipId: 'missing' }],
        }),
        frame: 20,
      },
      {
        track: makeTrack('V1', 'video', [from, middle, later], {
          transitions: [{ ...transition, toClipId: later.id }],
        }),
        frame: 25,
      },
      {
        track: makeTrack('V1', 'video', [from, { ...to, timelineRange: {
          ...to.timelineRange,
          startFrame: 21,
        } }], { transitions: [transition] }),
        frame: 21,
      },
      {
        track: makeTrack('V1', 'video', [from, to], {
          transitions: [{ ...transition, durationFrames: 30 }],
        }),
        frame: 20,
      },
      {
        track: makeTrack('V1', 'video', [from, to], {
          transitions: [transition, { ...transition, id: 'duplicate' }],
        }),
        frame: 20,
      },
    ]

    for (const { track, frame } of cases) {
      const withTransition = summary(makeDoc([track]), frame)
      const hardCut = summary(
        makeDoc([{ ...track, transitions: [] }]),
        frame,
      )
      expect(withTransition).toEqual(hardCut)
    }
  })

  test('invalidates partially overlapping transition windows for their full duration', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [from, to], {
        transitions: [
          transition,
          { ...transition, id: 'wider', durationFrames: 5 },
        ],
      }),
    ])
    const hardCutDoc = makeDoc([
      { ...transitionTrack, transitions: [] },
    ])

    for (const frame of [18, 19, 20, 21, 22]) {
      expect(summary(doc, frame)).toEqual(summary(hardCutDoc, frame))
    }
  })

  test('fails closed for duplicate transition ids on the same track', () => {
    const clips = [
      makeClip('A', 0, 10),
      makeClip('B', 10, 10),
      makeClip('C', 20, 10),
      makeClip('D', 30, 10),
    ]
    const track = makeTrack('V1', 'video', clips, {
      transitions: [
        {
          id: 'duplicate-id',
          type: 'crossfade',
          fromClipId: 'A',
          toClipId: 'B',
          durationFrames: 3,
          audio: { enabled: true, curve: 'equal-power' },
        },
        {
          id: 'duplicate-id',
          type: 'crossfade',
          fromClipId: 'C',
          toClipId: 'D',
          durationFrames: 3,
          audio: { enabled: true, curve: 'equal-power' },
        },
      ],
    })
    const withDuplicates = makeDoc([track])
    const hardCuts = makeDoc([{ ...track, transitions: [] }])

    expect(summary(withDuplicates, 10)).toEqual(summary(hardCuts, 10))
    expect(summary(withDuplicates, 30)).toEqual(summary(hardCuts, 30))
  })
})
