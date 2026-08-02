import {
  reapplyPartialTrackImport,
  type MediaCompatibilityReport,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type {
  FrameRate,
  MediaAsset,
  MediaSourceBounds,
} from '../domain/schema'
import { mediaSourceBoundsAcceptAnalyzed } from '../domain/sourceBounds'
import { microsecondsDurationToFrames, rateEquals } from '../domain/time'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'

interface ConnectedAssetLookup {
  has(assetId: string): boolean
}

export interface DescriptorInspectionCandidate {
  asset: MediaAsset
  compatibility: MediaCompatibilityReport
}

export interface MatchingDescriptorCandidate {
  descriptor: PortableAssetDescriptor
  candidate: DescriptorInspectionCandidate
}

function ratesMatch(
  descriptor: FrameRate | null,
  analyzed: FrameRate | null,
): boolean {
  if (descriptor === null || analyzed === null) return descriptor === analyzed
  return rateEquals(descriptor, analyzed)
}

export function descriptorMatches(
  descriptor: PortableAssetDescriptor,
  analyzed: MediaAsset,
): boolean {
  return descriptor.size === analyzed.size
    && descriptor.kind === analyzed.kind
    && descriptor.partialTrackSelection === analyzed.partialTrackSelection
    && (descriptor.kind === 'image'
      || descriptor.durationMicroseconds === analyzed.durationMicroseconds)
    && mediaSourceBoundsAcceptAnalyzed(
      descriptor.sourceBounds,
      analyzed.sourceBounds,
    )
    && ratesMatch(descriptor.nativeFrameRate, analyzed.frameRate)
    && descriptor.width === analyzed.width
    && descriptor.height === analyzed.height
    && descriptor.hasAudio === analyzed.hasAudio
    && descriptor.audioSampleRate === analyzed.audioSampleRate
    && descriptor.audioChannels === analyzed.audioChannels
}

/** Reapply a saved partial-track choice without asking or restoring omissions. */
export function inspectionCandidateForDescriptor(
  descriptor: PortableAssetDescriptor,
  inspection: MediaProbeResult,
): DescriptorInspectionCandidate | null {
  if (!inspection.asset) return null
  const candidate = descriptor.partialTrackSelection
    ? reapplyPartialTrackImport(
        inspection.asset,
        inspection.compatibility,
        descriptor.partialTrackSelection,
      )
    : inspection.status === 'ready'
      ? {
          asset: inspection.asset,
          compatibility: inspection.compatibility,
        }
      : null
  if (!candidate || !descriptorMatches(descriptor, candidate.asset)) return null
  return candidate
}

export function compatibilityReportMatchesDescriptor(
  descriptor: PortableAssetDescriptor,
  file: File,
  report: MediaCompatibilityReport,
): boolean {
  const video = report.tracks.find((track) => track.kind === 'video' && track.primary)
    ?? report.tracks.find((track) => track.kind === 'video')
  const audio = report.tracks.find((track) => track.kind === 'audio' && track.primary)
    ?? report.tracks.find((track) => track.kind === 'audio')
  const effectiveDuration = descriptor.partialTrackSelection === 'video-only'
    ? video?.durationMicroseconds ?? report.durationMicroseconds
    : descriptor.partialTrackSelection === 'audio-only'
      ? audio?.durationMicroseconds ?? report.durationMicroseconds
      : report.durationMicroseconds
  const analyzedBounds: MediaSourceBounds = descriptor.kind === 'image'
    ? { video: null, audio: null }
    : {
        video: descriptor.partialTrackSelection === 'audio-only'
          ? null
          : video?.sourceBounds ?? null,
        audio: descriptor.partialTrackSelection === 'video-only'
          ? null
          : audio?.sourceBounds ?? null,
      }
  if (
    file.size !== descriptor.size
    || (descriptor.kind !== 'image'
      && effectiveDuration !== descriptor.durationMicroseconds)
    || !mediaSourceBoundsAcceptAnalyzed(descriptor.sourceBounds, analyzedBounds)
  ) return false
  if (descriptor.partialTrackSelection === 'video-only') {
    if (!video || !audio) return false
  } else if (descriptor.partialTrackSelection === 'audio-only') {
    if (!audio || !video) return false
  } else {
    if ((descriptor.kind === 'video') !== Boolean(video)) return false
    if ((descriptor.kind === 'audio') !== (!video && Boolean(audio))) return false
  }
  if (descriptor.kind === 'video') {
    if (!video) return false
    if (video.width !== descriptor.width || video.height !== descriptor.height) {
      return false
    }
    if (!ratesMatch(descriptor.nativeFrameRate, video.frameRate)) return false
  }
  if (descriptor.kind === 'image') {
    if (
      !report.image
      || report.image.width !== descriptor.width
      || report.image.height !== descriptor.height
    ) return false
  }
  if (
    descriptor.partialTrackSelection !== 'video-only'
    && descriptor.hasAudio !== Boolean(audio)
  ) return false
  if (descriptor.hasAudio) {
    if (!audio) return false
    if (
      audio.sampleRate !== descriptor.audioSampleRate
      || audio.channels !== descriptor.audioChannels
    ) return false
  }
  return true
}

export function matchingDescriptorCandidates(
  descriptors: readonly PortableAssetDescriptor[],
  connectedAssets: ConnectedAssetLookup,
  inspection: MediaProbeResult,
): MatchingDescriptorCandidate[] {
  return descriptors.flatMap((descriptor) => {
    if (connectedAssets.has(descriptor.id)) return []
    const candidate = inspectionCandidateForDescriptor(descriptor, inspection)
    return candidate ? [{ descriptor, candidate }] : []
  })
}

export function selectDescriptor(
  descriptors: readonly PortableAssetDescriptor[],
  connectedAssets: ConnectedAssetLookup,
  file: File,
  inspection: MediaProbeResult,
): MatchingDescriptorCandidate {
  const matches = matchingDescriptorCandidates(
    descriptors,
    connectedAssets,
    inspection,
  )
  if (matches.length === 0) {
    throw new Error(`"${file.name}" does not match any missing project source`)
  }
  if (matches.length === 1) return matches[0]

  const nameMatches = matches.filter(
    (match) => match.descriptor.fileName === file.name,
  )
  if (nameMatches.length === 1) return nameMatches[0]
  const timestampMatches = (nameMatches.length > 0 ? nameMatches : matches)
    .filter((match) => match.descriptor.lastModified === file.lastModified)
  if (timestampMatches.length === 1) return timestampMatches[0]
  throw new Error(
    `"${file.name}" matches more than one missing source; reconnect those files individually`,
  )
}

export function selectDescriptorByFileIdentity(
  descriptors: readonly PortableAssetDescriptor[],
  connectedAssets: ConnectedAssetLookup,
  file: File,
): PortableAssetDescriptor | null {
  const exact = descriptors.filter((descriptor) =>
    !connectedAssets.has(descriptor.id)
    && descriptor.fileName === file.name
    && descriptor.size === file.size
    && descriptor.lastModified === file.lastModified
    && (!file.type || descriptor.mimeType === file.type),
  )
  return exact.length === 1 ? exact[0] : null
}

export function selectDescriptorByCompatibilityReport(
  descriptors: readonly PortableAssetDescriptor[],
  connectedAssets: ConnectedAssetLookup,
  file: File,
  report: MediaCompatibilityReport,
): PortableAssetDescriptor | null {
  const matches = descriptors.filter(
    (descriptor) =>
      !connectedAssets.has(descriptor.id)
      && compatibilityReportMatchesDescriptor(descriptor, file, report),
  )
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]

  const nameMatches = matches.filter(
    (descriptor) => descriptor.fileName === file.name,
  )
  if (nameMatches.length === 1) return nameMatches[0]
  const timestampMatches = (nameMatches.length > 0 ? nameMatches : matches)
    .filter((descriptor) => descriptor.lastModified === file.lastModified)
  return timestampMatches.length === 1 ? timestampMatches[0] : null
}

