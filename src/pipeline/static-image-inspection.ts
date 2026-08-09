/**
 * Bounded, content-based inspection for raster-image sources.
 *
 * This module deliberately does not decode pixels. It establishes a small,
 * immutable policy boundary before a Blob reaches ImageDecoder or
 * createImageBitmap. The eventual decoder must still verify its output
 * dimensions because encoded metadata is not proof that decoding will agree.
 */

export const STATIC_IMAGE_RESOURCE_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024 * 1024,
  maxHeaderBytes: 4 * 1024 * 1024,
  maxDimension: 16_384,
  maxPixels: 64 * 1024 * 1024,
  maxBytesPerPixel: 4,
  maxAggregateDecodedBytes: 256 * 1024 * 1024,
})

const MAX_METADATA_STRUCTURES = 4_096
const MAX_BMFF_DEPTH = 8

export type StaticImageFormat = 'png' | 'jpeg' | 'webp' | 'avif'
export type StaticImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/avif'

export type StaticImageDetectedFormat =
  | StaticImageFormat
  | 'gif'
  | 'svg'
  | null

export type StaticImageInspectionFailureReason =
  | 'unsupported-format'
  | 'malformed-image'
  | 'resource-limit'

export type StaticImageInspectionErrorCode =
  | 'unsupported-format'
  | 'malformed-image'
  | 'file-size-limit'
  | 'header-scan-limit'
  | 'metadata-structure-limit'
  | 'dimension-limit'
  | 'pixel-limit'
  | 'decoded-byte-limit'

export interface StaticImageResourceLimits {
  maxFileBytes: number
  maxHeaderBytes: number
  maxDimension: number
  maxPixels: number
  maxBytesPerPixel: number
  maxAggregateDecodedBytes: number
}

export type StaticImageResourceLimitOverrides = Partial<
  Omit<StaticImageResourceLimits, 'maxBytesPerPixel'>
>

export interface StaticImageAnimationInfo {
  isAnimated: boolean
  /** Declared frame count when the container exposes one cheaply. */
  frameCount: number | null
  /**
   * The format's encoded loop field. PNG and WebP use zero for infinite
   * looping. Null means that the bounded header did not expose the field.
   */
  loopCount: number | null
}

export interface StaticImageDimensions {
  readonly width: number
  readonly height: number
}

export interface StaticImageInspection {
  format: StaticImageFormat
  mimeType: StaticImageMimeType
  /** Exact source size bound to the bytes that produced this inspection. */
  fileBytes: number
  /**
   * Conservative encoded extent used for resource budgeting before decode.
   * For AVIF collections this is the greatest-area advertised item extent,
   * which is not necessarily the primary item the browser will decode.
   */
  width: number
  height: number
  pixelCount: number
  /** Conservative RGBA allocation used at image decode boundaries. */
  decodedBytes: number
  /**
   * Bounded, unique encoded extents that a browser-decoded primary image may
   * match, before orientation. AVIF can advertise primary, auxiliary, and
   * derived item properties; the greatest-area budget extent is therefore not
   * treated as proof of the primary item's dimensions.
   */
  dimensionCandidates: readonly StaticImageDimensions[]
  animation: StaticImageAnimationInfo
}

export interface InspectStaticImageBytesOptions {
  /**
   * Full source size when `bytes` is only a bounded prefix. Defaults to the
   * supplied byte length.
   */
  totalFileBytes?: number
  /** Tests and stricter callers may lower, but never relax, policy ceilings. */
  limits?: StaticImageResourceLimitOverrides
}

export interface InspectStaticImageBlobOptions {
  signal?: AbortSignal
  /** Tests and stricter callers may lower, but never relax, policy ceilings. */
  limits?: StaticImageResourceLimitOverrides
}

export class StaticImageInspectionError extends Error {
  readonly reason: StaticImageInspectionFailureReason
  readonly code: StaticImageInspectionErrorCode
  readonly detectedFormat: StaticImageDetectedFormat

  constructor(
    reason: StaticImageInspectionFailureReason,
    code: StaticImageInspectionErrorCode,
    message: string,
    detectedFormat: StaticImageDetectedFormat = null,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'StaticImageInspectionError'
    this.reason = reason
    this.code = code
    this.detectedFormat = detectedFormat
  }
}

interface InspectionContext {
  bytes: Uint8Array
  totalFileBytes: number
  limits: StaticImageResourceLimits
}

interface ParsedDimensions {
  width: number
  height: number
}

interface BmffBox {
  type: string
  payloadStart: number
  end: number
}

