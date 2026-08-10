/**
 * Browser-native editing-proxy generator.
 *
 * One Mediabunny Input/CanvasSink owns the decoder, one CanvasSource owns the
 * WebCodecs encoder, and one awaited StreamTarget owns OPFS backpressure. The
 * caller supplies the destination only after decoder and encoder support have
 * both been revalidated.
 */

import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  NullTarget,
  Output,
} from 'mediabunny'
import {
  ensureMediaDecoderSupport,
  refineVideoDecoderBudget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import {
  DEFAULT_PROXY_PARAMETERS,
  proxyOutputDimensions,
  type ProxyGenerationParameters,
} from '../domain/proxyCache'
import type { FrameRate } from '../domain/schema'
import {
  createDirectFileExportTarget,
  type CommittedExportFile,
  type DirectFileExportTarget,
  type PreparedExportFileCapability,
} from './export-file-target'

const MAX_PROXY_FRAMES = 500_000

export interface ProxyGenerationAsset {
  readonly id: string
  readonly fileName: string
  readonly size: number
  readonly videoBounds: {
    readonly firstTimestampUs: number
    readonly endTimestampUs: number
  }
  readonly frameRate: FrameRate
  readonly width: number
  readonly height: number
}

export interface ProxyGenerationRequest {
  readonly source: Blob
  readonly asset: ProxyGenerationAsset
  readonly budget: LocalDecoderBudget
  readonly parameters?: ProxyGenerationParameters
  readonly signal?: AbortSignal
  readonly openDestination: () => Promise<PreparedExportFileCapability>
  readonly onProgress?: (progress: number) => void
  readonly onDecoderCount?: (count: number) => void
}

export interface ProxyGenerationResult extends CommittedExportFile {
  readonly width: number
  readonly height: number
  readonly frameRate: FrameRate
  readonly durationMicroseconds: number
  readonly frameCount: number
}

export interface ProxyEncoderSupport {
  readonly supported: boolean
  readonly reason: string
}

export interface ProxyInputSupport {
  readonly supported: boolean
  readonly reason: string
}

export interface ProxyGenerationPlan {
  readonly firstTimestampUs: number
  readonly endTimestampUs: number
  readonly durationMicroseconds: number
  readonly frameCount: number
  readonly framesPerSecond: number
  readonly frameDurationSeconds: number
  sourceTimestampSeconds(frame: number): number
  outputTimestampSeconds(frame: number): number
  outputDurationSeconds(frame: number): number
}

export interface ProxyEncoderProbeConfig {
  readonly width: number
  readonly height: number
  readonly bitrate: number
  readonly framesPerSecond: number
  readonly keyFrameIntervalSeconds: number
}

export interface ProxyEncoderProbeDeps {
  runExactProbe(config: ProxyEncoderProbeConfig): Promise<ProxyEncoderProbeResult>
}

export interface ProxyEncoderProbeResult {
  readonly supported: boolean
  readonly reason?: string
}

function abortError(): Error {
  const error = new Error('Proxy generation was canceled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw abortError()
}

function assertFrameIndex(frame: number, frameCount: number): void {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) {
    throw new RangeError('Proxy frame index is outside the generation plan')
  }
}

export function planProxyGeneration(asset: ProxyGenerationAsset): ProxyGenerationPlan {
  if (!asset.id || !asset.fileName) throw new TypeError('Proxy source identity is required')
  const firstTimestampUs = asset.videoBounds.firstTimestampUs
  const endTimestampUs = asset.videoBounds.endTimestampUs
  if (
    !Number.isSafeInteger(firstTimestampUs)
    || !Number.isSafeInteger(endTimestampUs)
    || endTimestampUs <= firstTimestampUs
  ) {
    throw new RangeError('Proxy source video bounds must be an exact increasing microsecond range')
  }
  const durationMicroseconds = endTimestampUs - firstTimestampUs
  if (!Number.isSafeInteger(durationMicroseconds)) {
    throw new RangeError('Proxy source video duration exceeds the safe integer range')
  }
  if (
    !Number.isSafeInteger(asset.frameRate.num)
    || asset.frameRate.num <= 0
    || !Number.isSafeInteger(asset.frameRate.den)
    || asset.frameRate.den <= 0
  ) throw new RangeError('Proxy source frame rate is invalid')
  const framesPerSecond = asset.frameRate.num / asset.frameRate.den
  const frameDurationUsDenominator = BigInt(asset.frameRate.den) * 1_000_000n
  const frameCount = Number((
    BigInt(durationMicroseconds) * BigInt(asset.frameRate.num)
    + frameDurationUsDenominator - 1n
  ) / frameDurationUsDenominator)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > MAX_PROXY_FRAMES) {
    throw new RangeError(`Proxy generation is limited to ${MAX_PROXY_FRAMES} frames`)
  }
  const frameDurationSeconds = asset.frameRate.den / asset.frameRate.num
  const durationSeconds = durationMicroseconds / 1_000_000
  return {
    firstTimestampUs,
    endTimestampUs,
    durationMicroseconds,
    frameCount,
    framesPerSecond,
    frameDurationSeconds,
    sourceTimestampSeconds(frame) {
      assertFrameIndex(frame, frameCount)
      return Math.min(
        firstTimestampUs / 1_000_000 + frame * frameDurationSeconds,
        (endTimestampUs - 1) / 1_000_000,
      )
    },
    outputTimestampSeconds(frame) {
      assertFrameIndex(frame, frameCount)
      return frame * frameDurationSeconds
    },
    outputDurationSeconds(frame) {
      assertFrameIndex(frame, frameCount)
      return Math.min(
        frameDurationSeconds,
        Math.max(0, durationSeconds - frame * frameDurationSeconds),
      )
    },
  }
}

