import { describe, expect, test } from 'vitest'
import type { MotionAnalysisWorkerWindowReply } from '../pipeline/motionAnalysisProtocol'
import {
  MotionAnalysisError,
} from './motionAnalysisController'
import {
  createVideoStabilizationProcessor,
  MAX_VIDEO_STABILIZATION_RESULT_BYTES,
  MAX_VIDEO_STABILIZATION_SAMPLES,
  parseVideoStabilizationAnalysis,
} from './videoStabilizationController'

function randomPlane(width: number, height: number, seed: number): Uint8Array<ArrayBuffer> {
  let state = seed >>> 0
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    data[index] = state >>> 24
  }
  return data
}

function shifted(
  source: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(source.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fromX = x - dx
      const fromY = y - dy
      output[y * width + x] = fromX >= 0 && fromX < width && fromY >= 0 && fromY < height
        ? source[fromY * width + fromX]!
        : 0
    }
  }
  return output
}

function window(
  planes: readonly Uint8Array<ArrayBuffer>[],
  sampleOffset = 0,
  windowIndex = 0,
): MotionAnalysisWorkerWindowReply {
  const width = 96
  const height = 64
  return {
    type: 'window',
    requestId: 1,
    windowIndex,
    sampleOffset,
    frames: planes.map((pixels, index) => ({
      timestampUs: (sampleOffset + index) * 33_334,
      width,
      height,
      pixels,
    })),
    retainedBytes: planes.reduce((total, plane) => total + plane.byteLength, 0),
  }
}

describe('video stabilization analysis adapter', () => {
  test('streams overlapping worker windows into one strict cache result', async () => {
    const first = randomPlane(96, 64, 0x109)
    const second = shifted(first, 96, 64, 1, 0)
    const third = shifted(first, 96, 64, 2, 0)
    const processor = createVideoStabilizationProcessor()
    const controller = new AbortController()

    await processor.consumeWindow(window([first.slice(), second.slice()]), controller.signal)
    await processor.consumeWindow(window([second.slice(), third.slice()], 1, 1), controller.signal)
    const bytes = await processor.finish({
      type: 'complete',
      requestId: 1,
      decodedFrameCount: 3,
      sampledFrameCount: 3,
      windowCount: 2,
      maxRetainedFrames: 2,
      maxRetainedBytes: first.byteLength * 2,
    }, controller.signal)
    const parsed = parseVideoStabilizationAnalysis(bytes)

    expect(parsed.samples).toHaveLength(3)
    expect(parsed.samples[0]?.estimateFromPrevious).toBeNull()
    expect(parsed.samples.slice(1).every((sample) => (
      sample.estimateFromPrevious !== null
      && sample.estimateFromPrevious.confidence > 0
    ))).toBe(true)
  })

  test('classifies a hard content replacement as a scene cut', async () => {
    const processor = createVideoStabilizationProcessor()
    const controller = new AbortController()
    const first = new Uint8Array(96 * 64)
    const second = new Uint8Array(96 * 64).fill(255)

    await expect(processor.consumeWindow(window([first, second]), controller.signal))
      .rejects.toMatchObject({
        name: 'MotionAnalysisError',
        code: 'scene-cut',
      })
  })

  test('stops streaming before retaining a sample beyond the derived result envelope', async () => {
    const first = randomPlane(96, 64, 0x109)
    const second = shifted(first, 96, 64, 1, 0)
    const third = shifted(first, 96, 64, 2, 0)
    const processor = createVideoStabilizationProcessor(2)
    const controller = new AbortController()

    await expect(processor.consumeWindow(
      window([first, second, third]),
      controller.signal,
    )).rejects.toMatchObject({
      name: 'MotionAnalysisError',
      code: 'resource-limit',
      message: 'Stabilization analysis exceeds the 2-sample result envelope',
    })
    expect(MAX_VIDEO_STABILIZATION_RESULT_BYTES).toBe(32 * 1024 * 1024)
    expect(MAX_VIDEO_STABILIZATION_SAMPLES).toBe(65_534)
  })

  test('rejects unknown members and malformed estimate values from cache', () => {
    const invalid = new TextEncoder().encode(JSON.stringify({
      version: 1,
      width: 96,
      height: 64,
      samples: [
        { timestampUs: 0, estimateFromPrevious: null },
        {
          timestampUs: 33_334,
          estimateFromPrevious: {
            transform: { a: 1, b: 0, tx: 1, ty: 0 },
            matchCount: 10,
            inlierCount: 11,
            inlierRatio: 1.1,
            meanInlierError: 0,
            confidence: 1,
          },
        },
      ],
      surprise: true,
    })) as Uint8Array<ArrayBuffer>
    expect(() => parseVideoStabilizationAnalysis(invalid)).toThrow(MotionAnalysisError)
  })

  test('honors cancellation before doing pair work', async () => {
    const processor = createVideoStabilizationProcessor()
    const controller = new AbortController()
    controller.abort()
    const frame = randomPlane(96, 64, 7)
    await expect(processor.consumeWindow(window([frame, frame.slice()]), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