function inspectionError(
  reason: StaticImageInspectionFailureReason,
  code: StaticImageInspectionErrorCode,
  message: string,
  detectedFormat: StaticImageDetectedFormat = null,
): never {
  throw new StaticImageInspectionError(
    reason,
    code,
    message,
    detectedFormat,
  )
}

function resolvedLimits(
  overrides: StaticImageResourceLimitOverrides | undefined,
): StaticImageResourceLimits {
  if (overrides !== undefined) {
    for (const [name, value] of Object.entries(overrides)) {
      if (
        name === 'maxBytesPerPixel'
        || !Object.prototype.hasOwnProperty.call(
          STATIC_IMAGE_RESOURCE_LIMITS,
          name,
        )
      ) {
        throw new TypeError(`${name} is not an overridable image resource limit`)
      }
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`)
      }
      const ceiling = STATIC_IMAGE_RESOURCE_LIMITS[
        name as keyof StaticImageResourceLimits
      ]
      if (value > ceiling) {
        throw new RangeError(
          `${name} cannot exceed Myrelith's immutable ${ceiling} ceiling`,
        )
      }
    }
  }
  const limits = {
    ...STATIC_IMAGE_RESOURCE_LIMITS,
    ...overrides,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  return Object.freeze(limits)
}

function makeAbortError(): Error {
  const error = new Error('Static image inspection was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

function hasBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.length < expected.length) return false
  return expected.every((value, index) => bytes[index] === value)
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index])
  }
  return value
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  value: string,
): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function ensureAvailable(
  context: InspectionContext,
  offset: number,
  length: number,
  format: StaticImageDetectedFormat,
  detail: string,
): void {
  const end = offset + length
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || !Number.isSafeInteger(end)
  ) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      `${detail} uses an invalid byte range.`,
      format,
    )
  }
  if (end <= context.bytes.length) return
  if (end > context.totalFileBytes) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      `${detail} is truncated.`,
      format,
    )
  }
  inspectionError(
    'resource-limit',
    'header-scan-limit',
    `${detail} lies beyond Myrelith's ${context.limits.maxHeaderBytes}-byte image-header scan limit.`,
    format,
  )
}

function u16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function u16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u24Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
  )
}

function u32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  )
}

function u32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    + bytes[offset + 1] * 0x100
    + bytes[offset + 2] * 0x10000
    + bytes[offset + 3] * 0x1000000
  )
}

function u64Be(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index])
  }
  return value
}

function validatedInspection(
  format: StaticImageFormat,
  mimeType: StaticImageMimeType,
  dimensions: ParsedDimensions,
  animation: StaticImageAnimationInfo,
  fileBytes: number,
  limits: StaticImageResourceLimits,
  dimensionCandidates: readonly ParsedDimensions[] = [dimensions],
): StaticImageInspection {
  const { pixelCount, decodedBytes } = validatedGeometry(
    dimensions,
    limits,
    format,
  )
  const { width, height } = dimensions
  const uniqueCandidates = new Map<string, StaticImageDimensions>()
  for (const candidate of dimensionCandidates) {
    validatedGeometry(candidate, limits, format)
    const key = `${candidate.width}x${candidate.height}`
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(
        key,
        Object.freeze({
          width: candidate.width,
          height: candidate.height,
        }),
      )
    }
  }
  const budgetKey = `${width}x${height}`
  if (!uniqueCandidates.has(budgetKey)) {
    uniqueCandidates.set(budgetKey, Object.freeze({ width, height }))
  }
  if (uniqueCandidates.size > MAX_METADATA_STRUCTURES) {
    inspectionError(
      'resource-limit',
      'metadata-structure-limit',
      'The image exposes too many distinct dimension candidates.',
      format,
    )
  }
  return Object.freeze({
    format,
    mimeType,
    fileBytes,
    width,
    height,
    pixelCount,
    decodedBytes,
    dimensionCandidates: Object.freeze([...uniqueCandidates.values()]),
    animation: Object.freeze({ ...animation }),
  })
}

function validatedGeometry(
  dimensions: ParsedDimensions,
  limits: StaticImageResourceLimits,
  format: StaticImageDetectedFormat,
): { pixelCount: number; decodedBytes: number } {
  const { width, height } = dimensions
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The image dimensions are not positive safe integers.',
      format,
    )
  }
  if (width > limits.maxDimension || height > limits.maxDimension) {
    inspectionError(
      'resource-limit',
      'dimension-limit',
      `${width}×${height} exceeds Myrelith's ${limits.maxDimension}px image-edge limit.`,
      format,
    )
  }
  const pixelCount = width * height
  if (!Number.isSafeInteger(pixelCount) || pixelCount > limits.maxPixels) {
    inspectionError(
      'resource-limit',
      'pixel-limit',
      `${width}×${height} exceeds Myrelith's ${limits.maxPixels}-pixel image limit.`,
      format,
    )
  }
  const decodedBytes = pixelCount * limits.maxBytesPerPixel
  if (
    !Number.isSafeInteger(decodedBytes)
    || decodedBytes > limits.maxAggregateDecodedBytes
  ) {
    inspectionError(
      'resource-limit',
      'decoded-byte-limit',
      `${width}×${height} would exceed Myrelith's ${limits.maxAggregateDecodedBytes}-byte decoded-image budget.`,
      format,
    )
  }
  return { pixelCount, decodedBytes }
}

