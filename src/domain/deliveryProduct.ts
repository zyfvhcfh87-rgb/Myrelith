/**
 * Typed alternative delivery products. Classic MP4/WebM video profiles stay in
 * exportProfile.ts and keep their exact-key contract. These kinds never
 * substitute a codec or claim container chapter support this muxer cannot write.
 */

import {
  MAX_EXPORT_AUDIO_BITRATE,
  MIN_EXPORT_AUDIO_BITRATE,
  MAX_EXPORT_VIDEO_BITRATE,
  MIN_EXPORT_VIDEO_BITRATE,
  MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
  exportProfileIncludesAudio,
  validateExportProfile,
  type ExportAudioChannelLayout,
  type ExportBitrateMode,
  type ExportDestination,
  type ExportProfile,
  type ExportVideoCodec,
} from './exportProfile'
import type { TimelineDoc } from './schema'
import {
  MAX_BUFFERED_EXPORT_ESTIMATE_BYTES,
  MAX_DIRECT_EXPORT_ESTIMATE_BYTES,
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_FRAME_COUNT,
} from './exportWorkBudget'
import type { ExportRange } from './exportRange'
import { framesToSeconds } from './time'

export type DeliveryKind = 'image-sequence' | 'audio-only' | 'alpha-video'
export type ChapterMode = 'off' | 'sidecar'
export type ImageSequenceFormat = 'png'
export type AudioOnlyContainer = 'wav' | 'mp4' | 'webm'
export type AudioOnlyCodec = 'pcm-s16' | 'aac' | 'opus'
export type AlphaVideoCodec = Extract<ExportVideoCodec, 'vp9' | 'av1'>

export interface ChapterPolicy {
  readonly mode: ChapterMode
}

export interface ImageSequenceProfile {
  readonly kind: 'image-sequence'
  readonly format: ImageSequenceFormat
  readonly destination: 'download' | 'directory'
  readonly fileNamePrefix: string
  readonly overwriteExisting: boolean
  readonly chapters: ChapterPolicy
}

export interface AudioOnlyProfile {
  readonly kind: 'audio-only'
  readonly container: AudioOnlyContainer
  readonly codec: AudioOnlyCodec
  readonly audioChannelLayout: Exclude<ExportAudioChannelLayout, 'off'>
  readonly audioBitrate: number | null
  readonly audioBitrateMode: ExportBitrateMode | null
  readonly mimeType: 'audio/wav' | 'audio/mp4' | 'audio/webm'
  readonly fileExtension: 'wav' | 'm4a' | 'webm'
  readonly destination: ExportDestination
  readonly chapters: ChapterPolicy
}

export interface AlphaVideoProfile {
  readonly kind: 'alpha-video'
  readonly container: 'webm'
  readonly videoCodec: AlphaVideoCodec
  readonly audioCodec: 'opus' | null
  readonly audioChannelLayout: ExportAudioChannelLayout
  readonly videoBitrate: number
  readonly audioBitrate: number | null
  readonly videoBitrateMode: ExportBitrateMode
  readonly audioBitrateMode: ExportBitrateMode | null
  readonly keyFrameIntervalMicroseconds: number
  readonly mimeType: 'video/webm'
  readonly fileExtension: 'webm'
  readonly destination: ExportDestination
  readonly chapters: ChapterPolicy
}

export type DeliveryProfile =
  | ImageSequenceProfile
  | AudioOnlyProfile
  | AlphaVideoProfile

export type ExportSettingsUnion = ExportProfile | DeliveryProfile

export const DEFAULT_CHAPTER_POLICY: Readonly<ChapterPolicy> = Object.freeze({
  mode: 'off',
})

const IMAGE_SEQUENCE_KEYS = Object.freeze([
  'kind',
  'format',
  'destination',
  'fileNamePrefix',
  'overwriteExisting',
  'chapters',
])

const AUDIO_ONLY_KEYS = Object.freeze([
  'kind',
  'container',
  'codec',
  'audioChannelLayout',
  'audioBitrate',
  'audioBitrateMode',
  'mimeType',
  'fileExtension',
  'destination',
  'chapters',
])

