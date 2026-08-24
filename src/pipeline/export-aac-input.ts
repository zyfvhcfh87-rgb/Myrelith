/**
 * Chrome's native AAC adapter needs two complete 1024-sample AAC frames
 * before it can flush reliably. Timeline mixing is intentionally aligned to
 * video frames, so high-frame-rate projects can produce smaller PCM chunks.
 * This bounded assembler preserves every scheduled sample while presenting a
 * stable AAC-shaped stream to the encoder.
 */

import { EXPORT_AUDIO_BLOCK_SAMPLES } from './export-audio'

export const AAC_ENCODER_STARTUP_SAMPLES = EXPORT_AUDIO_BLOCK_SAMPLES * 2

export interface AacInputChunk {
  readonly startSample: number
  readonly sampleCount: number
  readonly data: Float32Array
}

export type AacInputWriter = (chunk: AacInputChunk) => Promise<void>

function assertSampleIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

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
    assertSampleIndex(chunk.startSample, 'AAC chunk start')
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
