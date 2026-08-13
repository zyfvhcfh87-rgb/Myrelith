import { MAX_ANALYSIS_SAMPLES } from '../domain/analysisCache'
import {
  MOTION_ANALYSIS_MAX_HEIGHT,
  MOTION_ANALYSIS_MAX_RETAINED_BYTES,
  MOTION_ANALYSIS_MAX_WIDTH,
  MOTION_ANALYSIS_MAX_WINDOW_FRAMES,
  MOTION_ANALYSIS_WINDOW_OVERLAP,
  type MotionAnalysisGrayFrame,
} from './motionAnalysisProtocol'

const TRANSPORT_WINDOW_FRAMES = MOTION_ANALYSIS_MAX_WINDOW_FRAMES
  - MOTION_ANALYSIS_WINDOW_OVERLAP

export interface MotionAnalysisDecodeCompletion {
  readonly decodedFrameCount: number
  readonly sampledFrameCount: number
  readonly windowCount: number
  readonly maxRetainedFrames: number
  readonly maxRetainedBytes: number
}

export interface MotionAnalysisDecodeWindow {
  readonly windowIndex: number
  readonly sampleOffset: number
  readonly frames: readonly MotionAnalysisGrayFrame[]
  readonly retainedBytes: number
}

export interface MotionAnalysisDecodedFrame {
  readonly timestampUs: number
  readonly displayWidth: number
  readonly displayHeight: number
  readonly frame: Pick<VideoFrame, 'close'>
}

export interface MotionAnalysisFrameCursor {
  next(): Promise<MotionAnalysisDecodedFrame | null>
  close(): Promise<void>
}

export interface MotionAnalysisVideoSource {
  openPlaybackLane(options: {
    readonly startTimestampUs: number
    readonly endTimestampUs: number
  }): MotionAnalysisFrameCursor
  close(): Promise<void>
}

export interface MotionAnalysisDecodeRequest {
  readonly source: MotionAnalysisVideoSource
  readonly startTimestampUs: number
  readonly endTimestampUs: number
  readonly samplingIntervalFrames: number
  readonly extractGrayFrame: (
    frame: VideoFrame,
    timestampUs: number,
    displayWidth: number,
    displayHeight: number,
  ) => MotionAnalysisGrayFrame
  readonly sendWindow: (window: MotionAnalysisDecodeWindow) => Promise<void>
  readonly reportProgress: (
    decodedFrameCount: number,
    sampledFrameCount: number,
    progress: number,
  ) => void
}

export function motionAnalysisDisplaySize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    MOTION_ANALYSIS_MAX_WIDTH / width,
    MOTION_ANALYSIS_MAX_HEIGHT / height,
  )
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

