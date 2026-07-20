/**
 * pipeline/export-mediabunny.ts — browser adapters for bounded A/V export.
 *
 * Decoding owns one Mediabunny Input/CanvasSink per asset. CanvasSink's
 * pooled canvas is copied immediately into a lease-owned ImageBitmap so a
 * later decode can never mutate pixels still being composited. Audio decode
 * keeps one sequential cursor per active clip; encoding owns one MP4 Output
 * and awaits video plus exact-sample AAC writes for every document frame.
 */

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  type EncodedPacket,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import {
  MediaAssetRuntimeError,
  type MediaRuntimeFailure,
} from '../domain/mediaCompatibility'
import {
  ensureMediaDecoderSupport,
  refineAudioDecoderBudget,
  refineVideoDecoderBudget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type { AssetId, TimelineDoc } from '../domain/schema'
import {
  docDurationFrames,
  visibleVideoLayersAtFrame,
} from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import type {
  ExportDeps,
  ExportFrameLease,
  ExportMediaSource,
  ExportResult,
  ExportSettings,
  ExportVideoSink,
} from './export'
import {
  EXPORT_AUDIO_CHANNELS,
  TimelineAudioMixer,
  audioSampleBoundary,
  type ExportAudioClipReader,
  type ExportAudioClipRequest,
  type ExportAudioMediaSource,
  type MixedAudioBlock,
} from './export-audio'
import { compositeFrame, type Composite2D } from './render'

/** Resolves one immutable session source and its local-fallback safety budget. */
export interface ResolvedExportAsset {
  blob: Blob
  budget: LocalDecoderBudget
}

export type ExportAssetResolver = (
  assetId: AssetId,
) => ResolvedExportAsset | Promise<ResolvedExportAsset>

interface DecodedAsset {
  input: Input
  sink: CanvasSink
  sourceFrames: readonly number[]
  canvases: ReturnType<CanvasSink['canvasesAtTimestamps']>
  nextRequestIndex: number
  /** Same-asset decodes serialize so the one-canvas pool is never reused early. */
  decodeTail: Promise<void>
}

function runtimeFailureDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.slice(0, 2_048)
}

function exportAssetError(
  assetId: AssetId,
  trackKind: MediaRuntimeFailure['trackKind'],
  reason: MediaRuntimeFailure['reason'],
  cause: unknown,
): MediaAssetRuntimeError {
  if (
    cause instanceof MediaAssetRuntimeError
    && cause.assetId === assetId
    && cause.failure.surface === 'export'
    && cause.failure.trackKind === trackKind
  ) return cause
  return new MediaAssetRuntimeError(assetId, {
    surface: 'export',
    trackKind,
    reason,
    detail: runtimeFailureDetail(cause),
  }, cause)
}

function assertFrame(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function closeBitmaps(bitmaps: Set<ImageBitmap>): void {
  let failure: unknown
  for (const bitmap of bitmaps) {
    try {
      bitmap.close()
    } catch (cause) {
      failure ??= cause
    }
  }
  bitmaps.clear()
  if (failure !== undefined) throw failure
}

/**
 * Build the exact per-asset request order compositeFrame will issue. Giving
 * that full stream to one canvasesAtTimestamps iterator keeps one decoder
 * alive per asset instead of creating a decoder for every exported frame.
 */
interface VideoFrameRequest {
  assetId: AssetId
  sourceFrame: number
}

interface VideoRequestSchedule {
  frameCount: number
  byAsset: Map<AssetId, number[]>
}

function videoRequestSchedule(doc: TimelineDoc): VideoRequestSchedule {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('Cannot schedule an invalid export timeline')
  }

  const byAsset = new Map<AssetId, number[]>()
  for (let frame = 0; frame < frameCount; frame++) {
    for (const { clip, sourceFrame } of visibleVideoLayersAtFrame(doc, frame)) {
      const assetRequests = byAsset.get(clip.assetId)
      if (assetRequests) assetRequests.push(sourceFrame)
      else byAsset.set(clip.assetId, [sourceFrame])
    }
  }
  return { frameCount, byAsset }
}

