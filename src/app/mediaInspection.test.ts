import { describe, expect, test, vi } from 'vitest'
import {
  inspectMediaFileCompatibility,
  type MediaInspectionDeps,
} from './mediaInspection'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import {
  StaticImageDecodeError,
  type DecodedStaticImage,
} from '../pipeline/static-image'
import {
  StaticImageInspectionError,
  type StaticImageInspection,
} from '../pipeline/static-image-inspection'

const RATE = { num: 30_000, den: 1_001 } as const

function imageFile(
  name = 'poster.png',
  type = 'image/png',
): File {
  return new File(['image bytes'], name, {
    type,
    lastModified: 123,
  })
}

function inspection(
  overrides: Partial<StaticImageInspection> = {},
): StaticImageInspection {
  return {
    format: 'png',
    mimeType: 'image/png',
    fileBytes: 11,
    width: 640,
    height: 360,
    pixelCount: 230_400,
    decodedBytes: 921_600,
    dimensionCandidates: [{ width: 640, height: 360 }],
    animation: {
      isAnimated: false,
      frameCount: 1,
      loopCount: null,
    },
    ...overrides,
  }
}

function decodedImage(
  close: () => void,
  overrides: Partial<DecodedStaticImage> = {},
): DecodedStaticImage {
  return {
    source: { close } as ImageBitmap,
    sourceKind: 'image-bitmap',
    width: 640,
    height: 360,
    animation: {
      isAnimated: false,
      frameCount: 1,
      loopCount: null,
    },
    decoderRepetitionCount: null,
    decodePath: 'image-bitmap',
    ...overrides,
  }
}

function timedResult(): MediaProbeResult {
  return {
    status: 'unsupported',
    asset: null,
    compatibility: {
      status: 'unsupported',
      container: null,
      durationMicroseconds: null,
      tracks: [],
      reason: 'unsupported-container',
      detail: 'not timed media',
    },
  }
}

function dependencies(
  overrides: Partial<MediaInspectionDeps> = {},
): MediaInspectionDeps {
  return {
    inspectStaticImage: vi.fn(async () => inspection()),
    decodeStaticImage: vi.fn(async () => decodedImage(vi.fn())),
    probeTimedMedia: vi.fn(async () => timedResult()),
    createObjectUrl: vi.fn(() => 'blob:verified-image'),
    ...overrides,
  }
}

