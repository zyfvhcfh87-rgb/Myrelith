import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import type { MediaAsset } from '../../domain/schema'
import { MotionAnalysisController } from '../../app/motionAnalysisController'
import { probeMotionAnalysisFoundationSupport } from '../../app/motionAnalysisSupport'
import { getMotionAnalysisWorkerDiagnostics } from '../../app/motionAnalysisWorkerBridge'
import type {
  MotionAnalysisWorkerCompleteReply,
  MotionAnalysisWorkerWindowReply,
} from '../../pipeline/motionAnalysisProtocol'

const WIDTH = 160
const HEIGHT = 90
const FRAME_RATE = 30
const FRAME_COUNT = 12
const DURATION_US = 400_000

async function syntheticVideo(): Promise<Blob> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D OffscreenCanvas is unavailable')
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: 750_000,
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: FRAME_RATE })
  let finalized = false
  try {
    await output.start()
    for (let index = 0; index < FRAME_COUNT; index++) {
      context.fillStyle = `hsl(${index * 29} 65% 20%)`
      context.fillRect(0, 0, WIDTH, HEIGHT)
      context.fillStyle = '#ffffff'
      context.fillRect(12 + index * 8, 24, 24, 24)
      await source.add(index / FRAME_RATE, 1 / FRAME_RATE)
    }
    await output.finalize()
    finalized = true
  } finally {
    if (!finalized) await output.cancel().catch(() => undefined)
  }
  if (!target.buffer?.byteLength) throw new Error('Synthetic analysis source is empty')
  return new Blob([target.buffer], { type: 'video/mp4' })
}

function asset(blob: Blob, objectUrl: string): MediaAsset {
  return {
    id: 'issue-108-real-decoded-source',
    fileName: 'issue-108-real-decoded-source.mp4',
    mimeType: 'video/mp4',
    size: blob.size,
    lastModified: 1_000,
    objectUrl,
    kind: 'video',
    durationFrames: FRAME_COUNT,
    durationMicroseconds: DURATION_US,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: DURATION_US },
      audio: null,
    },
    frameRate: { num: FRAME_RATE, den: 1 },
    width: WIDTH,
    height: HEIGHT,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
    decoderConfigB64: null,
  }
}

export async function runMotionAnalysisFoundationBrowserGate() {
  const support = await probeMotionAnalysisFoundationSupport()
  if (!support.supported) {
    throw new Error(`Motion-analysis foundation support failed: ${support.failures.join(' ')}`)
  }
  const blob = await syntheticVideo()
  const objectUrl = URL.createObjectURL(blob)
  const media = asset(blob, objectUrl)
  const controller = new MotionAnalysisController()
  const projectBindingId = 'local-project:issue-108-browser-gate'
  const clipId = 'issue-108-browser-clip'
  const observedWindows: Array<{
    index: number
    offset: number
    frames: number
    retainedBytes: number
    lumaChecksum: number
  }> = []
  const request = {
    projectBindingId,
    asset: media,
    source: {
      videoStreamIndex: 0,
      width: WIDTH,
      height: HEIGHT,
      frameRate: { num: FRAME_RATE, den: 1 },
      sourceStartMicroseconds: 0,
      sourceEndMicroseconds: DURATION_US,
      samplingIntervalFrames: 1,
    },
    attachment: {
      clipId,
      sourceMappingDigest: '1'.repeat(64),
      projectionDigest: '2'.repeat(64),
    },
    algorithm: {
      kind: 'stabilization' as const,
      algorithmId: 'issue-108-decoded-foundation',
      algorithmVersion: 'decoded-foundation-v1',
      parametersDigest: '3'.repeat(64),
    },
    processor: {
      consumeWindow: async (window: MotionAnalysisWorkerWindowReply) => {
        let lumaChecksum = 0
        for (const frame of window.frames) {
          for (let index = 0; index < frame.pixels.length; index += 97) {
            lumaChecksum = (lumaChecksum + frame.pixels[index]!) >>> 0
          }
        }
        observedWindows.push({
          index: window.windowIndex,
          offset: window.sampleOffset,
          frames: window.frames.length,
          retainedBytes: window.retainedBytes,
          lumaChecksum,
        })
      },
      finish: async (completion: MotionAnalysisWorkerCompleteReply) => new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        completion,
        windows: observedWindows,
      })),
    },
    currentFailure: () => null,
  }
  try {
    const first = await controller.analyze(request)
    const second = await controller.analyze({
      ...request,
      processor: {
        consumeWindow: async () => {
          throw new Error('Fresh cache lookup unexpectedly started a worker')
        },
        finish: async () => {
          throw new Error('Fresh cache lookup unexpectedly finalized a result')
        },
      },
    })
    const firstText = new TextDecoder().decode(first.bytes)
    const secondText = new TextDecoder().decode(second.bytes)
    await controller.removeAttachment(projectBindingId, clipId)
    const scheduler = controller.snapshot().scheduler
    const workerDiagnostics = getMotionAnalysisWorkerDiagnostics()
    if (
      first.fromCache
      || !second.fromCache
      || firstText !== secondText
      || first.completion?.sampledFrameCount !== FRAME_COUNT
      || first.completion.maxRetainedFrames > 300
      || first.completion.maxRetainedBytes > 32 * 1024 * 1024
      || scheduler.maxActiveJobCount > 1
      || scheduler.maxActiveDecoderCount > 1
      || scheduler.queueDepth !== 0
      || scheduler.activeJobCount !== 0
      || scheduler.activeDecoderCount !== 0
      || scheduler.completedCount !== 2
      || scheduler.cancelledCount !== 0
      || workerDiagnostics.activeWorkers !== 0
    ) throw new Error('Motion-analysis foundation browser invariants failed')
    return {
      support,
      source: { bytes: blob.size, width: WIDTH, height: HEIGHT, frameCount: FRAME_COUNT },
      first: {
        fromCache: first.fromCache,
        resultBytes: first.bytes.byteLength,
        completion: first.completion,
      },
      second: { fromCache: second.fromCache, resultBytes: second.bytes.byteLength },
      windows: observedWindows,
      scheduler,
      workerDiagnostics,
      cacheRemoved: true,
    }
  } finally {
    await controller.dispose()
    URL.revokeObjectURL(objectUrl)
  }
}