const realEncoderProbeDeps: ProxyEncoderProbeDeps = {
  async runExactProbe(config) {
    const canvas = new OffscreenCanvas(config.width, config.height)
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
    if (!context) {
      return { supported: false, reason: 'Could not create the exact proxy conversion canvas.' }
    }
    context.fillStyle = '#000'
    context.fillRect(0, 0, config.width, config.height)
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new NullTarget(),
    })
    const source = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: config.bitrate,
      keyFrameInterval: config.keyFrameIntervalSeconds,
    })
    output.addVideoTrack(source, { frameRate: config.framesPerSecond })
    let closed = false
    try {
      await output.start()
      await source.add(0, 1 / config.framesPerSecond)
      source.close()
      closed = true
      await output.finalize()
      return { supported: true }
    } catch (cause) {
      if (!closed) {
        try {
          source.close()
        } catch {
          // Output cancellation below remains the authoritative cleanup.
        }
      }
      try {
        await output.cancel()
      } catch {
        // The exact probe is disposable and reports only supported/unsupported.
      }
      return {
        supported: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      }
    }
  },
}

const encoderProbeCache = new Map<string, Promise<ProxyEncoderProbeResult>>()
let encoderProbeTail: Promise<void> = Promise.resolve()

function runBoundedEncoderProbe(config: ProxyEncoderProbeConfig): Promise<ProxyEncoderProbeResult> {
  const run = encoderProbeTail.then(() => realEncoderProbeDeps.runExactProbe(config))
  encoderProbeTail = run.then(() => undefined, () => undefined)
  return run
}