const ALPHA_VIDEO_KEYS = Object.freeze([
  'kind',
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
  'chapters',
])

const AUDIO_ONLY_METADATA = Object.freeze({
  wav: Object.freeze({
    codec: 'pcm-s16',
    mimeType: 'audio/wav',
    fileExtension: 'wav',
  }),
  mp4: Object.freeze({
    codec: 'aac',
    mimeType: 'audio/mp4',
    fileExtension: 'm4a',
  }),
  webm: Object.freeze({
    codec: 'opus',
    mimeType: 'audio/webm',
    fileExtension: 'webm',
  }),
} as const)

const MAX_PREFIX_CHARACTERS = 80

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

export function parseChapterPolicy(value: unknown): Readonly<ChapterPolicy> {
  if (!isRecord(value) || !hasExactlyKeys(value, ['mode'])) {
    throw new TypeError('Chapter policy must contain only mode')
  }
  if (!isOneOf(value.mode, ['off', 'sidecar'])) {
    throw new TypeError('Chapter policy mode must be off or sidecar')
  }
  if (value.mode === 'sidecar') {
    return Object.freeze({ mode: 'sidecar' })
  }
  return DEFAULT_CHAPTER_POLICY
}

/**
 * Mediabunny's MP4/WebM muxers do not write chapter metadata. Never advertise
 * container chapters; the sidecar is the honest delivery.
 */
export function containerChapterSupport(
  _container: 'mp4' | 'webm' | 'wav' | 'png-sequence',
): 'unsupported' {
  void _container
  return 'unsupported'
}

export function isDeliveryProfile(
  value: unknown,
): value is DeliveryProfile {
  return isRecord(value) && isOneOf(value.kind, ['image-sequence', 'audio-only', 'alpha-video'])
}

export function isImageSequenceProfile(
  value: unknown,
): value is ImageSequenceProfile {
  return isDeliveryProfile(value) && value.kind === 'image-sequence'
}

export function isAudioOnlyProfile(
  value: unknown,
): value is AudioOnlyProfile {
  return isDeliveryProfile(value) && value.kind === 'audio-only'
}

export function isAlphaVideoProfile(
  value: unknown,
): value is AlphaVideoProfile {
  return isDeliveryProfile(value) && value.kind === 'alpha-video'
}

export function exportSettingsIncludesVisual(
  settings: Readonly<ExportSettingsUnion>,
): boolean {
  return !isAudioOnlyProfile(settings)
}

export function exportSettingsSummary(settings: Readonly<ExportSettingsUnion>): string {
  if (!isDeliveryProfile(settings)) {
    return `${settings.container.toUpperCase()}/${settings.videoCodec}`
  }
  return deliveryProductLabel(settings)
}