function inspectPng(context: InspectionContext): StaticImageInspection {
  const format = 'png'
  ensureAvailable(context, 0, 33, format, 'The PNG header')
  const bytes = context.bytes
  const ihdrLength = u32Be(bytes, 8)
  if (ihdrLength !== 13 || !matchesAscii(bytes, 12, 'IHDR')) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The PNG does not begin with a valid IHDR chunk.',
      format,
    )
  }
  const dimensions = {
    width: u32Be(bytes, 16),
    height: u32Be(bytes, 20),
  }
  let offset = 8
  let structureCount = 0
  let animation: StaticImageAnimationInfo = {
    isAnimated: false,
    frameCount: 1,
    loopCount: null,
  }
  let sawAnimationControl = false
  let sawFirstFrameControl = false

  while (offset < context.totalFileBytes) {
    structureCount += 1
    if (structureCount > MAX_METADATA_STRUCTURES) {
      inspectionError(
        'resource-limit',
        'metadata-structure-limit',
        'The PNG contains too many metadata chunks to inspect safely.',
        format,
      )
    }
    ensureAvailable(context, offset, 8, format, 'A PNG chunk header')
    const chunkLength = u32Be(bytes, offset)
    const chunkType = asciiAt(bytes, offset + 4, 4)
    const chunkEnd = offset + 12 + chunkLength
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > context.totalFileBytes) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        `The PNG ${chunkType} chunk is truncated.`,
        format,
      )
    }

    if (chunkType === 'acTL') {
      if (sawAnimationControl || chunkLength !== 8) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG animation control chunk is invalid.',
          format,
        )
      }
      ensureAvailable(
        context,
        offset + 8,
        8,
        format,
        'The PNG animation control chunk',
      )
      const frameCount = u32Be(bytes, offset + 8)
      if (frameCount === 0) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG animation declares zero frames.',
          format,
        )
      }
      animation = {
        isAnimated: true,
        frameCount,
        loopCount: u32Be(bytes, offset + 12),
      }
      sawAnimationControl = true
    }

    if (chunkType === 'fcTL') {
      if (
        !sawAnimationControl
        || sawFirstFrameControl
        || chunkLength !== 26
      ) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG first-frame control chunk is invalid or out of order.',
          format,
        )
      }
      ensureAvailable(
        context,
        offset + 8,
        26,
        format,
        'The PNG first-frame control chunk',
      )
      const payloadStart = offset + 8
      if (u32Be(bytes, payloadStart) !== 0) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG first-frame control sequence must begin at zero.',
          format,
        )
      }
      const frameDimensions = {
        width: u32Be(bytes, payloadStart + 4),
        height: u32Be(bytes, payloadStart + 8),
      }
      validatedGeometry(frameDimensions, context.limits, format)
      const x = u32Be(bytes, payloadStart + 12)
      const y = u32Be(bytes, payloadStart + 16)
      const right = x + frameDimensions.width
      const bottom = y + frameDimensions.height
      if (
        !Number.isSafeInteger(right)
        || !Number.isSafeInteger(bottom)
        || right > dimensions.width
        || bottom > dimensions.height
      ) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG first animation frame lies outside its canvas.',
          format,
        )
      }
      const disposeOperation = bytes[payloadStart + 24]
      const blendOperation = bytes[payloadStart + 25]
      if (disposeOperation > 2 || blendOperation > 1) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The PNG first animation frame uses invalid disposal or blend operations.',
          format,
        )
      }
      sawFirstFrameControl = true
    }

    // Slice 1 intentionally validates only the default/first frame metadata
    // before IDAT. Later fcTL/fdAT chunks remain outside this bounded gate.
    if (chunkType === 'IDAT' || chunkType === 'IEND') break
    if (chunkEnd > context.bytes.length) {
      inspectionError(
        'resource-limit',
        'header-scan-limit',
        `PNG metadata extends beyond Myrelith's ${context.limits.maxHeaderBytes}-byte image-header scan limit.`,
        format,
      )
    }
    offset = chunkEnd
  }

  return validatedInspection(
    format,
    'image/png',
    dimensions,
    animation,
    context.totalFileBytes,
    context.limits,
  )
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