export async function probeProxyEncoderSupport(
  width: number,
  height: number,
  frameRate: FrameRate,
  parameters: ProxyGenerationParameters = DEFAULT_PROXY_PARAMETERS,
  deps: ProxyEncoderProbeDeps = realEncoderProbeDeps,
): Promise<ProxyEncoderSupport> {
  const framesPerSecond = frameRate.num / frameRate.den
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    return { supported: false, reason: 'The source frame rate is invalid for proxy generation.' }
  }
  if (
    deps === realEncoderProbeDeps
    && (typeof OffscreenCanvas === 'undefined' || typeof VideoEncoder === 'undefined')
  ) {
    return {
      supported: false,
      reason: 'This browser does not expose the required OffscreenCanvas and WebCodecs encoder APIs.',
    }
  }
  const output = proxyOutputDimensions(width, height, parameters)
  try {
    const format = new Mp4OutputFormat()
    if (!format.getSupportedVideoCodecs().includes(parameters.videoCodec)) {
      return { supported: false, reason: 'MP4 output does not support the AVC proxy profile.' }
    }
    const config: ProxyEncoderProbeConfig = {
      width: output.width,
      height: output.height,
      bitrate: parameters.bitrate,
      framesPerSecond,
      keyFrameIntervalSeconds: parameters.keyFrameIntervalSeconds,
    }
    const cacheKey = JSON.stringify(config)
    let probe = encoderProbeCache.get(cacheKey)
    if (!probe || deps !== realEncoderProbeDeps) {
      probe = deps === realEncoderProbeDeps
        ? runBoundedEncoderProbe(config)
        : deps.runExactProbe(config)
      if (deps === realEncoderProbeDeps) encoderProbeCache.set(cacheKey, probe)
    }
    const result = await probe
    return result.supported
      ? {
          supported: true,
          reason: `AVC MP4 ${output.width}×${output.height} at ${framesPerSecond.toFixed(3)} fps is available.`,
        }
      : {
          supported: false,
          reason: result.reason
            ? `AVC MP4 ${output.width}×${output.height} at ${framesPerSecond.toFixed(3)} fps is unavailable: ${result.reason}`
            : `AVC MP4 ${output.width}×${output.height} at ${framesPerSecond.toFixed(3)} fps is unavailable in this browser.`,
        }
  } catch (cause) {
    return {
      supported: false,
      reason: `Could not verify AVC proxy encoding: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

/**
 * Reopen and revalidate the exact video decoder boundary before UI consent is
 * enabled. The temporary Input never escapes and owns no long-lived decoder.
 */
export async function probeProxyInputSupport(
  source: Blob,
  sourceId: string,
  budget: LocalDecoderBudget,
  signal?: AbortSignal,
): Promise<ProxyInputSupport> {
  throwIfAborted(signal)
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { supported: false, reason: 'The source has no video track to proxy.' }
    const [codec, configuration] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
    ])
    throwIfAborted(signal)
    const support = await ensureMediaDecoderSupport({
      codec,
      canDecode: () => track.canDecode(),
      configuration,
      trackKind: 'video',
      sourceId,
      boundary: 'proxy-generation',
      policy: 'revalidate',
      budget: refineVideoDecoderBudget(budget, source.size, configuration),
    })
    throwIfAborted(signal)
    const pathLabel = support.decodable
      ? support.path === 'native'
        ? 'Native browser decoder'
        : support.path === 'local-prores'
          ? 'Local fallback (ProRes)'
          : 'Local fallback (AC-3/E-AC-3)'
      : null
    return support.decodable
      ? { supported: true, reason: `Input decoder verified: ${pathLabel}.` }
      : { supported: false, reason: `Proxy input is unsupported: ${support.failure.detail}` }
  } catch (cause) {
    if (signal?.aborted) throw abortError()
    return {
      supported: false,
      reason: `Could not verify the proxy input: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  } finally {
    input.dispose()
  }
}

