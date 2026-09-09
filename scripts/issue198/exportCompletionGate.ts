/** Remaining production lifecycle: exact pre-encode pixels, qualified lossy output. */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny'
import type { ExportDeps } from '../../src/pipeline/export'
import { videoCompositionRequests } from '../../src/domain/videoCompositionPlan'
import { diagnosticBounded, diagnosticCanvasAttributes } from './diagnosticComposite'
import { DiagnosticPixelOwner, pixelErrors, type DiagnosticPixels } from './diagnosticPixels'
import { IMMUTABLE_DIAGNOSTIC_INPUTS, immutableBlob, staticOracle } from './exportPixelDiagnostic'
import { prepareExportFixture, RESOURCE_EXPORT_PROFILE, type PersistBinary } from './exportResourceGate'
import type { RecordEvidence } from './maskPerformanceGate'

export const OUTPUT_TARGETS = [0, 127, 255, 299] as const
const WIDTH = 1280, HEIGHT = 720, FRAME_BYTES = WIDTH * HEIGHT * 4
const FRAME_COUNT = 300, ORDINAL_LIMIT = 1800, SOURCE_LIMIT = 1980

export function lossyOutputComparison(actual: DiagnosticPixels, reference: DiagnosticPixels, width: number, height: number) {
  const quality = pixelErrors(actual, reference, width, height)
  return { quality, accepted: quality.meanDelta <= 2, legacyMaximumPassed: quality.maximumDelta <= 12 }
}

/** Borrow the actual source exactly once; finish before the production lease closes or encoding starts. */
export async function comparePreEncode(composite: ExportDeps['composite'], request: Parameters<ExportDeps['composite']>,
  owner: DiagnosticPixelOwner, record: RecordEvidence) {
  const [, plan, target, source] = request, frame = plan.frame
  const planned = videoCompositionRequests(plan)
  if (!OUTPUT_TARGETS.some((value) => value === frame) || planned.length !== 1 || planned[0]!.sourceFrame !== frame) throw new Error('Pre-encode target/source plan differs')
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  let reference: DiagnosticPixels | undefined, actual: DiagnosticPixels | undefined, retained = false, borrowed = 0
  try {
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    const targetCanvas = (target as OffscreenCanvasRenderingContext2D).canvas
    if (!ctx || !(targetCanvas instanceof OffscreenCanvas) || targetCanvas.width !== WIDTH || targetCanvas.height !== HEIGHT) throw new Error('Pre-encode canvas extent differs')
    // Obtain the same native context without the production-readback counting proxy.
    // This extra observation has its own owner and never changes sink pixels.
    const targetContext = targetCanvas.getContext('2d')
    if (!targetContext) throw new Error('Pre-encode sink context unavailable')
    const observedSource: typeof source = { getFrame: async (assetId, sourceFrame) => {
      if (++borrowed !== 1 || assetId !== planned[0]!.clip.assetId || sourceFrame !== frame) throw new Error('Pre-encode source request differs')
      const image = await source.getFrame(assetId, sourceFrame)
      if (!image || (image as ImageBitmap).width !== WIDTH || (image as ImageBitmap).height !== HEIGHT) throw new Error('Pre-encode source dimensions differ')
      ctx.drawImage(image, 0, 0)
      const input = owner.create(FRAME_BYTES, () => ctx.getImageData(0, 0, WIDTH, HEIGHT).data)
      try { reference = staticOracle(input, Math.min(frame, 255) % 2, owner) }
      finally { owner.release(input) }
      return image
    } }
    const observedRequest: Parameters<ExportDeps['composite']> = [...request]
    observedRequest[3] = observedSource
    const result = await composite(...observedRequest)
    if (borrowed !== 1 || !reference || result.missing.length || result.drawn.length !== 1 || result.drawn[0] !== planned[0]!.clip.id) throw new Error('Pre-encode composite/source result differs')
    actual = owner.create(FRAME_BYTES, () => targetContext.getImageData(0, 0, WIDTH, HEIGHT).data)
    const errors = pixelErrors(actual, reference, WIDTH, HEIGHT)
    await record({ kind: 'export-pre-encode-parity', frame, sourceFrame: planned[0]!.sourceFrame,
      actualHeldPath: planned[0]!.clip.effects[0]?.params.path, expectedPathIndex: Math.min(frame, 255) % 2,
      errors, accepted: errors.maximumDelta === 0, sourceBorrowedFromActualLease: true })
    if (errors.maximumDelta !== 0) throw new Error(`Exact pre-encode RGB parity failed at ${frame}`)
    retained = true
    return { result, reference }
  } finally {
    if (actual) owner.release(actual)
    if (reference && !retained) owner.release(reference)
    canvas.height = canvas.width = 1
    await record({ kind: 'pre-encode-observer-released', frame, borrowed, retainedReferenceBytes: retained ? FRAME_BYTES : 0,
      surface: { width: canvas.width, height: canvas.height }, pixels: owner.snapshot() })
  }
}