function inspectJpeg(context: InspectionContext): StaticImageInspection {
  const format = 'jpeg'
  const bytes = context.bytes
  let offset = 2
  let structureCount = 0

  while (offset < context.totalFileBytes) {
    structureCount += 1
    if (structureCount > MAX_METADATA_STRUCTURES) {
      inspectionError(
        'resource-limit',
        'metadata-structure-limit',
        'The JPEG contains too many metadata segments to inspect safely.',
        format,
      )
    }
    ensureAvailable(context, offset, 2, format, 'A JPEG marker')
    if (bytes[offset] !== 0xff) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        'The JPEG contains invalid data before its frame header.',
        format,
      )
    }
    while (offset < context.bytes.length && bytes[offset] === 0xff) offset += 1
    ensureAvailable(context, offset, 1, format, 'A JPEG marker code')
    const marker = bytes[offset]
    offset += 1

    if (marker === 0xd9 || marker === 0xda) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        'The JPEG has no supported start-of-frame header.',
        format,
      )
    }
    if (
      marker === 0x01
      || marker === 0xd8
      || (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue
    }

    ensureAvailable(context, offset, 2, format, 'A JPEG segment length')
    const segmentLength = u16Be(bytes, offset)
    if (segmentLength < 2) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        'The JPEG contains an invalid segment length.',
        format,
      )
    }
    const segmentEnd = offset + segmentLength
    if (!Number.isSafeInteger(segmentEnd) || segmentEnd > context.totalFileBytes) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        'A JPEG segment is truncated.',
        format,
      )
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The JPEG start-of-frame header is too short.',
          format,
        )
      }
      ensureAvailable(
        context,
        offset,
        8,
        format,
        'The JPEG start-of-frame header',
      )
      return validatedInspection(
        format,
        'image/jpeg',
        {
          width: u16Be(bytes, offset + 5),
          height: u16Be(bytes, offset + 3),
        },
        { isAnimated: false, frameCount: 1, loopCount: null },
        context.totalFileBytes,
        context.limits,
      )
    }

    if (segmentEnd > context.bytes.length) {
      inspectionError(
        'resource-limit',
        'header-scan-limit',
        `JPEG metadata extends beyond Myrelith's ${context.limits.maxHeaderBytes}-byte image-header scan limit.`,
        format,
      )
    }
    offset = segmentEnd
  }

  inspectionError(
    'malformed-image',
    'malformed-image',
    'The JPEG ends before a start-of-frame header.',
    format,
  )
}

function webpVp8Dimensions(
  context: InspectionContext,
  payloadStart: number,
  payloadLength: number,
): ParsedDimensions {
  if (payloadLength < 10) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP VP8 frame header is too short.',
      'webp',
    )
  }
  ensureAvailable(
    context,
    payloadStart,
    10,
    'webp',
    'The WebP VP8 frame header',
  )
  const bytes = context.bytes
  if (
    bytes[payloadStart + 3] !== 0x9d
    || bytes[payloadStart + 4] !== 0x01
    || bytes[payloadStart + 5] !== 0x2a
  ) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP VP8 frame signature is invalid.',
      'webp',
    )
  }
  return {
    width: u16Le(bytes, payloadStart + 6) & 0x3fff,
    height: u16Le(bytes, payloadStart + 8) & 0x3fff,
  }
}

function webpVp8lDimensions(
  context: InspectionContext,
  payloadStart: number,
  payloadLength: number,
): ParsedDimensions {
  if (payloadLength < 5) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP VP8L frame header is too short.',
      'webp',
    )
  }
  ensureAvailable(
    context,
    payloadStart,
    5,
    'webp',
    'The WebP VP8L frame header',
  )
  const bytes = context.bytes
  if (bytes[payloadStart] !== 0x2f) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP VP8L frame signature is invalid.',
      'webp',
    )
  }
  return {
    width: 1 + bytes[payloadStart + 1]
      + ((bytes[payloadStart + 2] & 0x3f) << 8),
    height: 1 + (bytes[payloadStart + 2] >> 6)
      + (bytes[payloadStart + 3] << 2)
      + ((bytes[payloadStart + 4] & 0x0f) << 10),
  }
}

function incrementWebpStructureCount(count: { value: number }): void {
  count.value += 1
  if (count.value > MAX_METADATA_STRUCTURES) {
    inspectionError(
      'resource-limit',
      'metadata-structure-limit',
      'The WebP contains too many chunks to inspect safely.',
      'webp',
    )
  }
}

