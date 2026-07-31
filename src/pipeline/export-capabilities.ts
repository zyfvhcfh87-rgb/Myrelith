/**
 * Capability coordination for concrete export profiles.
 *
 * Mediabunny is injected so this module can test containment, exact probe
 * arguments, Auto policy inputs, and changed-support behavior without browser
 * globals. The real adapter lives in export-mediabunny-capabilities.ts.
 */

import {
  exportProfileIncludesAudio,
  validateExportProfile,
  type ExportAudioCodec,
  type ExportBitrateMode,
  type ExportContainer,
  type ExportProfile,
  type ExportVideoCodec,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { framesToSeconds } from '../domain/time'

export { exportProfileIncludesAudio } from '../domain/exportProfile'

export interface ExportFormatCapabilities {
  /** Mediabunny format extensions include their leading dot. */
  readonly fileExtension: string
  readonly mimeType: string
  getSupportedVideoCodecs(): readonly string[]
  getSupportedAudioCodecs(): readonly string[]
}

export interface ExportVideoCapabilityOptions {
  readonly width: number
  readonly height: number
  readonly bitrate: number
  readonly bitrateMode: ExportBitrateMode
}

export interface ExportAudioCapabilityOptions {
  readonly numberOfChannels: 1 | 2
  readonly sampleRate: number
  readonly bitrate: number
  readonly bitrateMode: ExportBitrateMode
}

export interface ExportCapabilityProbe {
  createFormat(container: ExportContainer): ExportFormatCapabilities
  getImplementationUnavailableReason(
    profile: Readonly<ExportProfile>,
    includeAudio: boolean,
  ): string | null
  canEncodeVideo(
    codec: ExportVideoCodec,
    options: ExportVideoCapabilityOptions,
  ): Promise<boolean>
  canEncodeAudio(
    codec: ExportAudioCodec,
    options: ExportAudioCapabilityOptions,
  ): Promise<boolean>
  freshEncode(
    doc: TimelineDoc,
    profile: Readonly<ExportProfile>,
    includeAudio: boolean,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface ExportCapabilityResult {
  readonly profile: Readonly<ExportProfile>
  readonly supported: boolean
  readonly reason: string | null
}

export const OPUS_EXACT_DURATION_UNAVAILABLE_REASON =
  'WebM/Opus audio export is temporarily unavailable because the installed ' +
  'media muxer cannot write exact Opus end-padding metadata.'

function unsupported(
  profile: Readonly<ExportProfile>,
  reason: string,
): Readonly<ExportCapabilityResult> {
  return Object.freeze({ profile, supported: false, reason })
}

function supported(
  profile: Readonly<ExportProfile>,
): Readonly<ExportCapabilityResult> {
  return Object.freeze({ profile, supported: true, reason: null })
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim()
  }
  return String(cause)
}

function assertCapabilityDocument(doc: TimelineDoc): void {
  if (!Number.isSafeInteger(doc.width) || doc.width <= 0) {
    throw new RangeError('Export capability width must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.height) || doc.height <= 0) {
    throw new RangeError('Export capability height must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.audioSampleRate) || doc.audioSampleRate <= 0) {
    throw new RangeError(
      'Export capability audio sample rate must be a positive safe integer',
    )
  }
  framesToSeconds(1, doc.frameRate)
}

export function exportAudioChannelCount(
  profile: ExportProfile,
): 0 | 1 | 2 {
  if (profile.audioChannelLayout === 'off') return 0
  return profile.audioChannelLayout === 'mono' ? 1 : 2
}

interface StaticCapability {
  readonly profile: Readonly<ExportProfile>
  readonly includeAudio: boolean
}

function inspectStaticCapability(
  doc: TimelineDoc,
  value: ExportProfile,
  probe: ExportCapabilityProbe,
): StaticCapability | Readonly<ExportCapabilityResult> {
  assertCapabilityDocument(doc)
  const profile = validateExportProfile(value)
  let format: ExportFormatCapabilities
  try {
    format = probe.createFormat(profile.container)
  } catch (cause) {
    return unsupported(
      profile,
      `Could not inspect ${profile.container.toUpperCase()} container support: ` +
        errorMessage(cause),
    )
  }

  try {
    if (
      format.mimeType !== profile.mimeType ||
      format.fileExtension !== `.${profile.fileExtension}`
    ) {
      return unsupported(
        profile,
        `The installed ${profile.container.toUpperCase()} adapter reports ` +
          `${format.mimeType} and ${format.fileExtension}, not ` +
          `${profile.mimeType} and .${profile.fileExtension}.`,
      )
    }
    if (!format.getSupportedVideoCodecs().includes(profile.videoCodec)) {
      return unsupported(
        profile,
        `${profile.container.toUpperCase()} cannot contain ${profile.videoCodec.toUpperCase()} video.`,
      )
    }
    if (
      profile.audioCodec !== null &&
      !format.getSupportedAudioCodecs().includes(profile.audioCodec)
    ) {
      return unsupported(
        profile,
        `${profile.container.toUpperCase()} cannot contain ${profile.audioCodec.toUpperCase()} audio.`,
      )
    }
  } catch (cause) {
    return unsupported(
      profile,
      `Could not inspect ${profile.container.toUpperCase()} container support: ` +
        errorMessage(cause),
    )
  }

  const includeAudio = exportProfileIncludesAudio(doc, profile)
  if (includeAudio && profile.audioCodec === 'opus') {
    return unsupported(profile, OPUS_EXACT_DURATION_UNAVAILABLE_REASON)
  }
  const implementationReason = probe.getImplementationUnavailableReason(
    profile,
    includeAudio,
  )
  if (implementationReason !== null) {
    return unsupported(profile, implementationReason)
  }
  return { profile, includeAudio }
}

function isCapabilityResult(
  value: StaticCapability | Readonly<ExportCapabilityResult>,
): value is Readonly<ExportCapabilityResult> {
  return Object.hasOwn(value, 'supported')
}

/**
 * Responsive, memoization-tolerant UI hint. This is not the Start authority;
 * verifyExportProfileSupportFresh performs a disposable real encode later.
 */
export async function checkExportProfileSupport(
  doc: TimelineDoc,
  value: ExportProfile,
  probe: ExportCapabilityProbe,
): Promise<Readonly<ExportCapabilityResult>> {
  const inspected = inspectStaticCapability(doc, value, probe)
  if (isCapabilityResult(inspected)) return inspected
  const { profile, includeAudio } = inspected

  let videoSupported: boolean
  try {
    videoSupported = await probe.canEncodeVideo(profile.videoCodec, {
      width: doc.width,
      height: doc.height,
      bitrate: profile.videoBitrate,
      bitrateMode: profile.videoBitrateMode,
    })
  } catch (cause) {
    return unsupported(
      profile,
      `Could not check ${profile.videoCodec.toUpperCase()} video support: ` +
        errorMessage(cause),
    )
  }
  if (!videoSupported) {
    return unsupported(
      profile,
      `This browser cannot encode ${profile.videoCodec.toUpperCase()} video ` +
        `at ${doc.width} x ${doc.height} and ${profile.videoBitrate} bps.`,
    )
  }

  if (!includeAudio || profile.audioChannelLayout === 'off') {
    return supported(profile)
  }

  let audioSupported: boolean
  try {
    audioSupported = await probe.canEncodeAudio(profile.audioCodec, {
      numberOfChannels: profile.audioChannelLayout === 'mono' ? 1 : 2,
      sampleRate: doc.audioSampleRate,
      bitrate: profile.audioBitrate,
      bitrateMode: profile.audioBitrateMode,
    })
  } catch (cause) {
    return unsupported(
      profile,
      `Could not check ${profile.audioCodec.toUpperCase()} audio support: ` +
        errorMessage(cause),
    )
  }
  if (!audioSupported) {
    return unsupported(
      profile,
      `This browser cannot encode ${profile.audioCodec.toUpperCase()} ` +
        `${profile.audioChannelLayout} audio at ${doc.audioSampleRate} Hz and ` +
        `${profile.audioBitrate} bps.`,
    )
  }
  return supported(profile)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Export capability check was canceled')
  error.name = 'AbortError'
  throw error
}

/**
 * Authoritative immediately-before-start check. It bypasses Mediabunny's
 * memoized canEncode helpers by configuring and encoding through real sources.
 */
export async function verifyExportProfileSupportFresh(
  doc: TimelineDoc,
  value: ExportProfile,
  probe: ExportCapabilityProbe,
  signal?: AbortSignal,
): Promise<Readonly<ExportCapabilityResult>> {
  throwIfAborted(signal)
  const inspected = inspectStaticCapability(doc, value, probe)
  if (isCapabilityResult(inspected)) return inspected
  const { profile, includeAudio } = inspected

  try {
    await probe.freshEncode(doc, profile, includeAudio, signal)
    throwIfAborted(signal)
    return supported(profile)
  } catch (cause) {
    throwIfAborted(signal)
    return unsupported(
      profile,
      `${profile.container.toUpperCase()}/${profile.videoCodec.toUpperCase()} ` +
        `became unavailable before encoding started: ${errorMessage(cause)} ` +
        'No codec was substituted.',
    )
  }
}