describe('shared media inspection', () => {
  test('creates a durable five-second image asset only after real decode', async () => {
    const close = vi.fn()
    const inspectStaticImage = vi.fn(async () => inspection({
      animation: {
        isAnimated: true,
        frameCount: 12,
        loopCount: 0,
      },
    }))
    const decodeStaticImage = vi.fn(async () => decodedImage(close, {
      width: 360,
      height: 640,
      animation: {
        isAnimated: true,
        frameCount: 12,
        loopCount: 0,
      },
      decodePath: 'image-decoder',
    }))
    const probeTimedMedia = vi.fn(async () => timedResult())
    const createObjectUrl = vi.fn(() => 'blob:animated-poster')
    const file = imageFile('animated.webp', 'application/octet-stream')

    const result = await inspectMediaFileCompatibility(
      file,
      RATE,
      'asset-image',
      undefined,
      dependencies({
        inspectStaticImage,
        decodeStaticImage,
        probeTimedMedia,
        createObjectUrl,
      }),
    )

    expect(result).toMatchObject({
      status: 'ready',
      asset: {
        id: 'asset-image',
        kind: 'image',
        mimeType: 'application/octet-stream',
        objectUrl: 'blob:animated-poster',
        durationMicroseconds: 5_000_000,
        durationFrames: 150,
        frameRate: null,
        width: 360,
        height: 640,
        hasAudio: false,
        audioSampleRate: null,
        audioChannels: null,
        decoderConfigB64: null,
      },
      compatibility: {
        status: 'ready',
        durationMicroseconds: 5_000_000,
        tracks: [],
        image: {
          format: 'png',
          mimeType: 'image/png',
          width: 360,
          height: 640,
          animated: true,
          frameCount: 12,
          firstFrameOnly: true,
          decodePath: 'image-decoder',
        },
      },
    })
    expect(result.compatibility.detail).toContain('first frame only')
    expect(inspectStaticImage).toHaveBeenCalledWith(file, {
      signal: undefined,
    })
    expect(decodeStaticImage).toHaveBeenCalledWith(file, {
      signal: undefined,
    })
    expect(createObjectUrl).toHaveBeenCalledWith(file)
    expect(probeTimedMedia).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  test('falls back to the timed-media probe only when bytes are not an image', async () => {
    const unknown = new StaticImageInspectionError(
      'unsupported-format',
      'unsupported-format',
      'not an image',
      null,
    )
    const inspectStaticImage = vi.fn(async () => {
      throw unknown
    })
    const probeResult = timedResult()
    const probeTimedMedia = vi.fn(async () => probeResult)
    const decodeStaticImage = vi.fn()
    const file = imageFile('movie.mp4', 'video/mp4')

    await expect(inspectMediaFileCompatibility(
      file,
      RATE,
      'asset-video',
      undefined,
      dependencies({
        inspectStaticImage,
        decodeStaticImage,
        probeTimedMedia,
      }),
    )).resolves.toBe(probeResult)

    expect(probeTimedMedia).toHaveBeenCalledWith(
      file,
      RATE,
      'asset-video',
      undefined,
    )
    expect(decodeStaticImage).not.toHaveBeenCalled()
  })

  test.each([
    ['gif', 'Animated GIF is not supported.'],
    ['svg', 'SVG is not supported.'],
  ] as const)('rejects recognized %s bytes without timed-media fallback', async (
    detectedFormat,
    message,
  ) => {
    const probeTimedMedia = vi.fn(async () => timedResult())
    const result = await inspectMediaFileCompatibility(
      imageFile(`unsafe.${detectedFormat}`),
      RATE,
      'asset-unsafe',
      undefined,
      dependencies({
        inspectStaticImage: vi.fn(async () => {
          throw new StaticImageInspectionError(
            'unsupported-format',
            'unsupported-format',
            message,
            detectedFormat,
          )
        }),
        probeTimedMedia,
      }),
    )

    expect(result).toMatchObject({
      status: 'unsupported',
      asset: null,
      compatibility: {
        reason: 'unsupported-container',
      },
    })
    expect(result.compatibility.detail).toContain(message)
    expect(probeTimedMedia).not.toHaveBeenCalled()
  })

  test('maps image decode and object-URL failures to actionable reports', async () => {
    const decodeFailure = await inspectMediaFileCompatibility(
      imageFile(),
      RATE,
      'asset-decode-failure',
      undefined,
      dependencies({
        decodeStaticImage: vi.fn(async () => {
          throw new StaticImageDecodeError('metadata-mismatch', 'png')
        }),
      }),
    )
    expect(decodeFailure).toMatchObject({
      status: 'error',
      compatibility: { reason: 'malformed-media' },
    })

    const close = vi.fn()
    const urlFailure = await inspectMediaFileCompatibility(
      imageFile(),
      RATE,
      'asset-url-failure',
      undefined,
      dependencies({
        decodeStaticImage: vi.fn(async () => decodedImage(close)),
        createObjectUrl: vi.fn(() => {
          throw new Error('object URL unavailable')
        }),
      }),
    )
    expect(urlFailure).toMatchObject({
      status: 'error',
      compatibility: { reason: 'resource-unavailable' },
    })
    expect(close).toHaveBeenCalledOnce()
  })

  test('propagates cancellation and never probes another media path', async () => {
    const cancellation = new Error('cancelled')
    cancellation.name = 'AbortError'
    const probeTimedMedia = vi.fn(async () => timedResult())

    await expect(inspectMediaFileCompatibility(
      imageFile(),
      RATE,
      'asset-cancelled',
      undefined,
      dependencies({
        inspectStaticImage: vi.fn(async () => {
          throw cancellation
        }),
        probeTimedMedia,
      }),
    )).rejects.toBe(cancellation)
    expect(probeTimedMedia).not.toHaveBeenCalled()
  })
})