function inspectWebpAnimationFrame(
  context: InspectionContext,
  payloadStart: number,
  payloadLength: number,
  canvas: ParsedDimensions,
  structureCount: { value: number },
): void {
  if (payloadLength < 16) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP animation frame header is too short.',
      'webp',
    )
  }
  ensureAvailable(
    context,
    payloadStart,
    16,
    'webp',
    'The WebP animation frame header',
  )

  const bytes = context.bytes
  const x = u24Le(bytes, payloadStart) * 2
  const y = u24Le(bytes, payloadStart + 3) * 2
  const frameDimensions = {
    width: 1 + u24Le(bytes, payloadStart + 6),
    height: 1 + u24Le(bytes, payloadStart + 9),
  }
  validatedGeometry(frameDimensions, context.limits, 'webp')
  const right = x + frameDimensions.width
  const bottom = y + frameDimensions.height
  if (
    !Number.isSafeInteger(right)
    || !Number.isSafeInteger(bottom)
    || right > canvas.width
    || bottom > canvas.height
  ) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP animation frame lies outside its canvas.',
      'webp',
    )
  }
  if ((bytes[payloadStart + 15] & 0xfc) !== 0) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP animation frame uses reserved flag bits.',
      'webp',
    )
  }

  const payloadEnd = payloadStart + payloadLength
  let offset = payloadStart + 16
  while (offset + 8 <= payloadEnd) {
    incrementWebpStructureCount(structureCount)
    ensureAvailable(
      context,
      offset,
      8,
      'webp',
      'A WebP animation frame subchunk header',
    )
    const chunkType = asciiAt(bytes, offset, 4)
    const chunkLength = u32Le(bytes, offset + 4)
    const nestedPayloadStart = offset + 8
    const paddedLength = chunkLength + (chunkLength & 1)
    const chunkEnd = nestedPayloadStart + paddedLength
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > payloadEnd) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        `The WebP animation frame ${chunkType} subchunk is truncated.`,
        'webp',
      )
    }

    let nestedDimensions: ParsedDimensions | null = null
    if (chunkType === 'VP8 ') {
      nestedDimensions = webpVp8Dimensions(
        context,
        nestedPayloadStart,
        chunkLength,
      )
    } else if (chunkType === 'VP8L') {
      nestedDimensions = webpVp8lDimensions(
        context,
        nestedPayloadStart,
        chunkLength,
      )
    }
    if (nestedDimensions !== null) {
      validatedGeometry(nestedDimensions, context.limits, 'webp')
      if (
        nestedDimensions.width !== frameDimensions.width
        || nestedDimensions.height !== frameDimensions.height
      ) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP animation frame dimensions disagree with its image data.',
          'webp',
        )
      }
      return
    }

    if (chunkEnd > context.bytes.length) {
      inspectionError(
        'resource-limit',
        'header-scan-limit',
        `WebP animation frame metadata extends beyond Myrelith's ${context.limits.maxHeaderBytes}-byte image-header scan limit.`,
        'webp',
      )
    }
    offset = chunkEnd
  }

  inspectionError(
    'malformed-image',
    'malformed-image',
    'The WebP animation frame has no supported image subchunk.',
    'webp',
  )
}