export function sanitizeDeliveryPrefix(value: string): string {
  let base = value.trim().replace(/[. ]+$/g, '')
  base = base.replace(/[<>:"/\\|?*]/g, '-')
  base = base.replace(/^\.+/g, '')
  base = base.replace(/\.png$/i, '')
  base = Array.from(base, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('')
  base = Array.from(base).slice(0, MAX_PREFIX_CHARACTERS).join('').replace(/[. ]+$/g, '')
  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i
      .test(base)
  ) {
    base = `myrelith-${base}`
  }
  return base || 'frame'
}

export function imageSequencePadWidth(endFrameExclusive: number): number {
  if (!Number.isSafeInteger(endFrameExclusive) || endFrameExclusive <= 0) {
    throw new RangeError('Image-sequence pad width requires a positive exclusive end frame')
  }
  const last = endFrameExclusive - 1
  return Math.max(5, String(last).length)
}

export function imageSequenceFileName(
  prefix: string,
  frame: number,
  padWidth: number,
): string {
  const safePrefix = sanitizeDeliveryPrefix(prefix)
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError('Image-sequence frame names use non-negative integer frames')
  }
  if (!Number.isSafeInteger(padWidth) || padWidth < 1 || padWidth > 16) {
    throw new RangeError('Image-sequence pad width must be an integer from 1-16')
  }
  const digits = String(frame)
  if (digits.length > padWidth) {
    throw new RangeError('Image-sequence frame index exceeds the pad width')
  }
  return `${safePrefix}_${digits.padStart(padWidth, '0')}.png`
}

export function imageSequenceFileNames(
  range: ExportRange,
  prefix: string,
): readonly string[] {
  const padWidth = imageSequencePadWidth(range.endFrame)
  const names: string[] = []
  for (let frame = range.startFrame; frame < range.endFrame; frame++) {
    names.push(imageSequenceFileName(prefix, frame, padWidth))
  }
  return Object.freeze(names)
}

function validateImageSequenceProfile(value: Record<string, unknown>): ImageSequenceProfile {
  if (!hasExactlyKeys(value, IMAGE_SEQUENCE_KEYS)) {
    throw new TypeError(`Image-sequence profile must contain only ${IMAGE_SEQUENCE_KEYS.join(', ')}`)
  }
  if (value.kind !== 'image-sequence') {
    throw new TypeError('Image-sequence profile kind must be image-sequence')
  }
  if (value.format !== 'png') {
    throw new TypeError('Image-sequence format must be png')
  }
  if (!isOneOf(value.destination, ['download', 'directory'])) {
    throw new TypeError('Image-sequence destination must be download or directory')
  }
  if (typeof value.fileNamePrefix !== 'string') {
    throw new TypeError('Image-sequence fileNamePrefix must be a string')
  }
  if (typeof value.overwriteExisting !== 'boolean') {
    throw new TypeError('Image-sequence overwriteExisting must be a boolean')
  }
  return Object.freeze({
    kind: 'image-sequence',
    format: 'png',
    destination: value.destination,
    fileNamePrefix: sanitizeDeliveryPrefix(value.fileNamePrefix),
    overwriteExisting: value.overwriteExisting,
    chapters: parseChapterPolicy(value.chapters),
  })
}

function validateAudioOnlyProfile(value: Record<string, unknown>): AudioOnlyProfile {
  if (!hasExactlyKeys(value, AUDIO_ONLY_KEYS)) {
    throw new TypeError(`Audio-only profile must contain only ${AUDIO_ONLY_KEYS.join(', ')}`)
  }
  if (value.kind !== 'audio-only') {
    throw new TypeError('Audio-only profile kind must be audio-only')
  }
  if (!isOneOf(value.container, ['wav', 'mp4', 'webm'])) {
    throw new TypeError('Audio-only container must be wav, mp4, or webm')
  }
  if (!isOneOf(value.codec, ['pcm-s16', 'aac', 'opus'])) {
    throw new TypeError('Audio-only codec must be pcm-s16, aac, or opus')
  }
  if (!isOneOf(value.audioChannelLayout, ['mono', 'stereo'])) {
    throw new TypeError('Audio-only channel layout must be mono or stereo')
  }
  if (!isOneOf(value.destination, ['download', 'file'])) {
    throw new TypeError('Audio-only destination must be download or file')
  }
  const expected = AUDIO_ONLY_METADATA[value.container]
  if (value.codec !== expected.codec) {
    throw new RangeError(
      `Audio-only ${value.container} requires ${expected.codec}; no codec substitution is permitted`,
    )
  }
  if (value.mimeType !== expected.mimeType || value.fileExtension !== expected.fileExtension) {
    throw new RangeError(
      `Audio-only ${value.container} must use ${expected.mimeType} and .${expected.fileExtension}`,
    )
  }

  let audioBitrate: number | null = null
  let audioBitrateMode: ExportBitrateMode | null = null
  if (value.codec === 'pcm-s16') {
    if (value.audioBitrate !== null || value.audioBitrateMode !== null) {
      throw new TypeError('WAV PCM profiles require null bitrate fields')
    }
  } else {
    if (value.audioBitrateMode !== 'constant' && value.audioBitrateMode !== 'variable') {
      throw new TypeError('Compressed audio-only profiles require a bitrate mode')
    }
    assertBoundedSafeInteger(
      value.audioBitrate,
      'Audio-only bitrate',
      MIN_EXPORT_AUDIO_BITRATE,
      MAX_EXPORT_AUDIO_BITRATE,
    )
    audioBitrate = value.audioBitrate
    audioBitrateMode = value.audioBitrateMode
  }

  return Object.freeze({
    kind: 'audio-only',
    container: value.container,
    codec: value.codec,
    audioChannelLayout: value.audioChannelLayout,
    audioBitrate,
    audioBitrateMode,
    mimeType: expected.mimeType,
    fileExtension: expected.fileExtension,
    destination: value.destination,
    chapters: parseChapterPolicy(value.chapters),
  })
}

function validateAlphaVideoProfile(value: Record<string, unknown>): AlphaVideoProfile {
  if (!hasExactlyKeys(value, ALPHA_VIDEO_KEYS)) {
    throw new TypeError(`Alpha-video profile must contain only ${ALPHA_VIDEO_KEYS.join(', ')}`)
  }
  if (value.kind !== 'alpha-video') {
    throw new TypeError('Alpha-video profile kind must be alpha-video')
  }
  if (value.container !== 'webm') {
    throw new TypeError('Alpha video must use WebM; MP4 alpha is not offered')
  }
  if (!isOneOf(value.videoCodec, ['vp9', 'av1'])) {
    throw new TypeError('Alpha video codec must be vp9 or av1')
  }
  if (value.audioCodec !== null && value.audioCodec !== 'opus') {
    throw new TypeError('Alpha video audio codec must be opus or null')
  }
  if (!isOneOf(value.audioChannelLayout, ['off', 'mono', 'stereo'])) {
    throw new TypeError('Alpha video channel layout must be off, mono, or stereo')
  }
  if (!isOneOf(value.videoBitrateMode, ['constant', 'variable'])) {
    throw new TypeError('Alpha video bitrate mode must be constant or variable')
  }
  if (!isOneOf(value.destination, ['download', 'file'])) {
    throw new TypeError('Alpha video destination must be download or file')
  }
  if (value.mimeType !== 'video/webm' || value.fileExtension !== 'webm') {
    throw new RangeError('Alpha video must use video/webm and .webm')
  }
  assertBoundedSafeInteger(
    value.videoBitrate,
    'Alpha video bitrate',
    MIN_EXPORT_VIDEO_BITRATE,
    MAX_EXPORT_VIDEO_BITRATE,
  )
  assertBoundedSafeInteger(
    value.keyFrameIntervalMicroseconds,
    'Alpha video key-frame interval',
    0,
    MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
  )

  let audioCodec: 'opus' | null
  let audioBitrate: number | null
  let audioBitrateMode: ExportBitrateMode | null
  if (value.audioChannelLayout === 'off') {
    if (value.audioCodec !== null || value.audioBitrate !== null || value.audioBitrateMode !== null) {
      throw new TypeError('Audio-off alpha profiles require null audio codec, bitrate, and bitrate mode')
    }
    audioCodec = null
    audioBitrate = null
    audioBitrateMode = null
  } else {
    if (value.audioCodec !== 'opus' || value.audioBitrateMode === null) {
      throw new TypeError('Alpha video with audio requires Opus and a bitrate mode')
    }
    if (value.audioBitrateMode !== 'constant' && value.audioBitrateMode !== 'variable') {
      throw new TypeError('Alpha audio bitrate mode must be constant or variable')
    }
    assertBoundedSafeInteger(
      value.audioBitrate,
      'Alpha audio bitrate',
      MIN_EXPORT_AUDIO_BITRATE,
      MAX_EXPORT_AUDIO_BITRATE,
    )
    audioCodec = 'opus'
    audioBitrate = value.audioBitrate
    audioBitrateMode = value.audioBitrateMode
  }

  return Object.freeze({
    kind: 'alpha-video',
    container: 'webm',
    videoCodec: value.videoCodec,
    audioCodec,
    audioChannelLayout: value.audioChannelLayout,
    videoBitrate: value.videoBitrate,
    audioBitrate,
    videoBitrateMode: value.videoBitrateMode,
    audioBitrateMode,
    keyFrameIntervalMicroseconds: value.keyFrameIntervalMicroseconds,
    mimeType: 'video/webm',
    fileExtension: 'webm',
    destination: value.destination,
    chapters: parseChapterPolicy(value.chapters),
  })
}

export function validateDeliveryProfile(value: unknown): Readonly<DeliveryProfile> {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError('Delivery profile must be a tagged object')
  }
  if (value.kind === 'image-sequence') return validateImageSequenceProfile(value)
  if (value.kind === 'audio-only') return validateAudioOnlyProfile(value)
  if (value.kind === 'alpha-video') return validateAlphaVideoProfile(value)
  throw new TypeError('Delivery profile kind is not supported')
}

