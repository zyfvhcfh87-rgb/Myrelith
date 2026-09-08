/** Disposable measurements through production owners; never imported by the app. */
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, VideoSampleSink } from 'mediabunny'
import { startExport, cancelExport, disposeExport, type ExportControllerDeps } from '../../src/app/exportController'
import { preflightExportProfile } from '../../src/app/exportCapabilitiesController'
import { importMedia } from '../../src/app/mediaImportController'
import { mediaResourceAdmission } from '../../src/app/mediaResourceAdmission'
import { capturePreviewRuntimeTelemetry, drainPreviewPlayback, setPreviewRuntimeTelemetryEnabled } from '../../src/app/previewController'
import { drainSourcePreviewPlayback } from '../../src/app/sourceMonitorPreviewController'
import { pauseAndDrainPlayback } from '../../src/app/transportController'
import { useDocumentStore } from '../../src/state/documentStore'
import { useMediaStore } from '../../src/state/mediaStore'
import { clipFromAssetRange } from '../../src/domain/operations'
import { DEFAULT_EXPORT_PROFILE } from '../../src/domain/exportProfile'
import { applyOrderedPixelEffectsToRgba } from '../../src/domain/effectPixels'
import { maskParams } from '../../src/domain/effectStack'
import { videoPixelWorkBudget } from '../../src/domain/videoPixelWorkBudget'
import { createMediabunnyExportDeps, createMediabunnyExportMediaSource } from '../../src/pipeline/export-mediabunny'
import { exportTimeline } from '../../src/pipeline/export'
import type { Composite2D } from '../../src/pipeline/render'
import type { ColorGradingFrame } from '../../src/pipeline/colorGradingRuntime'
import { matrixFixture, type RecordEvidence } from './maskPerformanceGate'

export type PersistBinary = (name: string, buffer: ArrayBuffer) => Promise<void>
export const EXPORT_FRAMES = 300
export const CANCEL_AFTER_FRAMES = 60
export const EXPORT_TIMEOUT_MS = 120_000
export const OUTPUT_MAX_CHANNEL_DELTA = 12
export const OUTPUT_MEAN_CHANNEL_DELTA = 2
const SIZE = { width: 1280, height: 720 }
const CELL = { ...SIZE, shape: 8, feather: 0.05, invert: false, offCanvas: false } as const
const PROFILE = { ...DEFAULT_EXPORT_PROFILE, videoBitrate: 2_000_000,
  audioCodec: null, audioChannelLayout: 'off', audioBitrate: null, audioBitrateMode: null } as const

async function fixtureVideo(): Promise<Blob> {
  const canvas = new OffscreenCanvas(SIZE.width, SIZE.height), ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Fixture canvas is unavailable')
  const target = new BufferTarget(), output = new Output({ target, format: new Mp4OutputFormat() })
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 2_000_000, keyFrameInterval: 1 })
  output.addVideoTrack(source, { frameRate: 30 })
  let complete = false, closed = false
  try {
    await output.start()
    for (let frame = 0; frame < EXPORT_FRAMES; frame++) {
      const gray = 128 + frame % 64
      ctx.fillStyle = `rgb(${gray} ${gray} ${gray})`; ctx.fillRect(0, 0, SIZE.width, SIZE.height)
      await source.add(frame / 30, 1 / 30)
    }
    source.close(); closed = true; await output.finalize(); complete = true
    if (!target.buffer?.byteLength) throw new Error('Empty fixture video')
    return new Blob([target.buffer], { type: 'video/mp4' })
  } finally {
    try { if (!closed) source.close() }
    finally { try { if (!complete) await output.cancel() } finally { canvas.width = canvas.height = 0 } }
  }
}

function projectIdentity() {
  const state = useDocumentStore.getState()
  return JSON.stringify({ project: state.project, past: state.past, future: state.future })
}

export async function prepareExportFixture(record: RecordEvidence, persist: PersistBinary) {
  const blob = await fixtureVideo()
  await persist('source.mp4', await blob.arrayBuffer())
  const imported = await importMedia(new File([blob], 'Issue198 resource source.mp4', { type: blob.type, lastModified: 198 }))
  if (imported.status !== 'imported') throw new Error(`Fixture import failed: ${JSON.stringify(imported)}`)
  const asset = useMediaStore.getState().assets.get(imported.assetId)
  if (!asset || asset.kind !== 'video' || asset.width !== SIZE.width || asset.height !== SIZE.height || asset.hasAudio) throw new Error('Fixture import provenance differs')
  const doc = useDocumentStore.getState().doc
  if (doc.width !== SIZE.width || doc.height !== SIZE.height || doc.frameRate.num !== 30 || doc.frameRate.den !== 1) throw new Error('Export project must be 1280 by 720 at exact 30 fps')
  const clip = clipFromAssetRange(asset, 0, 0, EXPORT_FRAMES), fixture = matrixFixture(CELL)
  clip.id = 'resource-mask'; clip.effects = fixture.clip.effects; clip.animation = fixture.clip.animation
  useDocumentStore.getState().insertClips([{ trackId: doc.tracks[0]!.id, clip }])
  setPreviewRuntimeTelemetryEnabled(true)
  await pauseAndDrainPlayback(); await drainPreviewPlayback()
  await record({ kind: 'export-fixture', importedAssetId: asset.id, bytes: blob.size, width: SIZE.width, height: SIZE.height,
    frames: EXPORT_FRAMES, keys: clip.animation!.effectPathTracks![0]!.keyframes.length, profile: PROFILE })
  return { blob, identity: projectIdentity() }
}

