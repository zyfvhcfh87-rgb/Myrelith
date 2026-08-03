/**
 * pipeline/export-audio.ts — bounded, integer-sample timeline audio mixing.
 *
 * The mixer advances in document-frame order, but every audio boundary is
 * derived independently with exact integer arithmetic. Browser decoding and
 * encoding stay injected so selection, gain, ownership, and sample-count
 * behavior remain testable without WebCodecs.
 */

import type { AssetId, ClipId, TimelineDoc } from '../domain/schema'
import {
  createTimelineAudioMixPlan,
  crossfadeAudioGain,
  type TimelineAudioClipPlan,
  type TimelineAudioEnvelope,
} from '../domain/audioMixPlan'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import { docDurationFrames } from '../domain/selectors'

export const EXPORT_AUDIO_CHANNELS = 2
export const EXPORT_AUDIO_BLOCK_SAMPLES = 1024

export interface ExportAudioClipRequest {
  clipId: ClipId
  assetId: AssetId
  startSample: number
  endSample: number
  sampleRate: number
  channelCount: typeof EXPORT_AUDIO_CHANNELS
  /** Crossfade handle legs must never freeze or zero-fill missing PCM. */
  requireComplete?: true
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

/**
 * Quantize the signed source-minus-timeline phase once per clip. The
 * antisymmetric tie rule is deliberate: a negative phase must exactly cancel
 * the matching positive timeline boundary. Because a razor split or start
 * trim advances both frame starts equally, this phase remains unchanged and
 * the resulting source sample stream stays continuous across the edit.
 */
function audioSamplePhaseOffset(
  sourceFrame: number,
  timelineFrame: number,
  doc: TimelineDoc,
): number {
  if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0) {
    throw new RangeError(
      'Audio source frame must be a non-negative safe integer',
    )
  }
  if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) {
    throw new RangeError(
      'Audio timeline frame must be a non-negative safe integer',
    )
  }
  assertPositiveSafeInteger(doc.frameRate.num, 'Frame-rate numerator')
  assertPositiveSafeInteger(doc.frameRate.den, 'Frame-rate denominator')
  assertPositiveSafeInteger(doc.audioSampleRate, 'Audio sample rate')

  const divisor = BigInt(doc.frameRate.num)
  const numerator =
    (BigInt(sourceFrame) - BigInt(timelineFrame)) *
    BigInt(doc.frameRate.den) *
    BigInt(doc.audioSampleRate)
  const magnitude = numerator < 0n ? -numerator : numerator
  const roundedMagnitude = (magnitude + divisor / 2n) / divisor
  if (roundedMagnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Audio sample phase exceeds the safe integer range')
  }
  return Number(numerator < 0n ? -roundedMagnitude : roundedMagnitude)
}

interface ActiveReader {
  plan: SampleAudioClipPlan
  reader: ExportAudioClipReader
}

interface SampleAudioEnvelope extends TimelineAudioEnvelope {
  startSample: number
  endSample: number
}

interface SampleAudioClipPlan extends TimelineAudioClipPlan {
  timelineStartSample: number
  timelineEndSample: number
  fadeInEndSample: number
  fadeOutStartSample: number
  sampleEnvelopes: SampleAudioEnvelope[]
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
  private readonly mixPlans: SampleAudioClipPlan[]
  private readonly readers = new Map<ClipId, ActiveReader>()
  private nextFrame = 0
  private closePromise: Promise<void> | null = null

  constructor(
    doc: TimelineDoc,
    source: ExportAudioMediaSource,
    catalog: SourceBoundsCatalog = new Map(),
  ) {
    this.doc = doc
    this.source = source
    this.durationFrames = docDurationFrames(doc)
    this.mixPlans = createTimelineAudioMixPlan(doc, catalog).clips.map(
      (plan) => ({
        ...plan,
        timelineStartSample: audioSampleBoundary(plan.timelineStartFrame, doc),
        timelineEndSample: audioSampleBoundary(plan.timelineEndFrame, doc),
        fadeInEndSample: audioSampleBoundary(
          plan.timelineStartFrame + plan.fadeInFrames,
          doc,
        ),
        fadeOutStartSample: audioSampleBoundary(
          plan.timelineEndFrame - plan.fadeOutFrames,
          doc,
        ),
        sampleEnvelopes: plan.envelopes.map((envelope) => ({
          ...envelope,
          startSample: audioSampleBoundary(envelope.startFrame, doc),
          endSample: audioSampleBoundary(envelope.endFrame, doc),
        })),
      }),
    )
    this.hasAudio = doc.tracks.some(
      (track) => track.kind === 'audio' && track.clips.length > 0,
    )

    audioSampleBoundary(0, doc)
    audioSampleBoundary(this.durationFrames, doc)
  }

