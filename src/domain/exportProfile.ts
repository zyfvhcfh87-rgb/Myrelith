/**
 * Pure, allow-listed export profile contract.
 *
 * Project dimensions, frame rate, and audio sample rate deliberately do not
 * live here. They are authoritative TimelineDoc fields owned by project
 * settings and are combined with one validated profile at the pipeline edge.
 */

import type { TimelineDoc } from './schema'

export type ExportPresetId = 'compatibility' | 'web' | 'modern' | 'hevc'
export type ExportSelectionId = 'auto' | ExportPresetId
export type ExportContainer = 'mp4' | 'webm'
export type ExportVideoCodec = 'avc' | 'vp9' | 'av1' | 'hevc'
export type ExportAudioCodec = 'aac' | 'opus'
export type ExportAudioChannelLayout = 'off' | 'mono' | 'stereo'
export type ExportBitrateMode = 'constant' | 'variable'
export type ExportDestination = 'download' | 'file'
export type ExportMimeType = 'video/mp4' | 'video/webm'
export type ExportFileExtension = 'mp4' | 'webm'

export interface ExportProfileCommon {
  readonly container: ExportContainer
  readonly videoCodec: ExportVideoCodec
  readonly videoBitrate: number
  readonly videoBitrateMode: ExportBitrateMode
  /** Exact integer duration. Convert to seconds only at the encoder boundary. */
  readonly keyFrameIntervalMicroseconds: number
  readonly mimeType: ExportMimeType
  readonly fileExtension: ExportFileExtension
  readonly destination: ExportDestination
}

export interface ExportAudioOffSettings {
  readonly audioCodec: null
  readonly audioChannelLayout: 'off'
  readonly audioBitrate: null
  readonly audioBitrateMode: null
}

export interface ExportAudioEnabledSettings {
  readonly audioCodec: ExportAudioCodec
  readonly audioChannelLayout: Exclude<ExportAudioChannelLayout, 'off'>
  readonly audioBitrate: number
  readonly audioBitrateMode: ExportBitrateMode
}

/** Audio-off/on invariants are enforced statically as well as at runtime. */
export type ExportProfile = ExportProfileCommon & (
  ExportAudioOffSettings | ExportAudioEnabledSettings
)

export type ExportProfileChanges = Partial<ExportProfileCommon & {
  readonly audioCodec: ExportAudioCodec | null
  readonly audioChannelLayout: ExportAudioChannelLayout
  readonly audioBitrate: number | null
  readonly audioBitrateMode: ExportBitrateMode | null
}>

export interface ExportPreset {
  readonly id: ExportPresetId
  readonly label: string
  readonly description: string
  readonly profile: Readonly<ExportProfile>
}

export const MIN_EXPORT_VIDEO_BITRATE = 100_000
export const MAX_EXPORT_VIDEO_BITRATE = 200_000_000
export const MIN_EXPORT_AUDIO_BITRATE = 16_000
export const MAX_EXPORT_AUDIO_BITRATE = 512_000
export const MAX_KEY_FRAME_INTERVAL_MICROSECONDS = 10_000_000

const PROFILE_KEYS = Object.freeze([
  'container',
  'videoCodec',
  'audioCodec',
  'audioChannelLayout',
  'videoBitrate',
  'audioBitrate',
  'videoBitrateMode',
  'audioBitrateMode',
  'keyFrameIntervalMicroseconds',
  'mimeType',
  'fileExtension',
  'destination',
])

const CONTAINER_METADATA: Readonly<Record<
  ExportContainer,
  Readonly<{
    mimeType: ExportMimeType
    fileExtension: ExportFileExtension
  }>
>> = Object.freeze({
  mp4: Object.freeze({ mimeType: 'video/mp4', fileExtension: 'mp4' }),
  webm: Object.freeze({ mimeType: 'video/webm', fileExtension: 'webm' }),
})

