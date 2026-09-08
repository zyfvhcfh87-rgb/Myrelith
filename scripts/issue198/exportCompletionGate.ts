/** One independent codec control, then the existing production lifecycle gate. */
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, VideoSampleSink, type VideoSample } from 'mediabunny'
import { diagnosticBounded, diagnosticCanvasAttributes } from './diagnosticComposite'
import { DiagnosticPixelOwner, pixelErrors, type DiagnosticPixels } from './diagnosticPixels'
import { IMMUTABLE_DIAGNOSTIC_INPUTS, immutableBlob, staticOracle } from './exportPixelDiagnostic'
import { prepareExportFixture, RESOURCE_EXPORT_PROFILE, type PersistBinary } from './exportResourceGate'
import type { RecordEvidence } from './maskPerformanceGate'

export const CONTROL_TARGETS = [0, 127, 255, 299] as const
const WIDTH = 1280, HEIGHT = 720, FRAME_BYTES = WIDTH * HEIGHT * 4
const FRAME_COUNT = 300, ORDINAL_LIMIT = 2700, SOURCE_LIMIT = 1980

/** Preserve historical maxima; a codec control does not make a failed max-12 pass. */
export function controlComparison(actual: DiagnosticPixels, control: DiagnosticPixels, reference: DiagnosticPixels, width: number, height: number) {
  const agreement = pixelErrors(actual, control, width, height)
  const quality = pixelErrors(actual, reference, width, height)
  return { agreement, quality, accepted: agreement.maximumDelta === 0 && quality.meanDelta <= 2,
    legacyMaximumPassed: quality.maximumDelta <= 12 }
}