export function narrowedFolderCandidateIds(
  descriptors: readonly PortableAssetDescriptor[],
  connectedAssets: ConnectedAssetLookup,
  file: File,
  inspection: MediaProbeResult,
): Set<string> {
  let matches = descriptors.filter(
    (descriptor) =>
      !connectedAssets.has(descriptor.id)
      && inspectionCandidateForDescriptor(descriptor, inspection) !== null,
  )
  const nameMatches = matches.filter(
    (descriptor) => descriptor.fileName === file.name,
  )
  if (nameMatches.length > 0) matches = nameMatches
  const timestampMatches = matches.filter(
    (descriptor) => descriptor.lastModified === file.lastModified,
  )
  if (timestampMatches.length > 0) matches = timestampMatches
  const mimeMatches = matches.filter(
    (descriptor) => descriptor.mimeType === file.type,
  )
  if (mimeMatches.length > 0) matches = mimeMatches
  return new Set(matches.map((descriptor) => descriptor.id))
}

export function relinkedAsset(
  descriptor: PortableAssetDescriptor,
  analyzed: MediaAsset,
  documentRate: FrameRate,
): MediaAsset {
  return {
    ...analyzed,
    id: descriptor.id,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    kind: descriptor.kind,
    ...(descriptor.partialTrackSelection === undefined
      ? {}
      : { partialTrackSelection: descriptor.partialTrackSelection }),
    durationFrames: microsecondsDurationToFrames(
      descriptor.durationMicroseconds,
      documentRate,
    ),
    durationMicroseconds: descriptor.durationMicroseconds,
    frameRate: descriptor.nativeFrameRate
      ? { ...descriptor.nativeFrameRate }
      : null,
    width: descriptor.width,
    height: descriptor.height,
    hasAudio: descriptor.hasAudio,
    audioSampleRate: descriptor.audioSampleRate,
    audioChannels: descriptor.audioChannels,
    decoderConfigB64: descriptor.kind === 'video'
      ? analyzed.decoderConfigB64
      : null,
  }
}
