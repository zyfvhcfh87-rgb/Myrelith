import type { MediaAsset } from '../../src/domain/schema'
import { createTimelineDoc } from '../../src/domain/projectSettings'
import { clipFromAssetRange } from '../../src/domain/operations'
import { fullResolutionPresentationProfile } from '../../src/domain/presentationProfile'
import { videoCompositionRequests } from '../../src/domain/videoCompositionPlan'
import { createMediabunnyExportMediaSource } from '../../src/pipeline/export-mediabunny'
import { compositeFrame, type TransitionSurfaces } from '../../src/pipeline/render'
import { ColorGradingRuntime } from '../../src/pipeline/colorGradingRuntime'
import type { ExportFrameLease } from '../../src/pipeline/export'
import { matrixFixture, type RecordEvidence } from './maskPerformanceGate'
import type { DiagnosticPixelOwner, DiagnosticPixels, DiagnosticWorkOwner } from './diagnosticPixels'

export const DIAGNOSTIC_SIZE = { width: 1280, height: 720 } as const
export const DIAGNOSTIC_CELL = { ...DIAGNOSTIC_SIZE, shape: 8, feather: 0.05, invert: false, offCanvas: false } as const
export const PRODUCTION_CANVAS_POLICY = { main: { colorSpace: 'srgb' }, scratch: { colorSpace: 'srgb', willReadFrequently: true } } as const
export const SOURCE_BYTES = 1_069_647

export function diagnosticCanvasAttributes(ctx: OffscreenCanvasRenderingContext2D) {
  const read = (ctx as unknown as { getContextAttributes?: () => unknown }).getContextAttributes
  return typeof read === 'function' ? { status: 'available', value: read.call(ctx) }
    : { status: 'unavailable', reason: 'This OffscreenCanvas context does not expose getContextAttributes; requested policy is recorded separately.' }
}

export function diagnosticDocument() {
  const asset: MediaAsset = { id: 'diagnostic-source', fileName: 'Immutable resource source.mp4', mimeType: 'video/mp4',
    size: SOURCE_BYTES, lastModified: 198, objectUrl: '', kind: 'video', durationFrames: 300,
    durationMicroseconds: 10_000_000, sourceBounds: { video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 }, audio: null },
    frameRate: { num: 30, den: 1 }, ...DIAGNOSTIC_SIZE, hasAudio: false, audioSampleRate: null, audioChannels: null, decoderConfigB64: null }
  const doc = structuredClone(createTimelineDoc('Immutable export diagnostic', {
    ...DIAGNOSTIC_SIZE, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000,
  }, 'diagnostic-doc'))
  const clip = clipFromAssetRange(asset, 0, 0, 300), fixture = matrixFixture(DIAGNOSTIC_CELL)
  clip.id = 'resource-mask'; clip.effects = fixture.clip.effects; clip.animation = fixture.clip.animation
  doc.tracks[0]!.clips.push(clip)
  return { doc, asset, paths: fixture.paths }
}

