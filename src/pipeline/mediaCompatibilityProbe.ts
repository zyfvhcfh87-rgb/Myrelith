/**
 * Content-based, metadata-only media compatibility probe.
 *
 * Layering: pipeline/ -> domain/ only. The selected File is read through a
 * bounded Mediabunny Input, every track is checked with its real decoder
 * configuration, and the Input is disposed exactly once on every path.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Input,
  UnsupportedInputFormatError,
} from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny'
import type {
  MediaCompatibilityReport,
  MediaDecoderConfigSummary,
  MediaTrackCompatibility,
  SettledMediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import type { FrameRate, MediaAsset } from '../domain/schema'
import {
  microsecondsDurationToFrames,
  secondsToMicroseconds,
  snapToStandardRate,
} from '../domain/time'
import { serializeDecoderConfig } from './demux'

const FPS_SAMPLE_PACKETS = 120
const MAX_PROBE_CONCURRENCY = 4
const MAX_DIAGNOSTIC_TOKEN_CHARACTERS = 256
const MAX_DIAGNOSTIC_DETAIL_CHARACTERS = 2_048

/** Hard ceilings reflect the current frame-count-bounded decoder caches. */
export const MEDIA_PROBE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024 * 1024,
  maxTracks: 64,
  maxDecoderDescriptionBytes: 1024 * 1024,
  maxDimension: 8192,
  maxPixelsPerFrame: 4096 * 2160,
  maxDurationMicroseconds: 24 * 60 * 60 * 1_000_000,
  maxFramesPerSecond: 240,
  maxAudioSampleRate: 384_000,
  maxAudioChannels: 32,
})

export type MediaProbeResult =
  | {
      status: 'ready'
      asset: MediaAsset
      compatibility: MediaCompatibilityReport
    }
  | {
      status: Exclude<SettledMediaCompatibilityStatus, 'ready'>
      asset: null
      compatibility: MediaCompatibilityReport
    }

interface VideoProbe {
  report: MediaTrackCompatibility
  decoderConfig: VideoDecoderConfig | null
}

interface AudioProbe {
  report: MediaTrackCompatibility
}

interface ProbeCoreResult {
  compatibility: MediaCompatibilityReport
  primaryVideo: VideoProbe | null
  primaryAudio: AudioProbe | null
}

function makeAbortError(): Error {
  const error = new Error('Media compatibility check was cancelled')
  error.name = 'AbortError'
  return error
}

export function isMediaProbeCancellation(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

function descriptionByteLength(
  description: AllowSharedBufferSource | undefined,
): number {
  if (description === undefined) return 0
  if (ArrayBuffer.isView(description)) return description.byteLength
  return (description as ArrayBuffer).byteLength
}

function boundedDiagnosticText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, maxCharacters - 1)}…`
}

function boundedDiagnosticToken(value: string | null): string | null {
  return value === null
    ? null
    : boundedDiagnosticText(value, MAX_DIAGNOSTIC_TOKEN_CHARACTERS)
}

function decoderCodecProblem(
  config: VideoDecoderConfig | AudioDecoderConfig | null,
  kind: 'video' | 'audio',
): { reason: 'malformed-media' | 'resource-limit'; detail: string } | null {
  if (!config) return null
  if (typeof config.codec !== 'string' || config.codec.length === 0) {
    return {
      reason: 'malformed-media',
      detail: `The ${kind} decoder codec identifier is missing or invalid.`,
    }
  }
  if (config.codec.length > MAX_DIAGNOSTIC_TOKEN_CHARACTERS) {
    return {
      reason: 'resource-limit',
      detail: `The ${kind} decoder codec identifier exceeds WebCut's diagnostic safety limit.`,
    }
  }
  return null
}

function videoConfigSummary(
  config: VideoDecoderConfig | null,
): MediaDecoderConfigSummary | null {
  if (!config) return null
  return {
    codec: boundedDiagnosticText(
      config.codec,
      MAX_DIAGNOSTIC_TOKEN_CHARACTERS,
    ),
    descriptionBytes: descriptionByteLength(config.description),
    codedWidth: config.codedWidth ?? null,
    codedHeight: config.codedHeight ?? null,
    sampleRate: null,
    channels: null,
  }
}