/**
 * Creates the real browser media source consumed by exportTimeline.
 * Inputs open lazily and stay alive until the whole export closes.
 */
export function createMediabunnyExportMediaSource(
  doc: TimelineDoc,
  resolveAsset: ExportAssetResolver,
): ExportMediaSource {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  // Validate the rational once, while retaining independent per-frame math.
  framesToSeconds(0, doc.frameRate)
  if (typeof createImageBitmap !== 'function') {
    throw new Error('ImageBitmap creation is not supported in this browser')
  }

  const sessions = new Map<AssetId, Promise<DecodedAsset>>()
  const openInputs = new Set<Input>()
  const requests = videoRequestSchedule(doc)
  let closed = false
  let closePromise: Promise<void> | null = null

  const openAsset = (assetId: AssetId): Promise<DecodedAsset> => {
    const cached = sessions.get(assetId)
    if (cached) return cached

    const pending = (async (): Promise<DecodedAsset> => {
      if (closed) throw new Error('Export media source is closed')
      const sourceFrames = requests.byAsset.get(assetId)
      if (!sourceFrames || sourceFrames.length === 0) {
        throw new Error(`Export asset "${assetId}" was not scheduled`)
      }
      let resolved: ResolvedExportAsset
      try {
        resolved = await resolveAsset(assetId)
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      const { blob } = resolved
      if (closed) throw new Error('Export media source is closed')

      let input: Input
      try {
        input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        })
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      openInputs.add(input)

      try {
        let track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>
        try {
          track = await input.getPrimaryVideoTrack()
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        if (!track) {
          throw exportAssetError(
            assetId,
            'video',
            'decode-failed',
            new Error(`Export asset "${assetId}" has no video track`),
          )
        }
        let support: Awaited<ReturnType<typeof ensureMediaDecoderSupport>>
        try {
          const codec = await track.getCodec()
          const configuration = await track.getDecoderConfig()
          support = await ensureMediaDecoderSupport({
            codec,
            canDecode: () => track.canDecode(),
            configuration,
            trackKind: 'video',
            sourceId: assetId,
            boundary: 'export-video',
            policy: 'revalidate',
            budget: refineVideoDecoderBudget(
              resolved.budget,
              blob.size,
              configuration,
            ),
          })
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        if (!support.decodable) {
          throw exportAssetError(
            assetId,
            'video',
            support.failure.reason,
            new Error(
              `Export asset "${assetId}" cannot be decoded: ${support.failure.detail}`,
            ),
          )
        }
        if (closed) throw new Error('Export media source is closed')

        const timestamps = sourceFrames.map((sourceFrame) =>
          framesToSeconds(sourceFrame, doc.frameRate),
        )
        let sink: CanvasSink
        let canvases: ReturnType<CanvasSink['canvasesAtTimestamps']>
        try {
          sink = new CanvasSink(track, { poolSize: 1 })
          canvases = sink.canvasesAtTimestamps(timestamps)
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        return {
          input,
          sink,
          sourceFrames,
          canvases,
          nextRequestIndex: 0,
          decodeTail: Promise.resolve(),
        }
      } catch (cause) {
        try {
          input.dispose()
        } catch {
          // Preserve the asset open/decode failure over disposal cleanup.
        }
        openInputs.delete(input)
        throw cause
      }
    })()

    sessions.set(assetId, pending)
    return pending
  }

  const openFrame = async (docFrame: number): Promise<ExportFrameLease> => {
    assertFrame(docFrame, 'Document frame')
    if (closed) throw new Error('Export media source is closed')
    if (docFrame >= requests.frameCount) {
      throw new Error(`Export received an extra document frame ${docFrame}`)
    }
    const frameRequests: VideoFrameRequest[] = visibleVideoLayersAtFrame(
      doc,
      docFrame,
    ).map(({ clip, sourceFrame }) => ({
      assetId: clip.assetId,
      sourceFrame,
    }))

    const bitmaps = new Set<ImageBitmap>()
    let leaseClosed = false
    let nextFrameRequestIndex = 0

    return {
      getFrame: async (
        assetId: AssetId,
        sourceFrame: number,
      ): Promise<ImageBitmap | null> => {
        assertFrame(sourceFrame, 'Source frame')
        if (closed || leaseClosed) {
          throw new Error('Export frame lease is closed')
        }

        const frameRequest = frameRequests[nextFrameRequestIndex]
        if (!frameRequest) {
          throw new Error(
            `Export document frame ${docFrame} received an extra media request`,
          )
        }
        if (
          frameRequest.assetId !== assetId ||
          frameRequest.sourceFrame !== sourceFrame
        ) {
          throw new Error(
            `Export document frame ${docFrame} expected ` +
              `${frameRequest.assetId}@${frameRequest.sourceFrame}, got ` +
              `${assetId}@${sourceFrame}`,
          )
        }
        nextFrameRequestIndex++

        const asset = await openAsset(assetId)
        const expectedFrame = asset.sourceFrames[asset.nextRequestIndex]
        if (expectedFrame === undefined) {
          throw new Error(`Export asset "${assetId}" received an extra frame request`)
        }
        if (sourceFrame !== expectedFrame) {
          throw new Error(
            `Export asset "${assetId}" expected source frame ` +
              `${expectedFrame}, got ${sourceFrame}`,
          )
        }
        asset.nextRequestIndex++

        const decode = async (): Promise<ImageBitmap | null> => {
          if (closed || leaseClosed) {
            throw new Error('Export frame lease is closed')
          }
          let step: Awaited<ReturnType<typeof asset.canvases.next>>
          try {
            step = await asset.canvases.next()
          } catch (cause) {
            throw exportAssetError(assetId, 'video', 'decode-failed', cause)
          }
          if (step.done) {
            throw exportAssetError(
              assetId,
              'video',
              'decode-failed',
              new Error(
                `Export asset "${assetId}" decode stream ended early`,
              ),
            )
          }
          const wrapped = step.value
          if (!wrapped) return null

          const bitmap = await createImageBitmap(wrapped.canvas)
          if (closed || leaseClosed) {
            bitmap.close()
            throw new Error('Export frame lease is closed')
          }
          bitmaps.add(bitmap)
          return bitmap
        }

        const result = asset.decodeTail.then(decode, decode)
        asset.decodeTail = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      },
      close: (): void => {
        if (leaseClosed) return
        leaseClosed = true
        let failure: unknown
        try {
          closeBitmaps(bitmaps)
        } catch (cause) {
          failure = cause
        }
        if (
          nextFrameRequestIndex !== frameRequests.length &&
          failure === undefined
        ) {
          failure = new Error(
            `Export document frame ${docFrame} received ` +
              `${nextFrameRequestIndex} of ${frameRequests.length} ` +
              'scheduled media requests',
          )
        }
        if (failure !== undefined) throw failure
      },
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      const settled = await Promise.allSettled(sessions.values())
      await Promise.all(
        settled.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value.decodeTail] : [],
        ),
      )

      let failure: unknown
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue
        try {
          await entry.value.canvases.return()
        } catch (cause) {
          failure ??= cause
        }
      }
      for (const input of openInputs) {
        try {
          input.dispose()
        } catch (cause) {
          failure ??= cause
        }
      }
      openInputs.clear()
      if (failure !== undefined) throw failure
    })()
    return closePromise
  }

  return { openFrame, close }
}

