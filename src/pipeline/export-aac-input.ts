/**
 * Encoder-side audio input shared by the A/V sink and audio-only delivery.
 *
 * Chrome's native AAC adapter needs two complete 1024-sample AAC frames
 * before it can flush reliably. Timeline mixing is intentionally aligned to
 * video frames, so high-frame-rate projects can produce smaller PCM chunks.
 * This bounded assembler preserves every scheduled sample while presenting a
 * stable AAC-shaped stream to the encoder.
 */

import {
  AudioSample,
  type AudioSampleSource,
  type EncodedPacket,
} from 'mediabunny'
import { EXPORT_AUDIO_BLOCK_SAMPLES, type MixedAudioBlock } from './export-audio'
import { requireNonNegativeSafeInteger } from '../domain/numeric'

export const AAC_ENCODER_STARTUP_SAMPLES = EXPORT_AUDIO_BLOCK_SAMPLES * 2

export interface AacInputChunk {
  readonly startSample: number
  readonly sampleCount: number
  readonly data: Float32Array
}

export type AacInputWriter = (chunk: AacInputChunk) => Promise<void>

export class AacInputAssembler {
  private readonly channelCount: 1 | 2
  private readonly pending: Float32Array
  private pendingStartSample = 0
  private pendingSampleCount = 0
  private nextInputSample: number | null = null
  private encoderStarted = false
  private flushed = false

  constructor(channelCount: 1 | 2) {
    this.channelCount = channelCount
    this.pending = new Float32Array(
      AAC_ENCODER_STARTUP_SAMPLES * channelCount,
    )
  }

  private async emit(sampleCount: number, write: AacInputWriter): Promise<void> {
    const dataLength = sampleCount * this.channelCount
    await write({
      startSample: this.pendingStartSample,
      sampleCount,
      data: this.pending.slice(0, dataLength),
    })
    this.pendingSampleCount = 0
    this.pendingStartSample += sampleCount
  }

  async add(chunk: AacInputChunk, write: AacInputWriter): Promise<void> {
    if (this.flushed) throw new Error('AAC input assembler is flushed')
    requireNonNegativeSafeInteger(chunk.startSample, 'AAC chunk start')
    if (!Number.isSafeInteger(chunk.sampleCount) || chunk.sampleCount <= 0) {
      throw new RangeError('AAC chunk size must be a positive safe integer')
    }
    if (chunk.data.length !== chunk.sampleCount * this.channelCount) {
      throw new RangeError('AAC chunk data length does not match its shape')
    }
    if (this.nextInputSample === null) {
      this.nextInputSample = chunk.startSample
      this.pendingStartSample = chunk.startSample
    }
    if (chunk.startSample !== this.nextInputSample) {
      throw new RangeError('AAC input chunks must be sample-contiguous')
    }
    this.nextInputSample += chunk.sampleCount

    let sourceOffset = 0
    while (sourceOffset < chunk.sampleCount) {
      const emitSize = this.encoderStarted
        ? EXPORT_AUDIO_BLOCK_SAMPLES
        : AAC_ENCODER_STARTUP_SAMPLES
      const copyCount = Math.min(
        emitSize - this.pendingSampleCount,
        chunk.sampleCount - sourceOffset,
      )
      const sourceStart = sourceOffset * this.channelCount
      const sourceEnd = (sourceOffset + copyCount) * this.channelCount
      this.pending.set(
        chunk.data.subarray(sourceStart, sourceEnd),
        this.pendingSampleCount * this.channelCount,
      )
      this.pendingSampleCount += copyCount
      sourceOffset += copyCount

      if (this.pendingSampleCount === emitSize) {
        await this.emit(emitSize, write)
        this.encoderStarted = true
      }
    }
  }

  async flush(write: AacInputWriter): Promise<void> {
    if (this.flushed) return
    if (this.pendingSampleCount > 0) {
      const emitSize = this.encoderStarted
        ? this.pendingSampleCount
        : AAC_ENCODER_STARTUP_SAMPLES
      await this.emit(emitSize, write)
    }
    this.flushed = true
  }
}

/** Interleave one mixed stereo bus block into the encoder's channel layout. */
export function interleaveAudioBlock(
  block: MixedAudioBlock,
  channelCount: 1 | 2,
): Float32Array {
  const data = new Float32Array(block.sampleCount * channelCount)
  for (let frame = 0; frame < block.sampleCount; frame++) {
    if (channelCount === 1) {
      // The internal mix bus stays stereo. An arithmetic mean preserves a
      // duplicated mono source's level and cannot clip two bounded channels.
      data[frame] = (block.channels[0][frame]! + block.channels[1][frame]!) / 2
    } else {
      data[frame * channelCount] = block.channels[0][frame]!
      data[frame * channelCount + 1] = block.channels[1][frame]!
    }
  }
  return data
}

/**
 * AAC encodes whole 1024-sample packets. Narrow the final packet's container
 * duration so the track ends at the exact rational sample boundary.
 */
export function trimAacPaddingPacket(
  packet: EncodedPacket,
  targetSamples: number,
  sampleRate: number,
): void {
  const packetStart = Math.round(packet.timestamp * sampleRate)
  const packetSamples = Math.round(packet.duration * sampleRate)
  const remaining = Math.max(0, targetSamples - packetStart)
  if (packetSamples <= remaining) return

  // Mediabunny 1.50.9 invokes onEncodedPacket synchronously immediately
  // before handing this same object to the muxer. Narrowing the final
  // packet's duration removes codec padding without changing the exact PCM
  // samples submitted.
  ;(packet as unknown as { duration: number }).duration =
    remaining / sampleRate
}

/** Submit one interleaved chunk to the encoder; the sample closes in finally. */
export async function addInterleavedAudioChunk(
  source: AudioSampleSource,
  chunk: AacInputChunk,
  channelCount: 1 | 2,
  sampleRate: number,
): Promise<void> {
  const sample = new AudioSample({
    data: chunk.data,
    format: 'f32',
    numberOfChannels: channelCount,
    sampleRate,
    timestamp: chunk.startSample / sampleRate,
  })
  try {
    await source.add(sample)
  } finally {
    sample.close()
  }
}
