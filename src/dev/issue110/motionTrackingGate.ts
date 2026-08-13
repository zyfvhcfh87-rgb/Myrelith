import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import {
  analyzeMotionTracking,
  applyMotionTracking,
  planMotionTracking,
} from '../../app/motionTrackingController'
import {
  clearActiveLocalProjectBindingId,
  setActiveLocalProjectBindingId,
} from '../../app/localProjectProvenance'
import {
  disposeMotionAnalysisRuntime,
  getMotionAnalysisController,
  initMotionAnalysisRuntime,
} from '../../app/motionAnalysisRuntime'
import { probeMotionAnalysisFoundationSupport } from '../../app/motionAnalysisSupport'
import { getMotionAnalysisWorkerDiagnostics } from '../../app/motionAnalysisWorkerBridge'
import { defaultClipVisualSettings } from '../../domain/clipInspector'
import type {
  MotionTrackingBoxAnalysis,
  MotionTrackingPointAnalysis,
} from '../../domain/motionTracking'
import type { Clip, MediaAsset, TimelineDoc } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'

const WIDTH = 160
const HEIGHT = 90
const FRAME_RATE = 30
const FRAME_COUNT = 32
const OCCLUSION_FRAME = 18
const DURATION_US = Math.ceil(FRAME_COUNT * 1_000_000 / FRAME_RATE)
const BINDING_ID = 'local-project:issue-110-browser-gate'
const SOURCE_CLIP_ID = 'issue-110-tracking-source'
const TARGET_CLIP_ID = 'issue-110-tracking-target'
const INITIAL_POINT = { x: 80, y: 45 }
const INITIAL_BOX = { x: 50, y: 20, width: 50, height: 50 }

function fillTexture(context: OffscreenCanvasRenderingContext2D): void {
  context.fillStyle = '#10182b'
  context.fillRect(0, 0, 220, 130)
  for (let y = 0; y < 130; y += 7) {
    for (let x = 0; x < 220; x += 9) {
      const hue = (x * 19 + y * 23) % 360
      context.fillStyle = `hsl(${hue} 78% ${30 + ((x + y) % 5) * 10}%)`
      context.fillRect(x + ((y / 7) % 2) * 2, y, 6, 5)
    }
  }
  context.strokeStyle = '#fff4c7'
  context.lineWidth = 2
  context.strokeRect(68, 39, 50, 50)
  context.fillStyle = '#ff4fa3'
  context.fillRect(100, 61, 5, 5)
}

async function trackingVideo(): Promise<Blob> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext('2d')
  const texture = new OffscreenCanvas(220, 130)
  const textureContext = texture.getContext('2d')
  if (!context || !textureContext) throw new Error('2D OffscreenCanvas is unavailable')
  fillTexture(textureContext)
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: 2_000_000,
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: FRAME_RATE })
  let finalized = false
  try {
    await output.start()
    for (let index = 0; index < FRAME_COUNT; index++) {
      context.fillStyle = index >= OCCLUSION_FRAME ? '#07090e' : '#000'
      context.fillRect(0, 0, WIDTH, HEIGHT)
      if (index < OCCLUSION_FRAME) context.drawImage(texture, -24 + index, -20)
      await source.add(index / FRAME_RATE, 1 / FRAME_RATE)
    }
    await output.finalize()
    finalized = true
  } finally {
    if (!finalized) await output.cancel().catch(() => undefined)
  }
  if (!target.buffer?.byteLength) throw new Error('Motion-tracking fixture is empty')
  return new Blob([target.buffer], { type: 'video/mp4' })
}