export async function prepareExportCompletion(record: RecordEvidence, persist: PersistBinary) {
  const owner = new DiagnosticPixelOwner(), references = new Map<number, DiagnosticPixels>()
  const work = { ordinalSamples: 0, productionSourceRequests: 0, preEncodeTargets: 0, completedOutputs: 0, completedAttempts: 0 }
  const began = performance.now()
  let closed = false
  const check = () => {
    if (closed) throw new Error('Completion owner is closed')
    if (performance.now() - began > 1_500_000) throw new Error('Completion whole-run ceiling exceeded')
  }
  const release = async (success: boolean) => {
    if (closed) return
    closed = true; owner.close(); references.clear()
    const complete = work.ordinalSamples === ORDINAL_LIMIT && work.productionSourceRequests === SOURCE_LIMIT
      && work.preEncodeTargets === 27 && work.completedOutputs === 6 && work.completedAttempts === 9
    await record({ kind: 'completion-pixels-released', success: success && complete, work, pixels: owner.snapshot() })
    if (success && !complete) throw new Error('Completion work totals differ')
  }

  // Reuse the accepted ordinal reader's ownership and exact timestamp convention.
  // No sparse lookup, EOF probe, extra source fixture or extra production composite.
  async function readOrdinal(blob: Blob, name: string,
    visit: (frame: number, pixels: DiagnosticPixels) => Promise<void>, outputRecord = record) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT), ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    let iterator: AsyncGenerator<VideoSample> | undefined, samples = 0, samplesClosed = 0, frames = 0, framesClosed = 0, failure: unknown
    try {
      if (!ctx) throw new Error('Completion readback context unavailable')
      const track = await diagnosticBounded(input.getPrimaryVideoTrack(), 5000, 'Completion video track')
      const duration = await diagnosticBounded(input.computeDuration(), 5000, 'Completion duration')
      const audio = !!await diagnosticBounded(input.getPrimaryAudioTrack(), 5000, 'Completion audio presence')
      if (!track || duration !== 10 || audio || track.displayWidth !== WIDTH || track.displayHeight !== HEIGHT) throw new Error('Completion metadata differs')
      const codec = await diagnosticBounded(track.getCodec(), 5000, 'Completion actual codec')
      const config = await diagnosticBounded(track.getDecoderConfig(), 5000, 'Completion decoder metadata')
      if (codec !== RESOURCE_EXPORT_PROFILE.videoCodec) throw new Error('Completion output codec differs')
      await outputRecord({ kind: 'completion-output-metadata', name, duration, audio, width: track.displayWidth, height: track.displayHeight,
        bytes: blob.size, codec, decoder: config ? { codec: config.codec, codedWidth: config.codedWidth, codedHeight: config.codedHeight,
          colorSpace: config.colorSpace } : null, context: diagnosticCanvasAttributes(ctx) })
      iterator = new VideoSampleSink(track).samples()
      for (let frame = 0; frame < FRAME_COUNT; frame++) {
        check()
        if (work.ordinalSamples >= ORDINAL_LIMIT) throw new Error('Completion ordinal request cap exceeded')
        work.ordinalSamples++
        const next = await diagnosticBounded(iterator.next(), 5000, 'Completion ordinal sample')
        if (next.done) throw new Error('Completion input ended before 300 frames')
        const sample = next.value; samples++
        try {
          if (sample.timestamp !== frame / 30 || sample.duration !== 1 / 30) throw new Error(`Completion ordinal time differs: ${name}/${frame}`)
          if (OUTPUT_TARGETS.some((target) => target === frame)) {
            const image = sample.toVideoFrame(); frames++
            let pixels: DiagnosticPixels | undefined
            try {
              if (image.displayWidth !== WIDTH || image.displayHeight !== HEIGHT) throw new Error('Completion decoded extent differs')
              ctx.drawImage(image, 0, 0)
              pixels = owner.create(FRAME_BYTES, () => ctx.getImageData(0, 0, WIDTH, HEIGHT).data)
            } finally { image.close(); framesClosed++ }
            try { await visit(frame, pixels) } finally { owner.release(pixels) }
          }
        } finally { sample.close(); samplesClosed++ }
      }
    } catch (cause) { failure = cause }
    finally {
      try { input.dispose() } catch (cause) { failure ??= cause }
      if (iterator) await diagnosticBounded(iterator.return(undefined), 5000, 'Completion ordinal release').catch((cause) => { failure ??= cause })
      canvas.height = canvas.width = 1
      await outputRecord({ kind: 'completion-reader-released', name, samples, samplesClosed, frames, framesClosed,
        surface: { width: canvas.width, height: canvas.height }, pixels: owner.snapshot(), error: failure ? String(failure) : null })
        .catch((cause) => { failure ??= cause })
    }
    if (failure !== undefined) throw failure
    if (samples !== FRAME_COUNT || samplesClosed !== samples || framesClosed !== frames) throw new Error('Completion reader ownership differs')
  }

  try {
    await record({ kind: 'lifecycle-completion-start', immutableSource: IMMUTABLE_DIAGNOSTIC_INPUTS[0], targets: OUTPUT_TARGETS,
      profile: RESOURCE_EXPORT_PROFILE, limits: { extraControlEncodes: 0, ordinalSamples: ORDINAL_LIMIT,
        productionSourceRequests: SOURCE_LIMIT, publicSampleAndSourceRequests: ORDINAL_LIMIT + SOURCE_LIMIT,
        preEncodeTargets: 27, pixelBytes: 64 * 1024 * 1024, attemptBrowserMs: 120_000, wholeHostMs: 1_500_000 },
      codecQualification: 'Historical production and independent control both failed max12; separate lossy encodes also differed. Require exact actual pre-encode RGB and encoded mean<=2; retain every measured maximum and historical failure.' })
    const sourceBlob = await immutableBlob(IMMUTABLE_DIAGNOSTIC_INPUTS[0])
    const fixture = await diagnosticBounded(prepareExportFixture(record, persist, sourceBlob), 30_000, 'Saved fixture import')
    return { ...fixture,
      claimSourceRequest: () => {
        check()
        if (work.productionSourceRequests >= SOURCE_LIMIT) throw new Error('Production source request cap exceeded')
        work.productionSourceRequests++
      },
      observeComposite: async (composite: ExportDeps['composite'], request: Parameters<ExportDeps['composite']>, outputRecord: RecordEvidence) => {
        const frame = request[1].frame
        if (!OUTPUT_TARGETS.some((value) => value === frame)) return composite(...request)
        if (references.has(frame) || work.preEncodeTargets >= 27) throw new Error('Pre-encode target count differs')
        const observation = await comparePreEncode(composite, request, owner, outputRecord)
        references.set(frame, observation.reference); work.preEncodeTargets++
        return observation.result
      },
      compareOutput: async (buffer: ArrayBuffer, outputRecord: RecordEvidence) => {
        if (work.completedOutputs >= 6 || references.size !== 4) throw new Error('Completion output/reference count differs')
        await readOrdinal(new Blob([buffer], { type: 'video/mp4' }), `production-output-${work.completedOutputs}`, async (frame, pixels) => {
          const reference = references.get(frame)
          if (!reference) throw new Error('Actual matching-input reference is missing')
          const result = lossyOutputComparison(pixels, reference, WIDTH, HEIGHT)
          await outputRecord({ kind: 'export-lossy-output-quality', frame, ...result,
            interpretation: 'Mean<=2 for lossy AVC; maximum error remains measured/reported, not guaranteed <=12. Exact pre-encode parity was checked separately against the same actual decoded input.' })
          if (!result.accepted) throw new Error(`Encoded mean quality failed at ${frame}`)
        }, outputRecord)
        work.completedOutputs++
      },
      finishAttempt: async (mode: 'complete' | 'cancel' | 'retry', success: boolean) => {
        const targets = [...references.keys()]
        const expected = mode === 'cancel' ? [0] : [...OUTPUT_TARGETS]
        const matched = JSON.stringify(targets) === JSON.stringify(expected)
        owner.close(); references.clear()
        if (success && matched) work.completedAttempts++
        await record({ kind: 'pre-encode-attempt-released', mode, success: success && matched, targets, pixels: owner.snapshot() })
        if (success && !matched) throw new Error('Completed attempt omitted pre-encode targets')
      },
      close: release,
    }
  } catch (cause) {
    await release(false).catch(() => {})
    throw cause
  }
}