function inspectWebp(context: InspectionContext): StaticImageInspection {
  const format = 'webp'
  ensureAvailable(context, 0, 12, format, 'The WebP RIFF header')
  const bytes = context.bytes
  const declaredEnd = u32Le(bytes, 4) + 8
  if (declaredEnd < 12 || declaredEnd > context.totalFileBytes) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP RIFF size is invalid or truncated.',
      format,
    )
  }

  let offset = 12
  const structureCount = { value: 0 }
  let dimensions: ParsedDimensions | null = null
  let extendedAnimation = false
  let sawImageData = false
  let loopCount: number | null = null

  while (offset + 8 <= declaredEnd) {
    incrementWebpStructureCount(structureCount)
    ensureAvailable(context, offset, 8, format, 'A WebP chunk header')
    const chunkType = asciiAt(bytes, offset, 4)
    const chunkLength = u32Le(bytes, offset + 4)
    const payloadStart = offset + 8
    const paddedLength = chunkLength + (chunkLength & 1)
    const chunkEnd = payloadStart + paddedLength
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > declaredEnd) {
      inspectionError(
        'malformed-image',
        'malformed-image',
        `The WebP ${chunkType} chunk is truncated.`,
        format,
      )
    }

    if (chunkType === 'VP8X') {
      if (dimensions || chunkLength !== 10) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP extended header is invalid.',
          format,
        )
      }
      ensureAvailable(
        context,
        payloadStart,
        10,
        format,
        'The WebP extended header',
      )
      const flags = bytes[payloadStart]
      if ((flags & 0xc1) !== 0) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP extended header uses reserved feature bits.',
          format,
        )
      }
      dimensions = {
        width: 1 + u24Le(bytes, payloadStart + 4),
        height: 1 + u24Le(bytes, payloadStart + 7),
      }
      extendedAnimation = (flags & 0x02) !== 0
    } else if (chunkType === 'VP8 ') {
      const frameDimensions = webpVp8Dimensions(
        context,
        payloadStart,
        chunkLength,
      )
      validatedGeometry(frameDimensions, context.limits, format)
      if (
        dimensions !== null
        && (
          dimensions.width !== frameDimensions.width
          || dimensions.height !== frameDimensions.height
        )
      ) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP canvas dimensions disagree with its VP8 image data.',
          format,
        )
      }
      dimensions = frameDimensions
      sawImageData = true
    } else if (chunkType === 'VP8L') {
      const frameDimensions = webpVp8lDimensions(
        context,
        payloadStart,
        chunkLength,
      )
      validatedGeometry(frameDimensions, context.limits, format)
      if (
        dimensions !== null
        && (
          dimensions.width !== frameDimensions.width
          || dimensions.height !== frameDimensions.height
        )
      ) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP canvas dimensions disagree with its VP8L image data.',
          format,
        )
      }
      dimensions = frameDimensions
      sawImageData = true
    } else if (chunkType === 'ANIM' && extendedAnimation) {
      if (chunkLength < 6) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The WebP animation header is too short.',
          format,
        )
      }
      ensureAvailable(
        context,
        payloadStart,
        6,
        format,
        'The WebP animation header',
      )
      loopCount = u16Le(bytes, payloadStart + 4)
    } else if (chunkType === 'ANMF') {
      if (!extendedAnimation || dimensions === null) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'A WebP animation frame requires an animated VP8X canvas.',
          format,
        )
      }
      inspectWebpAnimationFrame(
        context,
        payloadStart,
        chunkLength,
        dimensions,
        structureCount,
      )
      sawImageData = true
    }

    if (chunkEnd > context.bytes.length) {
      if (
        sawImageData
        && dimensions !== null
        && (!extendedAnimation || loopCount !== null)
      ) {
        break
      }
      inspectionError(
        'resource-limit',
        'header-scan-limit',
        `WebP metadata extends beyond Myrelith's ${context.limits.maxHeaderBytes}-byte image-header scan limit.`,
        format,
      )
    }
    offset = chunkEnd
    if (
      offset < declaredEnd
      && offset + 8 > context.bytes.length
      && sawImageData
      && dimensions !== null
      && (!extendedAnimation || loopCount !== null)
    ) {
      break
    }
  }

  if (!dimensions || !sawImageData) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The WebP has no supported image frame.',
      format,
    )
  }
  if (extendedAnimation && loopCount === null) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The animated WebP has no animation control header.',
      format,
    )
  }

  return validatedInspection(
    format,
    'image/webp',
    dimensions,
    {
      isAnimated: extendedAnimation,
      frameCount: extendedAnimation ? null : 1,
      loopCount,
    },
    context.totalFileBytes,
    context.limits,
  )
}

function readBmffBox(
  context: InspectionContext,
  offset: number,
  containerEnd: number,
): BmffBox {
  ensureAvailable(context, offset, 8, 'avif', 'An AVIF box header')
  const bytes = context.bytes
  const size32 = u32Be(bytes, offset)
  const type = asciiAt(bytes, offset + 4, 4)
  let headerBytes = 8
  let size: number

  if (size32 === 1) {
    ensureAvailable(context, offset + 8, 8, 'avif', 'An AVIF extended box size')
    const size64 = u64Be(bytes, offset + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      inspectionError(
        'resource-limit',
        'header-scan-limit',
        'An AVIF box size exceeds JavaScript safe-integer bounds.',
        'avif',
      )
    }
    size = Number(size64)
    headerBytes = 16
  } else if (size32 === 0) {
    size = containerEnd - offset
  } else {
    size = size32
  }

  if (size < headerBytes) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      `The AVIF ${type} box has an invalid size.`,
      'avif',
    )
  }
  const end = offset + size
  if (!Number.isSafeInteger(end) || end > containerEnd) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      `The AVIF ${type} box is truncated.`,
      'avif',
    )
  }
  return { type, payloadStart: offset + headerBytes, end }
}

