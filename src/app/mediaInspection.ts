/**
 * Shared typed File inspection facade for imports, Resume, and Relink.
 *
 * Raster images are identified from their bytes before the timed-media probe
 * is allowed to run. A recognized image is decoded once at this boundary so a
 * durable asset is never created from filename, declared MIME, or metadata
 * alone.
 */

import type {
  MediaCompatibilityReason,
  MediaCompatibilityReport,
  SettledMediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import type { FrameRate, MediaAsset } from '../domain/schema'
import { stillImageDurationFrames } from '../domain/staticImage'
import { usePreferencesStore } from '../state/preferencesStore'
import {
  probeMediaFile,
  type MediaProbeResult,
} from '../pipeline/mediaCompatibilityProbe'
import {
  decodeStaticImage,
  isStaticImageDecodeCancellation,
  StaticImageDecodeError,
  type DecodedStaticImage,
} from '../pipeline/static-image'
import {
  inspectStaticImageBlob,
  StaticImageInspectionError,
  type StaticImageFormat,
  type StaticImageInspection,
  type StaticImageMimeType,
} from '../pipeline/static-image-inspection'

export interface MediaInspectionDeps {
  inspectStaticImage: typeof inspectStaticImageBlob
  decodeStaticImage: typeof decodeStaticImage
  probeTimedMedia: typeof probeMediaFile
  createObjectUrl: (source: Blob) => string
  getDefaultStillImageDurationMicroseconds: () => number
}

const defaultDeps: MediaInspectionDeps = {
  inspectStaticImage: inspectStaticImageBlob,
  decodeStaticImage,
  probeTimedMedia: probeMediaFile,
  createObjectUrl: (source) => URL.createObjectURL(source),
  getDefaultStillImageDurationMicroseconds: () => (
    usePreferencesStore.getState().defaultStillImageDurationMicroseconds
  ),
}

function imageContainer(
  format: StaticImageFormat,
  mimeType: StaticImageMimeType,
): NonNullable<MediaCompatibilityReport['container']> {
  return {
    name: format === 'jpeg' ? 'JPEG image' : `${format.toUpperCase()} image`,
    mimeType,
    fullMimeType: mimeType,
  }
}

function imageFailure(
  file: File,
  status: Extract<SettledMediaCompatibilityStatus, 'unsupported' | 'error'>,
  reason: MediaCompatibilityReason,
  detail: string,
  format?: StaticImageFormat,
  mimeType?: StaticImageMimeType,
): MediaProbeResult {
  return {
    status,
    asset: null,
    compatibility: {
      status,
      container: format && mimeType ? imageContainer(format, mimeType) : null,
      durationMicroseconds: null,
      tracks: [],
      reason,
      detail: `"${file.name}": ${detail}`,
    },
  }
}

function inspectionFailure(
  file: File,
  cause: StaticImageInspectionError,
): MediaProbeResult | null {
  if (cause.detectedFormat === null) return null
  if (cause.detectedFormat === 'gif' || cause.detectedFormat === 'svg') {
    return imageFailure(
      file,
      'unsupported',
      'unsupported-container',
      cause.message,
    )
  }
  const format = cause.detectedFormat
  const mimeType = `image/${format === 'jpeg' ? 'jpeg' : format}` as
    StaticImageMimeType
  return imageFailure(
    file,
    cause.reason === 'resource-limit' ? 'unsupported' : 'error',
    cause.reason === 'resource-limit' ? 'resource-limit' : 'malformed-media',
    cause.message,
    format,
    mimeType,
  )
}

function decodeFailure(
  file: File,
  inspection: StaticImageInspection,
  cause: unknown,
): MediaProbeResult {
  if (cause instanceof StaticImageInspectionError) {
    return inspectionFailure(file, cause) ?? imageFailure(
      file,
      'error',
      'malformed-media',
      'The image bytes changed while Myrelith was verifying them.',
      inspection.format,
      inspection.mimeType,
    )
  }
  if (cause instanceof StaticImageDecodeError) {
    if (cause.reason === 'unsupported-runtime') {
      return imageFailure(
        file,
        'unsupported',
        'unsupported-codec',
        cause.message,
        inspection.format,
        inspection.mimeType,
      )
    }
    if (cause.reason === 'resource-limit') {
      return imageFailure(
        file,
        'unsupported',
        'resource-limit',
        cause.message,
        inspection.format,
        inspection.mimeType,
      )
    }
    return imageFailure(
      file,
      'error',
      cause.reason === 'metadata-mismatch'
        ? 'malformed-media'
        : 'decode-failed',
      cause.message,
      inspection.format,
      inspection.mimeType,
    )
  }
  return imageFailure(
    file,
    'error',
    'decode-failed',
    cause instanceof Error
      ? `The browser could not decode the still image: ${cause.message}`
      : 'The browser could not decode the still image.',
    inspection.format,
    inspection.mimeType,
  )
}

function readyImageResult(
  file: File,
  documentRate: FrameRate,
  assetId: string,
  inspection: StaticImageInspection,
  decoded: DecodedStaticImage,
  objectUrl: string,
  durationMicroseconds: number,
): MediaProbeResult {
  const animated = decoded.animation.isAnimated
  const asset: MediaAsset = {
    id: assetId,
    fileName: file.name,
    mimeType: inspection.mimeType,
    size: file.size,
    lastModified: file.lastModified,
    objectUrl,
    kind: 'image',
    durationFrames: stillImageDurationFrames(documentRate, durationMicroseconds),
    durationMicroseconds,
    sourceBounds: { video: null, audio: null },
    frameRate: null,
    width: decoded.width,
    height: decoded.height,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
    decoderConfigB64: null,
  }
  return {
    status: 'ready',
    asset,
    compatibility: {
      status: 'ready',
      container: imageContainer(inspection.format, inspection.mimeType),
      durationMicroseconds,
      tracks: [],
      image: {
        format: inspection.format,
        mimeType: inspection.mimeType,
        width: decoded.width,
        height: decoded.height,
        animated,
        frameCount: decoded.animation.frameCount,
        firstFrameOnly: animated,
        decodePath: decoded.decodePath,
      },
      reason: null,
      detail: animated
        ? 'Animated image detected; Myrelith uses its first frame only.'
        : 'Still image bytes and browser decode verified.',
    },
  }
}

export async function inspectMediaFileCompatibility(
  file: File,
  documentRate: FrameRate,
  assetId: string,
  signal?: AbortSignal,
  deps: MediaInspectionDeps = defaultDeps,
): Promise<MediaProbeResult> {
  const stillImageDurationMicroseconds =
    deps.getDefaultStillImageDurationMicroseconds()
  let inspection: StaticImageInspection
  try {
    inspection = await deps.inspectStaticImage(file, { signal })
  } catch (cause) {
    if (
      signal?.aborted
      || isStaticImageDecodeCancellation(cause)
    ) {
      throw cause
    }
    if (cause instanceof StaticImageInspectionError) {
      const failure = inspectionFailure(file, cause)
      if (failure) return failure
      return deps.probeTimedMedia(file, documentRate, assetId, signal)
    }
    return deps.probeTimedMedia(file, documentRate, assetId, signal)
  }

  let decoded: DecodedStaticImage | null = null
  try {
    decoded = await deps.decodeStaticImage(file, { signal })
    let objectUrl: string
    try {
      objectUrl = deps.createObjectUrl(file)
    } catch (cause) {
      return imageFailure(
        file,
        'error',
        'resource-unavailable',
        cause instanceof Error
          ? `Myrelith could not retain the image source: ${cause.message}`
          : 'Myrelith could not retain the image source.',
        inspection.format,
        inspection.mimeType,
      )
    }
    return readyImageResult(
      file,
      documentRate,
      assetId,
      inspection,
      decoded,
      objectUrl,
      stillImageDurationMicroseconds,
    )
  } catch (cause) {
    if (
      signal?.aborted
      || isStaticImageDecodeCancellation(cause)
    ) {
      throw cause
    }
    return decodeFailure(file, inspection, cause)
  } finally {
    decoded?.source.close()
  }
}
