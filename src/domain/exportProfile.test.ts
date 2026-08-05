import { describe, expect, test } from 'vitest'
import {
  AUTO_EXPORT_PRESET_ORDER,
  DEFAULT_EXPORT_PRESET_ID,
  DEFAULT_EXPORT_PROFILE,
  EXPORT_PRESETS,
  exportProfileIncludesAudio,
  exportPresetById,
  isAllowedExportCodecPair,
  MAX_EXPORT_AUDIO_BITRATE,
  MAX_EXPORT_VIDEO_BITRATE,
  MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
  MIN_EXPORT_AUDIO_BITRATE,
  MIN_EXPORT_VIDEO_BITRATE,
  updateExportProfile,
  validateExportProfile,
} from './exportProfile'
import type { Clip, TimelineDoc, Track } from './schema'

const compatibility = {
  container: 'mp4',
  videoCodec: 'avc',
  audioCodec: 'aac',
  audioChannelLayout: 'stereo',
  videoBitrate: 8_000_000,
  audioBitrate: 192_000,
  videoBitrateMode: 'variable',
  audioBitrateMode: 'variable',
  keyFrameIntervalMicroseconds: 2_000_000,
  mimeType: 'video/mp4',
  fileExtension: 'mp4',
  destination: 'download',
} as const

function audioTimeline(hasClip: boolean): TimelineDoc {
  const clips: Clip[] = hasClip
    ? [{
        id: 'audio-clip',
        assetId: 'audio-asset',
        name: 'Audio clip',
        sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 30 },
        timelineRange: { startFrame: 0, durationFrames: 30 },
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
      }]
    : []
  const audioTrack: Track = {
    id: 'A1',
    kind: 'audio',
    name: 'A1',
    clips,
    transitions: [],
    hidden: false,
    muted: true,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 6,
    id: 'export-profile-audio-doc',
    name: 'Audio profile fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [audioTrack],
  }
}

