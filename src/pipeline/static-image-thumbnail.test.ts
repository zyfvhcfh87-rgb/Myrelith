import { describe, expect, test, vi } from 'vitest'
import type { DecodedStaticImage } from './static-image'
import {
  generateStaticImageThumbnail,
  STATIC_IMAGE_THUMBNAIL_LIMITS,
  type StaticImageThumbnailCanvas,
} from './static-image-thumbnail'

function decodedImage(
  width: number,
  height: number,
  close: () => void,
): DecodedStaticImage {
  return {
    source: { close } as ImageBitmap,
    sourceKind: 'image-bitmap',
    width,
    height,
    animation: {
      isAnimated: false,
      frameCount: 1,
      loopCount: null,
    },
    decoderRepetitionCount: null,
    decodePath: 'image-bitmap',
  }
}

function canvas(
  png = new Blob(['png bytes'], { type: 'image/png' }),
): StaticImageThumbnailCanvas {
  return {
    draw: vi.fn(),
    encodePng: vi.fn(async () => png),
  }
}

describe('static-image thumbnail', () => {
  test.each([
    [640, 360, 320, 180],
    [360, 640, 101, 180],
    [80, 40, 80, 40],
  ])('fits %sx%s into one bounded %sx%s tile', async (
    sourceWidth,
    sourceHeight,
    expectedWidth,
    expectedHeight,
  ) => {
    const close = vi.fn()
    const surface = canvas()
    const createCanvas = vi.fn(() => surface)
    const createObjectUrl = vi.fn(() => 'blob:thumbnail')
    const decode = vi.fn(async () => (
      decodedImage(sourceWidth, sourceHeight, close)
    ))

    const result = await generateStaticImageThumbnail(new Blob(['image']), {
      decode,
      createCanvas,
      createObjectUrl,
    })

    expect(result).toEqual({
      url: 'blob:thumbnail',
      tiles: 1,
      tileWidth: expectedWidth,
      tileHeight: expectedHeight,
    })
    expect(createCanvas).toHaveBeenCalledWith(expectedWidth, expectedHeight)
    expect(surface.draw).toHaveBeenCalledWith(
      expect.anything(),
      expectedWidth,
      expectedHeight,
    )
    expect(createObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
    )
    expect(close).toHaveBeenCalledOnce()
  })

  test('closes the decoded source when drawing or encoding fails', async () => {
    const drawClose = vi.fn()
    await expect(generateStaticImageThumbnail(new Blob(['image']), {
      decode: vi.fn(async () => decodedImage(100, 100, drawClose)),
      createCanvas: () => ({
        draw: () => {
          throw new Error('draw exploded')
        },
        encodePng: vi.fn(),
      }),
    })).rejects.toMatchObject({
      name: 'StaticImageThumbnailError',
      reason: 'encode-failed',
    })
    expect(drawClose).toHaveBeenCalledOnce()

    const encodeClose = vi.fn()
    await expect(generateStaticImageThumbnail(new Blob(['image']), {
      decode: vi.fn(async () => decodedImage(100, 100, encodeClose)),
      createCanvas: () => ({
        draw: vi.fn(),
        encodePng: vi.fn(async () => {
          throw new Error('encode exploded')
        }),
      }),
    })).rejects.toMatchObject({
      name: 'StaticImageThumbnailError',
      reason: 'encode-failed',
    })
    expect(encodeClose).toHaveBeenCalledOnce()
  })

  test('rejects empty and oversized encoded results without creating a URL', async () => {
    for (const png of [
      new Blob([]),
      new Blob([
        new Uint8Array(
          STATIC_IMAGE_THUMBNAIL_LIMITS.maxEncodedBytes + 1,
        ),
      ]),
    ]) {
      const close = vi.fn()
      const createObjectUrl = vi.fn()
      await expect(generateStaticImageThumbnail(new Blob(['image']), {
        decode: vi.fn(async () => decodedImage(100, 100, close)),
        createCanvas: () => canvas(png),
        createObjectUrl,
      })).rejects.toMatchObject({
        name: 'StaticImageThumbnailError',
        reason: 'resource-limit',
      })
      expect(createObjectUrl).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    }
  })

  test('abort wins a pending encode and still closes the decoded source', async () => {
    let finishEncoding = (_blob: Blob): void => {}
    const encoding = new Promise<Blob>((resolve) => {
      finishEncoding = resolve
    })
    const close = vi.fn()
    const controller = new AbortController()
    const generating = generateStaticImageThumbnail(new Blob(['image']), {
      signal: controller.signal,
      decode: vi.fn(async () => decodedImage(100, 100, close)),
      createCanvas: () => ({
        draw: vi.fn(),
        encodePng: () => encoding,
      }),
      createObjectUrl: vi.fn(),
    })

    await Promise.resolve()
    controller.abort()
    await expect(generating).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledOnce()

    finishEncoding(new Blob(['late png']))
    await Promise.resolve()
  })
})