  private activePlans(frame: number): SampleAudioClipPlan[] {
    return this.mixPlans.filter((plan) =>
      plan.timelineStartFrame <= frame
      && frame < plan.timelineEndFrame,
    )
  }

  private async reconcileReaders(
    plans: readonly SampleAudioClipPlan[],
  ): Promise<void> {
    const wanted = new Set(plans.map((plan) => plan.clipId))
    const stale: ExportAudioClipReader[] = []
    for (const [clipId, active] of this.readers) {
      if (wanted.has(clipId)) continue
      this.readers.delete(clipId)
      stale.push(active.reader)
    }
    await closeReaders(stale)

    for (const plan of plans) {
      if (this.readers.has(plan.clipId)) continue
      const timelineStartSample = audioSampleBoundary(
        plan.timelineStartFrame,
        this.doc,
      )
      const timelineEndSample = audioSampleBoundary(
        plan.timelineEndFrame,
        this.doc,
      )
      const sourceStartSample =
        timelineStartSample +
        audioSamplePhaseOffset(
          plan.sourceStartFrame,
          plan.timelineStartFrame,
          this.doc,
        )
      if (!Number.isSafeInteger(sourceStartSample) || sourceStartSample < 0) {
        throw new RangeError(
          `Clip "${plan.clipId}" has an invalid audio in-point`,
        )
      }
      const sourceEndSample =
        sourceStartSample + (timelineEndSample - timelineStartSample)
      if (!Number.isSafeInteger(sourceEndSample)) {
        throw new RangeError(
          `Clip "${plan.clipId}" audio range is too large`,
        )
      }
      const reader = await this.source.openClip({
        clipId: plan.clipId,
        assetId: plan.assetId,
        startSample: sourceStartSample,
        endSample: sourceEndSample,
        sampleRate: this.doc.audioSampleRate,
        channelCount: EXPORT_AUDIO_CHANNELS,
        ...(plan.sampleEnvelopes.length > 0
          ? { requireComplete: true as const }
          : {}),
      })
      this.readers.set(plan.clipId, { plan, reader })
    }
  }

  private gainAtSample(plan: SampleAudioClipPlan, sample: number): number {
    let gain = plan.volume
    if (plan.fadeInFrames > 0) {
      const duration = plan.fadeInEndSample - plan.timelineStartSample
      if (duration <= 0) throw new RangeError('Audio fade-in sample window must be non-empty')
      gain *= Math.min(1, Math.max(
        0,
        (sample - plan.timelineStartSample) / duration,
      ))
    }
    if (plan.fadeOutFrames > 0) {
      const duration = plan.timelineEndSample - plan.fadeOutStartSample
      if (duration <= 0) throw new RangeError('Audio fade-out sample window must be non-empty')
      gain *= Math.min(1, Math.max(
        0,
        (plan.timelineEndSample - sample) / duration,
      ))
    }
    const envelope = plan.sampleEnvelopes.find((candidate) =>
      sample >= candidate.startSample && sample < candidate.endSample,
    )
    if (!envelope) return gain
    const duration = envelope.endSample - envelope.startSample
    if (duration <= 0) {
      throw new RangeError('Audio crossfade sample window must be non-empty')
    }
    const progress = (sample - envelope.startSample) / duration
    return gain * crossfadeAudioGain(
      envelope.curve,
      envelope.role,
      progress,
    )
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

    const plans = this.activePlans(docFrame)
    await this.reconcileReaders(plans)

    const frameStart = audioSampleBoundary(docFrame, this.doc)
    const frameEnd = audioSampleBoundary(docFrame + 1, this.doc)
    let blockStart = frameStart

    while (blockStart < frameEnd) {
      const sampleCount = Math.min(
        EXPORT_AUDIO_BLOCK_SAMPLES,
        frameEnd - blockStart,
      )
      const settled = await Promise.allSettled(
        plans.map(async (plan) => {
          const active = this.readers.get(plan.clipId)
          if (!active) {
            throw new Error(
              `Audio reader for clip "${plan.clipId}" is missing`,
            )
          }
          const channels = await active.reader.read(sampleCount)
          assertReaderBlock(plan.clipId, channels, sampleCount)
          return { channels, plan }
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
          const gain = this.gainAtSample(input.plan, blockStart + i)
          left[i] += l * gain * input.plan.leftGain
          right[i] += r * gain * input.plan.rightGain
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
