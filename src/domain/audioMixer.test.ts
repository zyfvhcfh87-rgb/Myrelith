import { describe, expect, test } from 'vitest'
import {
  DEFAULT_MASTER_AUDIO,
  masterAudioSettings,
  mixerGains,
  timelineAudioMixerGraph,
  trackBalance,
  trackVolume,
} from './audioMixer'
import type { TimelineDoc, Track } from './schema'

function track(id: string, kind: Track['kind'], extra: Partial<Track> = {}): Track {
  return {
    id,
    kind,
    name: id,
    clips: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    ...extra,
  }
}

function doc(tracks: Track[], masterAudio?: TimelineDoc['masterAudio']): TimelineDoc {
  return {
    schemaVersion: 16,
    id: 'mixer-doc',
    name: 'Mixer',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
    ...(masterAudio === undefined ? {} : { masterAudio }),
  }
}

describe('audio mixer defaults', () => {
  test('missing track and master fields fall back to unity', () => {
    const audio = track('A1', 'audio')
    const document = doc([track('V1', 'video'), audio])
    expect(trackVolume(audio)).toBe(1)
    expect(trackBalance(audio)).toBe(0)
    expect(masterAudioSettings(document)).toEqual(DEFAULT_MASTER_AUDIO)
  })

  test('balance 0 keeps both channels; left/right attenuate the opposite side', () => {
    expect(mixerGains(1, 0)).toEqual({
      volume: 1,
      balance: 0,
      leftGain: 1,
      rightGain: 1,
    })
    expect(mixerGains(0.5, -1)).toEqual({
      volume: 0.5,
      balance: -1,
      leftGain: 1,
      rightGain: 0,
    })
    expect(mixerGains(1, 1).leftGain).toBe(0)
  })

  test('graph lists every audio track, including muted ones', () => {
    const graph = timelineAudioMixerGraph(doc([
      track('V1', 'video', { volume: 0.2 }),
      track('A1', 'audio', { volume: 0.5, balance: 0.5, muted: true }),
      track('A2', 'audio'),
    ], { volume: 1.25, balance: 0, muted: false }))

    expect(graph.tracks).toEqual([
      { trackId: 'A1', volume: 0.5, balance: 0.5, leftGain: 0.5, rightGain: 1 },
      { trackId: 'A2', volume: 1, balance: 0, leftGain: 1, rightGain: 1 },
    ])
    expect(graph.master).toMatchObject({ volume: 1.25, muted: false })
  })

  test('rejects out-of-range authored mixer values', () => {
    expect(() => timelineAudioMixerGraph(doc([
      track('A1', 'audio', { volume: 3 }),
    ]))).toThrow(/volume/)
    expect(() => timelineAudioMixerGraph(doc(
      [track('A1', 'audio')],
      { volume: 1, balance: 2, muted: false },
    ))).toThrow(/balance/)
  })
})