/** Interface-level observations. Decoder internals remain explicitly unavailable. */
function observedProductionDeps() {
  const counters = { mediaOpened: 0, mediaClosed: 0, leasesOpened: 0, leasesClosed: 0, liveLeases: 0,
    peakLeases: 0, sourceRequests: 0, sinksOpened: 0, sinksFinalized: 0, sinksCancelled: 0, liveSinks: 0,
    framesAdded: 0, composites: 0, activeComposites: 0, readbacks: 0, liveReadbackBytes: 0,
    peakReadbackBytes: 0, actualSurfaceBytesPeak: 0, modeledPixelWorkBytesPeak: 0 }
  const surfaces = new Set<OffscreenCanvas>(), readbacks = new Map<ImageData, number>()
  const contexts = new WeakMap<Composite2D, Composite2D>()
  let grading: ColorGradingFrame | undefined
  const sampleSurfaces = () => {
    const bytes = [...surfaces].reduce((sum, surface) => sum + surface.width * surface.height * 4, 0)
    counters.actualSurfaceBytesPeak = Math.max(counters.actualSurfaceBytesPeak, bytes)
    return bytes
  }
  const observeContext = (ctx: Composite2D) => {
    const existing = contexts.get(ctx); if (existing) return existing
    const canvas = (ctx as OffscreenCanvasRenderingContext2D).canvas
    if (!(canvas instanceof OffscreenCanvas)) throw new Error('Production sink did not expose an OffscreenCanvas context')
    surfaces.add(canvas); sampleSurfaces()
    const proxy = new Proxy(ctx, { get(target, property) {
      if (property === 'getImageData' && target.getImageData) return (...args: Parameters<NonNullable<Composite2D['getImageData']>>) => {
        const image = target.getImageData!(...args), bytes = image.data.byteLength
        readbacks.set(image, bytes); counters.readbacks++; counters.liveReadbackBytes += bytes
        counters.peakReadbackBytes = Math.max(counters.peakReadbackBytes, counters.liveReadbackBytes)
        return image
      }
      if (property === 'putImageData' && target.putImageData) return (...args: Parameters<NonNullable<Composite2D['putImageData']>>) => {
        try { return target.putImageData!(...args) }
        finally { const bytes = readbacks.get(args[0]); if (bytes !== undefined) { counters.liveReadbackBytes -= bytes; readbacks.delete(args[0]) } }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }, set(target, property, value) { return Reflect.set(target, property, value, target) } })
    contexts.set(ctx, proxy); return proxy
  }
  const deps: ExportControllerDeps = {
    preparePlaybackForExport: async () => { await Promise.all([pauseAndDrainPlayback(), drainPreviewPlayback(), drainSourcePreviewPlayback()]) },
    preflightProfile: preflightExportProfile,
    fetchBlob: async (url) => { const response = await fetch(url); if (!response.ok) throw new Error(`Media read failed: ${response.status}`); return response.blob() },
    createMediaSource: (...args) => {
      const source = createMediabunnyExportMediaSource(...args); counters.mediaOpened++
      return {
        openFrame: async (frame) => {
          const lease = await source.openFrame(frame); counters.leasesOpened++; counters.liveLeases++
          counters.peakLeases = Math.max(counters.peakLeases, counters.liveLeases)
          return { plan: lease.plan, getFrame: (...request) => { counters.sourceRequests++; return lease.getFrame(...request) },
            close: async () => { await lease.close(); counters.leasesClosed++; counters.liveLeases-- } }
        },
        close: async () => { await source.close(); counters.mediaClosed++ },
      }
    },
    createPipelineDeps: (...args) => {
      const real = createMediabunnyExportDeps(...args)
      return { ...real,
        composite: async (...request) => {
          counters.composites++; counters.activeComposites++; grading = request[8]
          try {
            const [doc, plan, , , , profile] = request
            const work = videoPixelWorkBudget(plan, { surfaceWidth: profile?.outputWidth ?? doc.width,
              surfaceHeight: profile?.outputHeight ?? doc.height, projectWidth: doc.width, projectHeight: doc.height }, grading?.context)
            if (work.reason) throw new Error(work.reason)
            counters.modeledPixelWorkBytesPeak = Math.max(counters.modeledPixelWorkBytesPeak, work.peakAdditionalBytes)
            return await real.composite(...request)
          }
          finally { counters.activeComposites--; readbacks.clear(); counters.liveReadbackBytes = 0; sampleSurfaces() }
        },
        createVideoSink: async (...request) => {
          const sink = await real.createVideoSink(...request); counters.sinksOpened++; counters.liveSinks++
          let released = false
          const release = () => { if (!released) { released = true; counters.liveSinks-- } sampleSurfaces() }
          return { ...sink, ctx: observeContext(sink.ctx), transitionSurfaceProvider: { get: () => {
            const value = sink.transitionSurfaceProvider.get()
            return { leg: { ...value.leg, ctx: observeContext(value.leg.ctx) }, group: { ...value.group, ctx: observeContext(value.group.ctx) } }
          } },
          addFrame: async (...frame) => { await sink.addFrame(...frame); counters.framesAdded++ },
          finalize: async () => { const result = await sink.finalize(); counters.sinksFinalized++; release(); return result },
          cancel: async (reason) => { await sink.cancel(reason); counters.sinksCancelled++; release() } }
        },
      }
    },
    runExport: exportTimeline,
  }
  return { deps, snapshot: () => ({ ...counters, actualSurfaceBytes: sampleSurfaces(),
    surfaceExtents: [...surfaces].map(({ width, height }) => ({ width, height })),
    grading: grading?.runtime.ledger() ?? null,
    decoderInternals: { status: 'unavailable', reason: 'Production media-source API exposes lease/close boundaries, not decoder/native allocation counters.' } }) }
}

async function compareOutput(buffer: ArrayBuffer, original: Blob, record: RecordEvidence) {
  const output = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([buffer], { type: 'video/mp4' })) })
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(original) })
  const canvas = new OffscreenCanvas(SIZE.width, SIZE.height), ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const oracle = new OffscreenCanvas(SIZE.width, SIZE.height), oracleCtx = oracle.getContext('2d', { willReadFrequently: true })!
  try {
    const track = await output.getPrimaryVideoTrack(), originalTrack = await input.getPrimaryVideoTrack()
    if (!track || !originalTrack) throw new Error('Missing video track')
    const duration = await output.computeDuration(), audio = !!await output.getPrimaryAudioTrack()
    await record({ kind: 'export-output-metadata', width: track.displayWidth, height: track.displayHeight, duration, audio, bytes: buffer.byteLength })
    if (track.displayWidth !== SIZE.width || track.displayHeight !== SIZE.height || audio || Math.abs(duration - 10) > 1 / 30) throw new Error('Export dimensions/audio/duration differ')
    const sink = new VideoSampleSink(track), reference = new VideoSampleSink(originalTrack), fixture = matrixFixture(CELL)
    for (const frame of [0, 127, 255, 299]) {
      const sampled = await sink.getSample(frame / 30)
      if (!sampled) throw new Error(`Missing output frame ${frame}`)
      try {
        const image = sampled.toVideoFrame(); try { ctx.drawImage(image, 0, 0) } finally { image.close() }
      } finally { sampled.close() }
      const originalSample = await reference.getSample(frame / 30)
      if (!originalSample) throw new Error(`Missing source frame ${frame}`)
      try {
        const image = originalSample.toVideoFrame(); try { oracleCtx.drawImage(image, 0, 0) } finally { image.close() }
      } finally { originalSample.close() }
      const pixels = ctx.getImageData(0, 0, SIZE.width, SIZE.height).data
      const expected = oracleCtx.getImageData(0, 0, SIZE.width, SIZE.height).data
      const effect = { ...fixture.clip.effects[0]!, params: { ...fixture.clip.effects[0]!.params, path: fixture.paths[Math.min(frame, 255) % 2]! } }
      applyOrderedPixelEffectsToRgba(expected, [{ kind: 'mask', params: maskParams(effect) }], {
        surfaceWidth: SIZE.width, surfaceHeight: SIZE.height, projectWidth: SIZE.width, projectHeight: SIZE.height,
      })
      let maximumChannelDelta = 0, total = 0, comparedChannels = 0
      for (let offset = 0; offset < pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
        const expectedOpaque = Math.round(expected[offset + channel]! * expected[offset + 3]! / 255)
        const delta = Math.abs(pixels[offset + channel]! - expectedOpaque)
        maximumChannelDelta = Math.max(maximumChannelDelta, delta); total += delta; comparedChannels++
      }
      const meanChannelDelta = total / comparedChannels
      await record({ kind: 'export-decoded-parity', frame, comparedChannels, maximumChannelDelta, meanChannelDelta,
        maximumAllowed: OUTPUT_MAX_CHANNEL_DELTA, meanAllowed: OUTPUT_MEAN_CHANNEL_DELTA })
      if (maximumChannelDelta > OUTPUT_MAX_CHANNEL_DELTA || meanChannelDelta > OUTPUT_MEAN_CHANNEL_DELTA) throw new Error(`Decoded export parity failed at ${frame}`)
    }
  } finally { canvas.width = canvas.height = oracle.width = oracle.height = 0; output.dispose(); input.dispose() }
}