function audioConfigSummary(
  config: AudioDecoderConfig | null,
): MediaDecoderConfigSummary | null {
  if (!config) return null
  return {
    codec: boundedDiagnosticText(
      config.codec,
      MAX_DIAGNOSTIC_TOKEN_CHARACTERS,
    ),
    descriptionBytes: descriptionByteLength(config.description),
    codedWidth: null,
    codedHeight: null,
    sampleRate: config.sampleRate,
    channels: config.numberOfChannels,
  }
}

function serializeInternalCodecId(
  value: string | number | Uint8Array<ArrayBufferLike> | null,
): string | null {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number') {
    return boundedDiagnosticText(
      String(value),
      MAX_DIAGNOSTIC_TOKEN_CHARACTERS,
    )
  }
  const shown = value.subarray(0, 64)
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `0x${hex}${value.length > shown.length ? '…' : ''}`
}

function emptyTrack(
  kind: 'video' | 'audio',
  number: number,
  primary: boolean,
  detail: string,
): MediaTrackCompatibility {
  return {
    kind,
    number,
    primary,
    codec: null,
    codecParameter: null,
    internalCodecId: null,
    decoderConfig: null,
    decodable: false,
    reason: 'malformed-media',
    detail,
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
  }
}

function videoResourceProblem(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number,
  averagePacketRate: number,
  decoderDescriptionBytes: number,
): { reason: 'malformed-media' | 'resource-limit'; detail: string } | null {
  if (
    !Number.isSafeInteger(codedWidth)
    || !Number.isSafeInteger(codedHeight)
    || !Number.isSafeInteger(displayWidth)
    || !Number.isSafeInteger(displayHeight)
    || codedWidth <= 0
    || codedHeight <= 0
    || displayWidth <= 0
    || displayHeight <= 0
  ) {
    return {
      reason: 'malformed-media',
      detail: 'Video dimensions are not positive safe integers.',
    }
  }
  if (
    codedWidth > MEDIA_PROBE_LIMITS.maxDimension
    || codedHeight > MEDIA_PROBE_LIMITS.maxDimension
  ) {
    return {
      reason: 'resource-limit',
      detail: `${codedWidth}×${codedHeight} exceeds WebCut's ${MEDIA_PROBE_LIMITS.maxDimension}px coded-dimension limit.`,
    }
  }
  if (
    displayWidth > MEDIA_PROBE_LIMITS.maxDimension
    || displayHeight > MEDIA_PROBE_LIMITS.maxDimension
  ) {
    return {
      reason: 'resource-limit',
      detail: `${displayWidth}×${displayHeight} exceeds WebCut's ${MEDIA_PROBE_LIMITS.maxDimension}px display-dimension limit.`,
    }
  }
  const codedPixels = codedWidth * codedHeight
  if (
    !Number.isSafeInteger(codedPixels)
    || codedPixels > MEDIA_PROBE_LIMITS.maxPixelsPerFrame
  ) {
    return {
      reason: 'resource-limit',
      detail: `${codedWidth}×${codedHeight} exceeds WebCut's safe pixels-per-frame limit.`,
    }
  }
  const displayPixels = displayWidth * displayHeight
  if (
    !Number.isSafeInteger(displayPixels)
    || displayPixels > MEDIA_PROBE_LIMITS.maxPixelsPerFrame
  ) {
    return {
      reason: 'resource-limit',
      detail: `${displayWidth}×${displayHeight} exceeds WebCut's safe display-pixels limit.`,
    }
  }
  if (!Number.isFinite(averagePacketRate) || averagePacketRate <= 0) {
    return {
      reason: 'malformed-media',
      detail: 'Video frame timing could not be determined.',
    }
  }
  if (averagePacketRate > MEDIA_PROBE_LIMITS.maxFramesPerSecond) {
    return {
      reason: 'resource-limit',
      detail: `${averagePacketRate.toFixed(3)} fps exceeds WebCut's safe frame-rate limit.`,
    }
  }
  if (decoderDescriptionBytes > MEDIA_PROBE_LIMITS.maxDecoderDescriptionBytes) {
    return {
      reason: 'resource-limit',
      detail: 'The video decoder configuration exceeds WebCut\'s 1 MiB safety limit.',
    }
  }
  return null
}

