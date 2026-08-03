import { describe, expect, test } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  MAX_EXPORT_VIDEO_BITRATE,
  exportPresetById,
  updateExportProfile,
} from '../domain/exportProfile'
import type {
  Clip,
  FrameRate,
  TimelineDoc,
  Track,
} from '../domain/schema'
import {
  changeExportContainer,
  estimateExportBytes,
  exportFileName,
  formatEstimatedFileSize,
  profileForSelectionFallback,
} from './exportProfileUi'

function clip(id: string, durationFrames: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame: 0, durationFrames },
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

function track(kind: 'video' | 'audio', durationFrames: number): Track {
  return {
    id: kind === 'video' ? 'V1' : 'A1',
    kind,
    name: kind === 'video' ? 'V1' : 'A1',
    clips: [clip(`${kind}-clip`, durationFrames)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function doc(
  durationFrames: number,
  options: {
    frameRate?: FrameRate
    audio?: boolean
    video?: boolean
  } = {},
): TimelineDoc {
  const frameRate = options.frameRate ?? { num: 30, den: 1 }
  const tracks: Track[] = []
  if (durationFrames > 0 && options.video !== false) {
    tracks.push(track('video', durationFrames))
  }
  if (durationFrames > 0 && options.audio !== false) {
    tracks.push(track('audio', durationFrames))
  }
  return {
    schemaVersion: 5,
    id: 'export-profile-ui-doc',
    name: 'Export profile UI',
    frameRate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

describe('export profile selection and container helpers', () => {
  test('uses Compatibility as the safe Auto fallback and preserves custom profiles', () => {
    const custom = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      videoBitrate: 12_000_000,
    })

    expect(profileForSelectionFallback('auto', custom)).toBe(
      exportPresetById('compatibility').profile,
    )
    expect(profileForSelectionFallback('modern', custom)).toBe(
      exportPresetById('modern').profile,
    )
    expect(profileForSelectionFallback('custom', custom)).toBe(custom)
  })

  test('changes container, codecs, and canonical metadata atomically', () => {
    const tunedMp4 = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioChannelLayout: 'mono',
      audioBitrate: 128_000,
      audioBitrateMode: 'constant',
      videoBitrate: 12_000_000,
      videoBitrateMode: 'constant',
      keyFrameIntervalMicroseconds: 1_500_000,
      destination: 'file',
    })

    const webm = changeExportContainer(tunedMp4, 'webm')
    expect(webm).toMatchObject({
      container: 'webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
      audioChannelLayout: 'mono',
      audioBitrate: 128_000,
      audioBitrateMode: 'constant',
      videoBitrate: 12_000_000,
      videoBitrateMode: 'constant',
      keyFrameIntervalMicroseconds: 1_500_000,
      mimeType: 'video/webm',
      fileExtension: 'webm',
      destination: 'file',
    })
    expect(Object.isFrozen(webm)).toBe(true)

    expect(changeExportContainer(webm, 'mp4')).toMatchObject({
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      audioChannelLayout: 'mono',
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
    })
  })

  test('keeps the complete audio-off shape while changing containers', () => {
    const audioOff = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })

    expect(changeExportContainer(audioOff, 'webm')).toMatchObject({
      container: 'webm',
      videoCodec: 'vp9',
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
      mimeType: 'video/webm',
      fileExtension: 'webm',
    })
  })
})

describe('export filenames', () => {
  test.each([
    ['Project.mp4', 'webm', 'Project.webm'],
    ['Project.WEBM', 'mp4', 'Project.mp4'],
    ['  My / Rough: Cut.mp4  ', 'webm', 'My - Rough- Cut.webm'],
    ['CON.txt', 'mp4', 'webcut-CON.txt.mp4'],
    [' . ', 'webm', 'webcut-export.webm'],
  ] as const)('creates a safe dynamic %s -> %s filename', (name, extension, expected) => {
    expect(exportFileName(name, extension)).toBe(expected)
  })

  test('limits the sanitized base by Unicode code point before adding the extension', () => {
    const name = String.fromCodePoint(0x1f3ac).repeat(90)
    const result = exportFileName(name, 'mp4')

    expect(Array.from(result.replace(/\.mp4$/, ''))).toHaveLength(80)
    expect(result.endsWith('.mp4')).toBe(true)
  })
})

describe('bitrate-based export estimates', () => {
  test('uses exact rational FPS math and includes a written audio track', () => {
    const ntsc = doc(300, {
      frameRate: { num: 30_000, den: 1_001 },
      audio: true,
    })

    expect(estimateExportBytes(ntsc, DEFAULT_EXPORT_PROFILE)).toBe(10_250_240)
  })

  test('omits audio bitrate when audio is disabled or no audio track is written', () => {
    const ntscWithAudio = doc(300, {
      frameRate: { num: 30_000, den: 1_001 },
      audio: true,
    })
    const ntscVideoOnly = doc(300, {
      frameRate: { num: 30_000, den: 1_001 },
      audio: false,
    })
    const audioOff = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })

    expect(estimateExportBytes(ntscWithAudio, audioOff)).toBe(10_010_000)
    expect(estimateExportBytes(ntscVideoOnly, DEFAULT_EXPORT_PROFILE)).toBe(
      10_010_000,
    )
  })

  test('returns zero for an empty timeline', () => {
    expect(estimateExportBytes(doc(0), DEFAULT_EXPORT_PROFILE)).toBe(0)
  })

  test('clamps an estimate larger than the safe Number boundary', () => {
    const maximumBitrate = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      videoBitrate: MAX_EXPORT_VIDEO_BITRATE,
    })
    const huge = doc(Number.MAX_SAFE_INTEGER, {
      frameRate: { num: 1, den: 1 },
      audio: false,
    })

    expect(estimateExportBytes(huge, maximumBitrate)).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  test.each([
    [0, '0 KB'],
    [499, '1 KB'],
    [9_500_000, '9.5 MB'],
    [25_000_000, '25 MB'],
    [1_500_000_000, '1.5 GB'],
    [Number.NaN, 'Unknown'],
  ] as const)('formats %s estimated bytes as %s', (bytes, expected) => {
    expect(formatEstimatedFileSize(bytes)).toBe(expected)
  })
})
