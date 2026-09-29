import { describe, expect, test } from 'vitest'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import type { SourceMonitorSession } from '../domain/sourceMonitor'
import { sourceReviewDocument } from './sourceReviewDocument'

function session(kind: 'video' | 'image' | 'audio'): SourceMonitorSession {
  return {
    source: {
      assetId: 'asset-1',
      kind,
      fileName: 'take.mov',
      rate: { num: 30, den: 1 },
      durationFrames: 90,
      hasAudio: kind !== 'image',
    },
    playheadFrame: 12,
    inFrame: null,
    outFrameExclusive: null,
    shuttleStep: 0,
  }
}

const asset = {
  width: 1280,
  height: 720,
  audioSampleRate: 44_100,
} as MediaAsset

const transform = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
}

function expectedDoc(tracks: unknown[], audioSampleRate = 48_000) {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'source-review:asset-1',
    name: 'take.mov',
    frameRate: { num: 30, den: 1 },
    width: 1280,
    height: 720,
    audioSampleRate,
    tracks,
  }
}

function expectedTrack(
  kind: 'video' | 'audio',
  sourceMode: 'still' | 'timed',
  sourceDurationFrames: number,
) {
  return {
    id: kind === 'audio' ? 'source-review-A1' : 'source-review-V1',
    kind,
    name: 'Source',
    clips: [{
      id: kind === 'audio' ? 'source-review-audio' : 'source-review-clip',
      assetId: 'asset-1',
      name: 'take.mov',
      sourceMode,
      sourceRange: { startFrame: 0, durationFrames: sourceDurationFrames },
      timelineRange: { startFrame: 0, durationFrames: 90 },
      transform,
      opacity: 1,
      volume: 1,
      effects: [],
    }],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

describe('sourceReviewDocument', () => {
  test('builds one timed visual track for a video source', () => {
    expect(sourceReviewDocument(session('video'), asset, 'video')).toStrictEqual(
      expectedDoc([expectedTrack('video', 'timed', 90)]),
    )
  })

  test('holds one still frame across the source duration for an image', () => {
    expect(sourceReviewDocument(session('image'), asset, 'video')).toStrictEqual(
      expectedDoc([expectedTrack('video', 'still', 1)]),
    )
  })

  test('leaves an audio-only source without a visual track', () => {
    expect(sourceReviewDocument(session('audio'), asset, 'video')).toStrictEqual(
      expectedDoc([]),
    )
  })

  test('auditions the source on one timed audio track at its sample rate', () => {
    expect(sourceReviewDocument(session('video'), asset, 'audio')).toStrictEqual(
      expectedDoc([expectedTrack('audio', 'timed', 90)], 44_100),
    )
  })

  test('falls back to 1080p and 48 kHz without connected facts', () => {
    const offline = sourceReviewDocument(session('video'), undefined, 'audio')
    expect(offline).toMatchObject({ width: 1920, height: 1080, audioSampleRate: 48_000 })
    const noRate = sourceReviewDocument(
      session('video'),
      { ...asset, audioSampleRate: null },
      'audio',
    )
    expect(noRate.audioSampleRate).toBe(48_000)
  })

  test('gives every document its own mutable clip transform', () => {
    const first = sourceReviewDocument(session('video'), asset, 'video')
    const second = sourceReviewDocument(session('video'), asset, 'video')
    expect(first.tracks[0].clips[0].transform)
      .not.toBe(second.tracks[0].clips[0].transform)
    expect(Object.isFrozen(first.tracks[0].clips[0].transform)).toBe(false)
  })
})
