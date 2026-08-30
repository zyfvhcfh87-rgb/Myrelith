import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  resolveTimelineSnap,
  timelineSnapCandidates,
  timelineSnapThresholdFrames,
  type TimelineSnapMovingPoint,
} from './timelineSnapping'

function clip(id: string, startFrame: number, durationFrames = 20): Clip {
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
    blendMode: 'normal',
    volume: 1,
    effects: [],
  }
}

function track(
  id: string,
  clips: Clip[],
  patch: Partial<Track> = {},
): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    ...patch,
  }
}

function doc(): TimelineDoc {
  const from = clip('from', 100, 20)
  const to = clip('to', 120, 20)
  return {
    schemaVersion: 15,
    id: 'snap-doc',
    name: 'snap doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [
      { id: 'm-b', frame: 205, label: 'Second', color: 'blue' },
      { id: 'm-a', frame: 205, label: 'First', color: 'yellow' },
    ],
    captionTracks: [],
    tracks: [
      track('V1', [from, to], {
        transitions: [{
          id: 'xf',
          type: 'crossfade',
          fromClipId: 'from',
          toClipId: 'to',
          durationFrames: 10,
          audio: { enabled: false, curve: 'equal-power' },
        }],
      }),
      track('V2', [clip('hidden', 300)], { hidden: true }),
      track('V3', [clip('locked', 400)], { locked: true }),
      track('A1', [clip('audio', 500)], { kind: 'audio' }),
    ],
  }
}

function point(
  frame: number,
  patch: Partial<TimelineSnapMovingPoint> = {},
): TimelineSnapMovingPoint {
  return {
    id: 'moving:start',
    kind: 'start',
    frame,
    deltaDirection: 1,
    trackKind: 'video',
    trackIndex: 0,
    ...patch,
  }
}

describe('timeline snapping', () => {
  test('collects playhead, sorted markers, eligible clip edges, and valid transition edges', () => {
    const candidates = timelineSnapCandidates(doc(), { playheadFrame: 90 })
    expect(candidates.map((candidate) => [candidate.kind, candidate.frame])).toEqual([
      ['playhead', 90],
      ['marker', 205],
      ['marker', 205],
      ['clip-start', 100],
      ['clip-end', 120],
      ['clip-start', 120],
      ['clip-end', 140],
      ['transition-start', 115],
      ['transition-end', 125],
      ['clip-start', 500],
      ['clip-end', 520],
    ])
  })

  test('excludes every gesture member and transitions attached to it', () => {
    const candidates = timelineSnapCandidates(doc(), {
      excludedClipIds: new Set(['from']),
    })
    expect(candidates.some((candidate) => candidate.id.includes('from'))).toBe(false)
    expect(candidates.some((candidate) => candidate.id.includes('xf'))).toBe(false)
  })

  test('keeps one stable pixel threshold across zoom', () => {
    expect(timelineSnapThresholdFrames(2)).toBe(4)
    expect(timelineSnapThresholdFrames(0.5)).toBe(16)
    expect(timelineSnapThresholdFrames(16)).toBe(0)

    const candidate = timelineSnapCandidates(doc(), { playheadFrame: 100 })[0]
    expect(resolveTimelineSnap({
      candidates: [candidate],
      movingPoints: [point(96)],
      rawDeltaFrames: 6,
      zoom: 2,
    }).deltaFrames).toBe(10)
    expect(resolveTimelineSnap({
      candidates: [candidate],
      movingPoints: [point(95)],
      rawDeltaFrames: 5,
      zoom: 2,
    }).guide).toBeNull()
  })

  test('uses deterministic source, frame, track, id, and moving-edge ties', () => {
    const candidates = timelineSnapCandidates(doc(), { playheadFrame: 205 })
    const resolution = resolveTimelineSnap({
      candidates,
      movingPoints: [point(200), point(210, { id: 'moving:end', kind: 'end' })],
      rawDeltaFrames: 0,
      zoom: 1,
    })
    expect(resolution.correctionFrames).toBe(5)
    expect(resolution.guide).toMatchObject({
      candidateKind: 'marker',
      candidateId: 'marker:m-a',
      frame: 205,
    })
  })

  test('rejects wrong-kind track candidates but keeps sequence-wide targets', () => {
    const candidates = timelineSnapCandidates(doc(), { playheadFrame: 499 })
    const audioEdge = candidates.find((candidate) => candidate.id.includes('audio'))!
    const playhead = candidates.find((candidate) => candidate.kind === 'playhead')!
    const resolution = resolveTimelineSnap({
      candidates: [audioEdge, playhead],
      movingPoints: [point(498)],
      rawDeltaFrames: 0,
      zoom: 1,
    })
    expect(resolution.guide?.candidateKind).toBe('playhead')
  })

  test('never snaps outside the caller-proven legal interval', () => {
    const candidate = timelineSnapCandidates(doc(), { playheadFrame: 90 })[0]
    expect(resolveTimelineSnap({
      candidates: [candidate],
      movingPoints: [point(92)],
      rawDeltaFrames: -8,
      minDeltaFrames: -5,
      maxDeltaFrames: 10,
      zoom: 1,
    })).toMatchObject({ deltaFrames: -8, guide: null })
  })
})