export function extractMotionAnalysisGrayFrame(
  frame: VideoFrame,
  timestampUs: number,
  displayWidth: number,
  displayHeight: number,
): MotionAnalysisGrayFrame {
  if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is unavailable')
  const size = motionAnalysisDisplaySize(displayWidth, displayHeight)
  const canvas = new OffscreenCanvas(size.width, size.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('OffscreenCanvas 2D readback is unavailable')
  context.drawImage(frame, 0, 0, size.width, size.height)
  const rgba = context.getImageData(0, 0, size.width, size.height).data
  const pixels = new Uint8Array(size.width * size.height)
  for (let source = 0, target = 0; target < pixels.length; source += 4, target++) {
    pixels[target] = Math.round(
      rgba[source]! * 0.2126 + rgba[source + 1]! * 0.7152 + rgba[source + 2]! * 0.0722,
    )
  }
  return { timestampUs, width: size.width, height: size.height, pixels }
}

function cloneFrame(frame: MotionAnalysisGrayFrame): MotionAnalysisGrayFrame {
  return {
    timestampUs: frame.timestampUs,
    width: frame.width,
    height: frame.height,
    pixels: frame.pixels.slice(),
  }
}

export function motionAnalysisRetainedBytes(
  frames: readonly MotionAnalysisGrayFrame[],
): number {
  let total = 0
  for (const frame of frames) {
    if (
      frame.pixels.byteOffset !== 0
      || frame.pixels.byteLength !== frame.pixels.buffer.byteLength
      || frame.pixels.byteLength !== frame.width * frame.height
    ) throw new Error('Analysis grayscale frame is not tightly owned')
    total += frame.pixels.byteLength
    if (!Number.isSafeInteger(total) || total > MOTION_ANALYSIS_MAX_RETAINED_BYTES) {
      throw new RangeError('Analysis window exceeded the 32 MiB retained-buffer limit')
    }
  }
  return total
}

export async function decodeMotionAnalysisWindows(
  request: MotionAnalysisDecodeRequest,
): Promise<MotionAnalysisDecodeCompletion> {
  let cursor: MotionAnalysisFrameCursor | null = null
  let decodedFrameCount = 0
  let sampledFrameCount = 0
  let windowCount = 0
  let maxRetainedFrames = 0
  let maxRetainedBytes = 0
  let sampleOffset = 0
  let window: MotionAnalysisGrayFrame[] = []
  try {
    cursor = request.source.openPlaybackLane({
      startTimestampUs: request.startTimestampUs,
      endTimestampUs: request.endTimestampUs,
    })
    while (true) {
      const decoded = await cursor.next()
      if (!decoded) break
      let sampled: MotionAnalysisGrayFrame | null = null
      try {
        const shouldSample = decodedFrameCount % request.samplingIntervalFrames === 0
        decodedFrameCount++
        if (shouldSample) {
          sampled = request.extractGrayFrame(
            decoded.frame as VideoFrame,
            decoded.timestampUs,
            decoded.displayWidth,
            decoded.displayHeight,
          )
        }
      } finally {
        decoded.frame.close()
      }
      if (!sampled) continue
      window.push(sampled)
      sampledFrameCount++
      if (sampledFrameCount > MAX_ANALYSIS_SAMPLES) {
        throw new RangeError('Analysis exceeded the maximum serializable sample count')
      }
      const currentBytes = motionAnalysisRetainedBytes(window)
      maxRetainedFrames = Math.max(maxRetainedFrames, window.length)
      maxRetainedBytes = Math.max(maxRetainedBytes, currentBytes)
      if (window.length === TRANSPORT_WINDOW_FRAMES) {
        const overlap = window.slice(-MOTION_ANALYSIS_WINDOW_OVERLAP).map(cloneFrame)
        const overlapBytes = motionAnalysisRetainedBytes(overlap)
        maxRetainedFrames = Math.max(maxRetainedFrames, window.length + overlap.length)
        maxRetainedBytes = Math.max(maxRetainedBytes, currentBytes + overlapBytes)
        await request.sendWindow({
          windowIndex: windowCount++,
          sampleOffset,
          frames: window,
          retainedBytes: currentBytes,
        })
        sampleOffset += window.length - overlap.length
        window = overlap
      }
      if (decodedFrameCount % 8 === 0) {
        const span = request.endTimestampUs - request.startTimestampUs
        request.reportProgress(
          decodedFrameCount,
          sampledFrameCount,
          Math.max(0, Math.min(0.99, (decoded.timestampUs - request.startTimestampUs) / span)),
        )
      }
    }
    if (window.length > 0) {
      const currentBytes = motionAnalysisRetainedBytes(window)
      maxRetainedFrames = Math.max(maxRetainedFrames, window.length)
      maxRetainedBytes = Math.max(maxRetainedBytes, currentBytes)
      await request.sendWindow({
        windowIndex: windowCount++,
        sampleOffset,
        frames: window,
        retainedBytes: currentBytes,
      })
    }
    return {
      decodedFrameCount,
      sampledFrameCount,
      windowCount,
      maxRetainedFrames,
      maxRetainedBytes,
    }
  } finally {
    await Promise.allSettled([
      cursor?.close() ?? Promise.resolve(),
      request.source.close(),
    ])
  }
}