function findAvifDimensions(
  context: InspectionContext,
  start: number,
  end: number,
  depth: number,
  count: { value: number },
  candidates: Map<string, ParsedDimensions>,
): ParsedDimensions | null {
  if (depth > MAX_BMFF_DEPTH) {
    inspectionError(
      'resource-limit',
      'metadata-structure-limit',
      'The AVIF metadata nesting is too deep to inspect safely.',
      'avif',
    )
  }
  let offset = start
  let largest: ParsedDimensions | null = null
  while (offset + 8 <= end) {
    count.value += 1
    if (count.value > MAX_METADATA_STRUCTURES) {
      inspectionError(
        'resource-limit',
        'metadata-structure-limit',
        'The AVIF contains too many metadata boxes to inspect safely.',
        'avif',
      )
    }
    const box = readBmffBox(context, offset, end)
    if (box.type === 'ispe') {
      ensureAvailable(
        context,
        box.payloadStart,
        12,
        'avif',
        'The AVIF image-spatial-extent box',
      )
      if (box.end - box.payloadStart < 12) {
        inspectionError(
          'malformed-image',
          'malformed-image',
          'The AVIF image-spatial-extent box is too short.',
          'avif',
        )
      }
      const candidate = {
        width: u32Be(context.bytes, box.payloadStart + 4),
        height: u32Be(context.bytes, box.payloadStart + 8),
      }
      const { pixelCount } = validatedGeometry(
        candidate,
        context.limits,
        'avif',
      )
      const candidateKey = `${candidate.width}x${candidate.height}`
      if (!candidates.has(candidateKey)) {
        candidates.set(candidateKey, candidate)
      }
      const largestPixels = largest
        ? largest.width * largest.height
        : -1
      if (pixelCount > largestPixels) largest = candidate
    }

    let childStart: number | null = null
    if (box.type === 'meta') {
      ensureAvailable(
        context,
        box.payloadStart,
        4,
        'avif',
        'The AVIF meta full-box header',
      )
      childStart = box.payloadStart + 4
    } else if (box.type === 'iprp' || box.type === 'ipco') {
      childStart = box.payloadStart
    }
    if (childStart !== null) {
      const found = findAvifDimensions(
        context,
        childStart,
        box.end,
        depth + 1,
        count,
        candidates,
      )
      if (found) {
        const foundPixels = found.width * found.height
        const largestPixels = largest
          ? largest.width * largest.height
          : -1
        if (foundPixels > largestPixels) largest = found
      }
    }

    offset = box.end
  }
  return largest
}

function inspectAvif(
  context: InspectionContext,
): StaticImageInspection | null {
  if (!matchesAscii(context.bytes, 4, 'ftyp')) return null
  const ftyp = readBmffBox(context, 0, context.totalFileBytes)
  if (ftyp.type !== 'ftyp' || ftyp.end - ftyp.payloadStart < 8) return null
  ensureAvailable(
    context,
    ftyp.payloadStart,
    ftyp.end - ftyp.payloadStart,
    null,
    'The ISO BMFF file-type box',
  )
  const brands = new Set<string>()
  brands.add(asciiAt(context.bytes, ftyp.payloadStart, 4))
  for (
    let offset = ftyp.payloadStart + 8;
    offset + 4 <= ftyp.end;
    offset += 4
  ) {
    brands.add(asciiAt(context.bytes, offset, 4))
  }
  if (!brands.has('avif') && !brands.has('avis')) return null

  const dimensionCandidates = new Map<string, ParsedDimensions>()
  const dimensions = findAvifDimensions(
    context,
    ftyp.end,
    context.totalFileBytes,
    0,
    { value: 0 },
    dimensionCandidates,
  )
  if (!dimensions) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The AVIF has no bounded image-spatial-extent metadata.',
      'avif',
    )
  }
  const isAnimated = brands.has('avis')
  return validatedInspection(
    'avif',
    'image/avif',
    dimensions,
    {
      isAnimated,
      frameCount: isAnimated ? null : 1,
      loopCount: null,
    },
    context.totalFileBytes,
    context.limits,
    [...dimensionCandidates.values()],
  )
}

function asciiLower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const scanLength = Math.min(bytes.length, 4_096)
  for (let offset = 0; offset + 4 <= scanLength; offset += 1) {
    if (
      bytes[offset] === 0x3c
      && asciiLower(bytes[offset + 1]) === 0x73
      && asciiLower(bytes[offset + 2]) === 0x76
      && asciiLower(bytes[offset + 3]) === 0x67
    ) {
      const next = bytes[offset + 4]
      if (
        offset + 4 === scanLength
        || next === 0x3e
        || next === 0x2f
        || next === 0x20
        || next === 0x09
        || next === 0x0a
        || next === 0x0d
      ) return true
    }
  }
  return false
}

