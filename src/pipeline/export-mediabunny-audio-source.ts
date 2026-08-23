/** Sequential Mediabunny PCM source for timeline export. */

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  BlobSource,
  Input,
} from 'mediabunny'
import {
  ensureMediaDecoderSupport,
  refineAudioDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { AssetId } from '../domain/schema'
import { foldDecodedFrameToStereo } from '../domain/audioChannelMix'
import {
  EXPORT_AUDIO_CHANNELS,
  type ExportAudioClipReader,
  type ExportAudioClipRequest,
  type ExportAudioMediaSource,
} from './export-audio'
import {
  exportAssetError,
  type ExportAssetResolver,
  type ResolvedExportAsset,
} from './export-mediabunny-common'

/**
 * Exact crossfade handles may zero-fill this many decoded samples of leading
 * encoder/decoder priming. HE-AAC frames and AAC encoder delay stay within
 * 2048–2112 samples; 4096 leaves one extra frame of seek alignment. A later
 * first packet is incomplete media, not priming.
 */
const MAX_EXPORT_AUDIO_PRIMING_SAMPLES = 4096

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
  private heardDecodedPcm = false
  private closePromise: Promise<void> | null = null

  private incompleteSource(sample: number, detail: string): MediaAssetRuntimeError {
    return exportAssetError(
      this.request.assetId,
      'audio',
      'decode-failed',
      new Error(
        `Export audio clip "${this.request.clipId}" is missing exact sample `
        + `${sample}: ${detail}`,
      ),
    )
  }

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
    const folded = foldDecodedFrameToStereo(chunk.channels, frame)
    return outputChannel === 1 ? folded[1] : folded[0]
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
          if (this.iteratorDone) {
            if (this.request.requireComplete) {
              throw this.incompleteSource(sourceSample, 'source ended early')
            }
            break
          }
          this.current = await this.shiftChunk()
        }
        if (!this.current) {
          if (this.request.requireComplete) {
            throw this.incompleteSource(sourceSample, 'source ended early')
          }
          break
        }
        if (sourceTime < pcmChunkEnd(this.current) - epsilon) break
        this.current = await this.shiftChunk()
      }

      const chunk = this.current
      if (!chunk) {
        if (this.iteratorDone) {
          if (this.request.requireComplete) {
            throw this.incompleteSource(sourceSample, 'source ended early')
          }
          this.nextSourceSample += sampleCount - outputIndex - 1
          break
        }
        continue
      }
      if (sourceTime < chunk.timestampSec - epsilon) {
        if (this.request.requireComplete && this.heardDecodedPcm) {
          throw this.incompleteSource(sourceSample, 'decoded PCM has a gap')
        }
        if (this.request.requireComplete) {
          const requestedStartSec =
            this.request.startSample / this.request.sampleRate
          const maxPrimingSec =
            MAX_EXPORT_AUDIO_PRIMING_SAMPLES / chunk.sampleRate
          if (
            chunk.timestampSec - requestedStartSec
            > maxPrimingSec + epsilon
          ) {
            throw this.incompleteSource(
              sourceSample,
              'decoded PCM starts after decoder priming',
            )
          }
        }
        continue
      }

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
        if (!nextChunk && this.request.requireComplete) {
          throw this.incompleteSource(
            sourceSample,
            'the final decoded sample cannot be interpolated',
          )
        }
      }

      for (let channel = 0; channel < EXPORT_AUDIO_CHANNELS; channel++) {
        const first = this.sampleAt(chunk, channel, lower)
        let second = first
        if (lower + 1 < chunk.frameCount) {
          second = this.sampleAt(chunk, channel, lower + 1)
        } else if (nextChunk) {
          const gap = Math.abs(nextChunk.timestampSec - pcmChunkEnd(chunk))
          if (
            this.request.requireComplete
            && gap > 1.5 / chunk.sampleRate
          ) {
            throw this.incompleteSource(
              sourceSample,
              'decoded PCM has a discontinuity',
            )
          }
          second =
            gap <= 1.5 / chunk.sampleRate
              ? this.sampleAt(nextChunk, channel, 0)
              : 0
        }
        const value = first + (second - first) * fraction
        if (channel === 0) left[outputIndex] = value
        else right[outputIndex] = value
      }
      this.heardDecodedPcm = true
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
