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
  clipAudioGainsAtLocalFrame,
  createTimelineAudioMixPlan,
  crossfadeAudioGain,
  isStretchedAudioClipPlan,
  type TimelineAudioClipPlan,
  type TimelineAudioEnvelope,
  type TimelineAudioMasterBus,
  type TimelineAudioTrackBus,
} from '../domain/audioMixPlan'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import { foldDecodedFrameToStereo } from '../domain/audioChannelMix'
import { docDurationFrames } from '../domain/selectors'
import { audioSampleBoundary, clipLocalFrameAtSample } from '../domain/time'
import { audioSampleFromSourceTicks } from '../domain/sourceTimeMap'
import {
  AUDIO_STRETCH_MAX_SESSIONS,
  AUDIO_STRETCH_RECHUNK_FRAMES,
  audioStretchSourceLeadSamples,
  createConstantRateAudioStretcher,
  type StereoPcm,
} from './audioStretch'

export { audioSampleBoundary }

export const EXPORT_AUDIO_CHANNELS = 2
export const EXPORT_AUDIO_BLOCK_SAMPLES = 1024

export interface ExportAudioClipRequest {
  clipId: ClipId
  assetId: AssetId
  startSample: number
  endSample: number
  sampleRate: number
  channelCount: typeof EXPORT_AUDIO_CHANNELS
  /**
   * Crossfade handle legs may zero-fill a bounded decoder-priming interval
   * before the first PCM packet, but must not invent samples after that bound,
   * after decode has started, or at EOF.
   */
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

/** Floor-scale a mix-grid sample index onto another integer sample rate. */
export function scaleExportSampleIndex(
  sample: number,
  fromRate: number,
  toRate: number,
): number {
  if (fromRate === toRate) return sample
  if (!Number.isSafeInteger(sample) || sample < 0) {
    throw new RangeError('Sample index must be a non-negative safe integer')
  }
  assertPositiveSafeInteger(fromRate, 'Source sample rate')
  assertPositiveSafeInteger(toRate, 'Encoder sample rate')
  const scaled = (BigInt(sample) * BigInt(toRate)) / BigInt(fromRate)
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Scaled sample index exceeds the safe integer range')
  }
  return Number(scaled)
}

/**
 * Trailing 96 kHz mix samples held for the next 2:1 downsample block.
 * Oldest sample first. Bounded by the anti-alias FIR length minus one; the
 * last sample is the unpaired leftover when the exclusive end is odd.
 */
export interface ExportAudioResampleCarry {
  readonly left: Float32Array
  readonly right: Float32Array
}

export interface ResampledAudioBlock {
  readonly encoded: MixedAudioBlock
  readonly carry: ExportAudioResampleCarry | null
}

/** Hamming-windowed sinc length for 96 kHz → 48 kHz anti-alias. */
const HALFRATE_LOWPASS_TAP_COUNT = 63
/** Cutoff as a fraction of the input rate (22 kHz at 96 kHz, below 24 kHz). */
const HALFRATE_LOWPASS_CUTOFF = 22_000 / 96_000

function hammingSincLowpassTaps(
  tapCount: number,
  cutoff: number,
): readonly number[] {
  if (!Number.isSafeInteger(tapCount) || tapCount < 3 || tapCount % 2 === 0) {
    throw new RangeError('Low-pass tap count must be an odd integer >= 3')
  }
  if (!(cutoff > 0) || !(cutoff < 0.5)) {
    throw new RangeError('Low-pass cutoff must be between 0 and 0.5')
  }
  const mid = (tapCount - 1) / 2
  const taps = new Array<number>(tapCount)
  let sum = 0
  for (let n = 0; n < tapCount; n++) {
    const k = n - mid
    const sinc = k === 0
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k)
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (tapCount - 1))
    const tap = sinc * window
    taps[n] = tap
    sum += tap
  }
  for (let n = 0; n < tapCount; n++) taps[n] /= sum
  return Object.freeze(taps)
}

