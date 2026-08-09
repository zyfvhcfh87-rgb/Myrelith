/** Pure UI helpers for capability-aware export settings. */

import {
  DEFAULT_EXPORT_PRESET_ID,
  exportProfileIncludesAudio,
  exportPresetById,
  updateExportProfile,
  type ExportContainer,
  type ExportFileExtension,
  type ExportPresetId,
  type ExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import type { ExportPreferenceSelectionId } from '../state/preferencesStore'

export type ExportUiSelectionId = ExportPreferenceSelectionId

export function profileForSelectionFallback(
  selectionId: ExportUiSelectionId,
  customProfile: Readonly<ExportProfile>,
): Readonly<ExportProfile> {
  if (selectionId === 'custom') return customProfile
  if (selectionId === 'auto') {
    return exportPresetById(DEFAULT_EXPORT_PRESET_ID).profile
  }
  return exportPresetById(selectionId).profile
}

/** Change container and its required codec metadata as one valid operation. */
export function changeExportContainer(
  profile: Readonly<ExportProfile>,
  container: ExportContainer,
): Readonly<ExportProfile> {
  const base = exportPresetById(
    container === 'mp4' ? 'compatibility' : 'web',
  ).profile
  return updateExportProfile(base, {
    videoBitrate: profile.videoBitrate,
    videoBitrateMode: profile.videoBitrateMode,
    keyFrameIntervalMicroseconds: profile.keyFrameIntervalMicroseconds,
    destination: profile.destination,
    ...(profile.audioChannelLayout === 'off'
      ? {
          audioCodec: null,
          audioChannelLayout: 'off',
          audioBitrate: null,
          audioBitrateMode: null,
        }
      : {
          audioChannelLayout: profile.audioChannelLayout,
          audioBitrate: profile.audioBitrate,
          audioBitrateMode: profile.audioBitrateMode,
        }),
  })
}

export function exportFileName(
  projectName: string,
  extension: ExportFileExtension,
): string {
  let base = projectName
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/\.(?:mp4|webm)$/i, '')
  base = base.replace(/[<>:"/\\|?*]/g, '-')
  base = Array.from(base, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('')
  base = Array.from(base).slice(0, 80).join('').replace(/[. ]+$/g, '')
  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i
      .test(base)
  ) {
    base = `myrelith-${base}`
  }
  return `${base || 'myrelith-export'}.${extension}`
}

/** Bitrate-based estimate only; real variable-rate output may differ. */
export function estimateExportBytes(
  doc: TimelineDoc,
  profile: Readonly<ExportProfile>,
): number {
  const frameCount = docDurationFrames(doc)
  if (frameCount === 0) return 0
  const includesAudio = exportProfileIncludesAudio(doc, profile)
  const bitsPerSecond = profile.videoBitrate + (
    includesAudio && profile.audioBitrate !== null ? profile.audioBitrate : 0
  )
  const numerator =
    BigInt(frameCount) * BigInt(doc.frameRate.den) * BigInt(bitsPerSecond)
  const divisor = BigInt(doc.frameRate.num) * 8n
  const bytes = (numerator + divisor - 1n) / divisor
  return bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bytes)
}

export function formatEstimatedFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown'
  if (bytes === 0) return '0 KB'
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  if (bytes < 1_000_000_000) {
    return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  }
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

export function exportVideoCodecLabel(profile: Readonly<ExportProfile>): string {
  switch (profile.videoCodec) {
    case 'avc': return 'H.264/AVC'
    case 'vp9': return 'VP9'
    case 'av1': return 'AV1'
    case 'hevc': return 'HEVC/H.265'
  }
}

export function exportAudioCodecLabel(profile: Readonly<ExportProfile>): string {
  if (profile.audioChannelLayout === 'off') return 'No audio'
  return `${profile.audioCodec.toUpperCase()} · ${profile.audioChannelLayout}`
}

export function exportProfileSummary(profile: Readonly<ExportProfile>): string {
  return `${profile.container.toUpperCase()} · ${exportVideoCodecLabel(profile)} · ` +
    exportAudioCodecLabel(profile)
}

export function presetLabel(id: ExportPresetId): string {
  return exportPresetById(id).label
}
