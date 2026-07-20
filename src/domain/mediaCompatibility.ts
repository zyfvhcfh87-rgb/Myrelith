/**
 * Serializable media-capability facts shared by the probe, session state,
 * and UI. This module deliberately contains no browser APIs or live media
 * resources, so compatibility never leaks into TimelineDoc or persistence.
 */

import type {
  FrameRate,
  MediaAsset,
  PartialTrackImportSelection,
} from './schema'

export type MediaCompatibilityReason =
  | 'unsupported-container'
  | 'unknown-codec'
  | 'unsupported-codec'
  | 'malformed-media'
  | 'resource-limit'
  | 'resource-unavailable'
  | 'decode-failed'

export type MediaCompatibilityStatus =
  | 'checking'
  | 'ready'
  | 'limited'
  | 'unsupported'
  | 'error'

export type MediaDecoderPath =
  | 'native'
  | 'local-prores'
  | 'local-ac3'

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
  /** Decoder selected by the compatibility check in this browser realm. */
  decoderPath: MediaDecoderPath | null
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
  /** Track duration when the container exposes it safely. */
  durationMicroseconds?: number
}

export interface MediaCompatibilityReport {
  status: SettledMediaCompatibilityStatus
  container: MediaContainerCompatibility | null
  durationMicroseconds: number | null
  tracks: MediaTrackCompatibility[]
  /** File-level reason. Track-specific failures live on the track itself. */
  reason: MediaCompatibilityReason | null
  detail: string | null
  /** Explicit user choice applied to this connected session asset. */
  partialImport?: {
    selection: PartialTrackImportSelection
  }
  /** Asset-scoped failures observed after the metadata probe completed. */
  runtimeFailures?: MediaRuntimeFailure[]
}

function selectedTrackKind(
  selection: PartialTrackImportSelection,
): MediaTrackCompatibility['kind'] {
  return selection === 'video-only' ? 'video' : 'audio'
}

/** The one safe partial-import choice offered by a Limited report, if any. */
export function partialTrackImportOption(
  report: MediaCompatibilityReport | null,
): PartialTrackImportSelection | null {
  if (!report || report.status !== 'limited' || report.partialImport) return null

  const choices = (['video-only', 'audio-only'] as const).filter((selection) => {
    const selectedKind = selectedTrackKind(selection)
    const selected = report.tracks.filter((track) => track.kind === selectedKind)
    const omitted = report.tracks.filter((track) => track.kind !== selectedKind)
    return selected.length > 0
      && selected.every((track) => track.decodable)
      && omitted.length > 0
      && omitted.some((track) => !track.decodable)
  })
  return choices.length === 1 ? choices[0] : null
}

/** Tracks intentionally excluded by an accepted partial-import report. */
export function omittedPartialImportTracks(
  report: MediaCompatibilityReport,
): MediaTrackCompatibility[] {
  const selection = report.partialImport?.selection
  if (!selection) return []
  const selectedKind = selectedTrackKind(selection)
  return report.tracks.filter((track) => track.kind !== selectedKind)
}

function partialTrackSelectionIsUsable(
  report: MediaCompatibilityReport,
  selection: PartialTrackImportSelection,
): boolean {
  const selectedKind = selectedTrackKind(selection)
  const selected = report.tracks.filter((track) => track.kind === selectedKind)
  const omitted = report.tracks.filter((track) => track.kind !== selectedKind)
  return selected.length > 0
    && selected.every((track) => track.decodable)
    && omitted.length > 0
}

function trackReference(track: MediaTrackCompatibility): string {
  const kind = track.kind === 'video' ? 'Video' : 'Audio'
  return `${kind} track ${track.number}${track.primary ? ' (primary)' : ''}`
}

function projectPartialTrackImport(
  asset: MediaAsset,
  report: MediaCompatibilityReport,
  selection: PartialTrackImportSelection,
): { asset: MediaAsset; compatibility: MediaCompatibilityReport } | null {
  if (!partialTrackSelectionIsUsable(report, selection)) return null

  const selectedKind = selectedTrackKind(selection)
  if (selectedKind === 'video' && asset.kind !== 'video') return null
  if (selectedKind === 'audio' && !asset.hasAudio) return null

  const selectedTracks = report.tracks.filter(
    (track) => track.kind === selectedKind,
  )
  const selectedPrimary = selectedTracks.find((track) => track.primary)
    ?? selectedTracks[0]
  const selectedDuration = selectedPrimary?.durationMicroseconds
    ?? asset.durationMicroseconds
  const omitted = report.tracks.filter((track) => track.kind !== selectedKind)
  const omittedLabel = omitted.map(trackReference).join(', ')
  const omittedCodecs = omitted.map((track) => {
    const codec = track.codecParameter
      ?? track.decoderConfig?.codec
      ?? track.codec
      ?? track.internalCodecId
      ?? 'unknown codec'
    return codec
  }).join(', ')
  const selectedLabel = selection === 'video-only' ? 'video only' : 'audio only'
  const acceptedAsset: MediaAsset = selection === 'video-only'
    ? {
        ...asset,
        kind: 'video',
        partialTrackSelection: selection,
        durationMicroseconds: selectedDuration,
        hasAudio: false,
        audioSampleRate: null,
        audioChannels: null,
      }
    : {
        ...asset,
        kind: 'audio',
        partialTrackSelection: selection,
        durationMicroseconds: selectedDuration,
        frameRate: null,
        width: null,
        height: null,
        hasAudio: true,
        decoderConfigB64: null,
      }

  return {
    asset: acceptedAsset,
    compatibility: {
      ...report,
      status: 'ready',
      reason: null,
      detail: `Imported ${selectedLabel}. ${omittedLabel} ${omitted.length === 1 ? 'is' : 'are'} omitted. Omitted ${omitted.length === 1 ? 'codec' : 'codecs'}: ${omittedCodecs}. This choice was confirmed by you.`,
      partialImport: { selection },
    },
  }
}