interface DecodedAudioAsset {
  input: Input
  sink: AudioSampleSink
}

interface DecodedPcmChunk {
  timestampSec: number
  sampleRate: number
  frameCount: number
  channels: readonly Float32Array[]
}

function pcmChunkEnd(chunk: DecodedPcmChunk): number {
  return chunk.timestampSec + chunk.frameCount / chunk.sampleRate
}

function copyDecodedSample(sample: AudioSample): DecodedPcmChunk {
  try {
    if (!Number.isFinite(sample.timestamp)) {
      throw new Error('Decoded audio sample has an invalid timestamp')
    }
    if (!Number.isSafeInteger(sample.sampleRate) || sample.sampleRate <= 0) {
      throw new Error('Decoded audio sample has an invalid sample rate')
    }
    if (!Number.isSafeInteger(sample.numberOfFrames) || sample.numberOfFrames <= 0) {
      throw new Error('Decoded audio sample has an invalid frame count')
    }
    if (
      !Number.isSafeInteger(sample.numberOfChannels) ||
      sample.numberOfChannels <= 0 ||
      sample.numberOfChannels > 32
    ) {
      throw new Error('Decoded audio sample has an invalid channel count')
    }

    const channels: Float32Array[] = []
    for (let channel = 0; channel < sample.numberOfChannels; channel++) {
      const data = new Float32Array(sample.numberOfFrames)
      sample.copyTo(data, {
        planeIndex: channel,
        format: 'f32-planar',
      })
      channels.push(data)
    }
    return {
      timestampSec: sample.timestamp,
      sampleRate: sample.sampleRate,
      frameCount: sample.numberOfFrames,
      channels,
    }
  } finally {
    sample.close()
  }
}