function hasAvifBrand(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !matchesAscii(bytes, 4, 'ftyp')) return false
  const declaredSize = u32Be(bytes, 0)
  const availableEnd = Math.min(
    declaredSize >= 16 ? declaredSize : bytes.length,
    bytes.length,
  )
  if (
    matchesAscii(bytes, 8, 'avif')
    || matchesAscii(bytes, 8, 'avis')
  ) {
    return true
  }
  for (let offset = 16; offset + 4 <= availableEnd; offset += 4) {
    if (
      matchesAscii(bytes, offset, 'avif')
      || matchesAscii(bytes, offset, 'avis')
    ) {
      return true
    }
  }
  return false
}

function detectStaticImageFormat(
  bytes: Uint8Array,
): StaticImageDetectedFormat {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png'
  }
  if (hasBytes(bytes, [0xff, 0xd8])) return 'jpeg'
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) {
    return 'webp'
  }
  if (hasAvifBrand(bytes)) return 'avif'
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) {
    return 'gif'
  }
  if (looksLikeSvg(bytes)) return 'svg'
  return null
}

function inspectStaticImageBytesWithLimits(
  sourceBytes: Uint8Array,
  totalFileBytes: number,
  limits: StaticImageResourceLimits,
): StaticImageInspection {
  if (
    !Number.isSafeInteger(totalFileBytes)
    || totalFileBytes < sourceBytes.byteLength
    || totalFileBytes < 0
  ) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The static-image source size is invalid.',
    )
  }
  const bytes = sourceBytes.subarray(
    0,
    Math.min(sourceBytes.byteLength, limits.maxHeaderBytes),
  )
  const detectedFormat = detectStaticImageFormat(bytes)
  if (totalFileBytes > limits.maxFileBytes) {
    inspectionError(
      'resource-limit',
      'file-size-limit',
      `${totalFileBytes} bytes exceeds Myrelith's ${limits.maxFileBytes}-byte static-image file limit.`,
      detectedFormat,
    )
  }
  const context = { bytes, totalFileBytes, limits }

  if (detectedFormat === 'png') {
    return inspectPng(context)
  }
  if (detectedFormat === 'jpeg') return inspectJpeg(context)
  if (detectedFormat === 'webp') return inspectWebp(context)
  if (detectedFormat === 'avif') {
    const avif = inspectAvif(context)
    if (avif) return avif
  }
  if (detectedFormat === 'gif') {
    inspectionError(
      'unsupported-format',
      'unsupported-format',
      'Animated GIF is not supported. Use PNG, JPEG, WebP, or AVIF.',
      'gif',
    )
  }
  if (detectedFormat === 'svg') {
    inspectionError(
      'unsupported-format',
      'unsupported-format',
      'SVG is not supported because Myrelith accepts decoded raster images only.',
      'svg',
    )
  }
  inspectionError(
    'unsupported-format',
    'unsupported-format',
    'The file bytes are not a supported PNG, JPEG, WebP, or AVIF image.',
  )
}

/**
 * Inspect a full image byte array or a bounded prefix plus `totalFileBytes`.
 * Declared filename and MIME are intentionally not accepted as inputs.
 */
export function inspectStaticImageBytes(
  sourceBytes: Uint8Array,
  options: InspectStaticImageBytesOptions = {},
): StaticImageInspection {
  const limits = resolvedLimits(options.limits)
  return inspectStaticImageBytesWithLimits(
    sourceBytes,
    options.totalFileBytes ?? sourceBytes.byteLength,
    limits,
  )
}

/**
 * Read at most the configured header budget from a Blob/File and inspect it.
 * Blob.arrayBuffer() cannot be cancelled, so abort wins the public promise and
 * the abandoned bounded read is allowed to settle without retaining results.
 */
export async function inspectStaticImageBlob(
  blob: Blob,
  options: InspectStaticImageBlobOptions = {},
): Promise<StaticImageInspection> {
  const limits = resolvedLimits(options.limits)
  throwIfAborted(options.signal)
  if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
    inspectionError(
      'malformed-image',
      'malformed-image',
      'The static-image Blob size is invalid.',
    )
  }

  const read = blob.slice(0, limits.maxHeaderBytes).arrayBuffer()
  let removeAbortListener = (): void => {}
  const aborted = options.signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(makeAbortError())
        options.signal?.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => {
          options.signal?.removeEventListener('abort', onAbort)
        }
      })
    : null
  try {
    const buffer = await (aborted ? Promise.race([read, aborted]) : read)
    throwIfAborted(options.signal)
    return inspectStaticImageBytesWithLimits(
      new Uint8Array(buffer),
      blob.size,
      limits,
    )
  } finally {
    removeAbortListener()
  }
}