export async function measureExportAttempt(index: number, mode: 'complete' | 'cancel' | 'retry', fixture: Awaited<ReturnType<typeof prepareExportFixture>>,
  record: RecordEvidence, persist: PersistBinary) {
  const observer = observedProductionDeps(), started = performance.now(), progress: number[] = []
  let cancellation: Promise<void> | undefined, cancellationAt: number | null = null, timedOut = false
  let progressWrites: Promise<void> = Promise.resolve(), recordFailure: unknown
  const timer = setTimeout(() => { timedOut = true; cancellation = cancelExport() }, EXPORT_TIMEOUT_MS)
  try {
    await record({ kind: 'export-attempt-start', index, mode, owners: observer.snapshot(), admission: mediaResourceAdmission.snapshot(), preview: await capturePreviewRuntimeTelemetry() })
    const result = await startExport(PROFILE, { onProgress: (value) => {
      progress.push(value)
      // The production generator reserves one finalization step: frame N
      // publishes N/(frameCount+1), not N/frameCount.
      const completedFrames = Math.min(EXPORT_FRAMES, Math.round(value * (EXPORT_FRAMES + 1)))
      const event = { kind: 'export-progress', index, mode, value, completedFrames, observedAtMs: performance.now(), owners: observer.snapshot() }
      progressWrites = progressWrites.then(() => record(event)).catch((cause) => {
        recordFailure ??= cause; cancellation = cancelExport()
      })
      if (mode === 'cancel' && cancellationAt === null && completedFrames >= CANCEL_AFTER_FRAMES) {
        cancellationAt = value; cancellation = cancelExport()
      }
    } }, observer.deps)
    await progressWrites
    if (cancellation) await cancellation
    if (recordFailure) throw recordFailure
    const owners = observer.snapshot()
    await record({ kind: 'export-attempt-settled', index, mode, progress, cancellationAt, timedOut,
      milliseconds: performance.now() - started, owners, admission: mediaResourceAdmission.snapshot(), hasOutput: !!result })
    if (timedOut) throw new Error('Export attempt exceeded its 120-second ceiling')
    if (owners.liveLeases || owners.liveSinks || owners.activeComposites || owners.liveReadbackBytes
      || owners.mediaOpened !== owners.mediaClosed || owners.leasesOpened !== owners.leasesClosed
      || owners.surfaceExtents.some(({ width, height }) => width > 1 || height > 1)
      || (owners.grading?.bytes ?? 0) !== 0 || (owners.grading?.ports ?? 0) !== 0) throw new Error('Export owners did not settle')
    const frameBytes = SIZE.width * SIZE.height * 4
    if (owners.peakLeases !== 1 || owners.actualSurfaceBytesPeak > frameBytes * 3
      || owners.peakReadbackBytes !== frameBytes || owners.composites !== owners.framesAdded
      || owners.leasesOpened !== owners.framesAdded) throw new Error('Export ownership exceeded the fixed single-frame/surface envelope')
    if (projectIdentity() !== fixture.identity) throw new Error('Export mutated project/history')
    if (mode === 'cancel') {
      if (result || cancellationAt === null || owners.framesAdded !== CANCEL_AFTER_FRAMES || owners.sinksCancelled !== 1) throw new Error('Cancellation was not observed at the specified production progress boundary')
    } else {
      if (!result || result.destination !== 'download' || owners.framesAdded !== EXPORT_FRAMES || owners.sinksFinalized !== 1) throw new Error('Export did not complete exactly 300 frames')
      await persist(`export-${mode}-${index}.mp4`, result.buffer)
      await compareOutput(result.buffer, fixture.blob, (event) => record({ ...event, index, mode }))
    }
    if (timedOut) throw new Error('Export attempt and parity exceeded the 120-second ceiling')
    await record({ kind: 'export-attempt-complete', index, mode })
  } catch (cause) {
    await progressWrites
    await record({ kind: 'export-attempt-failed', index, mode, progress, cancellationAt, timedOut,
      owners: observer.snapshot(), error: cause instanceof Error ? cause.message : String(cause) })
    throw cause
  } finally {
    clearTimeout(timer); await disposeExport(); if (cancellation) await cancellation
    await record({ kind: 'export-attempt-released', index, mode, owners: observer.snapshot(), admission: mediaResourceAdmission.snapshot() })
  }
}