const ALLOWED_CODEC_PAIRS = Object.freeze([
  Object.freeze({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac' }),
  Object.freeze({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' }),
  Object.freeze({ container: 'webm', videoCodec: 'av1', audioCodec: 'opus' }),
  Object.freeze({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' }),
] as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

function assertBoundedSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`)
  }
  if ((value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`)
  }
}

/** Pure allow-list query for advanced controls and runtime containment checks. */
export function isAllowedExportCodecPair(
  container: ExportContainer,
  videoCodec: ExportVideoCodec,
  audioCodec: ExportAudioCodec | null,
): boolean {
  return ALLOWED_CODEC_PAIRS.some((pair) => (
    pair.container === container &&
    pair.videoCodec === videoCodec &&
    (audioCodec === null || pair.audioCodec === audioCodec)
  ))
}

/**
 * Validate untrusted settings and return a detached, frozen concrete profile.
 * Invalid container/codec combinations are rejected; this function never
 * substitutes another codec or changes a user's explicit selection.
 */
export function validateExportProfile(value: unknown): Readonly<ExportProfile> {
  if (!isRecord(value) || !hasExactlyKeys(value, PROFILE_KEYS)) {
    throw new TypeError(`Export profile must contain only ${PROFILE_KEYS.join(', ')}`)
  }

  const {
    container,
    videoCodec,
    audioCodec,
    audioChannelLayout,
    videoBitrate,
    audioBitrate,
    videoBitrateMode,
    audioBitrateMode,
    keyFrameIntervalMicroseconds,
    mimeType,
    fileExtension,
    destination,
  } = value

  if (!isOneOf(container, ['mp4', 'webm'])) {
    throw new TypeError('Export container must be mp4 or webm')
  }
  if (!isOneOf(videoCodec, ['avc', 'vp9', 'av1', 'hevc'])) {
    throw new TypeError('Export video codec must be avc, vp9, av1, or hevc')
  }
  if (audioCodec !== null && !isOneOf(audioCodec, ['aac', 'opus'])) {
    throw new TypeError('Export audio codec must be aac, opus, or null')
  }
  if (!isOneOf(audioChannelLayout, ['off', 'mono', 'stereo'])) {
    throw new TypeError('Export audio channel layout must be off, mono, or stereo')
  }
  if (!isOneOf(videoBitrateMode, ['constant', 'variable'])) {
    throw new TypeError('Export video bitrate mode must be constant or variable')
  }
  if (audioBitrateMode !== null && !isOneOf(audioBitrateMode, ['constant', 'variable'])) {
    throw new TypeError('Export audio bitrate mode must be constant, variable, or null')
  }
  if (!isOneOf(destination, ['download', 'file'])) {
    throw new TypeError('Export destination must be download or file')
  }

  assertBoundedSafeInteger(
    videoBitrate,
    'Export video bitrate',
    MIN_EXPORT_VIDEO_BITRATE,
    MAX_EXPORT_VIDEO_BITRATE,
  )
  assertBoundedSafeInteger(
    keyFrameIntervalMicroseconds,
    'Export key-frame interval',
    0,
    MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
  )

  let audio: ExportAudioOffSettings | ExportAudioEnabledSettings
  if (audioChannelLayout === 'off') {
    if (audioCodec !== null || audioBitrate !== null || audioBitrateMode !== null) {
      throw new TypeError(
        'Audio-off profiles require null audio codec, bitrate, and bitrate mode',
      )
    }
    audio = {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    }
  } else {
    if (audioCodec === null || audioBitrate === null || audioBitrateMode === null) {
      throw new TypeError(
        'Mono and stereo profiles require an audio codec, bitrate, and bitrate mode',
      )
    }
    assertBoundedSafeInteger(
      audioBitrate,
      'Export audio bitrate',
      MIN_EXPORT_AUDIO_BITRATE,
      MAX_EXPORT_AUDIO_BITRATE,
    )
    audio = {
      audioCodec,
      audioChannelLayout,
      audioBitrate,
      audioBitrateMode,
    }
  }

  if (!isAllowedExportCodecPair(container, videoCodec, audio.audioCodec)) {
    const audioLabel = audio.audioCodec ?? 'no audio'
    throw new RangeError(
      `Unsupported export codec pair: ${container}/${videoCodec}/${audioLabel}`,
    )
  }

  const expectedMetadata = CONTAINER_METADATA[container]
  if (mimeType !== expectedMetadata.mimeType) {
    throw new RangeError(
      `${container} export MIME type must be ${expectedMetadata.mimeType}`,
    )
  }
  if (fileExtension !== expectedMetadata.fileExtension) {
    throw new RangeError(
      `${container} export file extension must be ${expectedMetadata.fileExtension}`,
    )
  }

  const common: ExportProfileCommon = {
    container,
    videoCodec,
    videoBitrate,
    videoBitrateMode,
    keyFrameIntervalMicroseconds,
    mimeType: expectedMetadata.mimeType,
    fileExtension: expectedMetadata.fileExtension,
    destination,
  }
  return Object.freeze({
    ...common,
    ...audio,
  })
}

function createPreset(
  id: ExportPresetId,
  label: string,
  description: string,
  profile: ExportProfile,
): Readonly<ExportPreset> {
  return Object.freeze({
    id,
    label,
    description,
    profile: validateExportProfile(profile),
  })
}

/** The explicit HEVC preset is deliberately absent from Auto's preference order. */
export const AUTO_EXPORT_PRESET_ORDER: readonly ExportPresetId[] = Object.freeze([
  'modern',
  'web',
  'compatibility',
])

/** Recommended profiles in user-facing display order. */
export const EXPORT_PRESETS: readonly Readonly<ExportPreset>[] = Object.freeze([
  createPreset(
    'compatibility',
    'Compatibility',
    'MP4, H.264/AVC video, AAC audio',
    {
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
    },
  ),
  createPreset(
    'web',
    'Web',
    'WebM, VP9 video, Opus audio',
    {
      container: 'webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
      audioChannelLayout: 'stereo',
      videoBitrate: 8_000_000,
      audioBitrate: 192_000,
      videoBitrateMode: 'variable',
      audioBitrateMode: 'variable',
      keyFrameIntervalMicroseconds: 2_000_000,
      mimeType: 'video/webm',
      fileExtension: 'webm',
      destination: 'download',
    },
  ),
  createPreset(
    'modern',
    'Modern',
    'WebM, AV1 video, Opus audio',
    {
      container: 'webm',
      videoCodec: 'av1',
      audioCodec: 'opus',
      audioChannelLayout: 'stereo',
      videoBitrate: 8_000_000,
      audioBitrate: 192_000,
      videoBitrateMode: 'variable',
      audioBitrateMode: 'variable',
      keyFrameIntervalMicroseconds: 2_000_000,
      mimeType: 'video/webm',
      fileExtension: 'webm',
      destination: 'download',
    },
  ),
  createPreset(
    'hevc',
    'HEVC',
    'MP4, HEVC video, AAC audio',
    {
      container: 'mp4',
      videoCodec: 'hevc',
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
    },
  ),
])

export const DEFAULT_EXPORT_PRESET_ID: ExportPresetId = 'compatibility'

export function exportPresetById(id: ExportPresetId): Readonly<ExportPreset> {
  const preset = EXPORT_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) {
    throw new RangeError(`Unknown export preset: ${id}`)
  }
  return preset
}

/** The current MP4/AVC/AAC path, made explicit as the safe default. */
export const DEFAULT_EXPORT_PROFILE: Readonly<ExportProfile> =
  exportPresetById(DEFAULT_EXPORT_PRESET_ID).profile

/** Whether this document/profile pair would create an encoded audio track. */
export function exportProfileIncludesAudio(
  doc: TimelineDoc,
  profile: ExportProfile,
): boolean {
  return profile.audioChannelLayout !== 'off' && doc.tracks.some(
    (track) => track.kind === 'audio' && track.clips.length > 0,
  )
}

/** Apply advanced-setting changes without weakening boundary validation. */
export function updateExportProfile(
  profile: ExportProfile,
  changes: ExportProfileChanges,
): Readonly<ExportProfile> {
  return validateExportProfile({ ...profile, ...changes })
}