describe('export profile catalog', () => {
  test('keeps the current MP4/AVC/AAC behavior as the immutable default', () => {
    expect(DEFAULT_EXPORT_PRESET_ID).toBe('compatibility')
    expect(DEFAULT_EXPORT_PROFILE).toEqual(compatibility)
    expect(Object.isFrozen(DEFAULT_EXPORT_PROFILE)).toBe(true)
  })

  test('exposes only the documented allow-listed profiles in display order', () => {
    expect(EXPORT_PRESETS.map(({ id, profile }) => ({
      id,
      container: profile.container,
      videoCodec: profile.videoCodec,
      audioCodec: profile.audioCodec,
    }))).toEqual([
      { id: 'compatibility', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac' },
      { id: 'web', container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' },
      { id: 'modern', container: 'webm', videoCodec: 'av1', audioCodec: 'opus' },
      { id: 'hevc', container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' },
    ])
    expect(Object.isFrozen(EXPORT_PRESETS)).toBe(true)
    expect(EXPORT_PRESETS.every(Object.isFrozen)).toBe(true)
    expect(EXPORT_PRESETS.every(({ profile }) => Object.isFrozen(profile))).toBe(true)
  })

  test('documents Auto order and keeps HEVC explicit-only', () => {
    expect(AUTO_EXPORT_PRESET_ORDER).toEqual([
      'modern',
      'web',
      'compatibility',
    ])
    expect(AUTO_EXPORT_PRESET_ORDER).not.toContain('hevc')
    expect(Object.isFrozen(AUTO_EXPORT_PRESET_ORDER)).toBe(true)
  })

  test('exposes the same pure codec-pair relation for advanced controls', () => {
    expect(isAllowedExportCodecPair('mp4', 'avc', 'aac')).toBe(true)
    expect(isAllowedExportCodecPair('webm', 'vp9', 'opus')).toBe(true)
    expect(isAllowedExportCodecPair('webm', 'av1', null)).toBe(true)
    expect(isAllowedExportCodecPair('mp4', 'hevc', null)).toBe(true)
    expect(isAllowedExportCodecPair('mp4', 'vp9', 'aac')).toBe(false)
    expect(isAllowedExportCodecPair('webm', 'vp9', 'aac')).toBe(false)
  })

  test('looks up a known preset and rejects unknown runtime ids', () => {
    expect(exportPresetById('web').label).toBe('Web')
    expect(() => exportPresetById('mystery' as 'web')).toThrow(/Unknown export preset/)
  })

  test('detects exactly when the profile would write an audio track', () => {
    const withAudio = audioTimeline(true)
    const withoutAudioClip = audioTimeline(false)
    const audioOff = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })

    expect(exportProfileIncludesAudio(withAudio, DEFAULT_EXPORT_PROFILE)).toBe(true)
    expect(exportProfileIncludesAudio(withoutAudioClip, DEFAULT_EXPORT_PROFILE))
      .toBe(false)
    expect(exportProfileIncludesAudio(withAudio, audioOff)).toBe(false)
  })
})

describe('validateExportProfile', () => {
  test('returns a detached immutable concrete profile', () => {
    const input = { ...compatibility }
    const validated = validateExportProfile(input)

    expect(validated).toEqual(input)
    expect(validated).not.toBe(input)
    expect(Object.isFrozen(validated)).toBe(true)
  })

  test.each([
    null,
    [],
    {},
    { ...compatibility, extra: true },
    Object.fromEntries(Object.entries(compatibility).filter(([key]) => key !== 'destination')),
  ])('rejects malformed or non-exact objects: %o', (value) => {
    expect(() => validateExportProfile(value)).toThrow(TypeError)
  })

  test.each([
    ['container', 'mov'],
    ['videoCodec', 'mpeg2'],
    ['audioCodec', 'mp3'],
    ['audioChannelLayout', 'surround'],
    ['videoBitrateMode', 'average'],
    ['audioBitrateMode', 'average'],
    ['destination', 'cloud'],
  ])('rejects an unknown %s value', (field, value) => {
    expect(() => validateExportProfile({
      ...compatibility,
      [field]: value,
    })).toThrow(TypeError)
  })

  test.each([
    ['videoBitrate', MIN_EXPORT_VIDEO_BITRATE - 1],
    ['videoBitrate', MAX_EXPORT_VIDEO_BITRATE + 1],
    ['videoBitrate', 8_000_000.5],
    ['audioBitrate', MIN_EXPORT_AUDIO_BITRATE - 1],
    ['audioBitrate', MAX_EXPORT_AUDIO_BITRATE + 1],
    ['audioBitrate', Number.POSITIVE_INFINITY],
    ['keyFrameIntervalMicroseconds', -1],
    ['keyFrameIntervalMicroseconds', MAX_KEY_FRAME_INTERVAL_MICROSECONDS + 1],
    ['keyFrameIntervalMicroseconds', 1.5],
  ])('rejects an unbounded or non-integer %s', (field, value) => {
    expect(() => validateExportProfile({
      ...compatibility,
      [field]: value,
    })).toThrow()
  })

  test('accepts the inclusive numeric boundaries', () => {
    expect(validateExportProfile({
      ...compatibility,
      videoBitrate: MIN_EXPORT_VIDEO_BITRATE,
      audioBitrate: MIN_EXPORT_AUDIO_BITRATE,
      keyFrameIntervalMicroseconds: 0,
    })).toMatchObject({
      videoBitrate: MIN_EXPORT_VIDEO_BITRATE,
      audioBitrate: MIN_EXPORT_AUDIO_BITRATE,
      keyFrameIntervalMicroseconds: 0,
    })
    expect(validateExportProfile({
      ...compatibility,
      videoBitrate: MAX_EXPORT_VIDEO_BITRATE,
      audioBitrate: MAX_EXPORT_AUDIO_BITRATE,
      keyFrameIntervalMicroseconds: MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
    })).toMatchObject({
      videoBitrate: MAX_EXPORT_VIDEO_BITRATE,
      audioBitrate: MAX_EXPORT_AUDIO_BITRATE,
      keyFrameIntervalMicroseconds: MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
    })
  })

  test.each([
    { audioCodec: null },
    { audioBitrate: null },
    { audioBitrateMode: null },
    { audioChannelLayout: 'off' },
  ])('rejects a partial audio-off shape: %o', (change) => {
    expect(() => validateExportProfile({
      ...compatibility,
      ...change,
    })).toThrow(/Audio-off|Mono and stereo/)
  })

  test.each(['mono', 'stereo'] as const)(
    'accepts explicit %s audio and a fully disabled audio profile',
    (audioChannelLayout) => {
      expect(validateExportProfile({
        ...compatibility,
        audioChannelLayout,
      }).audioChannelLayout).toBe(audioChannelLayout)

      expect(validateExportProfile({
        ...compatibility,
        audioCodec: null,
        audioChannelLayout: 'off',
        audioBitrate: null,
        audioBitrateMode: null,
      })).toMatchObject({
        audioCodec: null,
        audioChannelLayout: 'off',
        audioBitrate: null,
        audioBitrateMode: null,
      })
    },
  )

  test('accepts audio-off variants of every allow-listed video pair', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(updateExportProfile(preset.profile, {
        audioCodec: null,
        audioChannelLayout: 'off',
        audioBitrate: null,
        audioBitrateMode: null,
      })).toMatchObject({
        container: preset.profile.container,
        videoCodec: preset.profile.videoCodec,
        audioCodec: null,
        audioChannelLayout: 'off',
      })
    }
  })

  test.each([
    { container: 'mp4', videoCodec: 'vp9', audioCodec: 'aac' },
    { container: 'webm', videoCodec: 'avc', audioCodec: 'opus' },
    { container: 'webm', videoCodec: 'vp9', audioCodec: 'aac' },
    { container: 'mp4', videoCodec: 'hevc', audioCodec: 'opus' },
  ])('rejects invalid container and codec pairs: %o', (change) => {
    expect(() => validateExportProfile({
      ...compatibility,
      ...change,
      mimeType: change.container === 'webm' ? 'video/webm' : 'video/mp4',
      fileExtension: change.container === 'webm' ? 'webm' : 'mp4',
    })).toThrow(/Unsupported export codec pair/)
  })

  test('still validates the container/video pair when audio is off', () => {
    expect(() => validateExportProfile({
      ...compatibility,
      container: 'webm',
      videoCodec: 'avc',
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
      mimeType: 'video/webm',
      fileExtension: 'webm',
    })).toThrow(/Unsupported export codec pair/)
  })

  test.each([
    { mimeType: 'video/webm' },
    { fileExtension: 'webm' },
  ])('rejects mismatched container metadata: %o', (change) => {
    expect(() => validateExportProfile({
      ...compatibility,
      ...change,
    })).toThrow()
  })

  test('applies advanced changes through the same boundary validation', () => {
    const changed = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      videoBitrate: 12_000_000,
      videoBitrateMode: 'constant',
      destination: 'file',
    })

    expect(changed).toMatchObject({
      videoBitrate: 12_000_000,
      videoBitrateMode: 'constant',
      destination: 'file',
    })
    expect(changed).not.toBe(DEFAULT_EXPORT_PROFILE)
    expect(Object.isFrozen(changed)).toBe(true)
    expect(() => updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      container: 'webm',
    })).toThrow()
  })
})