function audioResourceProblem(
  sampleRate: number,
  channels: number,
  decoderDescriptionBytes: number,
): { reason: 'malformed-media' | 'resource-limit'; detail: string } | null {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    return {
      reason: 'malformed-media',
      detail: 'The audio sample rate is not a positive safe integer.',
    }
  }
  if (sampleRate > MEDIA_PROBE_LIMITS.maxAudioSampleRate) {
    return {
      reason: 'resource-limit',
      detail: `${sampleRate} Hz exceeds WebCut's safe audio sample-rate limit.`,
    }
  }
  if (!Number.isSafeInteger(channels) || channels <= 0) {
    return {
      reason: 'malformed-media',
      detail: 'The audio channel count is not a positive safe integer.',
    }
  }
  if (channels > MEDIA_PROBE_LIMITS.maxAudioChannels) {
    return {
      reason: 'resource-limit',
      detail: `${channels} audio channels exceeds WebCut's safe channel-count limit.`,
    }
  }
  if (decoderDescriptionBytes > MEDIA_PROBE_LIMITS.maxDecoderDescriptionBytes) {
    return {
      reason: 'resource-limit',
      detail: 'The audio decoder configuration exceeds WebCut\'s 1 MiB safety limit.',
    }
  }
  return null
}

async function probeVideoTrack(
  track: InputVideoTrack,
  number: number,
  primary: boolean,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  try {
    const [
      codec,
      codecParameter,
      internalCodecId,
      decoderConfig,
      codedWidth,
      codedHeight,
      displayWidth,
      displayHeight,
      stats,
    ] = await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getInternalCodecId(),
      track.getDecoderConfig(),
      track.getCodedWidth(),
      track.getCodedHeight(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.computePacketStats(FPS_SAMPLE_PACKETS),
    ])
    throwIfAborted(signal)

    const decoderConfigSummary = videoConfigSummary(decoderConfig)
    const problem = (
      videoResourceProblem(
        codedWidth,
        codedHeight,
        displayWidth,
        displayHeight,
        stats.averagePacketRate,
        decoderConfigSummary?.descriptionBytes ?? 0,
      )
      ?? (decoderConfigSummary
        ? videoResourceProblem(
            decoderConfigSummary.codedWidth ?? codedWidth,
            decoderConfigSummary.codedHeight ?? codedHeight,
            decoderConfig?.displayAspectWidth ?? displayWidth,
            decoderConfig?.displayAspectHeight ?? displayHeight,
            stats.averagePacketRate,
            0,
          )
        : null)
      ?? decoderCodecProblem(decoderConfig, 'video')
    )
    const frameRate = problem
      ? null
      : snapToStandardRate(stats.averagePacketRate)
    let decodable = false
    let reason: MediaTrackCompatibility['reason'] = null
    let detail: string | null = null

    if (problem) {
      reason = problem.reason
      detail = problem.detail
    } else if (!codec) {
      reason = 'unknown-codec'
      detail = 'WebCut could not identify this video track codec.'
    } else if (!decoderConfig) {
      reason = 'malformed-media'
      detail = 'The video decoder configuration is missing or invalid.'
    } else {
      try {
        decodable = await track.canDecode()
        throwIfAborted(signal)
        if (!decodable) {
          reason = 'unsupported-codec'
          detail = 'This browser cannot decode this video codec.'
        }
      } catch (cause) {
        if (signal?.aborted) throw makeAbortError()
        const failure = boundedDiagnosticText(
          cause instanceof Error ? cause.message : String(cause),
          MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
        )
        reason = 'decode-failed'
        detail = `The video decoder compatibility check failed: ${failure}`
      }
    }

    return {
      report: {
        kind: 'video',
        number,
        primary,
        codec: boundedDiagnosticToken(codec),
        codecParameter: boundedDiagnosticToken(codecParameter),
        internalCodecId: serializeInternalCodecId(internalCodecId),
        decoderConfig: decoderConfigSummary,
        decodable,
        reason,
        detail,
        width: displayWidth,
        height: displayHeight,
        codedWidth,
        codedHeight,
        frameRate,
        sampleRate: null,
        channels: null,
      },
      decoderConfig,
    }
  } catch (cause) {
    if (signal?.aborted) throw makeAbortError()
    const detail = boundedDiagnosticText(
      cause instanceof Error ? cause.message : String(cause),
      MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
    )
    return {
      report: emptyTrack(
        'video',
        number,
        primary,
        `The video track metadata check failed: ${detail}`,
      ),
      decoderConfig: null,
    }
  }
}

