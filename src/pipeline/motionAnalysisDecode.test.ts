import { describe, expect, it, vi } from 'vitest'
import {
  decodeMotionAnalysisWindows,
  motionAnalysisDisplaySize,
  motionAnalysisRetainedBytes,
  type MotionAnalysisDecodedFrame,
  type MotionAnalysisDecodeWindow,
  type MotionAnalysisFrameCursor,
  type MotionAnalysisVideoSource,
} from './motionAnalysisDecode'

function sourceFixture(frameCount: number) {
  let nextIndex = 0
  const closeCounts = Array.from({ length: frameCount }, () => 0)
  const cursorClose = vi.fn(async () => undefined)
  const sourceClose = vi.fn(async () => undefined)
  const cursor: MotionAnalysisFrameCursor = {
    next: vi.fn(async (): Promise<MotionAnalysisDecodedFrame | null> => {
      if (nextIndex >= frameCount) return null
      const index = nextIndex++
      return {
        timestampUs: index * 33_333,
        displayWidth: 320,
        displayHeight: 180,
        frame: {
          close() {
            closeCounts[index]!++
          },
        },
      }
    }),
    close: cursorClose,
  }
  const source: MotionAnalysisVideoSource = {
    openPlaybackLane: vi.fn(() => cursor),
    close: sourceClose,
  }
  return { closeCounts, cursor, cursorClose, source, sourceClose }
}

describe('decodeMotionAnalysisWindows', () => {
  it('streams long clips with overlap while retaining at most 300 frames', async () => {
    const fixture = sourceFixture(600)
    const windows: MotionAnalysisDecodeWindow[] = []
    const completion = await decodeMotionAnalysisWindows({
      source: fixture.source,
      startTimestampUs: 0,
      endTimestampUs: 20_000_000,
      samplingIntervalFrames: 1,
      extractGrayFrame: (_frame, timestampUs) => ({
        timestampUs,
        width: 1,
        height: 1,
        pixels: new Uint8Array(new ArrayBuffer(1)),
      }),
      sendWindow: async (window) => {
        windows.push(window)
      },
      reportProgress: vi.fn(),
    })

    expect(windows.map((window) => ({
      index: window.windowIndex,
      offset: window.sampleOffset,
      length: window.frames.length,
    }))).toEqual([
      { index: 0, offset: 0, length: 298 },
      { index: 1, offset: 296, length: 298 },
      { index: 2, offset: 592, length: 8 },
    ])
    expect(windows[0]?.frames.at(-2)?.timestampUs).toBe(windows[1]?.frames[0]?.timestampUs)
    expect(windows[1]?.frames.at(-2)?.timestampUs).toBe(windows[2]?.frames[0]?.timestampUs)
    expect(completion).toMatchObject({
      decodedFrameCount: 600,
      sampledFrameCount: 600,
      windowCount: 3,
      maxRetainedFrames: 300,
      maxRetainedBytes: 300,
    })
    expect(fixture.closeCounts.every((count) => count === 1)).toBe(true)
    expect(fixture.cursorClose).toHaveBeenCalledOnce()
    expect(fixture.sourceClose).toHaveBeenCalledOnce()
  })

  it('closes every yielded frame and both decoder owners after a consumer failure', async () => {
    const fixture = sourceFixture(400)
    await expect(decodeMotionAnalysisWindows({
      source: fixture.source,
      startTimestampUs: 0,
      endTimestampUs: 20_000_000,
      samplingIntervalFrames: 1,
      extractGrayFrame: (_frame, timestampUs) => ({
        timestampUs,
        width: 1,
        height: 1,
        pixels: new Uint8Array(new ArrayBuffer(1)),
      }),
      sendWindow: async () => {
        throw new Error('consumer-failed')
      },
      reportProgress: vi.fn(),
    })).rejects.toThrow('consumer-failed')

    expect(fixture.closeCounts.slice(0, 298).every((count) => count === 1)).toBe(true)
    expect(fixture.closeCounts.slice(298).every((count) => count === 0)).toBe(true)
    expect(fixture.cursorClose).toHaveBeenCalledOnce()
    expect(fixture.sourceClose).toHaveBeenCalledOnce()
  })

  it('closes the source when playback-lane creation fails', async () => {
    const fixture = sourceFixture(1)
    fixture.source.openPlaybackLane = vi.fn(() => {
      throw new Error('lane-open-failed')
    })

    await expect(decodeMotionAnalysisWindows({
      source: fixture.source,
      startTimestampUs: 0,
      endTimestampUs: 1_000_000,
      samplingIntervalFrames: 1,
      extractGrayFrame: vi.fn(),
      sendWindow: vi.fn(),
      reportProgress: vi.fn(),
    })).rejects.toThrow('lane-open-failed')

    expect(fixture.cursorClose).not.toHaveBeenCalled()
    expect(fixture.sourceClose).toHaveBeenCalledOnce()
  })

  it('samples deterministically and rejects non-tight or oversized planes', async () => {
    const fixture = sourceFixture(5)
    const timestamps: number[] = []
    const completion = await decodeMotionAnalysisWindows({
      source: fixture.source,
      startTimestampUs: 0,
      endTimestampUs: 1_000_000,
      samplingIntervalFrames: 2,
      extractGrayFrame: (_frame, timestampUs) => ({
        timestampUs,
        width: 1,
        height: 1,
        pixels: new Uint8Array(new ArrayBuffer(1)),
      }),
      sendWindow: async (window) => {
        timestamps.push(...window.frames.map((frame) => frame.timestampUs))
      },
      reportProgress: vi.fn(),
    })
    expect(timestamps).toEqual([0, 66_666, 133_332])
    expect(completion.sampledFrameCount).toBe(3)

    const backing = new Uint8Array(new ArrayBuffer(8))
    expect(() => motionAnalysisRetainedBytes([{
      timestampUs: 0,
      width: 2,
      height: 2,
      pixels: backing.subarray(2, 6),
    }])).toThrow(/tightly owned/)
    expect(motionAnalysisDisplaySize(3840, 2160)).toEqual({ width: 320, height: 180 })
    expect(motionAnalysisDisplaySize(100, 50)).toEqual({ width: 100, height: 50 })
  })
})