function asset(blob: Blob, objectUrl: string): MediaAsset {
  return {
    id: 'issue-110-tracking-asset',
    fileName: 'issue-110-tracking-source.mp4',
    mimeType: 'video/mp4',
    size: blob.size,
    lastModified: 1_100,
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

function clip(id: string, media: MediaAsset): Clip {
  return {
    id,
    assetId: media.id,
    name: id === SOURCE_CLIP_ID ? 'Tracking source' : 'Tracking target',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: FRAME_COUNT },
    timelineRange: { startFrame: 0, durationFrames: FRAME_COUNT },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: { tracks: [], effectTracks: [] },
    effects: [],
  }
}

function document(media: MediaAsset): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'issue-110-browser-document',
    name: 'Issue 110 browser gate',
    frameRate: { num: FRAME_RATE, den: 1 },
    width: WIDTH,
    height: HEIGHT,
    audioSampleRate: 48_000,
    tracks: [
      {
        id: 'video-source',
        kind: 'video',
        name: 'Tracking source',
        clips: [clip(SOURCE_CLIP_ID, media)],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
      {
        id: 'video-target',
        kind: 'video',
        name: 'Tracking target',
        clips: [clip(TARGET_CLIP_ID, media)],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
}

function pointAccuracy(analysis: MotionTrackingPointAnalysis) {
  const errors = analysis.samples.map((sample) => Math.hypot(
    sample.x - (INITIAL_POINT.x + sample.localFrame),
    sample.y - INITIAL_POINT.y,
  ))
  return {
    meanPixels: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    maximumPixels: Math.max(...errors),
  }
}

function boxAccuracy(analysis: MotionTrackingBoxAnalysis) {
  const centerErrors = analysis.samples.map((sample) => Math.hypot(
    sample.x + sample.width / 2 - (INITIAL_BOX.x + INITIAL_BOX.width / 2 + sample.localFrame),
    sample.y + sample.height / 2 - (INITIAL_BOX.y + INITIAL_BOX.height / 2),
  ))
  const scaleErrors = analysis.samples.map((sample) => Math.max(
    Math.abs(sample.width / INITIAL_BOX.width - 1),
    Math.abs(sample.height / INITIAL_BOX.height - 1),
  ))
  return {
    meanCenterPixels: centerErrors.reduce((sum, value) => sum + value, 0) / centerErrors.length,
    meanScaleRelativeError: scaleErrors.reduce((sum, value) => sum + value, 0) / scaleErrors.length,
    maximumScaleRelativeError: Math.max(...scaleErrors),
  }
}

export async function runMotionTrackingBrowserGate() {
  const support = await probeMotionAnalysisFoundationSupport()
  if (!support.supported) {
    throw new Error(`Motion-tracking support failed: ${support.failures.join(' ')}`)
  }
  const blob = await trackingVideo()
  const objectUrl = URL.createObjectURL(blob)
  const media = asset(blob, objectUrl)
  useDocumentStore.getState().setDoc(document(media))
  if (!useMediaStore.getState().addAsset(media)) {
    URL.revokeObjectURL(objectUrl)
    throw new Error('Could not connect the motion-tracking fixture')
  }
  setActiveLocalProjectBindingId(BINDING_ID)
  const release = await initMotionAnalysisRuntime()
  try {
    const point = await analyzeMotionTracking({
      sourceClipId: SOURCE_CLIP_ID,
      selectionGlobalFrame: 0,
      direction: 'forward',
      selection: {
        kind: 'point',
        point: {
          x: INITIAL_POINT.x / (WIDTH - 1),
          y: INITIAL_POINT.y / (HEIGHT - 1),
        },
      },
    })
    if (point.analysis.kind !== 'point') throw new Error('Point tracker returned the wrong result kind')
    const cachedPoint = await analyzeMotionTracking({
      sourceClipId: SOURCE_CLIP_ID,
      selectionGlobalFrame: 0,
      direction: 'forward',
      selection: {
        kind: 'point',
        point: {
          x: INITIAL_POINT.x / (WIDTH - 1),
          y: INITIAL_POINT.y / (HEIGHT - 1),
        },
      },
    })
    if (!cachedPoint.fromCache || cachedPoint.cacheKey !== point.cacheKey) {
      throw new Error('Point-tracking cache round-trip was not exact')
    }
    const backwardPoint = await analyzeMotionTracking({
      sourceClipId: SOURCE_CLIP_ID,
      selectionGlobalFrame: OCCLUSION_FRAME - 1,
      direction: 'backward',
      selection: {
        kind: 'point',
        point: {
          x: (INITIAL_POINT.x + OCCLUSION_FRAME - 1) / (WIDTH - 1),
          y: INITIAL_POINT.y / (HEIGHT - 1),
        },
      },
    })
    if (backwardPoint.analysis.kind !== 'point') {
      throw new Error('Backward point tracker returned the wrong result kind')
    }
    const backwardPointMetrics = pointAccuracy(backwardPoint.analysis)
    if (
      backwardPoint.analysis.failure !== null
      || backwardPoint.analysis.samples.length !== OCCLUSION_FRAME
      || backwardPoint.analysis.samples[0]?.localFrame !== OCCLUSION_FRAME - 1
      || backwardPoint.analysis.samples.at(-1)?.localFrame !== 0
      || backwardPointMetrics.meanPixels > 2
      || backwardPointMetrics.maximumPixels > 4
    ) throw new Error(`Backward point-tracking gate failed: ${JSON.stringify({
      analysis: backwardPoint.analysis,
      metrics: backwardPointMetrics,
    })}`)
    const box = await analyzeMotionTracking({
      sourceClipId: SOURCE_CLIP_ID,
      selectionGlobalFrame: 0,
      direction: 'forward',
      selection: {
        kind: 'box',
        box: {
          x: INITIAL_BOX.x / (WIDTH - 1),
          y: INITIAL_BOX.y / (HEIGHT - 1),
          width: INITIAL_BOX.width / WIDTH,
          height: INITIAL_BOX.height / HEIGHT,
        },
      },
    })
    if (box.analysis.kind !== 'box') throw new Error('Box tracker returned the wrong result kind')
    const pointMetrics = pointAccuracy(point.analysis)
    const boxMetrics = boxAccuracy(box.analysis)
    if (
      point.analysis.failure?.localFrame !== OCCLUSION_FRAME
      || box.analysis.failure?.localFrame !== OCCLUSION_FRAME
      || pointMetrics.meanPixels > 2
      || pointMetrics.maximumPixels > 4
      || boxMetrics.meanCenterPixels > 3
      || boxMetrics.meanScaleRelativeError > 0.08
    ) throw new Error(`Motion-tracking quality gate failed: ${JSON.stringify({
      pointFailure: point.analysis.failure,
      boxFailure: box.analysis.failure,
      pointMetrics,
      boxMetrics,
    })}`)
    const planned = planMotionTracking(box, TARGET_CLIP_ID, true)
    if (!planned.ok) throw new Error(planned.reason)
    const applied = applyMotionTracking(box, TARGET_CLIP_ID, true, false)
    if (!applied.ok || !applied.changed) {
      throw new Error(applied.ok ? 'Motion tracking did not change the document' : applied.reason)
    }
    const target = useDocumentStore.getState().doc.tracks[1]!.clips[0]!
    const properties = target.animation?.tracks.map((track) => track.property) ?? []
    await getMotionAnalysisController()?.removeAttachment(BINDING_ID, SOURCE_CLIP_ID)
    const scheduler = getMotionAnalysisController()?.snapshot().scheduler
    const workerDiagnostics = getMotionAnalysisWorkerDiagnostics()
    if (
      properties.join(',') !== 'position-x,position-y,scale-x,scale-y'
      || target.animation?.tracks.some((track) => track.keyframes.length > 1_024)
      || useDocumentStore.getState().past.length !== 1
      || !scheduler
      || scheduler.activeJobCount !== 0
      || scheduler.activeDecoderCount !== 0
      || workerDiagnostics.activeWorkers !== 0
    ) throw new Error(`Motion-tracking product invariants failed: ${JSON.stringify({
      properties,
      keyCounts: target.animation?.tracks.map((track) => track.keyframes.length),
      historyEntries: useDocumentStore.getState().past.length,
      scheduler,
      workerDiagnostics,
    })}`)
    return {
      support,
      source: {
        bytes: blob.size,
        width: WIDTH,
        height: HEIGHT,
        frameCount: FRAME_COUNT,
        occlusionFrame: OCCLUSION_FRAME,
      },
      point: {
        acceptedSamples: point.analysis.samples.length,
        failure: point.analysis.failure,
        ...pointMetrics,
        cachedFromSecondRun: cachedPoint.fromCache,
      },
      backwardPoint: {
        acceptedSamples: backwardPoint.analysis.samples.length,
        failure: backwardPoint.analysis.failure,
        ...backwardPointMetrics,
      },
      box: {
        acceptedSamples: box.analysis.samples.length,
        failure: box.analysis.failure,
        ...boxMetrics,
      },
      authoredProperties: properties,
      historyEntries: useDocumentStore.getState().past.length,
      scheduler,
      workerDiagnostics,
      cacheRemoved: true,
    }
  } finally {
    await release()
    await disposeMotionAnalysisRuntime()
    clearActiveLocalProjectBindingId()
    useMediaStore.getState().clearAssets()
  }
}
