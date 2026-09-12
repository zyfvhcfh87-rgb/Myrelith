/**
 * Encode/decode round-trip proof for alpha WebM. canEncodeVideo forces
 * alpha:'discard', so a real mux/reopen is the only honest capability signal.
 */

import {
  BufferTarget,
  CanvasSource,
  Input,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny'
import type { AlphaVideoCodec } from '../domain/deliveryProduct'

export interface AlphaCapabilityResult {
  readonly codec: AlphaVideoCodec
  readonly supported: boolean
  readonly reason: string | null
}

const PROBE_SIZE = 32

function probeCanvas(alpha: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE)
  const context = canvas.getContext('2d', { colorSpace: 'srgb', alpha: true })
  if (!context) throw new Error('Could not create the alpha proof canvas')
  context.clearRect(0, 0, PROBE_SIZE, PROBE_SIZE)
  context.fillStyle = `rgba(255, 0, 0, ${alpha / 255})`
  context.fillRect(2, 2, 6, 6)
  context.fillStyle = 'rgba(0, 255, 0, 0)'
  context.fillRect(20, 20, 6, 6)
  return canvas
}

async function roundTrip(codec: AlphaVideoCodec, signal?: AbortSignal): Promise<void> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }
  const canvas = probeCanvas(128)
  const target = new BufferTarget()
  const output = new Output({ format: new WebMOutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec,
    bitrate: 500_000,
    bitrateMode: 'variable',
    keyFrameInterval: 1,
    alpha: 'keep',
  })
  output.addVideoTrack(source, { frameRate: 30 })
  try {
    await output.start()
    if (signal?.aborted) throw new DOMException('Alpha proof cancelled', 'AbortError')
    await source.add(0, 1 / 30)
    await source.add(1 / 30, 1 / 30)
    source.close()
    await output.finalize()
  } catch (cause) {
    try {
      await output.cancel()
    } catch {
      // Proof failure stays primary.
    }
    canvas.width = 1
    canvas.height = 1
    throw cause
  }
  canvas.width = 1
  canvas.height = 1
  if (target.buffer === null) throw new Error('Alpha proof muxed without a buffer')

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(new Blob([target.buffer], { type: 'video/webm' })),
  })
  const read = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE)
  const readContext = read.getContext('2d', { colorSpace: 'srgb', alpha: true, willReadFrequently: true })
  if (!readContext) {
    input.dispose()
    throw new Error('Could not create the alpha proof readback canvas')
  }
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Alpha proof produced no video track')
    const audio = await input.getPrimaryAudioTrack()
    if (audio) throw new Error('Alpha proof unexpectedly included an audio track')
    let samples = 0
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        sample.draw(readContext, 0, 0, PROBE_SIZE, PROBE_SIZE)
        samples++
      } finally {
        sample.close()
      }
    }
    if (samples < 1) throw new Error('Alpha proof decoded no frames')
    const opaque = readContext.getImageData(3, 3, 1, 1).data
    const clear = readContext.getImageData(21, 21, 1, 1).data
    if (opaque[3]! < 80 || opaque[3]! > 200) {
      throw new Error(`Decoded alpha ${opaque[3]} was not preserved as transparency`)
    }
    if (clear[3]! > 40) {
      throw new Error(`Transparent pixels decoded as opaque alpha ${clear[3]}`)
    }
  } finally {
    input.dispose()
    read.width = 1
    read.height = 1
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  if (signal.reason !== undefined) throw signal.reason
  throw new DOMException('Alpha proof cancelled', 'AbortError')
}

export async function proveAlphaVideoCodec(
  codec: AlphaVideoCodec,
  signal?: AbortSignal,
): Promise<Readonly<AlphaCapabilityResult>> {
  throwIfAborted(signal)
  try {
    await roundTrip(codec, signal)
    throwIfAborted(signal)
    return Object.freeze({ codec, supported: true, reason: null })
  } catch (cause) {
    throwIfAborted(signal)
    const reason = cause instanceof Error && cause.message.trim()
      ? cause.message.trim()
      : String(cause)
    return Object.freeze({
      codec,
      supported: false,
      reason: `${codec.toUpperCase()} alpha is unavailable on this browser: ${reason}`,
    })
  }
}

export async function provePngSequenceSupport(): Promise<{
  readonly supported: boolean
  readonly reason: string | null
}> {
  if (typeof OffscreenCanvas === 'undefined') {
    return { supported: false, reason: 'OffscreenCanvas is not supported in this browser' }
  }
  const canvas = new OffscreenCanvas(8, 8)
  const context = canvas.getContext('2d', { colorSpace: 'srgb', alpha: true })
  if (!context || typeof canvas.convertToBlob !== 'function') {
    canvas.width = 1
    canvas.height = 1
    return { supported: false, reason: 'This browser cannot encode PNG frames from a canvas' }
  }
  try {
    context.clearRect(0, 0, 8, 8)
    context.fillStyle = 'rgba(12, 34, 56, 0.5)'
    context.fillRect(0, 0, 4, 4)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    if (blob.type !== 'image/png' || blob.size <= 0) {
      return { supported: false, reason: 'PNG encoding did not produce a PNG blob' }
    }
    return { supported: true, reason: null }
  } catch (cause) {
    return {
      supported: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
}