class MediabunnyAudioClipReader implements ExportAudioClipReader {
  private readonly iterator: AsyncGenerator<AudioSample, void, unknown>
  private readonly request: ExportAudioClipRequest
  private readonly onClosed: () => void
  private nextSourceSample: number
  private current: DecodedPcmChunk | null = null
  private lookahead: DecodedPcmChunk | null = null
  private lookaheadLoaded = false
  private iteratorDone = false
  private closePromise: Promise<void> | null = null

  constructor(
    iterator: AsyncGenerator<AudioSample, void, unknown>,
    request: ExportAudioClipRequest,
    onClosed: () => void,
  ) {
    this.iterator = iterator
    this.request = request
    this.onClosed = onClosed
    this.nextSourceSample = request.startSample
  }

  private async pullChunk(): Promise<DecodedPcmChunk | null> {
    if (this.iteratorDone) return null
    let step: Awaited<ReturnType<typeof this.iterator.next>>
    try {
      step = await this.iterator.next()
    } catch (cause) {
      throw exportAssetError(
        this.request.assetId,
        'audio',
        'decode-failed',
        cause,
      )
    }
    if (step.done) {
      this.iteratorDone = true
      return null
    }
    try {
      return copyDecodedSample(step.value)
    } catch (cause) {
      throw exportAssetError(
        this.request.assetId,
        'audio',
        'decode-failed',
        cause,
      )
    }
  }

  private async shiftChunk(): Promise<DecodedPcmChunk | null> {
    if (this.lookaheadLoaded) {
      const next = this.lookahead
      this.lookahead = null
      this.lookaheadLoaded = false
      return next
    }
    return this.pullChunk()
  }

  private async peekChunk(): Promise<DecodedPcmChunk | null> {
    if (!this.lookaheadLoaded) {
      this.lookahead = await this.pullChunk()
      this.lookaheadLoaded = true
    }
    return this.lookahead
  }

  private sampleAt(
    chunk: DecodedPcmChunk,
    outputChannel: number,
    frame: number,
  ): number {
    const channel = (index: number): number =>
      chunk.channels[index]?.[frame] ?? 0
    const count = chunk.channels.length
    if (count === 1) return channel(0)
    if (count === 2) return channel(outputChannel)

    // Web Audio's canonical layouts: 3=L/R/C, 4=L/R/SL/SR,
    // 5=L/R/C/SL/SR, 6=L/R/C/LFE/SL/SR. Extra discrete channels are
    // folded alternately at -6 dB rather than making export fail.
    let value = channel(outputChannel)
    if (count === 3) {
      value += channel(2) * Math.SQRT1_2
    } else if (count === 4) {
      value += channel(outputChannel + 2) * Math.SQRT1_2
    } else if (count === 5) {
      value += channel(2) * Math.SQRT1_2
      value += channel(outputChannel + 3) * Math.SQRT1_2
    } else {
      value += channel(2) * Math.SQRT1_2
      value += channel(3) * 0.5
      value += channel(outputChannel + 4) * Math.SQRT1_2
      for (let index = 6 + outputChannel; index < count; index += 2) {
        value += channel(index) * 0.5
      }
    }
    return value
  }

