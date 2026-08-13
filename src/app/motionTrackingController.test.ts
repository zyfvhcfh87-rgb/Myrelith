import { afterEach, describe, expect, test, vi } from 'vitest'
import { MOTION_TRACKING_RESULT_VERSION } from '../domain/motionTracking'
import type { MotionAnalysisWorkerWindowReply } from '../pipeline/motionAnalysisProtocol'
import {
  createMotionTrackingProcessor,
  motionTrackingAnalysisMatchesSource,
  parseMotionTrackingAnalysis,
} from './motionTrackingController'

function translatedFrames(): MotionAnalysisWorkerWindowReply['frames'] {
  const width = 64
  const height = 48
  const texture = new Uint8Array(width * height)
  let state = 0x44a11ce
  for (let index = 0; index < texture.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    texture[index] = state >>> 24
  }
  return [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 2 }].map((offset, index) => {
    const pixels = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const targetX = x + offset.x
        const targetY = y + offset.y
        if (targetX < width && targetY < height) pixels[targetY * width + targetX] = texture[y * width + x]!
      }
    }
    return { timestampUs: index * 33_333, width, height, pixels }
  })
}

function completion(sampledFrameCount: number) {
  return {
    type: 'complete' as const,
    requestId: 1,
    decodedFrameCount: sampledFrameCount,
    sampledFrameCount,
    windowCount: 1,
    maxRetainedFrames: sampledFrameCount,
    maxRetainedBytes: sampledFrameCount * 64 * 48,
  }
}

describe('motion-tracking result processor', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('streams point tracking, preserves the directional schedule, and parses the exact result', async () => {
    const processor = createMotionTrackingProcessor(
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      'backward',
      [2_000_000, 1_000_000, 0],
      [2, 1, 0],
    )
    const frames = translatedFrames().map((frame, index) => ({
      ...frame,
      timestampUs: (2 - index) * 33_333,
    }))
    await processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 0, sampleOffset: 0,
      frames, retainedBytes: frames.length * 64 * 48,
    }, new AbortController().signal)
    const bytes = await processor.finish(completion(3), new AbortController().signal)
    const result = parseMotionTrackingAnalysis(bytes)

    expect(result).toMatchObject({
      version: MOTION_TRACKING_RESULT_VERSION,
      kind: 'point',
      direction: 'backward',
      selectionLocalFrame: 2,
      failure: null,
    })
    expect(result.samples.map((sample) => ({ frame: sample.localFrame, x: sample.x, y: sample.y }))).toEqual([
      { frame: 2, x: 32, y: 24 },
      { frame: 1, x: 34, y: 25 },
      { frame: 0, x: 36, y: 26 },
    ])
  })

  test('skips overlapped transport frames without duplicating accepted samples', async () => {
    const processor = createMotionTrackingProcessor(
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      'forward',
      [0, 1_000_000, 2_000_000],
      [0, 1, 2],
    )
    const frames = translatedFrames()
    const signal = new AbortController().signal
    await processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 0, sampleOffset: 0,
      frames: frames.slice(0, 2), retainedBytes: 2 * 64 * 48,
    }, signal)
    await processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 1, sampleOffset: 0,
      frames, retainedBytes: 3 * 64 * 48,
    }, signal)
    const result = parseMotionTrackingAnalysis(await processor.finish(completion(3), signal))
    expect(result.samples).toHaveLength(3)
  })

  test('records loss as a partial immutable result instead of extrapolating', async () => {
    const processor = createMotionTrackingProcessor(
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      'forward',
      [0, 1_000_000, 2_000_000],
      [0, 1, 2],
    )
    const frames = translatedFrames()
    frames[1]!.pixels.fill(0)
    frames[2]!.pixels.fill(255)
    const signal = new AbortController().signal
    await processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 0, sampleOffset: 0,
      frames, retainedBytes: 3 * 64 * 48,
    }, signal)
    const result = parseMotionTrackingAnalysis(await processor.finish(completion(3), signal))
    expect(result.samples).toHaveLength(1)
    expect(result.failure).toMatchObject({ localFrame: 1, code: 'lost-point' })
  })

  test('rejects an initial selection outside the bounded analyzable region', async () => {
    const processor = createMotionTrackingProcessor(
      { kind: 'point', point: { x: 0, y: 0 } },
      'forward',
      [0, 1_000_000],
      [0, 1],
    )
    await expect(processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 0, sampleOffset: 0,
      frames: translatedFrames().slice(0, 1), retainedBytes: 64 * 48,
    }, new AbortController().signal)).rejects.toThrow(/analyzable frame region/i)
  })

  test('observes cancellation immediately after a cooperative browser yield', async () => {
    const controller = new AbortController()
    vi.stubGlobal('scheduler', {
      yield: async () => controller.abort(),
    })
    const first = translatedFrames()[0]!
    const frames = Array.from({ length: 9 }, (_, index) => ({
      ...first,
      timestampUs: index * 33_333,
      pixels: first.pixels.slice(),
    }))
    const processor = createMotionTrackingProcessor(
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      'forward',
      Array.from({ length: 9 }, (_, index) => index * 1_000_000),
      Array.from({ length: 9 }, (_, index) => index),
    )
    await expect(processor.consumeWindow({
      type: 'window', requestId: 1, windowIndex: 0, sampleOffset: 0,
      frames, retainedBytes: frames.length * 64 * 48,
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('rejects cached point and box geometry outside the decoded frame', () => {
    const base = {
      version: MOTION_TRACKING_RESULT_VERSION,
      direction: 'forward',
      selectionLocalFrame: 0,
      width: 64,
      height: 48,
      failure: null,
    }
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>
    expect(() => parseMotionTrackingAnalysis(encode({
      ...base,
      kind: 'point',
      samples: [{ timestampUs: 0, sourceTimeTicks: 0, localFrame: 0, x: 64, y: 24, confidence: 1 }],
    }))).toThrow(/samples are invalid/)
    expect(() => parseMotionTrackingAnalysis(encode({
      ...base,
      kind: 'box',
      samples: [{
        timestampUs: 0, sourceTimeTicks: 0, localFrame: 0,
        x: 50, y: 20, width: 15, height: 10, confidence: 1,
      }],
    }))).toThrow(/samples are invalid/)
  })

  test('matches result geometry to the exact bounded connected-source size', () => {
    const source = { width: 1_920, height: 1_080 }
    expect(motionTrackingAnalysisMatchesSource({ width: 320, height: 180 }, source)).toBe(true)
    expect(motionTrackingAnalysisMatchesSource({ width: 319, height: 180 }, source)).toBe(false)
    expect(motionTrackingAnalysisMatchesSource({ width: 320, height: 179 }, source)).toBe(false)
    expect(motionTrackingAnalysisMatchesSource(
      { width: 160, height: 90 },
      { width: 160, height: 90 },
    )).toBe(true)
  })
})
