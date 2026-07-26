import { describe, expect, test, vi } from 'vitest'
import {
  inspectStaticImageBlob,
  inspectStaticImageBytes,
  STATIC_IMAGE_RESOURCE_LIMITS,
  StaticImageInspectionError,
  type StaticImageDetectedFormat,
  type StaticImageInspectionErrorCode,
  type StaticImageInspectionFailureReason,
} from './static-image-inspection'

type TestBytes = Uint8Array<ArrayBuffer>

function bytes(...values: number[]): TestBytes {
  return new Uint8Array(values)
}

function concat(...parts: TestBytes[]): TestBytes {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function ascii(value: string): TestBytes {
  return new Uint8Array(Array.from(value, (character) => character.charCodeAt(0)))
}

function u16Be(value: number): TestBytes {
  return bytes((value >>> 8) & 0xff, value & 0xff)
}

function u16Le(value: number): TestBytes {
  return bytes(value & 0xff, (value >>> 8) & 0xff)
}

function u24Le(value: number): TestBytes {
  return bytes(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
  )
}

function u32Be(value: number): TestBytes {
  return bytes(
    Math.floor(value / 0x1000000) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  )
}

function u32Le(value: number): TestBytes {
  return bytes(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    Math.floor(value / 0x1000000) & 0xff,
  )
}

function pngChunk(type: string, payload = new Uint8Array()): TestBytes {
  return concat(
    u32Be(payload.length),
    ascii(type),
    payload,
    bytes(0, 0, 0, 0),
  )
}

interface PngFrameControlOptions {
  sequenceNumber?: number
  width?: number
  height?: number
  x?: number
  y?: number
  disposeOperation?: number
  blendOperation?: number
}

const PNG_SIGNATURE = bytes(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
)

function pngHeader(width: number, height: number): TestBytes {
  return pngChunk('IHDR', concat(
    u32Be(width),
    u32Be(height),
    bytes(8, 6, 0, 0, 0),
  ))
}

function pngFrameControl(
  canvasWidth: number,
  canvasHeight: number,
  options: PngFrameControlOptions = {},
): TestBytes {
  return concat(
    u32Be(options.sequenceNumber ?? 0),
    u32Be(options.width ?? canvasWidth),
    u32Be(options.height ?? canvasHeight),
    u32Be(options.x ?? 0),
    u32Be(options.y ?? 0),
    u16Be(1),
    u16Be(30),
    bytes(
      options.disposeOperation ?? 0,
      options.blendOperation ?? 0,
    ),
  )
}

function png(
  width: number,
  height: number,
  animation?: {
    frames: number
    loops: number
    firstFrame?: PngFrameControlOptions
  },
): TestBytes {
  return concat(
    PNG_SIGNATURE,
    pngHeader(width, height),
    ...(animation
      ? [
          pngChunk('acTL', concat(
            u32Be(animation.frames),
            u32Be(animation.loops),
          )),
          pngChunk(
            'fcTL',
            pngFrameControl(width, height, animation.firstFrame),
          ),
        ]
      : []),
    pngChunk('IDAT'),
    pngChunk('IEND'),
  )
}

function jpeg(
  width: number,
  height: number,
  prefix: TestBytes = new Uint8Array(),
): TestBytes {
  const sofPayload = concat(
    bytes(8),
    u16Be(height),
    u16Be(width),
    bytes(
      3,
      1, 0x11, 0,
      2, 0x11, 0,
      3, 0x11, 0,
    ),
  )
  return concat(
    bytes(0xff, 0xd8),
    prefix,
    bytes(0xff, 0xc0),
    u16Be(sofPayload.length + 2),
    sofPayload,
    bytes(0xff, 0xd9),
  )
}

function jpegSegment(marker: number, payload: TestBytes): TestBytes {
  return concat(bytes(0xff, marker), u16Be(payload.length + 2), payload)
}

function webpChunk(type: string, payload: TestBytes): TestBytes {
  return concat(
    ascii(type),
    u32Le(payload.length),
    payload,
    ...(payload.length % 2 === 1 ? [bytes(0)] : []),
  )
}

function webp(...chunks: TestBytes[]): TestBytes {
  const body = concat(ascii('WEBP'), ...chunks)
  return concat(ascii('RIFF'), u32Le(body.length), body)
}

function vp8Chunk(width: number, height: number): TestBytes {
  return webpChunk('VP8 ', concat(
    bytes(0, 0, 0, 0x9d, 0x01, 0x2a),
    u16Le(width),
    u16Le(height),
  ))
}

function vp8lChunk(width: number, height: number): TestBytes {
  const packed = (width - 1) + (height - 1) * 0x4000
  return webpChunk('VP8L', concat(
    bytes(0x2f),
    u32Le(packed),
  ))
}

function vp8xChunk(
  width: number,
  height: number,
  flags = 0,
): TestBytes {
  return webpChunk('VP8X', concat(
    bytes(flags, 0, 0, 0),
    u24Le(width - 1),
    u24Le(height - 1),
  ))
}

function anmfChunk(
  width: number,
  height: number,
  options: {
    x?: number
    y?: number
    imageWidth?: number
    imageHeight?: number
  } = {},
): TestBytes {
  const x = options.x ?? 0
  const y = options.y ?? 0
  if (x % 2 !== 0 || y % 2 !== 0) {
    throw new Error('WebP animation frame offsets must be even')
  }
  const imageWidth = options.imageWidth ?? width
  const imageHeight = options.imageHeight ?? height
  return webpChunk('ANMF', concat(
    u24Le(x / 2),
    u24Le(y / 2),
    u24Le(width - 1),
    u24Le(height - 1),
    u24Le(100),
    bytes(0),
    vp8lChunk(imageWidth, imageHeight),
  ))
}

function bmffBox(type: string, payload: TestBytes): TestBytes {
  return concat(u32Be(payload.length + 8), ascii(type), payload)
}

function avif(
  width: number,
  height: number,
  brand: 'avif' | 'avis' = 'avif',
): TestBytes {
  return avifWithExtents([{ width, height }], brand)
}

function avifWithExtents(
  extents: readonly { width: number; height: number }[],
  brand: 'avif' | 'avis' = 'avif',
): TestBytes {
  const ftyp = bmffBox('ftyp', concat(
    ascii(brand),
    u32Be(0),
    ascii('mif1'),
    ascii(brand),
  ))
  const properties = extents.map(({ width, height }) => (
    bmffBox('ispe', concat(
      bytes(0, 0, 0, 0),
      u32Be(width),
      u32Be(height),
    ))
  ))
  const meta = bmffBox('meta', concat(
    bytes(0, 0, 0, 0),
    bmffBox('iprp', bmffBox('ipco', concat(...properties))),
  ))
  return concat(ftyp, meta)
}

function expectInspectionError(
  action: () => unknown,
  reason: StaticImageInspectionFailureReason,
  code: StaticImageInspectionErrorCode,
  detectedFormat: StaticImageDetectedFormat,
): StaticImageInspectionError {
  try {
    action()
  } catch (cause) {
    expect(cause).toBeInstanceOf(StaticImageInspectionError)
    expect(cause).toMatchObject({ reason, code, detectedFormat })
    return cause as StaticImageInspectionError
  }
  throw new Error('Expected static-image inspection to reject')
}

describe('static-image byte inspection', () => {
  test('detects PNG bytes and reports immutable canonical facts', () => {
    const result = inspectStaticImageBytes(png(640, 360))

    expect(result).toEqual({
      format: 'png',
      mimeType: 'image/png',
      fileBytes: png(640, 360).byteLength,
      width: 640,
      height: 360,
      pixelCount: 230_400,
      decodedBytes: 921_600,
      dimensionCandidates: [{
        width: 640,
        height: 360,
      }],
      animation: {
        isAnimated: false,
        frameCount: 1,
        loopCount: null,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.dimensionCandidates)).toBe(true)
    expect(Object.isFrozen(result.dimensionCandidates[0])).toBe(true)
    expect(Object.isFrozen(result.animation)).toBe(true)
  })

  test('reads APNG animation frame and loop declarations', () => {
    expect(inspectStaticImageBytes(
      png(320, 240, { frames: 12, loops: 0 }),
    ).animation).toEqual({
      isAnimated: true,
      frameCount: 12,
      loopCount: 0,
    })
  })

  test('rejects APNG first frames that bypass canvas resource limits', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(1, 1, {
        frames: 1,
        loops: 0,
        firstFrame: { width: 16_384, height: 16_384 },
      })),
      'resource-limit',
      'pixel-limit',
      'png',
    )
  })

  test('rejects APNG first frames outside the canvas or with zero extents', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, {
        frames: 1,
        loops: 0,
        firstFrame: { width: 8, height: 8, x: 3 },
      })),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, {
        frames: 1,
        loops: 0,
        firstFrame: { width: 0 },
      })),
      'malformed-image',
      'malformed-image',
      'png',
    )
  })

  test('rejects invalid APNG first-frame disposal and blend operations', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, {
        frames: 1,
        loops: 0,
        firstFrame: { disposeOperation: 3 },
      })),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, {
        frames: 1,
        loops: 0,
        firstFrame: { blendOperation: 2 },
      })),
      'malformed-image',
      'malformed-image',
      'png',
    )
  })

  test('requires a single ordered APNG default-frame control at sequence zero', () => {
    const animationControl = pngChunk(
      'acTL',
      concat(u32Be(1), u32Be(0)),
    )
    const frameControl = pngChunk('fcTL', pngFrameControl(10, 10))

    expectInspectionError(
      () => inspectStaticImageBytes(concat(
        PNG_SIGNATURE,
        pngHeader(10, 10),
        frameControl,
        animationControl,
        pngChunk('IDAT'),
      )),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(concat(
        PNG_SIGNATURE,
        pngHeader(10, 10),
        animationControl,
        pngChunk('fcTL', new Uint8Array(25)),
        pngChunk('IDAT'),
      )),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, {
        frames: 1,
        loops: 0,
        firstFrame: { sequenceNumber: 1 },
      })),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(concat(
        PNG_SIGNATURE,
        pngHeader(10, 10),
        animationControl,
        frameControl,
        frameControl,
        pngChunk('IDAT'),
      )),
      'malformed-image',
      'malformed-image',
      'png',
    )
  })

  test('keeps later APNG frames outside the bounded first-frame gate', () => {
    const source = concat(
      PNG_SIGNATURE,
      pngHeader(10, 10),
      pngChunk('acTL', concat(u32Be(2), u32Be(0))),
      pngChunk('fcTL', pngFrameControl(10, 10)),
      pngChunk('IDAT'),
      pngChunk('fcTL', pngFrameControl(10, 10, {
        sequenceNumber: 1,
        width: 16_384,
        height: 16_384,
      })),
      pngChunk('IEND'),
    )

    expect(inspectStaticImageBytes(source).animation).toEqual({
      isAnimated: true,
      frameCount: 2,
      loopCount: 0,
    })
  })

  test('detects JPEG dimensions after bounded metadata segments', () => {
    const result = inspectStaticImageBytes(jpeg(
      1_920,
      1_080,
      jpegSegment(0xe1, ascii('Exif\0\0fixture')),
    ))

    expect(result).toMatchObject({
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 1_920,
      height: 1_080,
      animation: { isAnimated: false, frameCount: 1 },
    })
  })

  test('supports progressive JPEG start-of-frame headers', () => {
    const source = jpeg(800, 600)
    const progressive = source.slice()
    const sofMarkerOffset = progressive.indexOf(0xc0)
    progressive[sofMarkerOffset] = 0xc2

    expect(inspectStaticImageBytes(progressive)).toMatchObject({
      format: 'jpeg',
      width: 800,
      height: 600,
    })
  })

  test('detects simple lossy and lossless WebP frame headers', () => {
    expect(inspectStaticImageBytes(webp(vp8Chunk(1_280, 720)))).toMatchObject({
      format: 'webp',
      width: 1_280,
      height: 720,
      animation: { isAnimated: false, frameCount: 1 },
    })
    expect(inspectStaticImageBytes(webp(vp8lChunk(333, 222)))).toMatchObject({
      format: 'webp',
      width: 333,
      height: 222,
      animation: { isAnimated: false, frameCount: 1 },
    })
  })

  test('reads extended WebP dimensions and animation loop metadata', () => {
    const source = webp(
      vp8xChunk(1_024, 768, 0x02),
      webpChunk('ANIM', concat(bytes(0, 0, 0, 0), u16Le(7))),
      anmfChunk(1_024, 768),
    )

    expect(inspectStaticImageBytes(source)).toMatchObject({
      format: 'webp',
      mimeType: 'image/webp',
      width: 1_024,
      height: 768,
      animation: {
        isAnimated: true,
        frameCount: null,
        loopCount: 7,
      },
    })
  })

  test('ignores ANIM when the WebP animation feature flag is unset', () => {
    const source = webp(
      vp8xChunk(2, 2, 0),
      webpChunk('ANIM', new Uint8Array()),
      vp8lChunk(2, 2),
    )

    expect(inspectStaticImageBytes(source).animation).toEqual({
      isAnimated: false,
      frameCount: 1,
      loopCount: null,
    })
  })

  test('budgets embedded WebP image geometry even when VP8X advertises a safe canvas', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(1, 1),
        vp8lChunk(16_384, 16_384),
      )),
      'resource-limit',
      'pixel-limit',
      'webp',
    )
  })

  test('requires static WebP image data to agree with the VP8X canvas', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(100, 100),
        vp8lChunk(50, 50),
      )),
      'malformed-image',
      'malformed-image',
      'webp',
    )
  })

  test('validates every bounded WebP animation frame and nested image header', () => {
    const animation = webpChunk(
      'ANIM',
      concat(bytes(0, 0, 0, 0), u16Le(0)),
    )
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(10, 10, 0x02),
        animation,
        anmfChunk(10, 10),
        anmfChunk(10, 10, { imageWidth: 9 }),
      )),
      'malformed-image',
      'malformed-image',
      'webp',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(10, 10, 0x02),
        animation,
        anmfChunk(8, 8, { x: 4, y: 4 }),
      )),
      'malformed-image',
      'malformed-image',
      'webp',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(1, 1, 0x02),
        animation,
        anmfChunk(1, 1, {
          imageWidth: 16_384,
          imageHeight: 16_384,
        }),
      )),
      'resource-limit',
      'pixel-limit',
      'webp',
    )
  })

  test.each([
    ['avif', false],
    ['avis', true],
  ] as const)('detects %s BMFF brands and ispe dimensions', (brand, animated) => {
    expect(inspectStaticImageBytes(avif(2_560, 1_440, brand))).toMatchObject({
      format: 'avif',
      mimeType: 'image/avif',
      width: 2_560,
      height: 1_440,
      animation: {
        isAnimated: animated,
        frameCount: animated ? null : 1,
        loopCount: null,
      },
    })
  })

  test('checks every AVIF extent, budgets the largest, and retains unique decode candidates', () => {
    const result = inspectStaticImageBytes(avifWithExtents([
      { width: 64, height: 64 },
      { width: 800, height: 600 },
      { width: 320, height: 240 },
      { width: 64, height: 64 },
    ]))
    expect(result).toMatchObject({
      format: 'avif',
      width: 800,
      height: 600,
      pixelCount: 480_000,
    })
    expect(result.dimensionCandidates).toEqual([
      { width: 64, height: 64 },
      { width: 800, height: 600 },
      { width: 320, height: 240 },
    ])
    expect(Object.isFrozen(result.dimensionCandidates)).toBe(true)
    expect(
      result.dimensionCandidates.every((candidate) =>
        Object.isFrozen(candidate)
      ),
    ).toBe(true)

    expectInspectionError(
      () => inspectStaticImageBytes(avifWithExtents([
        { width: 100, height: 100 },
        { width: 16_385, height: 1 },
      ])),
      'resource-limit',
      'dimension-limit',
      'avif',
    )
  })

  test('does not classify a generic ISO BMFF file as AVIF', () => {
    const generic = bmffBox('ftyp', concat(
      ascii('isom'),
      u32Be(0),
      ascii('mp42'),
    ))

    expectInspectionError(
      () => inspectStaticImageBytes(generic),
      'unsupported-format',
      'unsupported-format',
      null,
    )
  })

  test.each([
    [ascii('GIF89a'), 'gif'],
    [concat(
      bytes(0xef, 0xbb, 0xbf),
      ascii('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'),
    ), 'svg'],
  ] as const)('explicitly rejects unsafe/non-target raster input', (source, format) => {
    expectInspectionError(
      () => inspectStaticImageBytes(source),
      'unsupported-format',
      'unsupported-format',
      format,
    )
  })

  test('rejects unknown and corrupt recognized data with distinct reasons', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(bytes(1, 2, 3, 4)),
      'unsupported-format',
      'unsupported-format',
      null,
    )
    expectInspectionError(
      () => inspectStaticImageBytes(bytes(
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      )),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 40)),
      'malformed-image',
      'malformed-image',
      'jpeg',
    )
  })

  test('rejects animated headers with invalid declarations', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10, { frames: 0, loops: 0 })),
      'malformed-image',
      'malformed-image',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(webp(
        vp8xChunk(10, 10, 0x02),
        webpChunk('ANMF', new Uint8Array()),
      )),
      'malformed-image',
      'malformed-image',
      'webp',
    )
  })

  test('enforces encoded file size before parsing bytes', () => {
    const error = expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10), {
        totalFileBytes: STATIC_IMAGE_RESOURCE_LIMITS.maxFileBytes + 1,
      }),
      'resource-limit',
      'file-size-limit',
      null,
    )
    expect(error.message).toContain('static-image file limit')
  })

  test('enforces dimension, pixel, and decoded-allocation limits separately', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(16_385, 1)),
      'resource-limit',
      'dimension-limit',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(png(10_000, 10_000)),
      'resource-limit',
      'pixel-limit',
      'png',
    )
    expectInspectionError(
      () => inspectStaticImageBytes(png(100, 100), {
        limits: { maxAggregateDecodedBytes: 39_999 },
      }),
      'resource-limit',
      'decoded-byte-limit',
      'png',
    )
  })

  test('rejects invalid source sizes and resource-limit relaxation', () => {
    expectInspectionError(
      () => inspectStaticImageBytes(png(10, 10), { totalFileBytes: 1 }),
      'malformed-image',
      'malformed-image',
      null,
    )
    expect(() => inspectStaticImageBytes(png(10, 10), {
      limits: { maxDimension: Number.NaN },
    })).toThrow(TypeError)
    expect(() => inspectStaticImageBytes(png(10, 10), {
      limits: {
        maxDimension: STATIC_IMAGE_RESOURCE_LIMITS.maxDimension + 1,
      },
    })).toThrow(RangeError)
    expect(() => inspectStaticImageBytes(png(10, 10), {
      limits: {
        maxBytesPerPixel: 1,
      },
    } as never)).toThrow(TypeError)
  })

  test('does not chase metadata beyond the configured header scan', () => {
    const source = jpeg(
      10,
      10,
      jpegSegment(0xe1, new Uint8Array(64)),
    )

    expectInspectionError(
      () => inspectStaticImageBytes(source, {
        limits: { maxHeaderBytes: 16 },
      }),
      'resource-limit',
      'header-scan-limit',
      'jpeg',
    )
  })

  test('bounds hostile metadata structure counts', () => {
    const standaloneMarkers = new Uint8Array(4_097 * 2)
    for (let index = 0; index < standaloneMarkers.length; index += 2) {
      standaloneMarkers[index] = 0xff
      standaloneMarkers[index + 1] = 0xd0
    }

    expectInspectionError(
      () => inspectStaticImageBytes(jpeg(10, 10, standaloneMarkers)),
      'resource-limit',
      'metadata-structure-limit',
      'jpeg',
    )
  })

  test('rejects unsafe extended AVIF box sizes', () => {
    const ftyp = bmffBox('ftyp', concat(
      ascii('avif'),
      u32Be(0),
      ascii('avif'),
    ))
    const unsafeBox = concat(
      bytes(0, 0, 0, 1),
      ascii('meta'),
      bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    )

    expectInspectionError(
      () => inspectStaticImageBytes(concat(ftyp, unsafeBox)),
      'resource-limit',
      'header-scan-limit',
      'avif',
    )
  })
})

