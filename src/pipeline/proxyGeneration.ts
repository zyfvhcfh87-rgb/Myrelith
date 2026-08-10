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
  Output,
  canEncodeVideo,
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
  readonly durationMicroseconds: number
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

function assertAsset(asset: ProxyGenerationAsset): number {
  if (!asset.id || !asset.fileName) throw new TypeError('Proxy source identity is required')
  if (!Number.isSafeInteger(asset.durationMicroseconds) || asset.durationMicroseconds <= 0) {
    throw new RangeError('Proxy source duration must be a positive integer number of microseconds')
  }
  if (
    !Number.isSafeInteger(asset.frameRate.num)
    || asset.frameRate.num <= 0
    || !Number.isSafeInteger(asset.frameRate.den)
    || asset.frameRate.den <= 0
  ) throw new RangeError('Proxy source frame rate is invalid')
  const frameRate = asset.frameRate.num / asset.frameRate.den
  const frameCount = Math.ceil(asset.durationMicroseconds / 1_000_000 * frameRate)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > MAX_PROXY_FRAMES) {
    throw new RangeError(`Proxy generation is limited to ${MAX_PROXY_FRAMES} frames`)
  }
  return frameCount
}

export async function probeProxyEncoderSupport(
  width: number,
  height: number,
  frameRate: FrameRate,
  parameters: ProxyGenerationParameters = DEFAULT_PROXY_PARAMETERS,
): Promise<ProxyEncoderSupport> {
  const framesPerSecond = frameRate.num / frameRate.den
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    return { supported: false, reason: 'The source frame rate is invalid for proxy generation.' }
  }
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoEncoder === 'undefined') {
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
    const supported = await canEncodeVideo(parameters.videoCodec, {
      width: output.width,
      height: output.height,
      bitrate: parameters.bitrate,
    })
    return supported
      ? {
          supported: true,
          reason: `AVC MP4 ${output.width}×${output.height} encoding is available.`,
        }
      : {
          supported: false,
          reason: `AVC MP4 ${output.width}×${output.height} encoding is unavailable in this browser.`,
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
  const frameCount = assertAsset(request.asset)
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
    const [codec, configuration, firstTimestamp] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
      track.getFirstTimestamp(),
    ])
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
    const framesPerSecond = request.asset.frameRate.num / request.asset.frameRate.den
    output.addVideoTrack(encoderSource, { frameRate: framesPerSecond })
    await output.start()

    const decoderSink = new CanvasSink(track, {
      width: outputSize.width,
      height: outputSize.height,
      fit: 'fill',
      poolSize: 1,
    })
    const frameDuration = request.asset.frameRate.den / request.asset.frameRate.num
    const durationSeconds = request.asset.durationMicroseconds / 1_000_000
    function* sourceTimestamps(): Generator<number> {
      for (let frame = 0; frame < frameCount; frame++) {
        yield firstTimestamp + frame * frameDuration
      }
    }

    request.onDecoderCount?.(1)
    let frame = 0
    for await (const decoded of decoderSink.canvasesAtTimestamps(sourceTimestamps())) {
      throwIfAborted(request.signal)
      if (!decoded) throw new Error(`The source decoder returned no frame at proxy frame ${frame}`)
      context.drawImage(decoded.canvas, 0, 0, outputSize.width, outputSize.height)
      const timestamp = frame * frameDuration
      const duration = Math.min(frameDuration, Math.max(0, durationSeconds - timestamp))
      if (!(duration > 0)) throw new Error(`Proxy frame ${frame} has no presentation duration`)
      await encoderSource.add(timestamp, duration)
      frame++
      request.onProgress?.(frame / frameCount)
    }
    if (frame !== frameCount) {
      throw new Error(`Proxy decoder produced ${frame} of ${frameCount} required frames`)
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
      durationMicroseconds: request.asset.durationMicroseconds,
      frameCount,
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
