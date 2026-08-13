import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import {
  analyzeVideoStabilization,
  applyVideoStabilization,
  planVideoStabilization,
} from '../../app/videoStabilizationController'
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
import { resolveClipAnimationAtFrame } from '../../domain/clipAnimation'
import { defaultClipVisualSettings } from '../../domain/clipInspector'
import type { Clip, MediaAsset, TimelineDoc } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'

const WIDTH = 160
const HEIGHT = 90
const FRAME_RATE = 30
const FRAME_COUNT = 32
const DURATION_US = Math.ceil(FRAME_COUNT * 1_000_000 / FRAME_RATE)
const BINDING_ID = 'local-project:issue-109-browser-gate'
const CLIP_ID = 'issue-109-stabilization-clip'

function fillTexture(context: OffscreenCanvasRenderingContext2D): void {
  context.fillStyle = '#182038'
  context.fillRect(0, 0, 208, 138)
  for (let y = 0; y < 138; y += 9) {
    for (let x = 0; x < 208; x += 11) {
      const hue = (x * 13 + y * 17) % 360
      context.fillStyle = `hsl(${hue} 72% ${35 + ((x + y) % 4) * 9}%)`
      context.fillRect(x + ((y / 9) % 2) * 2, y, 7, 6)
    }
  }
  context.strokeStyle = '#f4e9ff'
  context.lineWidth = 2
  context.strokeRect(31, 28, 56, 39)
  context.strokeRect(112, 62, 45, 31)
}

async function handheldVideo(): Promise<Blob> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext('2d')
  const texture = new OffscreenCanvas(208, 138)
  const textureContext = texture.getContext('2d')
  if (!context || !textureContext) throw new Error('2D OffscreenCanvas is unavailable')
  fillTexture(textureContext)
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: 1_400_000,
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: FRAME_RATE })
  let finalized = false
  try {
    await output.start()
    for (let index = 0; index < FRAME_COUNT; index++) {
      const panX = index * 0.18
      const panY = index * 0.06
      const jitterX = Math.sin(index * 1.77) * 1.8
      const jitterY = Math.cos(index * 1.31) * 1.35
      const angle = Math.sin(index * 1.11) * 0.004
      context.save()
      context.fillStyle = '#000'
      context.fillRect(0, 0, WIDTH, HEIGHT)
      context.translate(WIDTH / 2, HEIGHT / 2)
      context.rotate(angle)
      context.drawImage(
        texture,
        -104 - 3 + panX + jitterX,
        -69 - 2 + panY + jitterY,
      )
      context.restore()
      await source.add(index / FRAME_RATE, 1 / FRAME_RATE)
    }
    await output.finalize()
    finalized = true
  } finally {
    if (!finalized) await output.cancel().catch(() => undefined)
  }
  if (!target.buffer?.byteLength) throw new Error('Stabilization fixture is empty')
  return new Blob([target.buffer], { type: 'video/mp4' })
}

function asset(blob: Blob, objectUrl: string): MediaAsset {
  return {
    id: 'issue-109-handheld-source',
    fileName: 'issue-109-handheld-source.mp4',
    mimeType: 'video/mp4',
    size: blob.size,
    lastModified: 1_090,
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

function document(media: MediaAsset): TimelineDoc {
  const clip: Clip = {
    id: CLIP_ID,
    assetId: media.id,
    name: 'Handheld stabilization fixture',
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
  return {
    schemaVersion: 13,
    id: 'issue-109-browser-document',
    name: 'Issue 109 browser gate',
    frameRate: { num: FRAME_RATE, den: 1 },
    width: WIDTH,
    height: HEIGHT,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [clip],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

export async function runVideoStabilizationBrowserGate() {
  const support = await probeMotionAnalysisFoundationSupport()
  if (!support.supported) {
    throw new Error(`Stabilization support failed: ${support.failures.join(' ')}`)
  }
  const blob = await handheldVideo()
  const objectUrl = URL.createObjectURL(blob)
  const media = asset(blob, objectUrl)
  useDocumentStore.getState().setDoc(document(media))
  if (!useMediaStore.getState().addAsset(media)) {
    URL.revokeObjectURL(objectUrl)
    throw new Error('Could not connect the stabilization fixture')
  }
  setActiveLocalProjectBindingId(BINDING_ID)
  const release = await initMotionAnalysisRuntime()
  try {
    const session = await analyzeVideoStabilization(CLIP_ID)
    const planned = planVideoStabilization(session, {
      strengthPercent: 50,
      smoothingRadiusFrames: 4,
    })
    if (!planned.ok) throw new Error(planned.reason)
    const applied = applyVideoStabilization(
      session,
      { strengthPercent: 50, smoothingRadiusFrames: 4 },
      false,
    )
    if (!applied.ok || !applied.changed) {
      throw new Error(applied.ok ? 'Stabilization did not change the document' : applied.reason)
    }
    const cached = await analyzeVideoStabilization(CLIP_ID)
    if (!cached.fromCache || cached.cacheKey !== session.cacheKey) {
      throw new Error('Stabilization cache round-trip was not exact')
    }
    const durable = useDocumentStore.getState().doc.tracks[0]!.clips[0]!
    const middle = resolveClipAnimationAtFrame(durable, 15)
    const properties = durable.animation?.tracks.map((track) => track.property) ?? []
    await getMotionAnalysisController()?.removeAttachment(BINDING_ID, CLIP_ID)
    const scheduler = getMotionAnalysisController()?.snapshot().scheduler
    const workerDiagnostics = getMotionAnalysisWorkerDiagnostics()
    if (
      properties.join(',') !== 'position-x,position-y,scale-x,scale-y,rotation'
      || durable.animation?.tracks.some((track) => track.keyframes.length > 1_024)
      || useDocumentStore.getState().past.length !== 1
      || !scheduler
      || scheduler.activeJobCount !== 0
      || scheduler.activeDecoderCount !== 0
      || workerDiagnostics.activeWorkers !== 0
    ) throw new Error(`Stabilization product invariants failed: ${JSON.stringify({
      properties,
      keyCounts: durable.animation?.tracks.map((track) => track.keyframes.length),
      historyEntries: useDocumentStore.getState().past.length,
      scheduler,
      workerDiagnostics,
    })}`)
    return {
      support,
      source: { bytes: blob.size, width: WIDTH, height: HEIGHT, frameCount: FRAME_COUNT },
      analysis: {
        fromCache: session.fromCache,
        cachedFromSecondRun: cached.fromCache,
        samples: planned.plan.sampleCount,
        retainedKeysPerTrack: planned.plan.retainedKeyframeCount,
      },
      plan: {
        strengthPercent: planned.plan.settings.strengthPercent,
        smoothingRadiusFrames: planned.plan.settings.smoothingRadiusFrames,
        requiredCropRatio: planned.plan.requiredCropRatio,
        safeZoom: planned.plan.safeZoom,
        jitterReductionRatio: planned.plan.jitterReductionRatio,
      },
      authoredProperties: properties,
      middleTransform: middle.transform,
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