  async read(sampleCount: number): Promise<readonly Float32Array[]> {
    if (this.closePromise) throw new Error('Audio clip reader is closed')
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
      throw new RangeError('Audio read size must be a positive safe integer')
    }

    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)
    const epsilon = 1e-10

    for (let outputIndex = 0; outputIndex < sampleCount; outputIndex++) {
      const sourceSample = this.nextSourceSample++
      if (sourceSample >= this.request.endSample) {
        this.nextSourceSample += sampleCount - outputIndex - 1
        break
      }
      const sourceTime = sourceSample / this.request.sampleRate

      while (true) {
        if (!this.current) {
          if (this.iteratorDone) break
          this.current = await this.shiftChunk()
        }
        if (!this.current) break
        if (sourceTime < pcmChunkEnd(this.current) - epsilon) break
        this.current = await this.shiftChunk()
      }

      const chunk = this.current
      if (!chunk) {
        if (this.iteratorDone) {
          this.nextSourceSample += sampleCount - outputIndex - 1
          break
        }
        continue
      }
      if (sourceTime < chunk.timestampSec - epsilon) continue

      const position = Math.max(
        0,
        (sourceTime - chunk.timestampSec) * chunk.sampleRate,
      )
      const lower = Math.min(
        chunk.frameCount - 1,
        Math.floor(position),
      )
      const fraction = Math.max(0, Math.min(1, position - lower))
      let nextChunk: DecodedPcmChunk | null = null
      if (lower + 1 >= chunk.frameCount && fraction > epsilon) {
        nextChunk = await this.peekChunk()
      }

      for (let channel = 0; channel < EXPORT_AUDIO_CHANNELS; channel++) {
        const first = this.sampleAt(chunk, channel, lower)
        let second = first
        if (lower + 1 < chunk.frameCount) {
          second = this.sampleAt(chunk, channel, lower + 1)
        } else if (nextChunk) {
          const gap = Math.abs(nextChunk.timestampSec - pcmChunkEnd(chunk))
          second =
            gap <= 1.5 / chunk.sampleRate
              ? this.sampleAt(nextChunk, channel, 0)
              : 0
        }
        const value = first + (second - first) * fraction
        if (channel === 0) left[outputIndex] = value
        else right[outputIndex] = value
      }
    }

    return [left, right]
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      try {
        if (!this.iteratorDone) {
          this.iteratorDone = true
          await this.iterator.return()
        }
      } finally {
        this.current = null
        this.lookahead = null
        this.onClosed()
      }
    })()
    return this.closePromise
  }
}

