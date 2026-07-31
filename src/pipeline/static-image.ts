/**
 * Browser/worker static-image decode boundary.
 *
 * The byte inspector owns format detection and pre-decode resource checks.
 * This module accepts only that canonical inspection, applies the detected
 * MIME type to a zero-copy Blob slice, and performs one real browser decode.
 *
 * Ownership:
 * - this module initially owns every ImageDecoder and VideoFrame it creates;
 * - intermediate ImageBitmaps close on every failed or cancelled path;
 * - a successful result transfers one ImageBitmap OR VideoFrame to the caller.
 */

import {
  inspectStaticImageBlob,
  STATIC_IMAGE_RESOURCE_LIMITS,
  type StaticImageAnimationInfo,
  type StaticImageDimensions,
  type StaticImageFormat,
  type StaticImageInspection,
  type StaticImageMimeType,
  type StaticImageResourceLimits,
  type StaticImageResourceLimitOverrides,
} from './static-image-inspection'

export const STATIC_IMAGE_BITMAP_OPTIONS = Object.freeze({
  imageOrientation: 'from-image',
  premultiplyAlpha: 'premultiply',
  colorSpaceConversion: 'default',
}) satisfies Readonly<ImageBitmapOptions>

export const STATIC_IMAGE_DECODER_OPTIONS = Object.freeze({
  // Keep the default/static presentation authoritative. We inspect every
  // track separately for an "animated, first frame only" label.
  preferAnimation: false,
  colorSpaceConversion: 'default',
})

export type StaticImageDecodeFailureReason =
  | 'unsupported-runtime'
  | 'decode-failed'
  | 'resource-limit'
  | 'metadata-mismatch'

const DECODE_FAILURE_MESSAGES: Readonly<
  Record<StaticImageDecodeFailureReason, string>
> = Object.freeze({
  'unsupported-runtime':
    'This browser cannot decode the selected still image.',
  'decode-failed': 'The selected still image could not be decoded.',
  'resource-limit':
    "The decoded still image exceeds WebCut's image resource limits.",
  'metadata-mismatch':
    'The decoded still image dimensions do not match the inspected source.',
})

export class StaticImageDecodeError extends Error {
  readonly reason: StaticImageDecodeFailureReason
  readonly format: StaticImageFormat

  constructor(
    reason: StaticImageDecodeFailureReason,
    format: StaticImageFormat,
    cause?: unknown,
  ) {
    super(
      DECODE_FAILURE_MESSAGES[reason],
      cause === undefined ? undefined : { cause },
    )
    this.name = 'StaticImageDecodeError'
    this.reason = reason
    this.format = format
  }
}

export interface StaticImageFrameLike {
  readonly codedWidth: number
  readonly codedHeight: number
  /** String stays open for newer WebCodecs formats missing from lib.dom. */
  readonly format: string | null
  readonly visibleRect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | null
  readonly displayWidth: number
  readonly displayHeight: number
  /**
   * WebCodecs added these orientation attributes after the currently bundled
   * TypeScript DOM declarations. The real browser adapter crosses that
   * declaration lag explicitly below.
   */
  readonly rotation: number
  readonly flip: boolean
  allocationSize(
    options?: Readonly<VideoFrameCopyToOptions>,
  ): number
  close(): void
}

export interface StaticImageTrackLike {
  readonly animated: boolean
  readonly frameCount: number
  readonly repetitionCount: number
}

export interface StaticImageTrackListLike {
  readonly ready: Promise<void>
  readonly length: number
  readonly selectedTrack: StaticImageTrackLike | null
  readonly [index: number]: StaticImageTrackLike
}

export interface StaticImageDecoderLike {
  readonly tracks: StaticImageTrackListLike
  readonly completed: Promise<void>
  decode(
    options: Readonly<ImageDecodeOptions>,
  ): Promise<{ image: StaticImageFrameLike }>
  close(): void
}

export interface StaticImageDecoderCreateOptions {
  readonly type: StaticImageMimeType
  readonly preferAnimation: false
  readonly colorSpaceConversion: 'default'
}

export interface StaticImageDecoderFactory {
  isTypeSupported(type: StaticImageMimeType): Promise<boolean>
  create(
    source: Blob,
    options: Readonly<StaticImageDecoderCreateOptions>,
  ): StaticImageDecoderLike
}

export type StaticImageBitmapFactory = (
  source: Blob,
  options: Readonly<ImageBitmapOptions>,
) => Promise<ImageBitmap>

