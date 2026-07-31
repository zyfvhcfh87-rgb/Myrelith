import { describe, expect, test, vi, type Mock } from 'vitest'
import {
  STATIC_IMAGE_RESOURCE_LIMITS,
  type StaticImageMimeType,
  type StaticImageResourceLimitOverrides,
} from './static-image-inspection'
import {
  STATIC_IMAGE_BITMAP_OPTIONS,
  decodeStaticImage,
  type StaticImageDecodeEnvironment,
  type StaticImageDecoderCreateOptions,
  type StaticImageDecoderLike,
  type StaticImageFrameLike,
} from './static-image'

interface TrackedFrame extends StaticImageFrameLike {
  closeCount: number
}

interface TrackedBitmap extends ImageBitmap {
  closeCount: number
}

interface TrackedDecoder extends StaticImageDecoderLike {
  closeCount: number
  decode: StaticImageDecoderLike['decode']
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(cause: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type TestBytes = Uint8Array<ArrayBuffer>

function bytes(...values: number[]): TestBytes {
  return new Uint8Array(values)
}

function concat(...parts: TestBytes[]): TestBytes {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function ascii(value: string): TestBytes {
  return new Uint8Array(
    Array.from(value, (character) => character.charCodeAt(0)),
  )
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

function pngChunk(
  type: string,
  payload: TestBytes = new Uint8Array(),
): TestBytes {
  return concat(
    u32Be(payload.length),
    ascii(type),
    payload,
    bytes(0, 0, 0, 0),
  )
}

function pngFrameControl(width: number, height: number): TestBytes {
  return concat(
    u32Be(0),
    u32Be(width),
    u32Be(height),
    u32Be(0),
    u32Be(0),
    u16Be(1),
    u16Be(30),
    bytes(0, 0),
  )
}

function pngBytes(
  width = 64,
  height = 32,
  animation?: { frames: number; loops: number },
): TestBytes {
  const ihdr = concat(
    u32Be(width),
    u32Be(height),
    bytes(8, 6, 0, 0, 0),
  )
  return concat(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    ...(animation === undefined
      ? []
      : [
          pngChunk(
            'acTL',
            concat(u32Be(animation.frames), u32Be(animation.loops)),
          ),
          pngChunk('fcTL', pngFrameControl(width, height)),
        ]),
    pngChunk('IDAT'),
    pngChunk('IEND'),
  )
}

function jpegBytes(width = 64, height = 32): TestBytes {
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
    bytes(0xff, 0xd8, 0xff, 0xc0),
    u16Be(sofPayload.length + 2),
    sofPayload,
    bytes(0xff, 0xd9),
  )
}

function webpChunk(type: string, payload: TestBytes): TestBytes {
  return concat(
    ascii(type),
    u32Le(payload.length),
    payload,
    ...(payload.length % 2 === 0 ? [] : [bytes(0)]),
  )
}

function vp8lChunk(width: number, height: number): TestBytes {
  const packed = (width - 1) + (height - 1) * 0x4000
  return webpChunk('VP8L', concat(
    bytes(0x2f),
    u32Le(packed),
  ))
}

function animatedWebpBytes(
  width: number,
  height: number,
  frameCount: number,
  loopCount: number,
): TestBytes {
  const vp8x = webpChunk('VP8X', concat(
    bytes(0x02, 0, 0, 0),
    u24Le(width - 1),
    u24Le(height - 1),
  ))
  const animation = webpChunk(
    'ANIM',
    concat(bytes(0, 0, 0, 0), u16Le(loopCount)),
  )
  const frames = Array.from(
    { length: frameCount },
    () => webpChunk('ANMF', concat(
      u24Le(0),
      u24Le(0),
      u24Le(width - 1),
      u24Le(height - 1),
      u24Le(100),
      bytes(0),
      vp8lChunk(width, height),
    )),
  )
  const body = concat(ascii('WEBP'), vp8x, animation, ...frames)
  return concat(ascii('RIFF'), u32Le(body.length), body)
}

function bmffBox(type: string, payload: TestBytes): TestBytes {
  return concat(u32Be(payload.length + 8), ascii(type), payload)
}

function avifBytes(
  extents: readonly { width: number; height: number }[],
): TestBytes {
  const ftyp = bmffBox('ftyp', concat(
    ascii('avif'),
    u32Be(0),
    ascii('mif1'),
    ascii('avif'),
  ))
  const properties = extents.map(({ width, height }) =>
    bmffBox('ispe', concat(
      bytes(0, 0, 0, 0),
      u32Be(width),
      u32Be(height),
    ))
  )
  const meta = bmffBox('meta', concat(
    bytes(0, 0, 0, 0),
    bmffBox('iprp', bmffBox('ipco', concat(...properties))),
  ))
  return concat(ftyp, meta)
}

function trackedFrame(
  overrides: Partial<StaticImageFrameLike> = {},
): TrackedFrame {
  const frame: TrackedFrame = {
    codedWidth: 64,
    codedHeight: 32,
    format: 'RGBA',
    displayWidth: 64,
    displayHeight: 32,
    rotation: 0,
    flip: false,
    allocationSize: () =>
      (overrides.codedWidth ?? 64)
      * (overrides.codedHeight ?? 32)
      * 4,
    ...overrides,
    visibleRect: overrides.visibleRect === undefined
      ? {
          x: 0,
          y: 0,
          width: 64,
          height: 32,
        }
      : overrides.visibleRect,
    closeCount: 0,
    close() {
      frame.closeCount++
    },
  }
  return frame
}

function trackedBitmap(width = 64, height = 32): TrackedBitmap {
  const bitmap = {
    width,
    height,
    closeCount: 0,
    close() {
      bitmap.closeCount++
    },
  }
  return bitmap as unknown as TrackedBitmap
}

function imageBlob(
  type = '',
  animation?: { frames: number; loops: number },
): Blob {
  return new Blob([pngBytes(64, 32, animation)], { type })
}

function jpegBlob(type = ''): Blob {
  return new Blob([jpegBytes()], { type })
}

function animatedWebpBlob(
  frameCount: number,
  loopCount: number,
  type = '',
): Blob {
  return new Blob([
    animatedWebpBytes(64, 32, frameCount, loopCount),
  ], { type })
}

function avifBlob(
  extents: readonly { width: number; height: number }[],
): Blob {
  return new Blob([avifBytes(extents)])
}

function trackedDecoder(
  frame: TrackedFrame,
  overrides: {
    ready?: Promise<void>
    completed?: Promise<void>
    tracks?: Array<StaticImageDecoderLike['tracks'][number]>
    selectedTrack?: StaticImageDecoderLike['tracks']['selectedTrack']
    decode?: StaticImageDecoderLike['decode']
    onClose?: () => void
  } = {},
): TrackedDecoder {
  const tracks = overrides.tracks ?? [{
    animated: false,
    frameCount: 1,
    repetitionCount: 0,
  }]
  const selectedTrack =
    overrides.selectedTrack === undefined
      ? tracks[0] ?? null
      : overrides.selectedTrack
  const trackList = {
    ready: overrides.ready ?? Promise.resolve(),
    length: tracks.length,
    selectedTrack,
  } as StaticImageDecoderLike['tracks']
  tracks.forEach((track, index) => {
    Object.defineProperty(trackList, index, {
      configurable: false,
      enumerable: true,
      value: track,
      writable: false,
    })
  })
  const decoder = {
    tracks: trackList,
    completed: overrides.completed ?? Promise.resolve(),
    closeCount: 0,
    decode: vi.fn(
      overrides.decode
        ?? (async () => ({ image: frame })),
    ),
    close() {
      decoder.closeCount++
      overrides.onClose?.()
    },
  }
  return decoder
}

function imageDecoderEnvironment(
  decoder: TrackedDecoder,
  createImageBitmap: StaticImageDecodeEnvironment['createImageBitmap'],
): {
  environment: StaticImageDecodeEnvironment
  isTypeSupported: Mock<
    (type: StaticImageMimeType) => Promise<boolean>
  >
  create: Mock<
    (
      source: Blob,
      options: Readonly<StaticImageDecoderCreateOptions>,
    ) => StaticImageDecoderLike
  >
} {
  const isTypeSupported = vi.fn(
    async (_type: StaticImageMimeType) => true,
  )
  const create = vi.fn(
    (
      _source: Blob,
      _options: Readonly<StaticImageDecoderCreateOptions>,
    ) => decoder,
  )
  return {
    environment: {
      createImageBitmap,
      imageDecoder: {
        isTypeSupported,
        create,
      },
    },
    isTypeSupported,
    create,
  }
}

describe('decodeStaticImage', () => {
  test('uses canonical ImageDecoder policy and transfers only the final bitmap', async () => {
    const frame = trackedFrame()
    const bitmap = trackedBitmap()
    const defaultTrack = {
      animated: false,
      frameCount: 1,
      repetitionCount: 0,
    }
    const decoder = trackedDecoder(frame, {
      tracks: [
        defaultTrack,
        { animated: true, frameCount: 7, repetitionCount: 3 },
      ],
      selectedTrack: defaultTrack,
    })
    const createImageBitmap = vi.fn(
      async (
        source: Blob,
        options: Readonly<ImageBitmapOptions>,
      ) => {
        expect(source).toBeInstanceOf(Blob)
        expect((source as Blob).type).toBe('image/png')
        expect(options).toEqual(STATIC_IMAGE_BITMAP_OPTIONS)
        return bitmap
      },
    )
    const { environment, isTypeSupported, create } =
      imageDecoderEnvironment(decoder, createImageBitmap)
    const input = imageBlob('text/html')

    const result = await decodeStaticImage(input, {
      environment,
    })

    expect(isTypeSupported).toHaveBeenCalledWith('image/png')
    expect(create).toHaveBeenCalledOnce()
    const [source, decoderOptions] = create.mock.calls[0]
    expect(source).toBeInstanceOf(Blob)
    expect(source).not.toBe(input)
    expect(source.type).toBe('image/png')
    expect(source.size).toBe(input.size)
    expect(decoderOptions).toEqual({
      type: 'image/png',
      preferAnimation: false,
      colorSpaceConversion: 'default',
    })
    expect(decoder.decode).not.toHaveBeenCalled()
    expect(result).toEqual({
      source: bitmap,
      sourceKind: 'image-bitmap',
      width: 64,
      height: 32,
      animation: {
        isAnimated: true,
        frameCount: 7,
        loopCount: null,
      },
      decoderRepetitionCount: 3,
      decodePath: 'image-bitmap',
    })
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)
    expect(bitmap.closeCount).toBe(0)

    result.source.close()
    expect(bitmap.closeCount).toBe(1)
  })

  test('observes decoder completion before close rejects it', async () => {
    const frame = trackedFrame()
    const completion = deferred<void>()
    const completionCatch = vi.spyOn(completion.promise, 'catch')
    const decoder = trackedDecoder(frame, {
      completed: completion.promise,
      onClose: () => {
        const error = new Error('ImageDecoder closed before completion')
        error.name = 'AbortError'
        completion.reject(error)
      },
    })
    const bitmap = trackedBitmap()
    const { environment } = imageDecoderEnvironment(
      decoder,
      vi.fn(async () => bitmap),
    )

    const result = await decodeStaticImage(imageBlob(), { environment })

    expect(completionCatch).toHaveBeenCalledOnce()
    expect(decoder.closeCount).toBe(1)
    await Promise.resolve()
    result.source.close()
  })

  test('never downgrades inspected animation facts with live partial tracks', async () => {
    const frame = trackedFrame()
    const decoder = trackedDecoder(frame, {
      tracks: [{
        animated: true,
        frameCount: 2,
        repetitionCount: Number.POSITIVE_INFINITY,
      }],
    })
    const bitmap = trackedBitmap()
    const { environment } = imageDecoderEnvironment(
      decoder,
      vi.fn(async () => bitmap),
    )

    const result = await decodeStaticImage(
      imageBlob('', { frames: 12, loops: 0 }),
      {
      environment,
      },
    )

    expect(result.animation).toEqual({
      isAnimated: true,
      frameCount: 12,
      loopCount: 0,
    })
    expect(result.decoderRepetitionCount).toBeNull()
    expect(decoder.decode).not.toHaveBeenCalled()
    expect(decoder.closeCount).toBe(1)
    result.source.close()
  })

  test('retains an animated label while a streaming track has zero frames', async () => {
    const frame = trackedFrame()
    const decoder = trackedDecoder(frame, {
      tracks: [{
        animated: true,
        frameCount: 0,
        repetitionCount: 0,
      }],
    })
    const bitmap = trackedBitmap()
    const { environment } = imageDecoderEnvironment(
      decoder,
      vi.fn(async () => bitmap),
    )

    const result = await decodeStaticImage(
      animatedWebpBlob(1, 0),
      {
      environment,
      },
    )

    expect(result.animation).toEqual({
      isAnimated: true,
      frameCount: null,
      loopCount: 0,
    })
    expect(decoder.decode).not.toHaveBeenCalled()
    result.source.close()
  })

  test('falls back to createImageBitmap with the inspected MIME and metadata', async () => {
    const bitmap = trackedBitmap()
    const createImageBitmap = vi.fn(
      async (
        source: Blob,
        options: Readonly<ImageBitmapOptions>,
      ) => {
        expect(source).toBeInstanceOf(Blob)
        expect((source as Blob).type).toBe('image/webp')
        expect(options).toEqual(STATIC_IMAGE_BITMAP_OPTIONS)
        return bitmap
      },
    )
    const result = await decodeStaticImage(
      animatedWebpBlob(4, 2, 'application/octet-stream'),
      {
        environment: { createImageBitmap },
      },
    )

    expect(result.decodePath).toBe('image-bitmap')
    expect(result.animation).toEqual({
      isAnimated: true,
      frameCount: null,
      loopCount: 2,
    })
    expect(result.decoderRepetitionCount).toBeNull()
    expect(bitmap.closeCount).toBe(0)
    result.source.close()
    expect(bitmap.closeCount).toBe(1)
  })

  test('uses the bitmap fallback when ImageDecoder does not support the type', async () => {
    const bitmap = trackedBitmap()
    const createImageBitmap = vi.fn(async () => bitmap)
    const create = vi.fn()
    const isTypeSupported = vi.fn(async () => false)

    const result = await decodeStaticImage(jpegBlob(), {
      environment: {
        createImageBitmap,
        imageDecoder: { isTypeSupported, create },
      },
    })

    expect(isTypeSupported).toHaveBeenCalledWith('image/jpeg')
    expect(create).not.toHaveBeenCalled()
    expect(createImageBitmap).toHaveBeenCalledOnce()
    expect(result.decodePath).toBe('image-bitmap')
    result.source.close()
  })

  test('transfers the fallback frame without allocating a second bitmap', async () => {
    const allocationSize = vi.fn(
      (_options?: Readonly<VideoFrameCopyToOptions>) => 8_192,
    )
    const frame = trackedFrame({ allocationSize })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async (_source: Blob) => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    const result = await decodeStaticImage(imageBlob(), {
      environment,
    })

    expect(createImageBitmap).toHaveBeenCalledOnce()
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)
    expect(decoder.decode).toHaveBeenCalledWith({
      frameIndex: 0,
      completeFramesOnly: true,
    })
    expect(allocationSize).toHaveBeenCalledWith({
      rect: {
        x: 0,
        y: 0,
        width: 64,
        height: 32,
      },
    })
    expect(result.source).toBe(frame)
    expect(result.sourceKind).toBe('video-frame')
    expect(result.width).toBe(64)
    expect(result.height).toBe(32)
    expect(result.decodePath).toBe('image-decoder')
    result.source.close()
    expect(frame.closeCount).toBe(1)
  })

  test('accepts a bounded padded coded frame using its visible rectangle', async () => {
    const frame = trackedFrame({
      codedWidth: 80,
      codedHeight: 40,
      visibleRect: {
        x: 8,
        y: 4,
        width: 64,
        height: 32,
      },
    })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    const result = await decodeStaticImage(imageBlob(), {
      environment,
    })

    expect(result.source).toBe(frame)
    expect(result.width).toBe(64)
    expect(result.height).toBe(32)
    expect(frame.closeCount).toBe(0)
    result.source.close()
    expect(frame.closeCount).toBe(1)
  })

  test('preserves frame rotation and flip in fallback presentation geometry', async () => {
    const frame = trackedFrame({
      displayWidth: 32,
      displayHeight: 64,
      rotation: 90,
      flip: true,
    })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    const result = await decodeStaticImage(imageBlob(), {
      environment,
    })

    expect(result.source).toBe(frame)
    expect(result.sourceKind).toBe('video-frame')
    expect(result.width).toBe(32)
    expect(result.height).toBe(64)
    expect(frame.rotation).toBe(90)
    expect(frame.flip).toBe(true)
    expect(frame.closeCount).toBe(0)
    expect(createImageBitmap).toHaveBeenCalledOnce()
    result.source.close()
    expect(frame.closeCount).toBe(1)
  })

  test('returns a stable typed failure when both browser paths reject', async () => {
    const frame = trackedFrame()
    const decoder = trackedDecoder(frame, {
      decode: async () => {
        throw new Error('ImageDecoder rejected bytes')
      },
    })
    const createImageBitmap = vi.fn(async () => {
      throw new Error('browser rejected bytes')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    await expect(
      decodeStaticImage(imageBlob(), {
        environment,
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'decode-failed',
      format: 'png',
      message: 'The selected still image could not be decoded.',
    })
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)
    expect(createImageBitmap).toHaveBeenCalledOnce()
  })

  test('accepts an orientation-swapped bitmap but closes a mismatched bitmap', async () => {
    const swapped = trackedBitmap(32, 64)
    const accepted = await decodeStaticImage(imageBlob(), {
      environment: {
        createImageBitmap: vi.fn(async () => swapped),
      },
    })
    expect(accepted.width).toBe(32)
    expect(accepted.height).toBe(64)
    expect(swapped.closeCount).toBe(0)
    accepted.source.close()

    const mismatch = trackedBitmap(63, 32)
    const mismatchFrame = trackedFrame()
    const mismatchDecoder = trackedDecoder(mismatchFrame)
    const mismatchEnvironment = imageDecoderEnvironment(
      mismatchDecoder,
      vi.fn(async () => mismatch),
    ).environment
    await expect(
      decodeStaticImage(imageBlob(), {
        environment: mismatchEnvironment,
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'metadata-mismatch',
    })
    expect(mismatch.closeCount).toBe(1)
    expect(mismatchDecoder.decode).not.toHaveBeenCalled()
    expect(mismatchDecoder.closeCount).toBe(1)
    expect(mismatchFrame.closeCount).toBe(0)
  })

  test('accepts safe transformed AVIF bitmap geometry', async () => {
    const bitmap = trackedBitmap(20, 10)

    const result = await decodeStaticImage(
      avifBlob([
        { width: 64, height: 32 },
        { width: 16, height: 16 },
      ]),
      {
        environment: {
          createImageBitmap: vi.fn(async () => bitmap),
        },
      },
    )

    expect(result.source).toBe(bitmap)
    expect(result.width).toBe(20)
    expect(result.height).toBe(10)
    expect(bitmap.closeCount).toBe(0)
    result.source.close()
    expect(bitmap.closeCount).toBe(1)
  })

  test('accepts safe transformed AVIF frame display geometry', async () => {
    const frame = trackedFrame({
      displayWidth: 16,
      displayHeight: 16,
    })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    const result = await decodeStaticImage(
      avifBlob([
        { width: 64, height: 32 },
        { width: 16, height: 16 },
      ]),
      { environment },
    )

    expect(result.source).toBe(frame)
    expect(result.width).toBe(16)
    expect(result.height).toBe(16)
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)
    result.source.close()
    expect(frame.closeCount).toBe(1)
  })

  test('applies stricter limits to transformed AVIF output geometry', async () => {
    const bitmap = trackedBitmap(32, 16)

    await expect(
      decodeStaticImage(
        avifBlob([{ width: 16, height: 16 }]),
        {
          limits: { maxDimension: 20 },
          environment: {
            createImageBitmap: vi.fn(async () => bitmap),
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'resource-limit',
      format: 'avif',
    })
    expect(bitmap.closeCount).toBe(1)
  })

  test('snapshots limits before an asynchronous Blob read', async () => {
    const source = avifBlob([{ width: 16, height: 16 }])
    const sourceBytes = await source.arrayBuffer()
    const readGate = deferred<ArrayBuffer>()
    const deferredBlob = {
      size: source.size,
      slice(
        start?: number,
        end?: number,
        contentType?: string,
      ): Blob {
        if (contentType === undefined) {
          return {
            arrayBuffer: async () => readGate.promise,
          } as unknown as Blob
        }
        return source.slice(start, end, contentType)
      },
    } as unknown as Blob
    const mutableLimits: Record<string, number> = {
      maxDimension: 20,
    }
    const bitmap = trackedBitmap(32, 16)

    const decoding = decodeStaticImage(deferredBlob, {
      limits: mutableLimits as StaticImageResourceLimitOverrides,
      environment: {
        createImageBitmap: vi.fn(async () => bitmap),
      },
    })
    mutableLimits.maxDimension =
      STATIC_IMAGE_RESOURCE_LIMITS.maxDimension + 1
    mutableLimits.maxBytesPerPixel = 1
    readGate.resolve(sourceBytes)

    await expect(decoding).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'resource-limit',
      format: 'avif',
    })
    expect(bitmap.closeCount).toBe(1)
  })

  test('revalidates decoded dimensions against the shared resource limits', async () => {
    const oversized = trackedBitmap(
      STATIC_IMAGE_RESOURCE_LIMITS.maxDimension + 1,
      32,
    )

    await expect(
      decodeStaticImage(imageBlob(), {
        environment: {
          createImageBitmap: vi.fn(async () => oversized),
        },
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'resource-limit',
      format: 'png',
    })
    expect(oversized.closeCount).toBe(1)
  })

  test('rejects an oversized coded frame before transferring ownership', async () => {
    const frame = trackedFrame({
      codedWidth: STATIC_IMAGE_RESOURCE_LIMITS.maxDimension + 1,
    })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    await expect(
      decodeStaticImage(imageBlob(), {
        environment,
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'resource-limit',
      format: 'png',
    })
    expect(createImageBitmap).toHaveBeenCalledOnce()
    expect(frame.closeCount).toBe(1)
    expect(decoder.closeCount).toBe(1)
  })

  test('rejects an oversized native VideoFrame allocation', async () => {
    const frame = trackedFrame({
      format: 'I444AP10',
      allocationSize: () =>
        STATIC_IMAGE_RESOURCE_LIMITS.maxAggregateDecodedBytes + 1,
    })
    const decoder = trackedDecoder(frame)
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )

    await expect(
      decodeStaticImage(imageBlob(), { environment }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'resource-limit',
      format: 'png',
    })
    expect(frame.closeCount).toBe(1)
    expect(decoder.closeCount).toBe(1)
  })

  test('aborts before touching either browser capability', async () => {
    const controller = new AbortController()
    controller.abort()
    const createImageBitmap = vi.fn()
    const isTypeSupported = vi.fn()
    const create = vi.fn()

    await expect(
      decodeStaticImage(imageBlob(), {
        signal: controller.signal,
        environment: {
          createImageBitmap,
          imageDecoder: { isTypeSupported, create },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(isTypeSupported).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  test('aborts without waiting for a pending ImageDecoder support query', async () => {
    const support = deferred<boolean>()
    const controller = new AbortController()
    const createImageBitmap = vi.fn(async () => trackedBitmap())
    const create = vi.fn()
    const isTypeSupported = vi.fn(async () => support.promise)

    const decoding = decodeStaticImage(imageBlob(), {
      signal: controller.signal,
      environment: {
        createImageBitmap,
        imageDecoder: { isTypeSupported, create },
      },
    })
    await vi.waitFor(() =>
      expect(isTypeSupported).toHaveBeenCalledOnce(),
    )
    controller.abort()

    await expect(decoding).rejects.toMatchObject({ name: 'AbortError' })
    expect(create).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()

    // The browser query itself is not cancellable; settling it later is
    // absorbed and cannot restart the cancelled decode.
    support.resolve(true)
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
  })

  test('aborting while tracks load closes ImageDecoder promptly and exactly once', async () => {
    const ready = deferred<void>()
    const frame = trackedFrame()
    const decoder = trackedDecoder(frame, { ready: ready.promise })
    const createImageBitmap = vi.fn(async () => trackedBitmap())
    const { environment, create } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )
    const controller = new AbortController()

    const decoding = decodeStaticImage(imageBlob(), {
      signal: controller.signal,
      environment,
    })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const rejection = expect(decoding).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    expect(decoder.closeCount).toBe(1)
    await rejection
    expect(decoder.closeCount).toBe(1)
    expect(decoder.decode).not.toHaveBeenCalled()
    expect(frame.closeCount).toBe(0)
    expect(createImageBitmap).not.toHaveBeenCalled()

    ready.resolve()
    await Promise.resolve()
    expect(decoder.closeCount).toBe(1)
  })

  test('late ImageDecoder completion closes its frame after cancellation', async () => {
    const frame = trackedFrame()
    const decodeGate = deferred<{ image: StaticImageFrameLike }>()
    const decoder = trackedDecoder(frame, {
      decode: async () => decodeGate.promise,
    })
    const createImageBitmap = vi.fn(async () => {
      throw new Error('Blob createImageBitmap rejected the format')
    })
    const { environment } = imageDecoderEnvironment(
      decoder,
      createImageBitmap,
    )
    const controller = new AbortController()

    const decoding = decodeStaticImage(imageBlob(), {
      signal: controller.signal,
      environment,
    })
    await vi.waitFor(() =>
      expect(decoder.decode).toHaveBeenCalledOnce(),
    )
    const rejection = expect(decoding).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    expect(decoder.closeCount).toBe(1)
    await rejection
    expect(createImageBitmap).toHaveBeenCalledOnce()
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)

    decodeGate.resolve({ image: frame })
    await vi.waitFor(() => expect(frame.closeCount).toBe(1))
    expect(frame.closeCount).toBe(1)
    expect(decoder.closeCount).toBe(1)
  })

  test('uses ImageDecoder directly when createImageBitmap is unavailable', async () => {
    const frame = trackedFrame()
    const decoder = trackedDecoder(frame)
    const { environment } = imageDecoderEnvironment(
      decoder,
      undefined,
    )

    const result = await decodeStaticImage(imageBlob(), {
      environment,
    })

    expect(result.source).toBe(frame)
    expect(result.sourceKind).toBe('video-frame')
    expect(result.decodePath).toBe('image-decoder')
    expect(frame.closeCount).toBe(0)
    expect(decoder.closeCount).toBe(1)
    result.source.close()
    expect(frame.closeCount).toBe(1)
  })

  test('late bitmap-only completion closes the bitmap after cancellation', async () => {
    const lateBitmap = trackedBitmap()
    const bitmapGate = deferred<ImageBitmap>()
    const createImageBitmap = vi.fn(async () => bitmapGate.promise)
    const controller = new AbortController()

    const decoding = decodeStaticImage(imageBlob(), {
      signal: controller.signal,
      environment: { createImageBitmap },
    })
    await vi.waitFor(() =>
      expect(createImageBitmap).toHaveBeenCalledOnce(),
    )
    const rejection = expect(decoding).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    await rejection
    expect(lateBitmap.closeCount).toBe(0)

    bitmapGate.resolve(lateBitmap)
    await vi.waitFor(() => expect(lateBitmap.closeCount).toBe(1))
    expect(lateBitmap.closeCount).toBe(1)
  })

  test('sniffs the exact Blob and rejects SVG before browser decode', async () => {
    const createImageBitmap = vi.fn(async () => trackedBitmap())
    const isTypeSupported = vi.fn(async () => true)
    const create = vi.fn()
    const spoofedBlob = new Blob(
      ['<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
      { type: 'image/png' },
    )

    await expect(
      decodeStaticImage(spoofedBlob, {
        environment: {
          createImageBitmap,
          imageDecoder: { isTypeSupported, create },
        },
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageInspectionError',
      reason: 'unsupported-format',
      code: 'unsupported-format',
      detectedFormat: 'svg',
    })
    expect(isTypeSupported).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  test('applies stricter inspection limits before browser decode', async () => {
    const createImageBitmap = vi.fn(async () => trackedBitmap())

    await expect(
      decodeStaticImage(imageBlob(), {
        limits: { maxDimension: 63 },
        environment: { createImageBitmap },
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageInspectionError',
      reason: 'resource-limit',
      code: 'dimension-limit',
      detectedFormat: 'png',
    })
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  test('reports an unsupported runtime before starting a decode', async () => {
    await expect(
      decodeStaticImage(imageBlob(), {
        environment: {},
      }),
    ).rejects.toMatchObject({
      name: 'StaticImageDecodeError',
      reason: 'unsupported-runtime',
      format: 'png',
    })
  })
})