/** Classic video profiles and alternative products share one stored-settings parser. */
export function parseExportSettings(value: unknown): Readonly<ExportSettingsUnion> {
  if (isDeliveryProfile(value)) return validateDeliveryProfile(value)
  return validateExportProfile(value)
}

export function chapterPolicyOf(settings: Readonly<ExportSettingsUnion>): Readonly<ChapterPolicy> {
  if (isDeliveryProfile(settings)) return settings.chapters
  return DEFAULT_CHAPTER_POLICY
}

export function exportSettingsIncludesAudio(
  doc: TimelineDoc,
  settings: Readonly<ExportSettingsUnion>,
): boolean {
  if (!isDeliveryProfile(settings)) return exportProfileIncludesAudio(doc, settings)
  if (settings.kind === 'image-sequence') return false
  if (settings.kind === 'audio-only') return true
  return settings.audioChannelLayout !== 'off' && doc.tracks.some(
    (track) => track.kind === 'audio' && track.clips.length > 0,
  )
}

export function deliveryWorkBudgetReason(
  frameCount: number,
  doc: Pick<TimelineDoc, 'frameRate' | 'width' | 'height' | 'audioSampleRate'>,
  profile: Readonly<DeliveryProfile>,
): string | null {
  framesToSeconds(1, doc.frameRate)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return 'Export work facts must be positive safe integers.'
  }
  if (frameCount > MAX_EXPORT_FRAME_COUNT) {
    return `Export work exceeds the ${MAX_EXPORT_FRAME_COUNT}-frame limit.`
  }
  const durationTooLong = BigInt(frameCount) * BigInt(doc.frameRate.den)
    > BigInt(MAX_EXPORT_DURATION_SECONDS) * BigInt(doc.frameRate.num)
  if (durationTooLong) {
    return `Export duration exceeds the ${MAX_EXPORT_DURATION_SECONDS}-second limit.`
  }

  let estimated = 1_048_576n
  if (profile.kind === 'image-sequence') {
    estimated += BigInt(frameCount) * BigInt(doc.width) * BigInt(doc.height) * 4n
  } else if (profile.kind === 'audio-only') {
    const channels = profile.audioChannelLayout === 'mono' ? 1n : 2n
    const secondsNum = BigInt(frameCount) * BigInt(doc.frameRate.den)
    const sampleBytes = profile.codec === 'pcm-s16' ? 2n : 4n
    estimated += secondsNum * BigInt(doc.audioSampleRate) * channels * sampleBytes
      / BigInt(doc.frameRate.num)
  } else {
    const totalBitrate = BigInt(profile.videoBitrate + (profile.audioBitrate ?? 0))
    const payload = (BigInt(frameCount) * BigInt(doc.frameRate.den) * totalBitrate)
      / (BigInt(doc.frameRate.num) * 8n)
    estimated += (payload * 11n) / 10n
  }

  // Audio-only always builds the mix (and muxed payload) in memory, then
  // writes once. File destination does not stream, so it cannot use the
  // larger direct-file budget that classic StreamTarget export earns.
  const memoryBuffered = profile.kind === 'audio-only' || profile.destination === 'download'
  const outputLimit = memoryBuffered
    ? MAX_BUFFERED_EXPORT_ESTIMATE_BYTES
    : MAX_DIRECT_EXPORT_ESTIMATE_BYTES
  if (estimated > BigInt(outputLimit)) {
    if (memoryBuffered) {
      return profile.kind === 'audio-only'
        ? 'Estimated output exceeds the memory-buffered export limit. Shorten the range.'
        : 'Estimated output exceeds the memory-buffered export limit. Choose a folder or shorten the range.'
    }
    return 'Estimated output exceeds the direct-file export limit.'
  }
  return null
}