export interface StaticImageDecodeEnvironment {
  readonly createImageBitmap?: StaticImageBitmapFactory
  readonly imageDecoder?: StaticImageDecoderFactory
}

export interface DecodeStaticImageOptions {
  readonly signal?: AbortSignal
  /** May tighten, but never relax, the immutable inspection ceilings. */
  readonly limits?: StaticImageResourceLimitOverrides
  readonly environment?: StaticImageDecodeEnvironment
}

export type StaticImageRenderSource = ImageBitmap | VideoFrame

export interface DecodedStaticImage {
  /** Caller-owned. Close after its final draw or transfer. */
  readonly source: StaticImageRenderSource
  readonly sourceKind: 'image-bitmap' | 'video-frame'
  readonly width: number
  readonly height: number
  readonly animation: Readonly<StaticImageAnimationInfo>
  /**
   * WebCodecs repetition semantics are deliberately separate from the
   * format-level loopCount (where PNG/WebP zero means infinite). Null means
   * unavailable or unbounded (WebCodecs reports infinite repetition as
   * `Infinity`, which is intentionally not retained as a serializable fact).
   */
  readonly decoderRepetitionCount: number | null
  readonly decodePath: 'image-decoder' | 'image-bitmap'
}

function makeAbortError(): Error {
  const error = new Error('Still image decoding was cancelled')
  error.name = 'AbortError'
  return error
}

export function isStaticImageDecodeCancellation(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

function awaitWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (signal === undefined) return pending
  const settleLate = (value: T) => {
    try {
      onLateResolve?.(value)
    } catch {
      // The public operation has already rejected. Detached cleanup cannot
      // surface a second failure or create an unhandled promise.
    }
  }
  if (signal.aborted) {
    void pending.then(settleLate, () => {})
    return Promise.reject(makeAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = () => {
      if (aborted) return
      aborted = true
      signal.removeEventListener('abort', onAbort)
      reject(makeAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void pending.then(
      (value) => {
        if (aborted) {
          settleLate(value)
          return
        }
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (cause: unknown) => {
        if (aborted) return
        signal.removeEventListener('abort', onAbort)
        reject(cause)
      },
    )
  })
}

function browserDecodeEnvironment(): StaticImageDecodeEnvironment {
  const bitmapFactory =
    typeof globalThis.createImageBitmap === 'function'
      ? (
          source: Blob,
          options: Readonly<ImageBitmapOptions>,
        ) =>
          globalThis.createImageBitmap(source, options)
      : undefined

  const decoderConstructor =
    typeof globalThis.ImageDecoder === 'function'
      ? globalThis.ImageDecoder
      : undefined
  const imageDecoder: StaticImageDecoderFactory | undefined =
    decoderConstructor === undefined
      ? undefined
      : {
          isTypeSupported: (type) =>
            decoderConstructor.isTypeSupported(type),
          create: (source, options) =>
            new decoderConstructor({
              data: source.stream(),
              type: options.type,
              preferAnimation: options.preferAnimation,
              colorSpaceConversion: options.colorSpaceConversion,
            }) as unknown as StaticImageDecoderLike,
        }

  return {
    createImageBitmap: bitmapFactory,
    imageDecoder,
  }
}

function normalizeCount(value: number, minimum: number): number | null {
  return Number.isSafeInteger(value) && value >= minimum ? value : null
}

interface DecoderAnimationObservation {
  animation: Readonly<StaticImageAnimationInfo>
  repetitionCount: number | null
}

function animationFromTracks(
  tracks: StaticImageTrackListLike,
  fallback: StaticImageAnimationInfo,
): DecoderAnimationObservation {
  if (!Number.isSafeInteger(tracks.length) || tracks.length <= 0) {
    return {
      animation: Object.freeze({ ...fallback }),
      repetitionCount: null,
    }
  }

  let best:
    | {
        isAnimated: boolean
        frameCount: number | null
        repetitionCount: number | null
      }
    | null = null
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index]
    if (track === undefined) continue
    const reportedFrameCount = normalizeCount(track.frameCount, 0)
    if (reportedFrameCount === null) continue
    const frameCount =
      reportedFrameCount === 0 ? null : reportedFrameCount
    const isAnimated =
      track.animated || (frameCount !== null && frameCount > 1)
    const repetitionCount = normalizeCount(track.repetitionCount, 0)
    if (
      best === null
      || (isAnimated && !best.isAnimated)
      || (isAnimated === best.isAnimated
        && (frameCount ?? 0) > (best.frameCount ?? 0))
    ) {
      best = { isAnimated, frameCount, repetitionCount }
    }
  }

  if (best === null) {
    return {
      animation: Object.freeze({ ...fallback }),
      repetitionCount: null,
    }
  }
  const fallbackFrameCount = fallback.frameCount
  const frameCount =
    fallbackFrameCount === null
      ? best.frameCount === null
        ? null
        : fallback.isAnimated && best.frameCount <= 1
        ? null
        : best.frameCount
      : best.frameCount === null
        ? fallbackFrameCount
        : Math.max(fallbackFrameCount, best.frameCount)
  return {
    animation: Object.freeze({
      isAnimated: fallback.isAnimated || best.isAnimated,
      // ImageTrack metadata is live while a Blob stream fills. Never replace
      // a stronger bounded header fact with a smaller partial frame count.
      frameCount,
      loopCount: fallback.loopCount,
    }),
    repetitionCount: best.repetitionCount,
  }
}

function dimensionsMatchCandidate(
  width: number,
  height: number,
  candidate: StaticImageDimensions,
): boolean {
  return (
    (width === candidate.width && height === candidate.height)
    || (width === candidate.height && height === candidate.width)
  )
}

function effectiveDecodeLimits(
  overrides: StaticImageResourceLimitOverrides | undefined,
): StaticImageResourceLimits {
  // inspectStaticImageBlob validates every override before this is called.
  return Object.freeze({
    ...STATIC_IMAGE_RESOURCE_LIMITS,
    ...overrides,
  })
}

function validateDimensionBudget(
  width: number,
  height: number,
  inspection: StaticImageInspection,
  limits: StaticImageResourceLimits,
): void {
  if (
    !Number.isSafeInteger(width)
    || width <= 0
    || !Number.isSafeInteger(height)
    || height <= 0
  ) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
    )
  }

  const pixelCount = width * height
  const decodedBytes = pixelCount * limits.maxBytesPerPixel
  if (
    width > limits.maxDimension
    || height > limits.maxDimension
    || !Number.isSafeInteger(pixelCount)
    || pixelCount > limits.maxPixels
    || !Number.isSafeInteger(decodedBytes)
    || decodedBytes > limits.maxAggregateDecodedBytes
  ) {
    throw new StaticImageDecodeError(
      'resource-limit',
      inspection.format,
    )
  }
}

