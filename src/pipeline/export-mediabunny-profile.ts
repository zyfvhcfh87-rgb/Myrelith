/**
 * One shared statement of which profiles the production buffered sink can
 * currently execute. Capability discovery and sink setup both consult this
 * boundary so a successful probe can never advertise an unwired path.
 */

import type { ExportProfile } from '../domain/exportProfile'

export function mediabunnyExportImplementationUnavailableReason(
  profile: Readonly<ExportProfile>,
  includeAudio: boolean,
): string | null {
  if (profile.container !== 'mp4' || profile.videoCodec !== 'avc') {
    return (
      `WebCut's buffered export adapter has not enabled ` +
      `${profile.container.toUpperCase()}/${profile.videoCodec.toUpperCase()} yet.`
    )
  }
  if (
    includeAudio &&
    (profile.audioCodec !== 'aac' || profile.audioChannelLayout !== 'stereo')
  ) {
    return (
      `WebCut's buffered MP4/AVC adapter currently supports AAC stereo ` +
      `or an export with no audio track.`
    )
  }
  return null
}