export async function diagnosticBounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** Same real export media source and compositor; never constructs a sink or encoder. */
export async function diagnosticProductionComposite(blob: Blob, owner: DiagnosticPixelOwner, work: DiagnosticWorkOwner, record: RecordEvidence, check: () => void) {
  const { doc, asset, paths } = diagnosticDocument(), identity = JSON.stringify(doc)
  if (blob.size !== SOURCE_BYTES) throw new Error('Production diagnostic source size changed')
  let resolverCalls = 0, leasesOpened = 0, leasesClosed = 0, requests = 0, mediaClosed = false, composites = 0
  const requestedFrames: number[] = [], canvases: OffscreenCanvas[] = [], policies: unknown[] = []
  let lease: ExportFrameLease | undefined, failure: unknown, input: DiagnosticPixels | undefined, rendered: DiagnosticPixels | undefined
  let result: { input: DiagnosticPixels; rendered: DiagnosticPixels } | undefined
  const grading = new ColorGradingRuntime()
  const media = createMediabunnyExportMediaSource(doc, (assetId) => {
    if (++resolverCalls !== 1 || assetId !== asset.id) throw new Error('Unexpected diagnostic asset resolver request')
    return { blob, kind: 'video', budget: { fileBytes: blob.size, durationMicroseconds: 10_000_000, ...DIAGNOSTIC_SIZE, framesPerSecond: 30 } }
  }, new Map([[asset.id, asset.sourceBounds]]))
  const surface = (policy: CanvasRenderingContext2DSettings) => {
    const canvas = new OffscreenCanvas(1280, 720); canvases.push(canvas)
    const ctx = canvas.getContext('2d', policy)
    if (!ctx) throw new Error('Diagnostic canvas context unavailable')
    policies.push({ requested: policy, actual: diagnosticCanvasAttributes(ctx) })
    return { canvas, ctx }
  }
  try {
    await record({ kind: 'production-composite-start', frame: 127, sourceFramesToConsume: 128, compositesAllowed: 1,
      explanation: 'The real export source requires sequential requests from frame0. Consume/close0..126 without compositing; render127 once.', document: doc })
    const target = surface(PRODUCTION_CANVAS_POLICY.main), readback = surface({ willReadFrequently: true })
    let transitions: TransitionSurfaces | undefined
    const provider = { get: () => transitions ??= { leg: surface(PRODUCTION_CANVAS_POLICY.scratch), group: surface(PRODUCTION_CANVAS_POLICY.scratch) } }
    grading.setCatalog([])
    for (let frame = 0; frame <= 127; frame++) {
      check()
      lease = await diagnosticBounded(media.openFrame(frame), 5000, `Production lease ${frame}`); leasesOpened++
      const activeLease = lease
      try {
        const planRequests = videoCompositionRequests(lease.plan)
        if (planRequests.length !== 1 || planRequests[0]!.sourceFrame !== frame || planRequests[0]!.clip.assetId !== asset.id) throw new Error('Production diagnostic request plan changed')
        work.claim('productionSource')
        const bitmap = await diagnosticBounded(lease.getFrame(asset.id, frame), 5000, `Production source ${frame}`)
        requestedFrames.push(frame); requests++
        if (!bitmap) throw new Error(`Missing actual production bitmap ${frame}`)
        if (frame === 127) {
          await record({ kind: 'production-frame127-selected', actualPlan: lease.plan, expectedHeldPath: paths[1],
            sourceFrame: frame, requestedFrames, bitmapOwner: 'Actual export frame lease; borrowed until the one composite settles.' })
          if (planRequests[0]!.clip.effects[0]!.params.path !== paths[1]) throw new Error('Production plan did not select the held path at127')
          readback.ctx.drawImage(bitmap, 0, 0)
          let inputColorSpace: PredefinedColorSpace | undefined, outputColorSpace: PredefinedColorSpace | undefined
          input = owner.create(3_686_400, () => { const image = readback.ctx.getImageData(0, 0, 1280, 720); inputColorSpace = image.colorSpace; return image.data })
          let borrowed = false
          work.claim('composite')
          composites++
          const result = await diagnosticBounded(compositeFrame(doc, lease.plan, target.ctx, {
            getFrame: async (id, sourceFrame) => {
              if (borrowed || id !== asset.id || sourceFrame !== 127) throw new Error('Unexpected production compositor source request')
              borrowed = true
              return bitmap
            },
          }, provider, fullResolutionPresentationProfile(doc, 'export'), null, null,
          { runtime: grading, context: grading.context, check, policy: 'fail' }), 10_000, 'Unencoded production composite127')
          if (!borrowed || result.missing.length || result.drawn.length !== 1 || result.drawn[0] !== 'resource-mask') throw new Error('Production composite result differs')
          rendered = owner.create(3_686_400, () => { const image = target.ctx.getImageData(0, 0, 1280, 720); outputColorSpace = image.colorSpace; return image.data })
          await record({ kind: 'production-composite-rendered', frame, result, actualPlan: lease.plan, policies,
            readbackColorSpaces: { actualSource: inputColorSpace, unencodedOutput: outputColorSpace },
            sourceOwnership: 'Same decoded ImageBitmap borrowed from the real export lease supplies both readback oracle and the one compositor request; lease closes afterward.', pixelOwner: owner.snapshot() })
        }
      } finally { await diagnosticBounded(Promise.resolve(activeLease.close()), 5000, `Production lease release ${frame}`); leasesClosed++; lease = undefined }
    }
    if (JSON.stringify(doc) !== identity) throw new Error('Production diagnostic mutated its local document')
    if (!input || !rendered || composites !== 1 || requests !== 128 || leasesOpened !== leasesClosed) throw new Error('Production diagnostic work count differs')
    result = { input, rendered }
  } catch (cause) { failure = cause }
  finally {
    let cleanupFailure: unknown
    if (lease) await diagnosticBounded(Promise.resolve(lease.close()), 5000, 'Remaining production lease release').then(() => { leasesClosed++ }).catch((cause) => { cleanupFailure ??= cause })
    await diagnosticBounded(Promise.resolve(media.close()), 5000, 'Production source release').then(() => { mediaClosed = true }).catch((cause) => { cleanupFailure ??= cause })
    grading.dispose()
    for (const canvas of canvases) { canvas.height = 1; canvas.width = 1 }
    await record({ kind: 'production-composite-released', resolverCalls, leasesOpened, leasesClosed, requests, requestedFrames,
      composites, mediaClosed, policies, surfaces: canvases.map(({ width, height }) => ({ width, height })), grading: grading.ledger(),
      error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      cleanupError: cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure ? String(cleanupFailure) : null })
      .catch((cause) => { failure ??= cause })
    failure ??= cleanupFailure
  }
  if (failure !== undefined) throw failure
  if (!result) throw new Error('Production diagnostic returned no comparison pixels')
  return result
}