async function probeAudioTrack(
  track: InputAudioTrack,
  number: number,
  primary: boolean,
  signal?: AbortSignal,
): Promise<AudioProbe> {
  try {
    const [
      codec,
      codecParameter,
      internalCodecId,
      decoderConfig,
      sampleRate,
      channels,
    ] = await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getInternalCodecId(),
      track.getDecoderConfig(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ])
    throwIfAborted(signal)

    const decoderConfigSummary = audioConfigSummary(decoderConfig)
    const problem = (
      audioResourceProblem(
        sampleRate,
        channels,
        decoderConfigSummary?.descriptionBytes ?? 0,
      )
      ?? (decoderConfigSummary
        ? audioResourceProblem(
            decoderConfigSummary.sampleRate ?? sampleRate,
            decoderConfigSummary.channels ?? channels,
            0,
          )
        : null)
      ?? decoderCodecProblem(decoderConfig, 'audio')
    )
    let decodable = false
    let reason: MediaTrackCompatibility['reason'] = null
    let detail: string | null = null
    if (problem) {
      reason = problem.reason
      detail = problem.detail
    } else if (!codec) {
      reason = 'unknown-codec'
      detail = 'WebCut could not identify this audio track codec.'
    } else if (!decoderConfig) {
      reason = 'malformed-media'
      detail = 'The audio decoder configuration is missing or invalid.'
    } else {
      try {
        decodable = await track.canDecode()
        throwIfAborted(signal)
        if (!decodable) {
          reason = 'unsupported-codec'
          detail = 'This browser cannot decode this audio codec.'
        }
      } catch (cause) {
        if (signal?.aborted) throw makeAbortError()
        const failure = boundedDiagnosticText(
          cause instanceof Error ? cause.message : String(cause),
          MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
        )
        reason = 'decode-failed'
        detail = `The audio decoder compatibility check failed: ${failure}`
      }
    }

    return {
      report: {
        kind: 'audio',
        number,
        primary,
        codec: boundedDiagnosticToken(codec),
        codecParameter: boundedDiagnosticToken(codecParameter),
        internalCodecId: serializeInternalCodecId(internalCodecId),
        decoderConfig: decoderConfigSummary,
        decodable,
        reason,
        detail,
        width: null,
        height: null,
        codedWidth: null,
        codedHeight: null,
        frameRate: null,
        sampleRate,
        channels,
      },
    }
  } catch (cause) {
    if (signal?.aborted) throw makeAbortError()
    const detail = boundedDiagnosticText(
      cause instanceof Error ? cause.message : String(cause),
      MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
    )
    return {
      report: emptyTrack(
        'audio',
        number,
        primary,
        `The audio track metadata check failed: ${detail}`,
      ),
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const run = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await worker(values[index], index)
    }
  }
  const workers = Array.from(
    { length: Math.min(MAX_PROBE_CONCURRENCY, values.length) },
    () => run(),
  )
  await Promise.all(workers)
  return results
}

function fileFailure(
  status: Extract<SettledMediaCompatibilityStatus, 'unsupported' | 'error'>,
  reason: MediaCompatibilityReport['reason'],
  detail: string,
): ProbeCoreResult {
  return {
    compatibility: {
      status,
      container: null,
      durationMicroseconds: null,
      tracks: [],
      reason,
      detail,
    },
    primaryVideo: null,
    primaryAudio: null,
  }
}

function settledStatus(
  tracks: readonly MediaTrackCompatibility[],
): SettledMediaCompatibilityStatus {
  const decodable = tracks.filter((track) => track.decodable).length
  if (decodable === tracks.length) return 'ready'
  if (decodable > 0) return 'limited'
  if (tracks.some((track) => (
    track.reason === 'decode-failed' || track.reason === 'malformed-media'
  ))) {
    return 'error'
  }
  return 'unsupported'
}