export function assertDeliveryWorkBudget(
  frameCount: number,
  doc: Pick<TimelineDoc, 'frameRate' | 'width' | 'height' | 'audioSampleRate'>,
  profile: Readonly<DeliveryProfile>,
): void {
  const reason = deliveryWorkBudgetReason(frameCount, doc, profile)
  if (reason) throw new RangeError(reason)
}

export const DEFAULT_IMAGE_SEQUENCE_PROFILE: Readonly<ImageSequenceProfile> = validateDeliveryProfile({
  kind: 'image-sequence',
  format: 'png',
  destination: 'download',
  fileNamePrefix: 'frame',
  overwriteExisting: false,
  chapters: { mode: 'off' },
}) as ImageSequenceProfile

export const DEFAULT_AUDIO_ONLY_PROFILE: Readonly<AudioOnlyProfile> = validateDeliveryProfile({
  kind: 'audio-only',
  container: 'wav',
  codec: 'pcm-s16',
  audioChannelLayout: 'stereo',
  audioBitrate: null,
  audioBitrateMode: null,
  mimeType: 'audio/wav',
  fileExtension: 'wav',
  destination: 'download',
  chapters: { mode: 'off' },
}) as AudioOnlyProfile

export const DEFAULT_ALPHA_VIDEO_PROFILE: Readonly<AlphaVideoProfile> = validateDeliveryProfile({
  kind: 'alpha-video',
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
  chapters: { mode: 'off' },
}) as AlphaVideoProfile

