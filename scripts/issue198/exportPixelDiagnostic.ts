import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny'
import { applyOrderedPixelEffectsToRgba } from '../../src/domain/effectPixels'
import { maskParams } from '../../src/domain/effectStack'
import { matrixFixture, type RecordEvidence } from './maskPerformanceGate'
import { DIAGNOSTIC_FRAMES, DiagnosticPixelOwner, DiagnosticWorkOwner, compositeReferenceOverBlack, pixelErrors, type DiagnosticPixels } from './diagnosticPixels'
import { diagnosticBounded, diagnosticCanvasAttributes, diagnosticProductionComposite, DIAGNOSTIC_CELL, DIAGNOSTIC_SIZE } from './diagnosticComposite'

export const IMMUTABLE_DIAGNOSTIC_INPUTS = [
  { name: 'source.mp4', bytes: 1_069_647, sha256: '55a7094a0d645e5ec67c7d266890d9c6c8500a125f3454408bdd467ef8ed6264' },
  { name: 'export-complete-0.mp4', bytes: 2_103_209, sha256: 'f31104bd0a9d26d8ae1285bd15798b625281f8222268c79a34d006481eba0f2c' },
] as const
export const DIAGNOSTIC_BROWSER_MS = 90_000

async function sha256(bytes: ArrayBuffer | DiagnosticPixels) {
  const hash = await diagnosticBounded(crypto.subtle.digest('SHA-256', bytes), 5000, 'Diagnostic pixel hash')
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function immutableBlob(input: typeof IMMUTABLE_DIAGNOSTIC_INPUTS[number]) {
  const response = await diagnosticBounded(fetch(`/__issue198_diagnostic/${input.name}`, { cache: 'no-store' }), 5000, 'Immutable input read')
  const contentLength = response.headers.get('content-length')
  const details = JSON.stringify({ requestedPath: `/__issue198_diagnostic/${input.name}`, status: response.status,
    contentLength: contentLength?.slice(0, 128) ?? null, contentType: response.headers.get('content-type')?.slice(0, 128) ?? null })
  if (!response.ok) throw new Error(`Missing immutable input ${input.name}: ${details}`)
  if (contentLength !== String(input.bytes)) throw new Error(`Immutable input response extent differs: ${details}`)
  const bytes = await diagnosticBounded(response.arrayBuffer(), 5000, 'Immutable input bytes')
  if (bytes.byteLength !== input.bytes || await sha256(bytes) !== input.sha256) throw new Error(`Immutable input differs: ${input.name}`)
  return new Blob([bytes], { type: 'video/mp4' })
}

async function decodeComparisons(blob: Blob, name: string, owner: DiagnosticPixelOwner, work: DiagnosticWorkOwner, record: RecordEvidence, check: () => void) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  const selected = new Map<number, DiagnosticPixels>(), hashes = new Map<number, string>()
  const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d', { willReadFrequently: true })!
  let ordinalSamples = 0, sparseSamples = 0, samplesClosed = 0, videoFramesOpened = 0, videoFramesClosed = 0
  const ordinalSampleTimes: { ordinal: number; timestamp: number; duration: number }[] = []
  let iterator: AsyncGenerator<VideoSample> | undefined, failure: unknown
  const capture = (sample: VideoSample) => {
    const frame = sample.toVideoFrame(); videoFramesOpened++
    try {
      if (frame.displayWidth !== 1280 || frame.displayHeight !== 720) throw new Error('Decoded frame dimensions changed')
      ctx.drawImage(frame, 0, 0)
      let colorSpace: PredefinedColorSpace | undefined
      const pixels = owner.create(3_686_400, () => { const image = ctx.getImageData(0, 0, 1280, 720); colorSpace = image.colorSpace; return image.data })
      return { pixels,
        metadata: { sampleTimestamp: sample.timestamp, sampleDuration: sample.duration,
          videoFrameTimestampUs: frame.timestamp, videoFrameDurationUs: frame.duration,
          displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, colorSpace: frame.colorSpace.toJSON(), readbackColorSpace: colorSpace } }
    } finally { frame.close(); videoFramesClosed++ }
  }
  try {
    if (!ctx) throw new Error('Diagnostic readback canvas unavailable')
    const track = await diagnosticBounded(input.getPrimaryVideoTrack(), 5000, 'Diagnostic track')
    if (!track) throw new Error('Missing diagnostic video track')
    const duration = await diagnosticBounded(input.computeDuration(), 5000, 'Diagnostic duration')
    if (duration !== 10 || track.displayWidth !== 1280 || track.displayHeight !== 720
      || await diagnosticBounded(input.getPrimaryAudioTrack(), 5000, 'Diagnostic audio presence')) throw new Error('Immutable media metadata differs')
    await record({ kind: 'decode-source-start', name, duration, width: track.displayWidth, height: track.displayHeight,
      requestedReadbackPolicy: { willReadFrequently: true }, actualReadbackPolicy: diagnosticCanvasAttributes(ctx) })
    const sink = new VideoSampleSink(track)
    iterator = sink.samples()
    // The immutable container has300 samples. Do not request a301st sample merely to probe EOF.
    for (let index = 0; index < 300; index++) {
      check()
      work.claim('ordinal')
      const next = await diagnosticBounded(iterator.next(), 5000, 'Ordinal sample')
      if (next.done) throw new Error('Ordinal source ended before300 samples')
      const sample = next.value, ordinal = ordinalSamples++
      try {
        if (ordinal >= 300) throw new Error('Ordinal sample count exceeds300')
        ordinalSampleTimes.push({ ordinal, timestamp: sample.timestamp, duration: sample.duration })
        if (DIAGNOSTIC_FRAMES.some((frame) => frame === ordinal)) {
          const value = capture(sample), hash = await sha256(value.pixels)
          selected.set(ordinal, value.pixels); hashes.set(ordinal, hash)
          await record({ kind: 'decoded-frame', name, method: 'ordinal', frame: ordinal, ...value.metadata,
            requestedSeconds: ordinal / 30, rgbaSha256: hash, rgbaBytes: value.pixels.byteLength, pixelOwner: owner.snapshot() })
        }
      } finally { sample.close(); samplesClosed++ }
    }
    await diagnosticBounded(iterator.return(undefined), 5000, 'Ordinal stream release after300 samples')
    iterator = undefined
    if (ordinalSamples !== 300 || selected.size !== 6) throw new Error('Ordinal diagnostic did not observe exactly300 frames and6 targets')
    for (const frame of DIAGNOSTIC_FRAMES) {
      check()
      work.claim('sparse')
      const sample = await diagnosticBounded(sink.getSample(frame / 30), 5000, 'Sparse sample')
      if (!sample) throw new Error(`Missing sparse frame${frame}`)
      sparseSamples++
      let pixels: DiagnosticPixels | undefined
      try {
        const value = capture(sample); pixels = value.pixels
        const hash = await sha256(pixels)
        await record({ kind: 'decoded-frame', name, method: 'sparse', frame, ...value.metadata,
          requestedSeconds: frame / 30, rgbaSha256: hash, rgbaBytes: pixels.byteLength })
        await record({ kind: 'ordinal-sparse-parity', name, frame, ordinalRgbaSha256: hashes.get(frame), sparseRgbaSha256: hash,
          exactRgbaHashMatch: hashes.get(frame) === hash, errors: pixelErrors(pixels, selected.get(frame)!, 1280, 720) })
      } finally { if (pixels) owner.release(pixels); sample.close(); samplesClosed++ }
    }
  } catch (cause) { failure = cause }
  finally {
    let cleanupFailure: unknown
    let inputDisposed = false
    try { input.dispose(); inputDisposed = true } catch (cause) { cleanupFailure = cause }
    if (iterator) await diagnosticBounded(iterator.return(undefined), 5000, 'Ordinal iterator release').catch((cause) => { cleanupFailure = cause })
    canvas.height = canvas.width = 1
    await record({ kind: 'decode-source-released', name, ordinalSamples, sparseSamples, samplesClosed, videoFramesOpened, videoFramesClosed,
      inputDisposed, ordinalSampleTimes, surface: { width: canvas.width, height: canvas.height }, pixelOwner: owner.snapshot(),
      error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      cleanupError: cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure ? String(cleanupFailure) : null })
      .catch((cause) => { failure ??= cause })
    failure ??= cleanupFailure
  }
  if (failure !== undefined) throw failure
  return selected
}