function validateDecodedBitmap(
  bitmap: ImageBitmap,
  inspection: StaticImageInspection,
  limits: StaticImageResourceLimits,
): void {
  const { width, height } = bitmap
  validateDimensionBudget(
    width,
    height,
    inspection,
    limits,
  )

  if (
    inspection.format !== 'avif'
    && !inspection.dimensionCandidates.some((candidate) =>
      dimensionsMatchCandidate(width, height, candidate)
    )
  ) {
    throw new StaticImageDecodeError(
      'metadata-mismatch',
      inspection.format,
    )
  }
}

interface StaticImagePresentationDimensions {
  width: number
  height: number
}

function validateFrameAllocation(
  frame: StaticImageFrameLike,
  inspection: StaticImageInspection,
  limits: StaticImageResourceLimits,
): void {
  if (
    typeof frame.format !== 'string'
    || frame.format.length === 0
  ) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
    )
  }

  let allocationBytes: number
  try {
    allocationBytes = frame.allocationSize({
      // Budget the complete coded surface, including non-visible padding,
      // in the frame's native pixel format and bit depth.
      rect: {
        x: 0,
        y: 0,
        width: frame.codedWidth,
        height: frame.codedHeight,
      },
    })
  } catch (cause) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
      cause,
    )
  }
  if (
    !Number.isSafeInteger(allocationBytes)
    || allocationBytes <= 0
  ) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
    )
  }
  if (allocationBytes > limits.maxAggregateDecodedBytes) {
    throw new StaticImageDecodeError(
      'resource-limit',
      inspection.format,
    )
  }
}