/**
 * Turn a Limited probe into the exact single-kind asset explicitly offered to
 * the user. Returns null instead of accepting a hidden or stale choice.
 */
export function acceptPartialTrackImport(
  asset: MediaAsset,
  report: MediaCompatibilityReport,
  selection: PartialTrackImportSelection,
): { asset: MediaAsset; compatibility: MediaCompatibilityReport } | null {
  if (partialTrackImportOption(report) !== selection) return null
  return projectPartialTrackImport(asset, report, selection)
}

/** Reapply a saved choice even when this browser can now decode both tracks. */
export function reapplyPartialTrackImport(
  asset: MediaAsset,
  report: MediaCompatibilityReport,
  selection: PartialTrackImportSelection,
): { asset: MediaAsset; compatibility: MediaCompatibilityReport } | null {
  if (
    report.status !== 'ready'
    && partialTrackImportOption(report) !== selection
  ) return null
  return projectPartialTrackImport(asset, report, selection)
}

export type MediaRuntimeSurface =
  | 'preview'
  | 'filmstrip'
  | 'waveform'
  | 'audio-playback'
  | 'export'

export interface MediaRuntimeFailure {
  surface: MediaRuntimeSurface
  trackKind: 'video' | 'audio' | null
  reason: Extract<
    MediaCompatibilityReason,
    'decode-failed' | 'resource-unavailable'
  >
  detail: string
}

const RUNTIME_SURFACE_LABELS: Record<MediaRuntimeSurface, string> = {
  preview: 'Preview',
  filmstrip: 'Thumbnail',
  waveform: 'Waveform',
  'audio-playback': 'Audio playback',
  export: 'Export',
}

export function mediaRuntimeSurfaceLabel(surface: MediaRuntimeSurface): string {
  return RUNTIME_SURFACE_LABELS[surface]
}

/** A typed pipeline error that keeps asset identity out of message parsing. */
export class MediaAssetRuntimeError extends Error {
  readonly assetId: string
  readonly failure: MediaRuntimeFailure

  constructor(
    assetId: string,
    failure: MediaRuntimeFailure,
    cause?: unknown,
  ) {
    super(failure.detail, { cause })
    this.name = 'MediaAssetRuntimeError'
    this.assetId = assetId
    this.failure = failure
  }
}

/** Preserve probe facts while marking only the implicated primary track. */
export function withMediaRuntimeFailure(
  previous: MediaCompatibilityReport | null,
  failure: MediaRuntimeFailure,
): MediaCompatibilityReport {
  let markedTrack = false
  const tracks = (previous?.tracks ?? []).map((track) => {
    if (
      markedTrack
      || failure.trackKind === null
      || track.kind !== failure.trackKind
      || !track.primary
    ) return { ...track }
    markedTrack = true
    return {
      ...track,
      decodable: false,
      reason: failure.reason,
      detail: failure.detail,
    }
  })
  if (!markedTrack && failure.trackKind !== null) {
    const fallbackIndex = tracks.findIndex(
      (track) => track.kind === failure.trackKind,
    )
    if (fallbackIndex >= 0) {
      const track = tracks[fallbackIndex]
      tracks[fallbackIndex] = {
        ...track,
        decodable: false,
        reason: failure.reason,
        detail: failure.detail,
      }
    }
  }

  const runtimeFailures = [
    ...(previous?.runtimeFailures ?? []),
    { ...failure },
  ]
  return {
    status: 'error',
    container: previous?.container ? { ...previous.container } : null,
    durationMicroseconds: previous?.durationMicroseconds ?? null,
    tracks,
    reason: failure.reason,
    detail: `${mediaRuntimeSurfaceLabel(failure.surface)} failed: ${failure.detail}`,
    ...(previous?.partialImport
      ? { partialImport: { ...previous.partialImport } }
      : {}),
    runtimeFailures,
  }
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
