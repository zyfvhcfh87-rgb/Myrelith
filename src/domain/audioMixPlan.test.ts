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
  createConstantRateAudioStretch,
  createTimelineAudioMixPlan,
  crossfadeAudioGain,
  isRampedAudioClipPlan,
  isStretchedAudioClipPlan,
  writeClipAudioGainsAtLocalFrame,
} from './audioMixPlan'
import { sourceTimeAudioPolicy } from './sourceTimeMap'

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
      schemaVersion: 19,
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

function setDoubleSpeed(target: Clip): void {
  target.sourceRange = {
    startFrame: target.sourceRange.startFrame,
    durationFrames: target.timelineRange.durationFrames * 2,
  }
  target.sourceTimeMap = {
    sourceStartTicks: target.sourceRange.startFrame * 1_000_000,
    sourceDurationTicks: target.sourceRange.durationFrames * 1_000_000,
    rate: { numerator: 2, denominator: 1 },
  }
}

describe('timeline audio mix plan', () => {
  test('plans a stretched 2x outgoing handle after envelope expansion', () => {
    const input = fixture()
    setDoubleSpeed(input.doc.tracks[1].clips[0])

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const stretched = plan.clips.find((item) => item.clipId === 'audio-from')

    expect(stretched).toEqual({
      clipId: 'audio-from',
      trackId: 'A-from',
      assetId: 'audio-from-asset',
      timelineStartFrame: 10,
      timelineEndFrame: 23,
      sourceStartFrame: 30,
      sourceEndFrame: 56,
      volume: 1,
      balance: 0,
      leftGain: 1,
      rightGain: 1,
      clipTimelineStartFrame: 10,
      volumeAnimation: null,
      balanceAnimation: null,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      envelopes: [{
        transitionId: 'crossfade',
        startFrame: 18,
        endFrame: 23,
        role: 'from',
        curve: 'equal-power',
      }],
      audioEffects: [],
      stretch: {
        rate: { numerator: 2, denominator: 1 },
        sourceStartTicks: 30_000_000,
        sourceEndTicks: 56_000_000,
      },
    })
    expect(stretched && isStretchedAudioClipPlan(stretched)).toBe(true)
    expect(plan.mutedClips.map((item) => item.clipId)).not.toContain('audio-from')
  })

  test('maps an isolated 2x clip window into its exact stretch descriptor', () => {
    const input = fixture()
    input.doc.tracks[0].transitions = []
    setDoubleSpeed(input.doc.tracks[1].clips[0])

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const stretched = plan.clips.find((item) => item.clipId === 'audio-from')

    expect(stretched).toMatchObject({
      timelineStartFrame: 10,
      timelineEndFrame: 20,
      sourceStartFrame: 30,
      sourceEndFrame: 50,
      stretch: {
        rate: { numerator: 2, denominator: 1 },
        sourceStartTicks: 30_000_000,
        sourceEndTicks: 50_000_000,
      },
    })
  })

  test('rejects invalid constant-rate stretch descriptors', () => {
    const input = fixture()
    const target = input.doc.tracks[1].clips[0]
    setDoubleSpeed(target)
    const policy = sourceTimeAudioPolicy(target)
    if (policy.status !== 'supported' || policy.kind !== 'stretched') {
      throw new Error('Expected a constant stretch policy')
    }
    const rate = policy.rate

    expect(() => createConstantRateAudioStretch(
      { ...rate, numerator: rate.denominator },
      0,
      1,
    )).toThrow(/unity/)
    expect(() => createConstantRateAudioStretch(rate, 5, 5)).toThrow(/non-empty/)
    expect(() => createConstantRateAudioStretch(rate, 6, 5)).toThrow(/ordered/)
    expect(() => createConstantRateAudioStretch(rate, -1, 5)).toThrow(/non-negative/)
    expect(() => createConstantRateAudioStretch(
      rate,
      0,
      Number.MAX_SAFE_INTEGER + 1,
    )).toThrow(/safe integers/)
  })

  test('emits one exact bounded ramp descriptor after envelope expansion', () => {
    const input = fixture()
    const target = input.doc.tracks[1].clips[0]
    target.sourceRange.durationFrames = 13
    target.sourceTimeMap = {
      sourceStartTicks: 30_000_000,
      sourceDurationTicks: 13_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
          { frame: 4, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 6, rate: { numerator: 2, denominator: 1 }, easing: 'linear' },
          { frame: 10, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    }

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const ramped = plan.clips.find((item) => item.clipId === 'audio-from')

    expect(ramped).toMatchObject({
      timelineStartFrame: 10,
      timelineEndFrame: 23,
      clipTimelineStartFrame: 10,
      sourceStartFrame: 30,
      sourceEndFrame: 43,
      ramp: {
        sourceStartTicks: 30_000_000,
        sourceEndTicks: 43_000_000,
        silenceRanges: [{ startFrame: 14, endFrame: 16 }],
        silent: false,
        sourceTimeMap: target.sourceTimeMap,
      },
    })
    expect(ramped && isRampedAudioClipPlan(ramped)).toBe(true)
    expect(plan.mutedClips.map((item) => item.clipId)).not.toContain('audio-from')
  })

  test('keeps a freeze map audible outside its explicit silence span', () => {
    const input = fixture()
    input.doc.tracks[1].clips[0].sourceTimeMap = {
      sourceStartTicks: 30_000_000,
      sourceDurationTicks: 10_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 4, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    }

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const ramped = plan.clips.find((item) => item.clipId === 'audio-from')

    expect(ramped && isRampedAudioClipPlan(ramped)).toBe(true)
    expect(ramped).toMatchObject({
      ramp: {
        silenceRanges: [{ startFrame: 10, endFrame: 14 }],
        silent: false,
      },
    })
    expect(plan.mutedClips.map((item) => item.clipId)).not.toContain('audio-from')
  })

  test('represents an entirely frozen window as decoder-free silence', () => {
    const input = fixture()
    const target = input.doc.tracks[1].clips[0]
    target.sourceTimeMap = {
      sourceStartTicks: 30_000_000,
      sourceDurationTicks: 10_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 13, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    }

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const ramped = plan.clips.find((item) => item.clipId === 'audio-from')

    expect(ramped).toMatchObject({
      sourceStartFrame: 30,
      sourceEndFrame: 30,
      ramp: {
        sourceStartTicks: 30_000_000,
        sourceEndTicks: 30_000_000,
        silenceRanges: [{ startFrame: 10, endFrame: 23 }],
        silent: true,
      },
    })
  })

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
        clipTimelineStartFrame: 10,
        sourceStartFrame: 30,
        sourceEndFrame: 43,
        volume: 1,
        balance: 0,
        leftGain: 1,
        rightGain: 1,
        volumeAnimation: null,
        balanceAnimation: null,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        envelopes: [{
          transitionId: 'crossfade',
          startFrame: 18,
          endFrame: 23,
          role: 'from',
          curve: 'equal-power',
        }],
        audioEffects: [],
      },
      {
        clipId: 'audio-to',
        trackId: 'A-to',
        assetId: 'audio-to-asset',
        timelineStartFrame: 18,
        timelineEndFrame: 30,
        clipTimelineStartFrame: 20,
        sourceStartFrame: 48,
        sourceEndFrame: 60,
        volume: 1,
        balance: 0,
        leftGain: 1,
        rightGain: 1,
        volumeAnimation: null,
        balanceAnimation: null,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        envelopes: [{
          transitionId: 'crossfade',
          startFrame: 18,
          endFrame: 23,
          role: 'to',
          curve: 'equal-power',
        }],
        audioEffects: [],
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

  test('includes a silent clip when volume keys become audible', () => {
    const input = fixture({ fromVolume: 0 })
    input.doc.tracks[1].clips[0].animation = {
      tracks: [{
        property: 'volume',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: 8, value: 1, easing: { type: 'linear' } },
        ],
      }],
      effectTracks: [],
    }

    const planned = createTimelineAudioMixPlan(input.doc, input.catalog).clips
      .find((item) => item.clipId === 'audio-from')

    expect(planned?.volume).toBe(0)
    expect(planned?.volumeAnimation?.keyframes).toHaveLength(2)
  })

  test('writes animated clip gains into caller-owned audio-rate scratch state', () => {
    const gains = { volume: 0, balance: 0, leftGain: 0, rightGain: 0 }
    const identity = gains
    writeClipAudioGainsAtLocalFrame({
      volume: 0,
      balance: 0,
      volumeAnimation: {
        property: 'volume',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: 2, value: 1, easing: { type: 'linear' } },
        ],
      },
      balanceAnimation: {
        property: 'balance',
        keyframes: [
          { frame: 0, value: -1, easing: { type: 'linear' } },
          { frame: 2, value: 1, easing: { type: 'linear' } },
        ],
      },
    }, 1, gains)

    expect(gains).toBe(identity)
    expect(gains).toEqual({ volume: 0.5, balance: 0, leftGain: 1, rightGain: 1 })
  })

  test('rejects invalid audio animation once at the planning boundary', () => {
    const input = fixture()
    input.doc.tracks[1].clips[0].animation = {
      tracks: [{
        property: 'volume',
        keyframes: [
          { frame: 0, value: 1, easing: { type: 'linear' } },
          { frame: 8, value: 3, easing: { type: 'linear' } },
        ],
      }],
      effectTracks: [],
    }

    expect(() => createTimelineAudioMixPlan(input.doc, input.catalog))
      .toThrow(/volume animation: volume keyframe value must be from 0 to 2/)
  })

  test('includes track and master mixer buses with authored gains', () => {
    const input = fixture()
    input.doc.tracks[1].volume = 0.5
    input.doc.tracks[1].balance = -1
    input.doc.tracks[2].muted = true
    input.doc.masterAudio = { volume: 0.8, balance: 1, muted: false }

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)

    expect(plan.tracks).toEqual([
      {
        trackId: 'A-from',
        volume: 0.5,
        balance: -1,
        leftGain: 1,
        rightGain: 0,
        audioEffects: [],
      },
      {
        trackId: 'A-to',
        volume: 1,
        balance: 0,
        leftGain: 1,
        rightGain: 1,
        audioEffects: [],
      },
    ])
    expect(plan.master).toEqual({
      volume: 0.8,
      balance: 1,
      leftGain: 0,
      rightGain: 1,
      muted: false,
      audioEffects: [],
    })
    expect(plan.clips.some((item) => item.trackId === 'A-to')).toBe(false)
  })

  test('attaches clip, track, and master audio-effect stacks to the mix plan', () => {
    const input = fixture()
    const clipEffect = {
      id: 'afx-clip',
      type: 'builtin.eq',
      version: 1,
      enabled: true,
      params: { band1Gain: 0 },
    }
    const trackEffect = {
      id: 'afx-track',
      type: 'builtin.compressor',
      version: 1,
      enabled: true,
      params: { ratio: 1 },
    }
    const masterEffect = {
      id: 'afx-master',
      type: 'builtin.limiter',
      version: 1,
      enabled: true,
      params: { ceilingDb: 0 },
    }
    input.doc.tracks[1].clips[0].audioEffects = [clipEffect]
    input.doc.tracks[1].audioEffects = [trackEffect]
    input.doc.masterAudio = {
      volume: 1,
      balance: 0,
      muted: false,
      audioEffects: [masterEffect],
    }

    const plan = createTimelineAudioMixPlan(input.doc, input.catalog)
    const clipPlan = plan.clips.find((item) => item.clipId === input.doc.tracks[1].clips[0].id)

    expect(clipPlan?.audioEffects).toEqual([clipEffect])
    expect(plan.tracks.find((item) => item.trackId === 'A-from')?.audioEffects).toEqual([
      trackEffect,
    ])
    expect(plan.master.audioEffects).toEqual([masterEffect])
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