function detectedFullMimeType(
  mimeType: string,
  tracks: readonly MediaTrackCompatibility[],
): string {
  const hasVideo = tracks.some((track) => track.kind === 'video')
  const hasAudio = tracks.some((track) => track.kind === 'audio')
  const detectedBase = !hasVideo && hasAudio && mimeType.startsWith('video/')
    ? `audio/${mimeType.slice('video/'.length)}`
    : mimeType
  const codecs = tracks
    .map((track) => (
      track.codecParameter ?? track.decoderConfig?.codec ?? track.codec
    ))
    .filter((codec): codec is string => Boolean(codec))
  const uniqueCodecs = [...new Set(codecs)]
  return uniqueCodecs.length === 0
    ? detectedBase
    : `${detectedBase}; codecs="${uniqueCodecs.join(', ')}"`
}

async function probeOpenedInput(
  input: Input,
  fileName: string,
  signal?: AbortSignal,
): Promise<ProbeCoreResult> {
  throwIfAborted(signal)
  if (!(await input.canRead())) {
    return fileFailure(
      'unsupported',
      'unsupported-container',
      `"${fileName}" is not a supported media container.`,
    )
  }
  throwIfAborted(signal)

  const [format, allTracks] = await Promise.all([
    input.getFormat(),
    input.getTracks(),
  ])
  throwIfAborted(signal)
  let container = {
    name: format.name,
    mimeType: format.mimeType,
    fullMimeType: format.mimeType,
  }
  const trackCount = allTracks.length
  if (trackCount > MEDIA_PROBE_LIMITS.maxTracks) {
    return {
      compatibility: {
        status: 'unsupported',
        container,
        durationMicroseconds: null,
        tracks: [],
        reason: 'resource-limit',
        detail: `${trackCount} media tracks exceeds WebCut's ${MEDIA_PROBE_LIMITS.maxTracks}-track safety limit.`,
      },
      primaryVideo: null,
      primaryAudio: null,
    }
  }
  const videoTracks = allTracks.filter(
    (track): track is InputVideoTrack => track.isVideoTrack(),
  )
  const audioTracks = allTracks.filter(
    (track): track is InputAudioTrack => track.isAudioTrack(),
  )
  if (videoTracks.length + audioTracks.length === 0) {
    return {
      compatibility: {
        status: 'unsupported',
        container,
        durationMicroseconds: null,
        tracks: [],
        reason: 'unsupported-container',
        detail: `"${fileName}" contains no video or audio track.`,
      },
      primaryVideo: null,
      primaryAudio: null,
    }
  }

  const [primaryVideoTrack, primaryAudioTrack] = await Promise.all([
    input.getPrimaryVideoTrack().catch(() => null),
    input.getPrimaryAudioTrack().catch(() => null),
  ])
  const primaryVideo = primaryVideoTrack ?? videoTracks[0] ?? null
  const primaryAudio = primaryAudioTrack ?? audioTracks[0] ?? null
  const combinedTracks = [
    ...videoTracks.map((track, index) => ({
      kind: 'video' as const,
      track,
      number: index + 1,
      primary: track === primaryVideo,
    })),
    ...audioTracks.map((track, index) => ({
      kind: 'audio' as const,
      track,
      number: index + 1,
      primary: track === primaryAudio,
    })),
  ]
  const [durationSec, probes] = await Promise.all([
    input.computeDuration([...videoTracks, ...audioTracks]),
    mapWithConcurrency(combinedTracks, async (entry) => (
      entry.kind === 'video'
        ? probeVideoTrack(
            entry.track,
            entry.number,
            entry.primary,
            signal,
          )
        : probeAudioTrack(
            entry.track,
            entry.number,
            entry.primary,
            signal,
          )
    )),
  ])
  throwIfAborted(signal)

  const tracks = probes.map((probe) => probe.report)
  container = {
    ...container,
    fullMimeType: detectedFullMimeType(container.mimeType, tracks),
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      compatibility: {
        status: 'error',
        container,
        durationMicroseconds: null,
        tracks,
        reason: 'malformed-media',
        detail: 'The media duration is missing or invalid.',
      },
      primaryVideo: null,
      primaryAudio: null,
    }
  }
  if (
    durationSec
    > MEDIA_PROBE_LIMITS.maxDurationMicroseconds / 1_000_000
  ) {
    return {
      compatibility: {
        status: 'unsupported',
        container,
        durationMicroseconds: null,
        tracks,
        reason: 'resource-limit',
        detail: 'The media duration exceeds WebCut\'s 24-hour safety limit.',
      },
      primaryVideo: null,
      primaryAudio: null,
    }
  }
  const durationMicroseconds = secondsToMicroseconds(durationSec)

  const status = settledStatus(tracks)
  const firstFailure = tracks.find((track) => !track.decodable)
  return {
    compatibility: {
      status,
      container,
      durationMicroseconds,
      tracks,
      reason: firstFailure?.reason ?? null,
      detail: status === 'limited'
        ? 'Some media tracks are not usable in this browser.'
        : status === 'unsupported'
          ? 'No media track is usable in this browser.'
          : null,
    },
    primaryVideo: probes.find(
      (probe): probe is VideoProbe => (
        probe.report.kind === 'video' && probe.report.primary
      ),
    ) ?? null,
    primaryAudio: probes.find(
      (probe): probe is AudioProbe => (
        probe.report.kind === 'audio' && probe.report.primary
      ),
    ) ?? null,
  }
}