export async function prepareExportCompletion(record: RecordEvidence, persist: PersistBinary) {
  const owner = new DiagnosticPixelOwner(), references = new Map<number, DiagnosticPixels>(), controls = new Map<number, DiagnosticPixels>()
  const work = { ordinalSamples: 0, productionSourceRequests: 0, controlFrames: 0, completedOutputs: 0 }
  const began = performance.now()
  let prepared = false, closed = false
  const check = () => {
    if (closed) throw new Error('Completion owner is closed')
    if (performance.now() - began > 1_500_000) throw new Error('Completion whole-run ceiling exceeded')
    if (!prepared && performance.now() - began > 120_000) throw new Error('Codec control preparation exceeded 120 seconds')
  }
  const release = async (success: boolean) => {
    if (closed) return
    closed = true; owner.close(); references.clear(); controls.clear()
    const complete = work.ordinalSamples === ORDINAL_LIMIT && work.productionSourceRequests === SOURCE_LIMIT
      && work.controlFrames === FRAME_COUNT && work.completedOutputs === 6
    await record({ kind: 'completion-pixels-released', success: success && complete, work, pixels: owner.snapshot() })
    if (success && !complete) throw new Error('Completion work totals differ')
  }

  // Reuse the accepted ordinal reader's ownership and exact timestamp convention.
  // No sparse lookup, EOF probe, extra source fixture or extra production composite.
  async function readOrdinal(blob: Blob, name: string, everyFrame: boolean,
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
          if (everyFrame || CONTROL_TARGETS.some((target) => target === frame)) {
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

  async function compare(blob: Blob, name: string, outputRecord = record) {
    await readOrdinal(blob, name, false, async (frame, pixels) => {
      const control = controls.get(frame), reference = references.get(frame)
      if (!control || !reference) throw new Error('Completion reference target is missing')
      const result = controlComparison(pixels, control, reference, WIDTH, HEIGHT)
      await outputRecord({ kind: 'completion-control-comparison', name, frame, ...result,
        interpretation: 'Exact RGB agreement at this target; historical max-12 result remains separate. No lossless or all-frame quality claim.' })
      if (!result.accepted) throw new Error(`Control agreement or mean quality failed: ${name}/${frame}`)
    }, outputRecord)
  }

  try {
    await record({ kind: 'completion-start', immutableInputs: IMMUTABLE_DIAGNOSTIC_INPUTS, targets: CONTROL_TARGETS,
      profile: RESOURCE_EXPORT_PROFILE, limits: { controlFrames: FRAME_COUNT, ordinalSamples: ORDINAL_LIMIT,
        productionSourceRequests: SOURCE_LIMIT, publicSampleAndSourceRequests: ORDINAL_LIMIT + SOURCE_LIMIT,
        pixelBytes: 64 * 1024 * 1024, controlBrowserMs: 120_000, attemptBrowserMs: 120_000, wholeHostMs: 1_500_000 },
      priorEvidence: 'Accepted exact pre-encode frame127, raster and native seven-flow results are reused; original encoded max19 exceeds12 and remains failed.' })
    const sourceBlob = await immutableBlob(IMMUTABLE_DIAGNOSTIC_INPUTS[0])
    const originalOutput = await immutableBlob(IMMUTABLE_DIAGNOSTIC_INPUTS[1])
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT), target = new BufferTarget()
    let output: Output | undefined, source: CanvasSource | undefined
    let finalized = false, sourceClosed = false
    let controlBlob: Blob | undefined
    try {
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
      if (!ctx) throw new Error('Control canvas unavailable')
      output = new Output({ target, format: new Mp4OutputFormat() })
      source = new CanvasSource(canvas, { codec: RESOURCE_EXPORT_PROFILE.videoCodec, bitrate: RESOURCE_EXPORT_PROFILE.videoBitrate,
        bitrateMode: RESOURCE_EXPORT_PROFILE.videoBitrateMode, keyFrameInterval: RESOURCE_EXPORT_PROFILE.keyFrameIntervalMicroseconds / 1_000_000 })
      const activeSource = source
      output.addVideoTrack(source, { frameRate: 30 })
      await diagnosticBounded(output.start(), 10_000, 'Control encoder start')
      await record({ kind: 'control-encoder-start', context: diagnosticCanvasAttributes(ctx), source: 'independent static oracle; no animation resolver, compositor or export controller' })
      await readOrdinal(sourceBlob, 'saved-source', true, async (frame, pixels) => {
        const oracle = staticOracle(pixels, Math.min(frame, 255) % 2, owner)
        try {
          if (CONTROL_TARGETS.some((target) => target === frame)) references.set(frame, owner.copy(oracle))
          // Oracle RGB is already composited over black; alpha must not apply it twice.
          for (let offset = 3; offset < oracle.length; offset += 4) oracle[offset] = 255
          ctx.putImageData(new ImageData(oracle, WIDTH, HEIGHT), 0, 0)
          const digest = await diagnosticBounded(crypto.subtle.digest('SHA-256', oracle), 5000, 'Control input hash')
          if (work.controlFrames >= FRAME_COUNT) throw new Error('Control encode cap exceeded')
          work.controlFrames++
          await diagnosticBounded(activeSource.add(frame / 30, 1 / 30), 10_000, 'Control frame encode')
          await record({ kind: 'control-frame', frame, pathIndex: Math.min(frame, 255) % 2,
            opaqueRgbaSha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('') })
        } finally { owner.release(oracle) }
      })
      source.close(); sourceClosed = true
      await diagnosticBounded(output.finalize(), 10_000, 'Control finalize'); finalized = true
      if (!target.buffer?.byteLength || target.buffer.byteLength > 128 * 1024 * 1024) throw new Error('Control encoded extent differs')
      await persist('codec-control.mp4', target.buffer)
      controlBlob = new Blob([target.buffer], { type: 'video/mp4' })
    } finally {
      try { if (source && !sourceClosed) { source.close(); sourceClosed = true } }
      finally {
        try { if (output && !finalized) await diagnosticBounded(output.cancel(), 10_000, 'Control cancellation') }
        finally {
          canvas.height = canvas.width = 1
          await record({ kind: 'control-encoder-released', finalized, sourceClosed, frames: work.controlFrames,
            surface: { width: canvas.width, height: canvas.height }, pixels: owner.snapshot() })
        }
      }
    }
    if (!controlBlob) throw new Error('Control encode did not produce output')
    await readOrdinal(controlBlob, 'codec-control', false, async (frame, pixels) => {
      const reference = references.get(frame)
      if (!reference) throw new Error('Control oracle is missing')
      const quality = pixelErrors(pixels, reference, WIDTH, HEIGHT)
      await record({ kind: 'independent-control-quality', frame, quality, legacyMaximumPassed: quality.maximumDelta <= 12 })
      if (quality.meanDelta > 2) throw new Error(`Independent control mean quality failed: ${frame}`)
      controls.set(frame, owner.copy(pixels))
    })
    await compare(originalOutput, 'original-failed-export')
    if (work.ordinalSamples !== 900 || references.size !== 4 || controls.size !== 4) throw new Error('Control qualification targets/counts differ')
    await record({ kind: 'control-qualified-for-lifecycle', work, pixels: owner.snapshot(), legacyMaximumRuleUnchanged: 12 })
    const fixture = await diagnosticBounded(prepareExportFixture(record, persist, sourceBlob), 30_000, 'Saved fixture import')
    check(); prepared = true
    return { ...fixture,
      claimSourceRequest: () => {
        check()
        if (work.productionSourceRequests >= SOURCE_LIMIT) throw new Error('Production source request cap exceeded')
        work.productionSourceRequests++
      },
      compareOutput: async (buffer: ArrayBuffer, outputRecord: RecordEvidence) => {
        if (work.completedOutputs >= 6) throw new Error('Completion output count cap exceeded')
        await compare(new Blob([buffer], { type: 'video/mp4' }), `production-output-${work.completedOutputs}`, outputRecord)
        work.completedOutputs++
      },
      close: release,
    }
  } catch (cause) {
    await release(false).catch(() => {}) // Preserve the first failure; host evidence reports any write failure.
    throw cause
  }
}