/** Creates lazy, sequential Mediabunny audio decoders for timeline clips. */
export function createMediabunnyExportAudioSource(
  resolveAsset: ExportAssetResolver,
): ExportAudioMediaSource {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }

  const sessions = new Map<AssetId, Promise<DecodedAudioAsset>>()
  const openInputs = new Set<Input>()
  const readers = new Set<MediabunnyAudioClipReader>()
  let closed = false
  let closePromise: Promise<void> | null = null

  const openAsset = (assetId: AssetId): Promise<DecodedAudioAsset> => {
    const cached = sessions.get(assetId)
    if (cached) return cached

    const pending = (async (): Promise<DecodedAudioAsset> => {
      if (closed) throw new Error('Export audio source is closed')
      let resolved: ResolvedExportAsset
      try {
        resolved = await resolveAsset(assetId)
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      const { blob } = resolved
      if (closed) throw new Error('Export audio source is closed')

      let input: Input
      try {
        input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        })
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      openInputs.add(input)
      try {
        let track: Awaited<ReturnType<Input['getPrimaryAudioTrack']>>
        try {
          track = await input.getPrimaryAudioTrack()
        } catch (cause) {
          throw exportAssetError(assetId, 'audio', 'decode-failed', cause)
        }
        if (!track) {
          throw exportAssetError(
            assetId,
            'audio',
            'decode-failed',
            new Error(`Export asset "${assetId}" has no audio track`),
          )
        }
        let support: Awaited<ReturnType<typeof ensureMediaDecoderSupport>>
        try {
          const codec = await track.getCodec()
          const configuration = await track.getDecoderConfig()
          support = await ensureMediaDecoderSupport({
            codec,
            canDecode: () => track.canDecode(),
            configuration,
            trackKind: 'audio',
            sourceId: assetId,
            boundary: 'export-audio',
            policy: 'revalidate',
            budget: refineAudioDecoderBudget(
              resolved.budget,
              blob.size,
              configuration,
            ),
          })
        } catch (cause) {
          throw exportAssetError(assetId, 'audio', 'decode-failed', cause)
        }
        if (!support.decodable) {
          throw exportAssetError(
            assetId,
            'audio',
            support.failure.reason,
            new Error(
              `Export asset "${assetId}" audio cannot be decoded: ${support.failure.detail}`,
            ),
          )
        }
        let channelCount: number
        try {
          channelCount = await track.getNumberOfChannels()
        } catch (cause) {
          throw exportAssetError(assetId, 'audio', 'decode-failed', cause)
        }
        if (
          !Number.isSafeInteger(channelCount) ||
          channelCount <= 0 ||
          channelCount > 32
        ) {
          throw exportAssetError(
            assetId,
            'audio',
            'decode-failed',
            new Error(
              `Export asset "${assetId}" has an invalid audio channel count`,
            ),
          )
        }
        if (closed) throw new Error('Export audio source is closed')
        let sink: AudioSampleSink
        try {
          sink = new AudioSampleSink(track)
        } catch (cause) {
          throw exportAssetError(assetId, 'audio', 'decode-failed', cause)
        }
        return { input, sink }
      } catch (cause) {
        try {
          input.dispose()
        } catch {
          // Preserve the track/decode failure over disposal cleanup.
        }
        openInputs.delete(input)
        throw cause
      }
    })()
    sessions.set(assetId, pending)
    return pending
  }

  const openClip = async (
    request: ExportAudioClipRequest,
  ): Promise<ExportAudioClipReader> => {
    if (closed) throw new Error('Export audio source is closed')
    if (
      !Number.isSafeInteger(request.startSample) ||
      !Number.isSafeInteger(request.endSample) ||
      request.startSample < 0 ||
      request.endSample < request.startSample
    ) {
      throw new RangeError('Export audio clip has an invalid sample range')
    }
    if (!Number.isSafeInteger(request.sampleRate) || request.sampleRate <= 0) {
      throw new RangeError('Export audio clip has an invalid sample rate')
    }
    if (request.channelCount !== EXPORT_AUDIO_CHANNELS) {
      throw new RangeError('Mediabunny export audio must be stereo')
    }

    const asset = await openAsset(request.assetId)
    if (closed) throw new Error('Export audio source is closed')
    let iterator: ReturnType<AudioSampleSink['samples']>
    try {
      iterator = asset.sink.samples(
        request.startSample / request.sampleRate,
      )
    } catch (cause) {
      throw exportAssetError(
        request.assetId,
        'audio',
        'decode-failed',
        cause,
      )
    }
    let reader!: MediabunnyAudioClipReader
    reader = new MediabunnyAudioClipReader(iterator, request, () => {
      readers.delete(reader)
    })
    readers.add(reader)
    return reader
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      let failure: unknown
      for (const reader of [...readers]) {
        try {
          await reader.close()
        } catch (cause) {
          failure ??= cause
        }
      }

      const settled = await Promise.allSettled(sessions.values())
      for (const input of openInputs) {
        try {
          input.dispose()
        } catch (cause) {
          failure ??= cause
        }
      }
      openInputs.clear()
      // Observe every lazy-session rejection before returning cleanup status.
      for (const entry of settled) {
        if (entry.status === 'rejected') failure ??= entry.reason
      }
      if (failure !== undefined) throw failure
    })()
    return closePromise
  }

  return { openClip, close }
}

