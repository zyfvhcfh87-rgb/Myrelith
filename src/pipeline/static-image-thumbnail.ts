/**
 * One-tile, bounded media-pool thumbnail for a content-verified still image.
 *
 * The decode boundary remains responsible for byte sniffing and all decoded
 * resource ceilings. This layer downsizes once, emits one PNG object URL, and
 * transfers URL ownership to the caller while closing the decoded source on
 * every path.
 */

import {
  decodeStaticImage,
  type StaticImageRenderSource,
} from './static-image'
import type { FilmstripResult } from './visuals'

export const STATIC_IMAGE_THUMBNAIL_LIMITS = Object.freeze({
  maxWidth: 320,
  maxHeight: 180,
  maxEncodedBytes: 1024 * 1024,
})

export type StaticImageThumbnailFailureReason =
  | 'unsupported-runtime'
  | 'encode-failed'
  | 'resource-limit'

export class StaticImageThumbnailError extends Error {
  readonly reason: StaticImageThumbnailFailureReason

  constructor(
    reason: StaticImageThumbnailFailureReason,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StaticImageThumbnailError'
    this.reason = reason
  }
}

export interface StaticImageThumbnailCanvas {
  draw(source: StaticImageRenderSource, width: number, height: number): void
  encodePng(): Promise<Blob>
}

export interface StaticImageThumbnailOptions {
  signal?: AbortSignal
  decode?: typeof decodeStaticImage
  createCanvas?: (
    width: number,
    height: number,
  ) => StaticImageThumbnailCanvas
  createObjectUrl?: (source: Blob) => string
  revokeObjectUrl?: (url: string) => void
}

function makeAbortError(): Error {
  const error = new Error('Still image thumbnail generation was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

function awaitWithAbort<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) {
    void pending.catch(() => {})
    return Promise.reject(makeAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(makeAbortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (cause: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(cause)
      },
    )
  })
}

function outputDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    STATIC_IMAGE_THUMBNAIL_LIMITS.maxWidth / width,
    STATIC_IMAGE_THUMBNAIL_LIMITS.maxHeight / height,
  )
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function browserCanvas(
  width: number,
  height: number,
): StaticImageThumbnailCanvas {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) {
      throw new StaticImageThumbnailError(
        'unsupported-runtime',
        'This browser cannot create a still-image thumbnail canvas.',
      )
    }
    return {
      draw: (source, drawWidth, drawHeight) => {
        context.drawImage(source, 0, 0, drawWidth, drawHeight)
      },
      encodePng: () => canvas.convertToBlob({ type: 'image/png' }),
    }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new StaticImageThumbnailError(
        'unsupported-runtime',
        'This browser cannot create a still-image thumbnail canvas.',
      )
    }
    return {
      draw: (source, drawWidth, drawHeight) => {
        context.drawImage(source, 0, 0, drawWidth, drawHeight)
      },
      encodePng: () => new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('The thumbnail canvas returned no PNG data'))
        }, 'image/png')
      }),
    }
  }
  throw new StaticImageThumbnailError(
    'unsupported-runtime',
    'This browser cannot create a still-image thumbnail canvas.',
  )
}

export async function generateStaticImageThumbnail(
  file: Blob,
  options: StaticImageThumbnailOptions = {},
): Promise<FilmstripResult> {
  const decode = options.decode ?? decodeStaticImage
  const createCanvas = options.createCanvas ?? browserCanvas
  const createObjectUrl = options.createObjectUrl
    ?? ((source: Blob) => URL.createObjectURL(source))
  const revokeObjectUrl = options.revokeObjectUrl
    ?? ((url: string) => URL.revokeObjectURL(url))
  throwIfAborted(options.signal)
  const decoded = await decode(file, { signal: options.signal })
  const dimensions = outputDimensions(decoded.width, decoded.height)
  let url: string | null = null
  try {
    throwIfAborted(options.signal)
    let canvas: StaticImageThumbnailCanvas
    try {
      canvas = createCanvas(dimensions.width, dimensions.height)
      canvas.draw(decoded.source, dimensions.width, dimensions.height)
    } catch (cause) {
      if (cause instanceof StaticImageThumbnailError) throw cause
      throw new StaticImageThumbnailError(
        'encode-failed',
        'WebCut could not draw the still-image thumbnail.',
        cause,
      )
    }

    let png: Blob
    try {
      png = await awaitWithAbort(canvas.encodePng(), options.signal)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      throw new StaticImageThumbnailError(
        'encode-failed',
        'WebCut could not encode the still-image thumbnail.',
        cause,
      )
    }
    if (
      !Number.isSafeInteger(png.size)
      || png.size <= 0
      || png.size > STATIC_IMAGE_THUMBNAIL_LIMITS.maxEncodedBytes
    ) {
      throw new StaticImageThumbnailError(
        'resource-limit',
        `The still-image thumbnail exceeds WebCut's ${STATIC_IMAGE_THUMBNAIL_LIMITS.maxEncodedBytes}-byte limit.`,
      )
    }
    throwIfAborted(options.signal)
    try {
      url = createObjectUrl(png)
    } catch (cause) {
      throw new StaticImageThumbnailError(
        'encode-failed',
        'WebCut could not retain the still-image thumbnail.',
        cause,
      )
    }
    if (options.signal?.aborted) {
      revokeObjectUrl(url)
      url = null
      throw makeAbortError()
    }
    return {
      url,
      tiles: 1,
      tileWidth: dimensions.width,
      tileHeight: dimensions.height,
    }
  } finally {
    decoded.source.close()
  }
}