describe('static-image Blob inspection', () => {
  test('reads only the bounded prefix and ignores declared MIME', async () => {
    const source = png(320, 180)
    const slice = vi.fn(() => new Blob([source]))
    const spoofedBlob = {
      size: 1_000,
      type: 'image/svg+xml',
      slice,
    } as unknown as Blob

    await expect(inspectStaticImageBlob(spoofedBlob, {
      limits: { maxHeaderBytes: 128 },
    })).resolves.toMatchObject({
      format: 'png',
      mimeType: 'image/png',
      fileBytes: 1_000,
      width: 320,
      height: 180,
    })
    expect(slice).toHaveBeenCalledOnce()
    expect(slice).toHaveBeenCalledWith(0, 128)
  })

  test('rejects an oversized Blob before requesting any bytes', async () => {
    const slice = vi.fn()
    const source = {
      size: STATIC_IMAGE_RESOURCE_LIMITS.maxFileBytes + 1,
      slice,
    } as unknown as Blob

    await expect(inspectStaticImageBlob(source)).rejects.toMatchObject({
      reason: 'resource-limit',
      code: 'file-size-limit',
    })
    expect(slice).not.toHaveBeenCalled()
  })

  test('snapshots stricter limits before awaiting Blob bytes', async () => {
    const sourceBytes = png(64, 32)
    let finishRead = (_buffer: ArrayBuffer): void => {}
    const pendingRead = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve
    })
    const source = {
      size: sourceBytes.byteLength,
      slice: () => ({ arrayBuffer: () => pendingRead }),
    } as unknown as Blob
    const limits = { maxDimension: 32 }

    const result = inspectStaticImageBlob(source, { limits })
    limits.maxDimension = STATIC_IMAGE_RESOURCE_LIMITS.maxDimension
    finishRead(sourceBytes.buffer)

    await expect(result).rejects.toMatchObject({
      reason: 'resource-limit',
      code: 'dimension-limit',
      detectedFormat: 'png',
    })
  })

  test('uses a stable AbortError before and during a bounded Blob read', async () => {
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(inspectStaticImageBlob(
      new Blob([png(10, 10)]),
      { signal: alreadyAborted.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })

    let finishRead = (_buffer: ArrayBuffer): void => {}
    const pendingRead = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve
    })
    const source = {
      size: 100,
      slice: () => ({ arrayBuffer: () => pendingRead }),
    } as unknown as Blob
    const controller = new AbortController()
    const result = inspectStaticImageBlob(source, { signal: controller.signal })

    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    finishRead(new ArrayBuffer(0))
  })
})
