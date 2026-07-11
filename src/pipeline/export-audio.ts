/**
 * pipeline/export-audio.ts — bounded, integer-sample timeline audio mixing.
 *
 * The mixer advances in document-frame order, but every audio boundary is
 * derived independently with exact integer arithmetic. Browser decoding and
 * encoding stay injected so selection, gain, ownership, and sample-count
 * behavior remain testable without WebCodecs.
 */

import type { AssetId, Clip, ClipId, TimelineDoc } from '../domain/schema'
import {
  activeClipAt,
  audibleTracks,
  docDurationFrames,
} from '../domain/selectors'

export const EXPORT_AUDIO_CHANNELS = 2
export const EXPORT_AUDIO_BLOCK_SAMPLES = 1024

export interface ExportAudioClipRequest {
  clipId: ClipId
  assetId: AssetId
  startSample: number
  endSample: number
  sampleRate: number
  channelCount: typeof EXPORT_AUDIO_CHANNELS
}

export interface ExportAudioClipReader {
  read(sampleCount: number): Promise<readonly Float32Array[]>
  close(): void | Promise<void>
}

export interface ExportAudioMediaSource {
  openClip(request: ExportAudioClipRequest): Promise<ExportAudioClipReader>
  close(): void | Promise<void>
}

export interface MixedAudioBlock {
  startSample: number
  sampleCount: number
  channels: readonly [Float32Array, Float32Array]
}

export type MixedAudioBlockWriter = (
  block: MixedAudioBlock,
) => Promise<void>

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

/**
 * Map one absolute document-frame boundary onto the document audio grid.
 * Positive half-sample ties round upward, matching Math.round without ever
 * introducing floating-point accumulation.
 */
export function audioSampleBoundary(
  frame: number,
  doc: TimelineDoc,
): number {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError('Audio boundary frame must be a non-negative safe integer')
  }
  assertPositiveSafeInteger(doc.frameRate.num, 'Frame-rate numerator')
  assertPositiveSafeInteger(doc.frameRate.den, 'Frame-rate denominator')
  assertPositiveSafeInteger(doc.audioSampleRate, 'Audio sample rate')

  const divisor = BigInt(doc.frameRate.num)
  const numerator =
    BigInt(frame) *
    BigInt(doc.frameRate.den) *
    BigInt(doc.audioSampleRate)
  const rounded = (numerator + divisor / 2n) / divisor
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Audio sample boundary exceeds the safe integer range')
  }
  return Number(rounded)
}

interface ActiveReader {
  clip: Clip
  reader: ExportAudioClipReader
}

function timelineEndFrame(clip: Clip): number {
  const end =
    clip.timelineRange.startFrame + clip.timelineRange.durationFrames
  if (!Number.isSafeInteger(end) || end < 0) {
    throw new RangeError(`Clip "${clip.id}" has an invalid timeline range`)
  }
  return end
}

function assertVolume(clip: Clip): number {
  if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 2) {
    throw new RangeError(`Clip "${clip.id}" has an invalid volume`)
  }
  return clip.volume
}

function assertReaderBlock(
  clipId: ClipId,
  channels: readonly Float32Array[],
  sampleCount: number,
): asserts channels is readonly [Float32Array, Float32Array] {
  if (
    channels.length !== EXPORT_AUDIO_CHANNELS ||
    !(channels[0] instanceof Float32Array) ||
    !(channels[1] instanceof Float32Array) ||
    channels[0].length !== sampleCount ||
    channels[1].length !== sampleCount
  ) {
    throw new Error(
      `Audio reader for clip "${clipId}" returned an invalid block`,
    )
  }
}

async function closeReaders(
  readers: Iterable<ExportAudioClipReader>,
): Promise<void> {
  let failure: unknown
  for (const reader of readers) {
    try {
      await reader.close()
    } catch (cause) {
      failure ??= cause
    }
  }
  if (failure !== undefined) throw failure
}

/**
 * Stateful sequential mixer. Its retained decoded state is bounded by the
 * number of simultaneously audible tracks; emitted PCM is capped at one
 * 1024-sample stereo block and released after each awaited writer call.
 */
export class TimelineAudioMixer {
  readonly hasAudio: boolean

  private readonly doc: TimelineDoc
  private readonly source: ExportAudioMediaSource
  private readonly durationFrames: number
  private readonly mixTracks: ReturnType<typeof audibleTracks>
  private readonly readers = new Map<ClipId, ActiveReader>()
  private nextFrame = 0
  private closePromise: Promise<void> | null = null

  constructor(doc: TimelineDoc, source: ExportAudioMediaSource) {
    this.doc = doc
    this.source = source
    this.durationFrames = docDurationFrames(doc)
    this.mixTracks = audibleTracks(doc)
    this.hasAudio = doc.tracks.some(
      (track) => track.kind === 'audio' && track.clips.length > 0,
    )

    audioSampleBoundary(0, doc)
    audioSampleBoundary(this.durationFrames, doc)
  }