function validateDecodedFrame(
  frame: StaticImageFrameLike,
  inspection: StaticImageInspection,
  limits: StaticImageResourceLimits,
): StaticImagePresentationDimensions {
  validateDimensionBudget(
    frame.codedWidth,
    frame.codedHeight,
    inspection,
    limits,
  )
  validateFrameAllocation(frame, inspection, limits)
  const visibleRect = frame.visibleRect
  if (
    visibleRect === null
    || !Number.isSafeInteger(visibleRect.x)
    || visibleRect.x < 0
    || !Number.isSafeInteger(visibleRect.y)
    || visibleRect.y < 0
    || !Number.isSafeInteger(visibleRect.width)
    || visibleRect.width <= 0
    || !Number.isSafeInteger(visibleRect.height)
    || visibleRect.height <= 0
    || !Number.isSafeInteger(visibleRect.x + visibleRect.width)
    || visibleRect.x + visibleRect.width > frame.codedWidth
    || !Number.isSafeInteger(visibleRect.y + visibleRect.height)
    || visibleRect.y + visibleRect.height > frame.codedHeight
  ) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
    )
  }
  validateDimensionBudget(
    visibleRect.width,
    visibleRect.height,
    inspection,
    limits,
  )
  validateDimensionBudget(
    frame.displayWidth,
    frame.displayHeight,
    inspection,
    limits,
  )
  if (inspection.format !== 'avif') {
    const visibleCandidate = inspection.dimensionCandidates.find(
      (candidate) =>
        visibleRect.width === candidate.width
        && visibleRect.height === candidate.height,
    )
    if (
      visibleCandidate === undefined
      || !dimensionsMatchCandidate(
        frame.displayWidth,
        frame.displayHeight,
        visibleCandidate,
      )
    ) {
      throw new StaticImageDecodeError(
        'metadata-mismatch',
        inspection.format,
      )
    }
  }

  if (
    ![0, 90, 180, 270].includes(frame.rotation)
    || typeof frame.flip !== 'boolean'
  ) {
    throw new StaticImageDecodeError(
      'decode-failed',
      inspection.format,
    )
  }

  // VideoFrame display dimensions are already in presentation space: the
  // WebCodecs rotation has been applied to their width/height relationship.
  return {
    width: frame.displayWidth,
    height: frame.displayHeight,
  }
}

function resultWithTransferredBitmap(
  bitmap: ImageBitmap,
  animation: StaticImageAnimationInfo,
  decoderRepetitionCount: number | null,
): DecodedStaticImage {
  return Object.freeze({
    source: bitmap,
    sourceKind: 'image-bitmap',
    width: bitmap.width,
    height: bitmap.height,
    animation: Object.freeze({ ...animation }),
    decoderRepetitionCount,
    decodePath: 'image-bitmap',
  })
}

function resultWithTransferredFrame(
  frame: StaticImageFrameLike,
  dimensions: StaticImagePresentationDimensions,
  animation: StaticImageAnimationInfo,
  decoderRepetitionCount: number | null,
): DecodedStaticImage {
  return Object.freeze({
    source: frame as unknown as VideoFrame,
    sourceKind: 'video-frame',
    width: dimensions.width,
    height: dimensions.height,
    animation: Object.freeze({ ...animation }),
    decoderRepetitionCount,
    decodePath: 'image-decoder',
  })
}

function closeBitmap(bitmap: ImageBitmap | null): void {
  bitmap?.close()
}

function closeFrame(frame: StaticImageFrameLike | null): void {
  frame?.close()
}

function combinedFailure(...causes: unknown[]): unknown {
  const present = causes.filter((cause) => cause !== undefined)
  if (present.length <= 1) return present[0]
  return new AggregateError(
    present,
    'Static-image browser decode paths failed',
  )
}

/**
 * Decode the default/first image frame.
 *
 * Inspection and decode are intentionally one atomic public operation: facts
 * are sniffed from this exact immutable Blob before it reaches a browser
 * decoder. The detected MIME type is authoritative; the Blob's declared MIME
 * is deliberately ignored. The returned render source belongs to the caller.
 */
