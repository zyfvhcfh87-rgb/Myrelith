/**
 * One shared statement of which profiles the production buffered sink can
 * currently execute. Capability discovery and sink setup both consult this
 * boundary so a successful probe can never advertise an unwired path.
 */

import {
  Mp4OutputFormat,
  WebMOutputFormat,
} from 'mediabunny'
import type {
  ExportContainer,
  ExportProfile,
} from '../domain/exportProfile'

export function createMediabunnyOutputFormat(
  container: ExportContainer,
): Mp4OutputFormat | WebMOutputFormat {
  if (container === 'mp4') return new Mp4OutputFormat()
  return new WebMOutputFormat()
}

export function mediabunnyExportImplementationUnavailableReason(
  profile: Readonly<ExportProfile>,
  includeAudio: boolean,
): string | null {
  if (includeAudio && profile.audioCodec === 'opus') {
    return (
      `WebCut's WebM/Opus audio adapter is unavailable until exact ` +
      `Opus end-padding metadata can be written.`
    )
  }
  return null
}
