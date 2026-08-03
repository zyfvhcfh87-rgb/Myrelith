import { describe, expect, test } from 'vitest'
import type {
  AssetId,
  Clip,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from './schema'
import type { SourceBoundsCatalog } from './crossfadePlan'
import {
  createTimelineAudioMixPlan,
  crossfadeAudioGain,
} from './audioMixPlan'

function clip(
  id: string,
  assetId: AssetId,
  timelineStart: number,
  duration: number,
  sourceStart: number,
  linkGroupId?: string,
  volume = 1,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
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
    opacity: 1,
    volume,
    effects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function track(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  transitions: Transition[] = [],
  flags: Partial<Pick<Track, 'muted' | 'solo'>> = {},
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions,
    hidden: false,
    muted: flags.muted ?? false,
    solo: flags.solo ?? false,
    locked: false,
  }
}

function exact(): MediaSourceBounds {
  return {
    video: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
    audio: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
  }
}

function fixture(options: {
  duration?: number
  curve?: Transition['audio']['curve']
  fromFlags?: Partial<Pick<Track, 'muted' | 'solo'>>
  toFlags?: Partial<Pick<Track, 'muted' | 'solo'>>
  fromVolume?: number
  toVolume?: number
} = {}): { doc: TimelineDoc; catalog: SourceBoundsCatalog } {
  const videoFrom = clip('video-from', 'video-from-asset', 10, 10, 30, 'from-link')
  const videoTo = clip('video-to', 'video-to-asset', 20, 10, 50, 'to-link')
  const audioFrom = clip(
    'audio-from',
    'audio-from-asset',
    10,
    10,
    30,
    'from-link',
    options.fromVolume,
  )
  const audioTo = clip(
    'audio-to',
    'audio-to-asset',
    20,
    10,
    50,
    'to-link',
    options.toVolume,
  )
  const transition: Transition = {
    id: 'crossfade',
    type: 'crossfade',
    fromClipId: videoFrom.id,
    toClipId: videoTo.id,
    durationFrames: options.duration ?? 5,
    audio: { enabled: true, curve: options.curve ?? 'equal-power' },
  }
  return {
    doc: {
      schemaVersion: 5,
      id: 'audio-plan-doc',
      name: 'Audio plan',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      tracks: [
        track('V1', 'video', [videoFrom, videoTo], [transition]),
        track('A-from', 'audio', [audioFrom], [], options.fromFlags),
        track('A-to', 'audio', [audioTo], [], options.toFlags),
      ],
    },
    catalog: new Map([
      ['video-from-asset', exact()],
      ['video-to-asset', exact()],
      ['audio-from-asset', exact()],
      ['audio-to-asset', exact()],
    ]),
  }
}

describe('timeline audio mix plan', () => {
  test('creates odd virtual handle legs without changing the document', () => {
    const input = fixture()
    const before = JSON.stringify(input.doc)
    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)

    expect(plan.clips).toEqual([
      {
        clipId: 'audio-from',
        trackId: 'A-from',
        assetId: 'audio-from-asset',
        timelineStartFrame: 10,
        timelineEndFrame: 23,
        sourceStartFrame: 30,
        sourceEndFrame: 43,
        volume: 1,
        balance: 0,
        leftGain: 1,
        rightGain: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        envelopes: [{
          transitionId: 'crossfade',
          startFrame: 18,
          endFrame: 23,
          role: 'from',
          curve: 'equal-power',
        }],
      },
      {
        clipId: 'audio-to',
        trackId: 'A-to',
        assetId: 'audio-to-asset',
        timelineStartFrame: 18,
        timelineEndFrame: 30,
        sourceStartFrame: 48,
        sourceEndFrame: 60,
        volume: 1,
        balance: 0,
        leftGain: 1,
        rightGain: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        envelopes: [{
          transitionId: 'crossfade',
          startFrame: 18,
          endFrame: 23,
          role: 'to',
          curve: 'equal-power',
        }],
      },
    ])
    expect(JSON.stringify(input.doc)).toBe(before)
  })

  test('retains the ordinary hard cut when linked audio is unavailable', () => {
    const input = fixture()
    const incompleteCatalog = new Map(input.catalog)
    incompleteCatalog.delete('audio-to-asset')

    expect(createTimelineAudioMixPlan(input.doc, incompleteCatalog).clips).toEqual([
      expect.objectContaining({
        clipId: 'audio-from',
        timelineStartFrame: 10,
        timelineEndFrame: 20,
        sourceStartFrame: 30,
        sourceEndFrame: 40,
        envelopes: [],
      }),
      expect.objectContaining({
        clipId: 'audio-to',
        timelineStartFrame: 20,
        timelineEndFrame: 30,
        sourceStartFrame: 50,
        sourceEndFrame: 60,
        envelopes: [],
      }),
    ])
  })

  test('applies canonical solo, mute, and volume selection before expansion', () => {
    const input = fixture({
      fromFlags: { solo: true },
      toFlags: { solo: true, muted: true },
      fromVolume: 0.35,
      toVolume: 0.8,
    })

    expect(createTimelineAudioMixPlan(input.doc, input.catalog).clips).toEqual([
      expect.objectContaining({
        clipId: 'audio-from',
        timelineEndFrame: 23,
        volume: 0.35,
        envelopes: [expect.objectContaining({ role: 'from' })],
      }),
    ])
  })

  test('excludes disabled clips and plans deterministic balance plus authored fades', () => {
    const input = fixture()
    input.doc.tracks[1].clips[0].audio = {
      enabled: true,
      balance: -0.25,
      fadeInFrames: 3,
      fadeOutFrames: 4,
    }
    input.doc.tracks[2].clips[0].audio = {
      enabled: false,
      balance: 0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    }

    expect(createTimelineAudioMixPlan(input.doc, input.catalog).clips).toEqual([
      expect.objectContaining({
        clipId: 'audio-from',
        balance: -0.25,
        leftGain: 1,
        rightGain: 0.75,
        fadeInFrames: 3,
        fadeOutFrames: 4,
      }),
    ])
  })
})

describe('crossfade audio gain', () => {
  test('evaluates both curves and clamps only the complete-window phase', () => {
    expect(crossfadeAudioGain('linear', 'from', 0.25)).toBe(0.75)
    expect(crossfadeAudioGain('linear', 'to', 0.25)).toBe(0.25)
    expect(crossfadeAudioGain('equal-power', 'from', 0.5)).toBeCloseTo(
      Math.SQRT1_2,
    )
    expect(crossfadeAudioGain('equal-power', 'to', 0.5)).toBeCloseTo(
      Math.SQRT1_2,
    )
    expect(crossfadeAudioGain('equal-power', 'from', -10)).toBe(1)
    expect(crossfadeAudioGain('equal-power', 'to', 10)).toBe(1)
    expect(() => crossfadeAudioGain('linear', 'from', Number.NaN)).toThrow(
      'must be finite',
    )
  })
})
