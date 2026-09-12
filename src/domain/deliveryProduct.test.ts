import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_ALPHA_VIDEO_PROFILE,
  DEFAULT_AUDIO_ONLY_PROFILE,
  DEFAULT_CHAPTER_POLICY,
  DEFAULT_IMAGE_SEQUENCE_PROFILE,
  assertChapterDelivery,
  assertDeliveryWorkBudget,
  containerChapterSupport,
  deliveryFileExtension,
  deliveryProductLabel,
  deliveryWorkBudgetReason,
  imageSequenceFileName,
  imageSequenceFileNames,
  imageSequencePadWidth,
  isDeliveryProfile,
  parseChapterPolicy,
  parseExportSettings,
  sanitizeDeliveryPrefix,
  validateDeliveryProfile,
} from './deliveryProduct'
import { DEFAULT_EXPORT_PROFILE } from './exportProfile'
import type { TimelineDoc } from './schema'

function doc(): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'delivery-doc',
    name: 'Delivery',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

describe('delivery products', () => {
  test('keeps classic export profiles distinct from tagged delivery kinds', () => {
    expect(isDeliveryProfile(DEFAULT_EXPORT_PROFILE)).toBe(false)
    expect(parseExportSettings(DEFAULT_EXPORT_PROFILE)).toEqual(DEFAULT_EXPORT_PROFILE)
    expect(isDeliveryProfile(DEFAULT_IMAGE_SEQUENCE_PROFILE)).toBe(true)
    expect(containerChapterSupport('mp4')).toBe('unsupported')
    expect(containerChapterSupport('webm')).toBe('unsupported')
  })

  test('names PNG frames from absolute range frames with deterministic padding', () => {
    expect(imageSequencePadWidth(12)).toBe(5)
    expect(imageSequencePadWidth(100_000)).toBe(5)
    expect(imageSequencePadWidth(1_000_000)).toBe(6)
    expect(imageSequenceFileName('frame', 7, 5)).toBe('frame_00007.png')
    expect(imageSequenceFileNames({ startFrame: 10, endFrame: 13 }, 'plate')).toEqual([
      'plate_00010.png',
      'plate_00011.png',
      'plate_00012.png',
    ])
    expect(sanitizeDeliveryPrefix('../evil/name.png')).toBe('-evil-name')
  })

  test('rejects inverted codec/container pairs without substituting another format', () => {
    expect(() => validateDeliveryProfile({
      ...DEFAULT_AUDIO_ONLY_PROFILE,
      container: 'wav',
      codec: 'aac',
    })).toThrow(/requires pcm-s16/i)
    expect(() => validateDeliveryProfile({
      ...DEFAULT_ALPHA_VIDEO_PROFILE,
      container: 'mp4',
      videoCodec: 'vp9',
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
    })).toThrow(/must use WebM/i)
    expect(() => parseChapterPolicy({ mode: 'container' })).toThrow(/off or sidecar/)
    expect(parseChapterPolicy({ mode: 'off' })).toEqual(DEFAULT_CHAPTER_POLICY)
  })

  test('WAV PCM keeps null bitrate and compressed audio-only requires an exact pair', () => {
    const wav = validateDeliveryProfile({
      kind: 'audio-only',
      container: 'wav',
      codec: 'pcm-s16',
      audioChannelLayout: 'mono',
      audioBitrate: null,
      audioBitrateMode: null,
      mimeType: 'audio/wav',
      fileExtension: 'wav',
      destination: 'file',
      chapters: { mode: 'sidecar' },
    })
    expect(wav).toMatchObject({ codec: 'pcm-s16', audioBitrate: null, audioChannelLayout: 'mono' })
    const aac = validateDeliveryProfile({
      kind: 'audio-only',
      container: 'mp4',
      codec: 'aac',
      audioChannelLayout: 'stereo',
      audioBitrate: 192_000,
      audioBitrateMode: 'variable',
      mimeType: 'audio/mp4',
      fileExtension: 'm4a',
      destination: 'download',
      chapters: { mode: 'off' },
    })
    expect(aac).toMatchObject({ kind: 'audio-only', fileExtension: 'm4a' })
  })

  test('labels and download extensions stay explicit for each product', () => {
    expect(deliveryProductLabel(DEFAULT_IMAGE_SEQUENCE_PROFILE)).toBe('PNG image sequence')
    expect(deliveryProductLabel(DEFAULT_AUDIO_ONLY_PROFILE)).toBe('WAV PCM audio')
    expect(deliveryFileExtension(DEFAULT_IMAGE_SEQUENCE_PROFILE)).toBe('zip')
    expect(deliveryFileExtension(DEFAULT_AUDIO_ONLY_PROFILE)).toBe('wav')
    expect(deliveryFileExtension(DEFAULT_EXPORT_PROFILE)).toBe('mp4')
    expect(deliveryFileExtension(DEFAULT_EXPORT_PROFILE, { mode: 'sidecar' })).toBe('zip')
  })

  test('charges image-sequence work from pixel area and audio-only from sample bytes', () => {
    const sequence = doc()
    expect(deliveryWorkBudgetReason(30, sequence, DEFAULT_IMAGE_SEQUENCE_PROFILE)).toBeNull()
    expect(deliveryWorkBudgetReason(30, sequence, DEFAULT_AUDIO_ONLY_PROFILE)).toBeNull()
    expect(() => assertDeliveryWorkBudget(0, sequence, DEFAULT_IMAGE_SEQUENCE_PROFILE)).toThrow(/positive/)
    expect(deliveryWorkBudgetReason(5_000_001, sequence, DEFAULT_IMAGE_SEQUENCE_PROFILE)).toMatch(/frame limit/)
  })

  test('rejects chapter sidecars for a single file destination and allows ZIP or PNG folders', () => {
    expect(() => assertChapterDelivery('file', { mode: 'sidecar' })).toThrow(
      /cannot be stored inside a single media file/i,
    )
    expect(() => assertChapterDelivery('download', { mode: 'sidecar' })).not.toThrow()
    expect(() => assertChapterDelivery('directory', { mode: 'sidecar' })).not.toThrow()
    expect(() => assertChapterDelivery('file', { mode: 'off' })).not.toThrow()
  })
})