export function staticOracle(source: DiagnosticPixels, pathIndex: number, owner: DiagnosticPixelOwner) {
  const fixture = matrixFixture(DIAGNOSTIC_CELL), pixels = owner.copy(source)
  const effect = { ...fixture.clip.effects[0]!, params: { ...fixture.clip.effects[0]!.params, path: fixture.paths[pathIndex]! } }
  try {
    applyOrderedPixelEffectsToRgba(pixels, [{ kind: 'mask', params: maskParams(effect) }], {
      surfaceWidth: 1280, surfaceHeight: 720, projectWidth: 1280, projectHeight: 720,
    })
    compositeReferenceOverBlack(pixels)
    return pixels
  } catch (cause) { owner.release(pixels); throw cause }
}

export async function runPixelDiagnostic(record: RecordEvidence) {
  const owner = new DiagnosticPixelOwner(), work = new DiagnosticWorkOwner(), began = performance.now()
  const check = () => { if (performance.now() - began > DIAGNOSTIC_BROWSER_MS) throw new Error('Diagnostic exceeded90-second browser budget') }
  let failure: unknown
  try {
    await record({ kind: 'diagnostic-start', immutableInputs: IMMUTABLE_DIAGNOSTIC_INPUTS, frames: DIAGNOSTIC_FRAMES,
      limits: { ordinalSamples: 600, sparseSamples: 12, productionSourceRequests: 128, productionComposites: 1,
        candidateComparisons: 6, browserMs: DIAGNOSTIC_BROWSER_MS, hostMs: 120_000, logicalPixelBytes: 64 * 1024 * 1024 },
      interpretation: 'Diagnostic differences are observations, not tolerance changes or an export pass. No encoding, export or application project mutation.' })
    const source = await immutableBlob(IMMUTABLE_DIAGNOSTIC_INPUTS[0]), output = await immutableBlob(IMMUTABLE_DIAGNOSTIC_INPUTS[1])
    const sourceFrames = await decodeComparisons(source, 'source', owner, work, record, check)
    const outputFrames = await decodeComparisons(output, 'output', owner, work, record, check)
    // Retain only candidates used below. Ordinal/sparse hashes and observations are already durable.
    for (const [frame, pixels] of sourceFrames) if (![126, 127, 128].includes(frame)) { owner.release(pixels); sourceFrames.delete(frame) }
    for (const [frame, pixels] of outputFrames) if (frame !== 127) { owner.release(pixels); outputFrames.delete(frame) }
    const output127 = outputFrames.get(127)!
    for (const sourceFrame of [126, 127, 128]) for (const pathIndex of [0, 1]) {
      check()
      work.claim('candidate')
      const oracle = staticOracle(sourceFrames.get(sourceFrame)!, pathIndex, owner)
      try {
        await record({ kind: 'frame127-candidate', sourceFrame, pathIndex, expectedHeldPathIndex: 1,
          outputRgbaSha256: await sha256(output127), referenceRgbaWithCoverageSha256: await sha256(oracle),
          errors: pixelErrors(output127, oracle, 1280, 720) })
      } finally { owner.release(oracle) }
    }
    check()
    const production = await diagnosticProductionComposite(source, owner, work, record, check)
    const oracle = staticOracle(production.input, 1, owner)
    const regionReference = owner.copy(production.rendered)
    try {
      for (let offset = 3; offset < regionReference.length; offset += 4) regionReference[offset] = oracle[offset]!
      await record({ kind: 'production-input-vs-ordinal127', productionInputSha256: await sha256(production.input), ordinalInputSha256: await sha256(sourceFrames.get(127)!),
        errors: pixelErrors(production.input, sourceFrames.get(127)!, 1280, 720) })
      await record({ kind: 'production-unencoded-vs-matching-input-oracle', frame: 127, sourceInputSha256: await sha256(production.input),
        unencodedRgbaSha256: await sha256(production.rendered), referenceRgbaWithCoverageSha256: await sha256(oracle),
        errors: pixelErrors(production.rendered, oracle, 1280, 720) })
      await record({ kind: 'saved-output-vs-production-unencoded', frame: 127, savedOutputRgbaSha256: await sha256(output127),
        unencodedRgbaSha256: await sha256(production.rendered), regionAlphaSource: 'Static oracle built from the exact production-decoded input; RGB from the unencoded actual compositor.',
        errors: pixelErrors(output127, regionReference, 1280, 720) })
    } finally { owner.release(oracle); owner.release(regionReference); owner.release(production.input); owner.release(production.rendered) }
    check()
    work.assertComplete()
    await record({ kind: 'diagnostic-observations-complete', elapsedMs: performance.now() - began, pixelOwner: owner.snapshot(), work: work.snapshot(),
      qualification: 'Collection completed; no export acceptance, fault attribution or native leak result is inferred automatically.' })
  } catch (cause) {
    failure = cause
    await record({ kind: 'diagnostic-failed', error: cause instanceof Error ? cause.stack : String(cause), elapsedMs: performance.now() - began, pixelOwner: owner.snapshot(), work: work.snapshot() })
    throw cause
  } finally {
    owner.close()
    await record({ kind: 'diagnostic-pixels-released', failed: !!failure, pixelOwner: owner.snapshot(), work: work.snapshot(), size: DIAGNOSTIC_SIZE })
  }
}