export async function decodeStaticImage(
  blob: Blob,
  options: DecodeStaticImageOptions = {},
): Promise<DecodedStaticImage> {
  const { signal } = options
  const requestedLimits = options.limits === undefined
    ? undefined
    : Object.freeze({ ...options.limits })
  throwIfAborted(signal)
  const inspection = await inspectStaticImageBlob(blob, {
    signal,
    limits: requestedLimits,
  })
  const resourceLimits = effectiveDecodeLimits(requestedLimits)
  throwIfAborted(signal)

  const environment = options.environment ?? browserDecodeEnvironment()
  const bitmapFactory = environment.createImageBitmap
  if (
    bitmapFactory === undefined
    && environment.imageDecoder === undefined
  ) {
    throw new StaticImageDecodeError(
      'unsupported-runtime',
      inspection.format,
    )
  }

  // Blob.slice re-labels without trusting File.type and does not copy bytes.
  const canonicalSource = blob.slice(0, blob.size, inspection.mimeType)
  let animation: StaticImageAnimationInfo = inspection.animation
  let decoderRepetitionCount: number | null = null
  let decoder: StaticImageDecoderLike | null = null
  let decoderClosed = false
  let frame: StaticImageFrameLike | null = null
  let bitmap: ImageBitmap | null = null
  let imageDecoderFailure: unknown
  let blobBitmapFailure: unknown

  const closeDecoder = () => {
    if (decoder === null || decoderClosed) return
    decoderClosed = true
    decoder.close()
  }
  const abortDecoder = () => closeDecoder()

  try {
    const decoderFactory = environment.imageDecoder
    if (decoderFactory !== undefined) {
      try {
        const supported = await awaitWithAbort(
          decoderFactory.isTypeSupported(inspection.mimeType),
          signal,
        )
        throwIfAborted(signal)
        if (supported) {
          decoder = decoderFactory.create(canonicalSource, {
            type: inspection.mimeType,
            ...STATIC_IMAGE_DECODER_OPTIONS,
          })
          // Closing an incomplete ImageDecoder rejects `completed`. Observe it
          // immediately so successful first-frame ownership never leaves a
          // browser-level unhandled rejection behind.
          void decoder.completed.catch(() => {})
          signal?.addEventListener('abort', abortDecoder, { once: true })
          if (signal?.aborted) closeDecoder()

          await awaitWithAbort(decoder.tracks.ready, signal)
          throwIfAborted(signal)
          if (decoder.tracks.length <= 0) {
            throw new Error('ImageDecoder exposed no image tracks')
          }
          const observation = animationFromTracks(
            decoder.tracks,
            inspection.animation,
          )
          animation = observation.animation
          decoderRepetitionCount = observation.repetitionCount
        }
      } catch (cause) {
        if (signal?.aborted) throw makeAbortError()
        if (isStaticImageDecodeCancellation(cause)) throw cause
        imageDecoderFailure = cause
        closeDecoder()
        decoder = null
      }
    }

    if (bitmapFactory !== undefined) {
      // Canonical path: the Blob carries the sniffed MIME and asks the browser
      // to apply encoded orientation before premultiplying into sRGB/default.
      try {
        throwIfAborted(signal)
        bitmap = await awaitWithAbort(
          bitmapFactory(
            canonicalSource,
            STATIC_IMAGE_BITMAP_OPTIONS,
          ),
          signal,
          closeBitmap,
        )
        throwIfAborted(signal)
        validateDecodedBitmap(bitmap, inspection, resourceLimits)

        const result = resultWithTransferredBitmap(
          bitmap,
          animation,
          decoderRepetitionCount,
        )
        bitmap = null
        return result
      } catch (cause) {
        if (signal?.aborted) throw makeAbortError()
        if (
          isStaticImageDecodeCancellation(cause)
          || cause instanceof StaticImageDecodeError
        ) {
          throw cause
        }
        blobBitmapFailure = cause
        bitmap?.close()
        bitmap = null
      }
    }

    // Some implementations accept the format through ImageDecoder but not
    // through Blob createImageBitmap. Transfer frame zero itself: Canvas image
    // rendering retains its WebCodecs rotation/flip without allocating a
    // second full-size bitmap beside the decoded frame.
    if (decoder === null || decoder.tracks.selectedTrack === null) {
      throw new StaticImageDecodeError(
        bitmapFactory === undefined
          ? 'unsupported-runtime'
          : 'decode-failed',
        inspection.format,
        combinedFailure(imageDecoderFailure, blobBitmapFailure),
      )
    }

    try {
      const decoded = await awaitWithAbort(
        decoder.decode({
          frameIndex: 0,
          completeFramesOnly: true,
        }),
        signal,
        (lateDecoded) => closeFrame(lateDecoded.image),
      )
      frame = decoded.image
      throwIfAborted(signal)
      const dimensions = validateDecodedFrame(
        frame,
        inspection,
        resourceLimits,
      )
      const result = resultWithTransferredFrame(
        frame,
        dimensions,
        animation,
        decoderRepetitionCount,
      )
      frame = null
      return result
    } catch (cause) {
      if (signal?.aborted) throw makeAbortError()
      if (
        isStaticImageDecodeCancellation(cause)
        || cause instanceof StaticImageDecodeError
      ) {
        throw cause
      }
      throw new StaticImageDecodeError(
        'decode-failed',
        inspection.format,
        combinedFailure(
          imageDecoderFailure,
          blobBitmapFailure,
          cause,
        ),
      )
    }
  } finally {
    signal?.removeEventListener('abort', abortDecoder)
    closeBitmap(bitmap)
    closeFrame(frame)
    closeDecoder()
  }
}