/**
 * Probe actual file bytes, metadata, and decoder support without decoding the
 * movie. The optional signal cancels in-flight reads by disposing the Input.
 */
export async function probeMediaFile(
  file: File,
  docRate: FrameRate,
  assetId: string,
  signal?: AbortSignal,
): Promise<MediaProbeResult> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    const compatibility = fileFailure(
      'error',
      'malformed-media',
      `"${file.name}" is empty or has an invalid file size.`,
    ).compatibility
    return { status: 'error', asset: null, compatibility }
  }
  if (file.size > MEDIA_PROBE_LIMITS.maxFileBytes) {
    const compatibility = fileFailure(
      'unsupported',
      'resource-limit',
      `"${file.name}" exceeds WebCut's 64 GiB media-file safety limit.`,
    ).compatibility
    return { status: 'unsupported', asset: null, compatibility }
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  let disposed = false
  const disposeOnce = (): void => {
    if (disposed) return
    disposed = true
    input.dispose()
  }
  const abort = (): void => {
    try {
      disposeOnce()
    } catch {
      // The awaited read still settles and the signal remains authoritative.
    }
  }
  signal?.addEventListener('abort', abort, { once: true })

  let core: ProbeCoreResult
  try {
    core = await probeOpenedInput(input, file.name, signal)
  } catch (cause) {
    if (signal?.aborted) throw makeAbortError()
    if (cause instanceof UnsupportedInputFormatError) {
      core = fileFailure(
        'unsupported',
        'unsupported-container',
        `"${file.name}" is not a supported media container.`,
      )
    } else {
      const detail = boundedDiagnosticText(
        cause instanceof Error ? cause.message : String(cause),
        MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
      )
      core = fileFailure(
        'error',
        'malformed-media',
        `The media is damaged or incomplete: ${detail}`,
      )
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    disposeOnce()
  }

  if (core.compatibility.status !== 'ready') {
    return {
      status: core.compatibility.status,
      asset: null,
      compatibility: core.compatibility,
    }
  }

  const video = core.primaryVideo?.report ?? null
  const audio = core.primaryAudio?.report ?? null
  const durationMicroseconds = core.compatibility.durationMicroseconds
  if (durationMicroseconds === null) {
    throw new Error('A ready compatibility report must include media duration')
  }
  const durationFrames = microsecondsDurationToFrames(
    durationMicroseconds,
    docRate,
  )
  const decoderConfigB64 = core.primaryVideo?.decoderConfig
    ? serializeDecoderConfig(core.primaryVideo.decoderConfig)
    : null
  const objectUrl = URL.createObjectURL(file)
  const asset: MediaAsset = {
    id: assetId,
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
    lastModified: file.lastModified,
    objectUrl,
    kind: video ? 'video' : 'audio',
    durationFrames,
    durationMicroseconds,
    frameRate: video?.frameRate ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: audio !== null,
    audioSampleRate: audio?.sampleRate ?? null,
    audioChannels: audio?.channels ?? null,
    decoderConfigB64,
  }
  return { status: 'ready', asset, compatibility: core.compatibility }
}
