/**
 * Serializable media-capability facts shared by the probe, session state,
 * and UI. This module deliberately contains no browser APIs or live media
 * resources, so compatibility never leaks into TimelineDoc or persistence.
 */

import type { FrameRate } from './schema'

export type MediaCompatibilityReason =
  | 'unsupported-container'
  | 'unknown-codec'
  | 'unsupported-codec'
  | 'malformed-media'
  | 'resource-limit'
  | 'decode-failed'

export type MediaCompatibilityStatus =
  | 'checking'
  | 'ready'
  | 'limited'
  | 'unsupported'
  | 'error'

export type SettledMediaCompatibilityStatus = Exclude<
  MediaCompatibilityStatus,
  'checking'
>

export interface MediaContainerCompatibility {
  /** Format detected from bytes, never from the filename or declared MIME. */
  name: string
  /** Typical base MIME type reported by the detected container format. */
  mimeType: string
  /** Full detected MIME string, including codec parameters when available. */
  fullMimeType: string
}

export interface MediaDecoderConfigSummary {
  codec: string
  descriptionBytes: number
  codedWidth: number | null
  codedHeight: number | null
  sampleRate: number | null
  channels: number | null
}

export interface MediaTrackCompatibility {
  kind: 'video' | 'audio'
  /** One-based index among tracks of the same kind. */
  number: number
  primary: boolean
  /** Mediabunny's normalized codec name, for example `avc` or `aac`. */
  codec: string | null
  /** Full WebCodecs parameter string, for example `avc1.640028`. */
  codecParameter: string | null
  /** Container-specific codec identifier, serialized for diagnostics. */
  internalCodecId: string | null
  decoderConfig: MediaDecoderConfigSummary | null
  decodable: boolean
  reason: MediaCompatibilityReason | null
  detail: string | null
  width: number | null
  height: number | null
  codedWidth: number | null
  codedHeight: number | null
  frameRate: FrameRate | null
  sampleRate: number | null
  channels: number | null
}

export interface MediaCompatibilityReport {
  status: SettledMediaCompatibilityStatus
  container: MediaContainerCompatibility | null
  durationMicroseconds: number | null
  tracks: MediaTrackCompatibility[]
  /** File-level reason. Track-specific failures live on the track itself. */
  reason: MediaCompatibilityReason | null
  detail: string | null
}

/**
 * Session-only projection for one import attempt or connected asset. Files,
 * handles, Inputs, and object URLs remain controller/store-owned elsewhere.
 */
export interface MediaCompatibilityItem {
  id: string
  requestId: string
  fileName: string
  declaredMimeType: string
  size: number
  lastModified: number
  status: MediaCompatibilityStatus
  report: MediaCompatibilityReport | null
}

/** Existing pre-compatibility project connections remain usable. */
export function compatibilityAllowsTimelineUse(
  item: MediaCompatibilityItem | undefined,
): boolean {
  return item === undefined || item.status === 'ready'
}