const HALFRATE_LOWPASS_TAPS = hammingSincLowpassTaps(
  HALFRATE_LOWPASS_TAP_COUNT,
  HALFRATE_LOWPASS_CUTOFF,
)

function mixSampleAt(
  channel: Float32Array,
  localIndex: number,
  history: Float32Array | null,
): number {
  if (localIndex >= 0 && localIndex < channel.length) {
    return channel[localIndex]
  }
  if (history !== null && localIndex < 0) {
    const historyIndex = history.length + localIndex
    if (historyIndex >= 0 && historyIndex < history.length) {
      return history[historyIndex]
    }
  }
  return 0
}

function halfRateResampleCarry(
  block: MixedAudioBlock,
  previous: ExportAudioResampleCarry | null,
): ExportAudioResampleCarry | null {
  const historyNeeded = HALFRATE_LOWPASS_TAPS.length - 1
  const prevLen = previous === null ? 0 : previous.left.length
  const total = prevLen + block.sampleCount
  if (total <= 0) return null
  const keep = Math.min(historyNeeded, total)
  const left = new Float32Array(keep)
  const right = new Float32Array(keep)
  const start = total - keep
  for (let index = 0; index < keep; index++) {
    const concatIndex = start + index
    if (concatIndex < prevLen && previous !== null) {
      left[index] = previous.left[concatIndex]
      right[index] = previous.right[concatIndex]
    } else {
      const local = concatIndex - prevLen
      left[index] = block.channels[0][local]
      right[index] = block.channels[1][local]
    }
  }
  return { left, right }
}

/**
 * Convert one mixed block from the document sample grid to the encoder grid.
 * 96 kHz → 48 kHz applies a Hamming-windowed sinc low-pass, then keeps every
 * other sample. Trailing source samples carry into the next mix block so the
 * 2:1 pairing and filter history stay exact when a block starts on an odd
 * document sample. Other integer ratios pick the containing source sample.
 */