  private activeClips(frame: number): Clip[] {
    const clips: Clip[] = []
    for (const track of this.mixTracks) {
      const clip = activeClipAt(track, frame)
      if (!clip) continue
      const volume = assertVolume(clip)
      if (volume > 0) clips.push(clip)
    }
    return clips
  }

  private async reconcileReaders(clips: readonly Clip[]): Promise<void> {
    const wanted = new Set(clips.map((clip) => clip.id))
    const stale: ExportAudioClipReader[] = []
    for (const [clipId, active] of this.readers) {
      if (wanted.has(clipId)) continue
      this.readers.delete(clipId)
      stale.push(active.reader)
    }
    await closeReaders(stale)

    for (const clip of clips) {
      if (this.readers.has(clip.id)) continue
      const sourceStartSample = audioSampleBoundary(
        clip.sourceRange.startFrame,
        this.doc,
      )
      const timelineStartSample = audioSampleBoundary(
        clip.timelineRange.startFrame,
        this.doc,
      )
      const timelineEndSample = audioSampleBoundary(
        timelineEndFrame(clip),
        this.doc,
      )
      const sourceEndSample =
        sourceStartSample + (timelineEndSample - timelineStartSample)
      if (!Number.isSafeInteger(sourceEndSample)) {
        throw new RangeError(`Clip "${clip.id}" audio range is too large`)
      }
      const reader = await this.source.openClip({
        clipId: clip.id,
        assetId: clip.assetId,
        startSample: sourceStartSample,
        endSample: sourceEndSample,
        sampleRate: this.doc.audioSampleRate,
        channelCount: EXPORT_AUDIO_CHANNELS,
      })
      this.readers.set(clip.id, { clip, reader })
    }
  }

  async writeFrame(
    docFrame: number,
    writeBlock: MixedAudioBlockWriter,
  ): Promise<void> {
    if (this.closePromise) throw new Error('Timeline audio mixer is closed')
    if (docFrame !== this.nextFrame) {
      throw new Error(
        `Timeline audio mixer expected frame ${this.nextFrame}, got ${docFrame}`,
      )
    }
    if (docFrame < 0 || docFrame >= this.durationFrames) {
      throw new RangeError('Audio frame is outside the export timeline')
    }
    if (typeof writeBlock !== 'function') {
      throw new TypeError('Audio block writer must be a function')
    }

    const clips = this.activeClips(docFrame)
    await this.reconcileReaders(clips)

    const frameStart = audioSampleBoundary(docFrame, this.doc)
    const frameEnd = audioSampleBoundary(docFrame + 1, this.doc)
    let blockStart = frameStart

    while (blockStart < frameEnd) {
      const sampleCount = Math.min(
        EXPORT_AUDIO_BLOCK_SAMPLES,
        frameEnd - blockStart,
      )
      const settled = await Promise.allSettled(
        clips.map(async (clip) => {
          const active = this.readers.get(clip.id)
          if (!active) {
            throw new Error(`Audio reader for clip "${clip.id}" is missing`)
          }
          const channels = await active.reader.read(sampleCount)
          assertReaderBlock(clip.id, channels, sampleCount)
          return { channels, volume: clip.volume }
        }),
      )
      const failed = settled.find(
        (entry): entry is PromiseRejectedResult =>
          entry.status === 'rejected',
      )
      if (failed) throw failed.reason
      const decoded = settled.map((entry) => {
        if (entry.status === 'rejected') throw entry.reason
        return entry.value
      })

      const left = new Float32Array(sampleCount)
      const right = new Float32Array(sampleCount)
      for (const input of decoded) {
        for (let i = 0; i < sampleCount; i++) {
          const l = input.channels[0][i]
          const r = input.channels[1][i]
          if (!Number.isFinite(l) || !Number.isFinite(r)) {
            throw new Error('Decoded audio contains a non-finite sample')
          }
          left[i] += l * input.volume
          right[i] += r * input.volume
        }
      }
      for (let i = 0; i < sampleCount; i++) {
        left[i] = Math.max(-1, Math.min(1, left[i]))
        right[i] = Math.max(-1, Math.min(1, right[i]))
      }

      await writeBlock({
        startSample: blockStart,
        sampleCount,
        channels: [left, right],
      })
      blockStart += sampleCount
    }

    this.nextFrame++
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      const readers = [...this.readers.values()].map((active) => active.reader)
      this.readers.clear()

      let failure: unknown
      try {
        await closeReaders(readers)
      } catch (cause) {
        failure = cause
      }
      try {
        await this.source.close()
      } catch (cause) {
        failure ??= cause
      }
      if (failure !== undefined) throw failure
    })()
    return this.closePromise
  }
}