export async function generateEditingProxy(
  request: ProxyGenerationRequest,
): Promise<ProxyGenerationResult> {
  const parameters = request.parameters ?? DEFAULT_PROXY_PARAMETERS
  const plan = planProxyGeneration(request.asset)
  const outputSize = proxyOutputDimensions(
    request.asset.width,
    request.asset.height,
    parameters,
  )
  throwIfAborted(request.signal)

  const input = new Input({
    source: new BlobSource(request.source),
    formats: ALL_FORMATS,
  })
  let output: Output | null = null
  let destination: DirectFileExportTarget | null = null
  let finalized = false
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error(`"${request.asset.fileName}" has no video track`)
    const [codec, configuration, firstTimestamp, endTimestamp] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
      track.getFirstTimestamp(),
      track.computeDuration(),
    ])
    if (
      Math.abs(Math.round(firstTimestamp * 1_000_000) - plan.firstTimestampUs) > 1
      || Math.abs(Math.round(endTimestamp * 1_000_000) - plan.endTimestampUs) > 1
    ) {
      throw new Error('The exact video timestamp bounds changed; relink and re-analyze before proxying')
    }
    const support = await ensureMediaDecoderSupport({
      codec,
      canDecode: () => track.canDecode(),
      configuration,
      trackKind: 'video',
      sourceId: request.asset.id,
      boundary: 'proxy-generation',
      policy: 'revalidate',
      budget: refineVideoDecoderBudget(
        request.budget,
        request.source.size,
        configuration,
      ),
    })
    if (!support.decodable) {
      throw new Error(`Proxy input is unsupported: ${support.failure.detail}`)
    }
    throwIfAborted(request.signal)
    const encoder = await probeProxyEncoderSupport(
      request.asset.width,
      request.asset.height,
      request.asset.frameRate,
      parameters,
    )
    if (!encoder.supported) throw new Error(encoder.reason)

    // Output acquisition begins only after the exact source and output codec
    // checks above succeed, so unsupported inputs cannot leave staged bytes.
    const capability = await request.openDestination()
    destination = await createDirectFileExportTarget(capability)
    const canvas = new OffscreenCanvas(outputSize.width, outputSize.height)
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
    if (!context) throw new Error('Could not create the proxy conversion canvas')
    output = new Output({
      format: new Mp4OutputFormat(),
      target: destination.target,
    })
    const encoderSource = new CanvasSource(canvas, {
      codec: parameters.videoCodec,
      bitrate: parameters.bitrate,
      keyFrameInterval: parameters.keyFrameIntervalSeconds,
    })
    output.addVideoTrack(encoderSource, { frameRate: plan.framesPerSecond })
    await output.start()

    const decoderSink = new CanvasSink(track, {
      width: outputSize.width,
      height: outputSize.height,
      fit: 'fill',
      poolSize: 1,
    })
    function* sourceTimestamps(): Generator<number> {
      for (let frame = 0; frame < plan.frameCount; frame++) {
        yield plan.sourceTimestampSeconds(frame)
      }
    }

    request.onDecoderCount?.(1)
    let frame = 0
    for await (const decoded of decoderSink.canvasesAtTimestamps(sourceTimestamps())) {
      throwIfAborted(request.signal)
      if (!decoded) throw new Error(`The source decoder returned no frame at proxy frame ${frame}`)
      context.drawImage(decoded.canvas, 0, 0, outputSize.width, outputSize.height)
      const timestamp = plan.outputTimestampSeconds(frame)
      const duration = plan.outputDurationSeconds(frame)
      if (!(duration > 0)) throw new Error(`Proxy frame ${frame} has no presentation duration`)
      await encoderSource.add(timestamp, duration)
      frame++
      request.onProgress?.(frame / plan.frameCount)
    }
    if (frame !== plan.frameCount) {
      throw new Error(`Proxy decoder produced ${frame} of ${plan.frameCount} required frames`)
    }
    throwIfAborted(request.signal)
    encoderSource.close()
    await output.finalize()
    const committed = await destination.commit()
    finalized = true
    return {
      ...committed,
      width: outputSize.width,
      height: outputSize.height,
      frameRate: request.asset.frameRate,
      durationMicroseconds: plan.durationMicroseconds,
      frameCount: plan.frameCount,
    }
  } catch (cause) {
    if (output && !finalized) {
      try {
        await output.cancel()
      } catch {
        // The operational failure remains primary unless native abort below fails.
      }
    }
    if (destination && !finalized) await destination.abort(cause)
    if (request.signal?.aborted && !(cause instanceof Error && cause.name === 'AbortError')) {
      throw abortError()
    }
    throw cause
  } finally {
    request.onDecoderCount?.(0)
    input.dispose()
  }
}