function assertVideoSinkInputs(
  doc: TimelineDoc,
  settings: ExportSettings,
): number {
  if (settings.format !== 'mp4' || settings.videoCodec !== 'avc') {
    throw new TypeError('Mediabunny video export supports MP4/AVC only')
  }
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.width) || doc.width <= 0) {
    throw new RangeError('Export width must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.height) || doc.height <= 0) {
    throw new RangeError('Export height must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.audioSampleRate) || doc.audioSampleRate <= 0) {
    throw new RangeError('Export audio sample rate must be a positive safe integer')
  }
  framesToSeconds(1, doc.frameRate)
  return doc.frameRate.num / doc.frameRate.den
}

export const EXPORT_AUDIO_CODEC = 'aac'
export const EXPORT_AUDIO_BITRATE = 192_000

async function cancelSetup(
  output: Output,
  mixer: TimelineAudioMixer | null,
  primary: unknown,
): Promise<never> {
  try {
    await output.cancel()
  } catch {
    // The setup failure remains primary; Output owns its own cancel promise.
  }
  try {
    await mixer?.close()
  } catch {
    // The setup failure remains primary over decoder cleanup.
  }
  throw primary
}

function interleaveAudioBlock(block: MixedAudioBlock): Float32Array {
  const data = new Float32Array(block.sampleCount * EXPORT_AUDIO_CHANNELS)
  for (let frame = 0; frame < block.sampleCount; frame++) {
    data[frame * EXPORT_AUDIO_CHANNELS] = block.channels[0][frame]
    data[frame * EXPORT_AUDIO_CHANNELS + 1] = block.channels[1][frame]
  }
  return data
}

function trimAacPaddingPacket(
  packet: EncodedPacket,
  targetSamples: number,
  sampleRate: number,
): void {
  const packetStart = Math.round(packet.timestamp * sampleRate)
  const packetSamples = Math.round(packet.duration * sampleRate)
  const remaining = Math.max(0, targetSamples - packetStart)
  if (packetSamples <= remaining) return

  // Mediabunny 1.50.3 invokes onEncodedPacket synchronously immediately
  // before handing this same object to the muxer. AAC encodes whole 1024-
  // sample packets; narrowing the final packet's container duration removes
  // codec padding without changing the exact PCM samples submitted.
  ;(packet as unknown as { duration: number }).duration =
    remaining / sampleRate
}

/** Creates and starts the real Mediabunny AVC/AAC MP4 sink. */
export async function createMediabunnyExportSink(
  doc: TimelineDoc,
  settings: ExportSettings,
  resolveAsset: ExportAssetResolver,
): Promise<ExportVideoSink> {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  const frameRate = assertVideoSinkInputs(doc, settings)
  const hasAudio = doc.tracks.some(
    (track) => track.kind === 'audio' && track.clips.length > 0,
  )
  const expectedFrames = docDurationFrames(doc)
  const expectedAudioSamples = hasAudio
    ? audioSampleBoundary(expectedFrames, doc)
    : 0

  const [videoSupported, audioSupported] = await Promise.all([
    canEncodeVideo('avc', {
      width: doc.width,
      height: doc.height,
      bitrate: settings.videoBitrate,
    }),
    hasAudio
      ? canEncodeAudio(EXPORT_AUDIO_CODEC, {
          numberOfChannels: EXPORT_AUDIO_CHANNELS,
          sampleRate: doc.audioSampleRate,
          bitrate: EXPORT_AUDIO_BITRATE,
        })
      : Promise.resolve(true),
  ])
  if (!videoSupported) {
    throw new Error(
      `AVC encoding is not supported for ${doc.width}x${doc.height} ` +
        `at ${settings.videoBitrate} bps`,
    )
  }
  if (!audioSupported) {
    throw new Error(
      `AAC encoding is not supported for stereo ${doc.audioSampleRate} Hz ` +
        `at ${EXPORT_AUDIO_BITRATE} bps`,
    )
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const canvas = new OffscreenCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create the export 2D context')
  }

  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  })
  let source: CanvasSource
  let audioSource: AudioSampleSource | null = null
  let mixer: TimelineAudioMixer | null = null
  try {
    mixer = hasAudio
      ? new TimelineAudioMixer(
          doc,
          createMediabunnyExportAudioSource(resolveAsset),
        )
      : null
    source = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: settings.videoBitrate,
    })
    output.addVideoTrack(source, { frameRate })
    if (hasAudio) {
      audioSource = new AudioSampleSource({
        codec: EXPORT_AUDIO_CODEC,
        bitrate: EXPORT_AUDIO_BITRATE,
        onEncodedPacket: (packet) => {
          trimAacPaddingPacket(
            packet,
            expectedAudioSamples,
            doc.audioSampleRate,
          )
        },
      })
      output.addAudioTrack(audioSource)
    }
    await output.start()
  } catch (cause) {
    return cancelSetup(output, mixer, cause)
  }

  type SinkState =
    | 'open'
    | 'finalizing'
    | 'finalized'
    | 'canceling'
    | 'canceled'
  let state: SinkState = 'open'
  let cancelPromise: Promise<void> | null = null
  let nextFrame = 0

  const cancel = (): Promise<void> => {
    if (state === 'finalized' || state === 'canceled') {
      return Promise.resolve()
    }
    if (cancelPromise) return cancelPromise
    state = 'canceling'
    cancelPromise = (async () => {
      let failure: unknown
      try {
        await output.cancel()
      } catch (cause) {
        failure = cause
      } finally {
        try {
          await mixer?.close()
        } catch (cause) {
          failure ??= cause
        } finally {
          state = 'canceled'
        }
      }
      if (failure !== undefined) throw failure
    })()
    return cancelPromise
  }

  const failAfterCancel = async (primary: unknown): Promise<never> => {
    try {
      await cancel()
    } catch {
      // Preserve the encode/finalize failure over cleanup failure.
    }
    throw primary
  }

  const addFrame = async (
    timestampSec: number,
    durationSec: number,
  ): Promise<void> => {
    if (state !== 'open') throw new Error('Export sink is closed')
    try {
      const videoWrite = source.add(timestampSec, durationSec)
      const audioWrite =
        mixer && audioSource
          ? mixer.writeFrame(nextFrame, async (block) => {
              const sample = new AudioSample({
                data: interleaveAudioBlock(block),
                format: 'f32',
                numberOfChannels: EXPORT_AUDIO_CHANNELS,
                sampleRate: doc.audioSampleRate,
                timestamp: block.startSample / doc.audioSampleRate,
              })
              try {
                await audioSource.add(sample)
              } finally {
                sample.close()
              }
            })
          : Promise.resolve()
      const writes = await Promise.allSettled([videoWrite, audioWrite])
      const failure = writes.find(
        (entry): entry is PromiseRejectedResult =>
          entry.status === 'rejected',
      )
      if (failure) throw failure.reason
      nextFrame++
    } catch (cause) {
      return failAfterCancel(cause)
    }
  }

  const finalize = async (): Promise<ExportResult> => {
    if (state !== 'open') throw new Error('Export sink is closed')
    if (nextFrame !== expectedFrames) {
      return failAfterCancel(
        new Error(
          `Export sink expected ${expectedFrames} frames, got ${nextFrame}`,
        ),
      )
    }
    state = 'finalizing'
    try {
      await mixer?.close()
      source.close()
      audioSource?.close()
      await output.finalize()
    } catch (cause) {
      return failAfterCancel(cause)
    }

    state = 'finalized'
    if (target.buffer === null) {
      throw new Error('Mediabunny finalized without an output buffer')
    }
    return { buffer: target.buffer, mimeType: 'video/mp4' }
  }

  return {
    ctx: context as Composite2D,
    addFrame,
    finalize,
    cancel,
  }
}

/** Production dependencies for exportTimeline, closed over the Blob resolver. */
export function createMediabunnyExportDeps(
  resolveAsset: ExportAssetResolver,
): ExportDeps {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  return {
    composite: compositeFrame,
    createVideoSink: (doc, settings) =>
      createMediabunnyExportSink(doc, settings, resolveAsset),
  }
}