export function alphaVideoAsExportProfile(
  profile: Readonly<AlphaVideoProfile>,
): Readonly<ExportProfile> {
  return validateExportProfile({
    container: 'webm',
    videoCodec: profile.videoCodec,
    audioCodec: profile.audioCodec,
    audioChannelLayout: profile.audioChannelLayout,
    videoBitrate: profile.videoBitrate,
    audioBitrate: profile.audioBitrate,
    videoBitrateMode: profile.videoBitrateMode,
    audioBitrateMode: profile.audioBitrateMode,
    keyFrameIntervalMicroseconds: profile.keyFrameIntervalMicroseconds,
    mimeType: 'video/webm',
    fileExtension: 'webm',
    destination: profile.destination,
  })
}

export function assertChapterDelivery(
  destination: 'download' | 'file' | 'directory',
  chapters: Readonly<ChapterPolicy>,
): void {
  if (chapters.mode !== 'sidecar') return
  if (destination === 'file') {
    throw new Error(
      'Chapter sidecars cannot be stored inside a single media file. Choose a browser download ZIP or a PNG folder.',
    )
  }
}

export function deliveryProductLabel(profile: Readonly<DeliveryProfile>): string {
  if (profile.kind === 'image-sequence') return 'PNG image sequence'
  if (profile.kind === 'audio-only') {
    if (profile.codec === 'pcm-s16') return 'WAV PCM audio'
    if (profile.codec === 'aac') return 'M4A AAC audio'
    return 'WebM Opus audio'
  }
  return profile.videoCodec === 'av1' ? 'WebM AV1 with alpha' : 'WebM VP9 with alpha'
}

export function deliveryFileExtension(
  settings: Readonly<ExportSettingsUnion>,
  chapters: Readonly<ChapterPolicy> = chapterPolicyOf(settings),
): string {
  if (isImageSequenceProfile(settings)) {
    return settings.destination === 'download' || chapters.mode === 'sidecar' ? 'zip' : 'png'
  }
  if (chapters.mode === 'sidecar' && settings.destination === 'download') return 'zip'
  return settings.fileExtension
}