export function resampleMixedAudioBlock(
  block: MixedAudioBlock,
  fromRate: number,
  toRate: number,
  carry: ExportAudioResampleCarry | null = null,
): ResampledAudioBlock {
  if (fromRate === toRate) return { encoded: block, carry: null }
  const startSample = scaleExportSampleIndex(block.startSample, fromRate, toRate)
  const endSample = scaleExportSampleIndex(
    block.startSample + block.sampleCount,
    fromRate,
    toRate,
  )
  const sampleCount = endSample - startSample
  const halfRate = fromRate === toRate * 2
  const nextCarry = halfRate ? halfRateResampleCarry(block, carry) : null
  if (sampleCount <= 0) {
    return {
      encoded: {
        startSample,
        sampleCount: 0,
        channels: [new Float32Array(0), new Float32Array(0)],
      },
      carry: nextCarry,
    }
  }

  const left = new Float32Array(sampleCount)
  const right = new Float32Array(sampleCount)
  const tapCount = HALFRATE_LOWPASS_TAPS.length
  const historyLeft = carry === null ? null : carry.left
  const historyRight = carry === null ? null : carry.right
  for (let index = 0; index < sampleCount; index++) {
    const sourceIndex = scaleExportSampleIndex(startSample + index, toRate, fromRate)
      - block.startSample
    if (halfRate && sourceIndex + 1 < block.sampleCount) {
      let accL = 0
      let accR = 0
      const oldest = sourceIndex + 1 - (tapCount - 1)
      for (let tapIndex = 0; tapIndex < tapCount; tapIndex++) {
        const tap = HALFRATE_LOWPASS_TAPS[tapIndex]
        const localIndex = oldest + tapIndex
        accL += tap * mixSampleAt(block.channels[0], localIndex, historyLeft)
        accR += tap * mixSampleAt(block.channels[1], localIndex, historyRight)
      }
      left[index] = accL
      right[index] = accR
    } else {
      const clamped = Math.max(0, Math.min(block.sampleCount - 1, sourceIndex))
      left[index] = block.channels[0][clamped]
      right[index] = block.channels[1][clamped]
    }
  }
  return {
    encoded: { startSample, sampleCount, channels: [left, right] },
    carry: nextCarry,
  }
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

type SampleAudioClipPlan = TimelineAudioClipPlan & {
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

function assertStretchSessionLimit(plans: readonly SampleAudioClipPlan[]): void {
  const events = plans
    .filter(isStretchedAudioClipPlan)
    .flatMap((plan) => [
      { frame: plan.timelineStartFrame, delta: 1 },
      { frame: plan.timelineEndFrame, delta: -1 },
    ])
    .sort((left, right) => left.frame - right.frame || left.delta - right.delta)
  let active = 0
  for (const event of events) {
    active += event.delta
    if (active > AUDIO_STRETCH_MAX_SESSIONS) {
      throw new Error(
        `Export supports at most ${AUDIO_STRETCH_MAX_SESSIONS} concurrent audio stretch sessions`,
      )
    }
  }
}

function createStretchedExportReader(
  inner: ExportAudioClipReader,
  plan: Extract<SampleAudioClipPlan, { stretch: object }>,
  sampleRate: number,
  preRollSamples: number,
): ExportAudioClipReader {
  const session = createConstantRateAudioStretcher({
    stretch: plan.stretch,
    sampleRate,
    outputStartSample: 0,
  })
  let chunk: StereoPcm | null = null
  let chunkOffset = 0
  let remainingPreRoll = preRollSamples
  let closePromise: Promise<void> | null = null

  const fillChunk = async (): Promise<void> => {
    const channels = await inner.read(AUDIO_STRETCH_RECHUNK_FRAMES)
    if (
      channels.length < 1
      || channels.some((plane) =>
        !(plane instanceof Float32Array)
        || plane.length !== AUDIO_STRETCH_RECHUNK_FRAMES
      )
    ) {
      throw new Error(
        `Audio reader for clip "${plan.clipId}" returned an invalid stretch block`,
      )
    }
    const left = new Float32Array(AUDIO_STRETCH_RECHUNK_FRAMES)
    const right = new Float32Array(AUDIO_STRETCH_RECHUNK_FRAMES)
    if (channels.length === EXPORT_AUDIO_CHANNELS) {
      left.set(channels[0])
      right.set(channels[1])
    } else {
      for (let frame = 0; frame < AUDIO_STRETCH_RECHUNK_FRAMES; frame++) {
        const folded = foldDecodedFrameToStereo(channels, frame)
        left[frame] = folded[0]
        right[frame] = folded[1]
      }
    }
    chunk = { left, right }
    chunkOffset = 0
  }

  const readSource = async (sampleCount: number): Promise<StereoPcm> => {
    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)
    let written = 0
    while (written < sampleCount) {
      if (!chunk || chunkOffset === chunk.left.length) await fillChunk()
      const available = chunk!.left.length - chunkOffset
      if (remainingPreRoll > 0) {
        const skipped = Math.min(available, remainingPreRoll)
        chunkOffset += skipped
        remainingPreRoll -= skipped
        continue
      }
      const copied = Math.min(available, sampleCount - written)
      left.set(chunk!.left.subarray(chunkOffset, chunkOffset + copied), written)
      right.set(chunk!.right.subarray(chunkOffset, chunkOffset + copied), written)
      chunkOffset += copied
      written += copied
    }
    return { left, right }
  }

  return {
    read: async (sampleCount) => {
      const output = await session.pull(sampleCount, readSource)
      return [output.left, output.right]
    },
    close: () => {
      if (closePromise) return closePromise
      session.close()
      chunk = null
      closePromise = Promise.resolve(inner.close())
      return closePromise
    },
  }
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
  private readonly trackGains: ReadonlyMap<string, TimelineAudioTrackBus>
  private readonly master: TimelineAudioMasterBus
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
    const mixPlan = createTimelineAudioMixPlan(doc, catalog)
    this.trackGains = new Map(
      mixPlan.tracks.map((track) => [track.trackId, track]),
    )
    this.master = mixPlan.master
    this.mixPlans = mixPlan.clips
      .map((plan) => ({
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
      }))
    assertStretchSessionLimit(this.mixPlans)
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
      if (
        isStretchedAudioClipPlan(plan)
        && [...this.readers.values()].filter((active) =>
          isStretchedAudioClipPlan(active.plan)
        ).length >= AUDIO_STRETCH_MAX_SESSIONS
      ) {
        throw new Error(
          `Export supports at most ${AUDIO_STRETCH_MAX_SESSIONS} concurrent audio stretch sessions`,
        )
      }
      const timelineStartSample = audioSampleBoundary(
        plan.timelineStartFrame,
        this.doc,
      )
      const timelineEndSample = audioSampleBoundary(
        plan.timelineEndFrame,
        this.doc,
      )
      const sourceStartSample = isStretchedAudioClipPlan(plan)
        ? audioSampleFromSourceTicks(
            plan.stretch.sourceStartTicks,
            this.doc.frameRate,
            this.doc.audioSampleRate,
          )
        : timelineStartSample + audioSamplePhaseOffset(
            plan.sourceStartFrame,
            plan.timelineStartFrame,
            this.doc,
          )
      if (!Number.isSafeInteger(sourceStartSample) || sourceStartSample < 0) {
        throw new RangeError(
          `Clip "${plan.clipId}" has an invalid audio in-point`,
        )
      }
      const sourceEndSample = isStretchedAudioClipPlan(plan)
        ? audioSampleFromSourceTicks(
            plan.stretch.sourceEndTicks,
            this.doc.frameRate,
            this.doc.audioSampleRate,
          )
        : sourceStartSample + (timelineEndSample - timelineStartSample)
      if (!Number.isSafeInteger(sourceEndSample)) {
        throw new RangeError(
          `Clip "${plan.clipId}" audio range is too large`,
        )
      }
      const lead = isStretchedAudioClipPlan(plan)
        ? audioStretchSourceLeadSamples(this.doc.audioSampleRate)
        : 0
      const openStartSample = Math.max(0, sourceStartSample - lead)
      const inner = await this.source.openClip({
        clipId: plan.clipId,
        assetId: plan.assetId,
        startSample: openStartSample,
        endSample: sourceEndSample,
        sampleRate: this.doc.audioSampleRate,
        channelCount: EXPORT_AUDIO_CHANNELS,
        ...(plan.sampleEnvelopes.length > 0
          ? { requireComplete: true as const }
          : {}),
      })
      let reader: ExportAudioClipReader
      try {
        reader = isStretchedAudioClipPlan(plan)
          ? createStretchedExportReader(
              inner,
              plan,
              this.doc.audioSampleRate,
              sourceStartSample - openStartSample,
            )
          : inner
      } catch (cause) {
        await inner.close()
        throw cause
      }
      this.readers.set(plan.clipId, { plan, reader })
    }
  }

  private envelopeAtSample(plan: SampleAudioClipPlan, sample: number): number {
    let gain = 1
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
          const sample = blockStart + i
          const localFrame = clipLocalFrameAtSample(
            input.plan.clipTimelineStartFrame,
            sample,
            docFrame,
            this.doc,
          )
          const gains = clipAudioGainsAtLocalFrame(input.plan, localFrame)
          const envelope = this.envelopeAtSample(input.plan, sample)
          const track = this.trackGains.get(input.plan.trackId)
          if (!track) {
            throw new Error(
              `Audio track bus for "${input.plan.trackId}" is missing`,
            )
          }
          left[i] += l * envelope * gains.volume * gains.leftGain
            * track.volume * track.leftGain
          right[i] += r * envelope * gains.volume * gains.rightGain
            * track.volume * track.rightGain
        }
      }
      for (let i = 0; i < sampleCount; i++) {
        if (this.master.muted) {
          left[i] = 0
          right[i] = 0
          continue
        }
        left[i] = Math.max(
          -1,
          Math.min(1, left[i] * this.master.volume * this.master.leftGain),
        )
        right[i] = Math.max(
          -1,
          Math.min(1, right[i] * this.master.volume * this.master.rightGain),
        )
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
