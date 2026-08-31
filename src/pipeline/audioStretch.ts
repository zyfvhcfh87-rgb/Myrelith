/**
 * First-party WSOLA after Verhelst and Roelands, 1993,
 * "An overlap-add technique based on waveform similarity for high quality
 * time-scale modification of speech."
 */

import type { FrameRate } from '../domain/schema'
import type {
  ConstantRateAudioStretch,
  RampedAudioStretch,
} from '../domain/audioMixPlan'
import {
  audioSampleFromSourceTicks,
  MAX_SOURCE_TIME_RATE,
  sourceTicksAtTimelineOffset,
} from '../domain/sourceTimeMap'
import { audioSampleBoundary } from '../domain/time'

export interface StereoPcm {
  readonly left: Float32Array
  readonly right: Float32Array
}

export interface ConstantRateAudioStretcher {
  pull(
    outputSampleCount: number,
    readNewSource: (sampleCount: number) => StereoPcm | Promise<StereoPcm>,
  ): Promise<StereoPcm>
  close(): void
}

export const AUDIO_STRETCH_MAX_OUTPUT_SAMPLES = 96_000
export const AUDIO_STRETCH_RECHUNK_FRAMES = 4_096
export const AUDIO_STRETCH_MAX_SESSIONS = 8
export const AUDIO_STRETCH_MAX_SESSION_WORKING_BYTES = 5 * 1024 * 1024
export const AUDIO_STRETCH_MAX_AGGREGATE_WORKING_BYTES =
  AUDIO_STRETCH_MAX_SESSION_WORKING_BYTES * AUDIO_STRETCH_MAX_SESSIONS
export const AUDIO_RAMP_SILENCE_FADE_MILLISECONDS = 3

const SUPPORTED_SAMPLE_RATES = new Set([44_100, 48_000, 96_000])

function assertSupportedSampleRate(sampleRate: number): void {
  if (
    !Number.isSafeInteger(sampleRate)
    || !SUPPORTED_SAMPLE_RATES.has(sampleRate)
  ) {
    throw new RangeError('Audio stretch sample rate must be 44100, 48000, or 96000')
  }
}

export function wsolaTimeConstants(sampleRate: number): {
  windowSamples: number
  outputHopSamples: number
  searchSamples: number
} {
  assertSupportedSampleRate(sampleRate)
  const unsnappedHop = sampleRate * 16 / 3_000
  const outputHopSamples = Math.round(unsnappedHop / 4) * 4
  return {
    windowSamples: outputHopSamples * 4,
    outputHopSamples,
    searchSamples: outputHopSamples * 2,
  }
}

export function audioStretchSourceLeadSamples(sampleRate: number): number {
  const { windowSamples, searchSamples } = wsolaTimeConstants(sampleRate)
  return windowSamples + searchSamples
}

interface RampAudioDocument {
  readonly frameRate: FrameRate
  readonly audioSampleRate: number
}

interface RampSilenceSampleRange {
  readonly startSample: number
  readonly endSample: number
}

interface RampAudioMappingArgs {
  readonly ramp: RampedAudioStretch
  readonly frameRate: FrameRate
  readonly sampleRate: number
  readonly timelineStartFrame: number
  readonly clipTimelineStartFrame: number
  readonly outputStartSample: number
}

function containingAudioFrame(sample: number, doc: RampAudioDocument): number {
  if (!Number.isSafeInteger(sample) || sample < 0) {
    throw new RangeError('Ramp audio sample must be a non-negative safe integer')
  }
  const denominator = BigInt(doc.audioSampleRate) * BigInt(doc.frameRate.den)
  let frame = Number(
    BigInt(sample) * BigInt(doc.frameRate.num) / denominator,
  )
  while (audioSampleBoundary(frame + 1, doc) <= sample) frame++
  while (frame > 0 && audioSampleBoundary(frame, doc) > sample) frame--
  return frame
}

function rampSourceSampleAtTimelineSample(
  ramp: RampedAudioStretch,
  doc: RampAudioDocument,
  clipTimelineStartFrame: number,
  absoluteTimelineSample: number,
): number {
  const frame = containingAudioFrame(absoluteTimelineSample, doc)
  const frameStartSample = audioSampleBoundary(frame, doc)
  const frameEndSample = audioSampleBoundary(frame + 1, doc)
  const localFrame = frame - clipTimelineStartFrame
  const sourceStartSample = audioSampleFromSourceTicks(
    sourceTicksAtTimelineOffset(ramp.sourceTimeMap, localFrame),
    doc.frameRate,
    doc.audioSampleRate,
  )
  const sourceEndSample = audioSampleFromSourceTicks(
    sourceTicksAtTimelineOffset(ramp.sourceTimeMap, localFrame + 1),
    doc.frameRate,
    doc.audioSampleRate,
  )
  const frameSamples = frameEndSample - frameStartSample
  const fraction = frameSamples <= 0
    ? 0
    : (absoluteTimelineSample - frameStartSample) / frameSamples
  return sourceStartSample + (sourceEndSample - sourceStartSample) * fraction
}

function assertRampAudioMappingArgs(args: RampAudioMappingArgs): void {
  assertSupportedSampleRate(args.sampleRate)
  for (const [value, label] of [
    [args.timelineStartFrame, 'timeline start frame'],
    [args.clipTimelineStartFrame, 'clip timeline start frame'],
    [args.outputStartSample, 'output start sample'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Ramp audio ${label} must be a non-negative safe integer`)
    }
  }
}

/**
 * Conservative typed-array peak for one maximum pull. It includes the two
 * fresh source planes at 4x, returned output planes, the host rechunk, and all
 * persistent WSOLA arrays. The public allowance leaves additional headroom for
 * the bounded ramp descriptor and ordinary JS bookkeeping.
 */
export function audioStretchMaximumPcmWorkingBytes(sampleRate: number): number {
  const { windowSamples, outputHopSamples, searchSamples } =
    wsolaTimeConstants(sampleRate)
  const maximumRate =
    MAX_SOURCE_TIME_RATE.numerator / MAX_SOURCE_TIME_RATE.denominator
  const maximumSourceSamples = Math.ceil(
    (AUDIO_STRETCH_MAX_OUTPUT_SAMPLES + outputHopSamples) * maximumRate,
  ) + windowSamples + searchSamples + 2
  const persistentElements =
    2 * (windowSamples + searchSamples * 2)
    + windowSamples
    + 3 * (windowSamples + outputHopSamples)
    + windowSamples
    + windowSamples
    + 2 * (searchSamples * 2 + windowSamples)
  const maximumPullElements =
    2 * maximumSourceSamples
    + 2 * AUDIO_STRETCH_MAX_OUTPUT_SAMPLES
    + 2 * AUDIO_STRETCH_RECHUNK_FRAMES
  return (persistentElements + maximumPullElements)
    * Float32Array.BYTES_PER_ELEMENT
}

export function rampedAudioSourceSampleAtOutputSample(
  args: RampAudioMappingArgs,
): number {
  assertRampAudioMappingArgs(args)
  const doc: RampAudioDocument = {
    frameRate: { ...args.frameRate },
    audioSampleRate: args.sampleRate,
  }
  const absoluteTimelineSample = audioSampleBoundary(args.timelineStartFrame, doc)
    + args.outputStartSample
  if (!Number.isSafeInteger(absoluteTimelineSample)) {
    throw new RangeError('Ramp timeline sample exceeds the safe integer range')
  }
  return Math.round(rampSourceSampleAtTimelineSample(
    args.ramp,
    doc,
    args.clipTimelineStartFrame,
    absoluteTimelineSample,
  ))
}

class RampSourceMapper {
  private readonly ramp: RampedAudioStretch
  private readonly doc: RampAudioDocument
  private readonly clipTimelineStartFrame: number
  private readonly outputStartSample: number
  private readonly timelineStartSample: number
  private readonly baseSourceSample: number
  private readonly fadeSamples: number
  private readonly silenceRanges: readonly RampSilenceSampleRange[]
  private cachedFrame = -1
  private cachedFrameStartSample = 0
  private cachedFrameEndSample = 0
  private cachedSourceStartSample = 0
  private cachedSourceEndSample = 0

  constructor(args: RampAudioMappingArgs) {
    this.ramp = args.ramp
    this.doc = {
      frameRate: { ...args.frameRate },
      audioSampleRate: args.sampleRate,
    }
    this.clipTimelineStartFrame = args.clipTimelineStartFrame
    this.outputStartSample = args.outputStartSample
    this.timelineStartSample = audioSampleBoundary(
      args.timelineStartFrame,
      this.doc,
    )
    this.fadeSamples = Math.max(
      1,
      Math.round(args.sampleRate * AUDIO_RAMP_SILENCE_FADE_MILLISECONDS / 1_000),
    )
    this.silenceRanges = args.ramp.silenceRanges.map((range) => ({
      startSample: audioSampleBoundary(range.startFrame, this.doc)
        - this.timelineStartSample,
      endSample: audioSampleBoundary(range.endFrame, this.doc)
        - this.timelineStartSample,
    }))
    this.baseSourceSample = this.absoluteSourceSampleAt(args.outputStartSample)
  }

  sourceNominalAt(sessionOutputSample: number): number {
    const absolute = this.absoluteSourceSampleAt(
      this.outputStartSample + sessionOutputSample,
    )
    return Math.max(0, Math.round(absolute - this.baseSourceSample))
  }

  applySilence(output: StereoPcm, sessionOutputStart: number): void {
    if (this.silenceRanges.length === 0) return
    const planOutputStart = this.outputStartSample + sessionOutputStart
    const planOutputEnd = planOutputStart + output.left.length
    for (const range of this.silenceRanges) {
      const affectedStart = Math.max(
        planOutputStart,
        range.startSample - this.fadeSamples,
      )
      const affectedEnd = Math.min(
        planOutputEnd,
        range.endSample + this.fadeSamples,
      )
      if (affectedEnd <= affectedStart) continue
      for (let sample = affectedStart; sample < affectedEnd; sample++) {
        let gain = 0
        if (sample < range.startSample) {
          gain = (range.startSample - sample) / this.fadeSamples
        } else if (sample >= range.endSample) {
          gain = (sample - range.endSample) / this.fadeSamples
        }
        gain = Math.min(1, Math.max(0, gain))
        const index = sample - planOutputStart
        output.left[index] *= gain
        output.right[index] *= gain
      }
    }
  }

  private absoluteSourceSampleAt(planOutputSample: number): number {
    if (!Number.isSafeInteger(planOutputSample) || planOutputSample < 0) {
      throw new RangeError('Ramp output sample must be a non-negative safe integer')
    }
    const absoluteTimelineSample = this.timelineStartSample + planOutputSample
    if (!Number.isSafeInteger(absoluteTimelineSample)) {
      throw new RangeError('Ramp timeline sample exceeds the safe integer range')
    }
    const frame = containingAudioFrame(absoluteTimelineSample, this.doc)
    if (frame !== this.cachedFrame) {
      this.cachedFrame = frame
      this.cachedFrameStartSample = audioSampleBoundary(frame, this.doc)
      this.cachedFrameEndSample = audioSampleBoundary(frame + 1, this.doc)
      const localFrame = frame - this.clipTimelineStartFrame
      this.cachedSourceStartSample = audioSampleFromSourceTicks(
        sourceTicksAtTimelineOffset(this.ramp.sourceTimeMap, localFrame),
        this.doc.frameRate,
        this.doc.audioSampleRate,
      )
      this.cachedSourceEndSample = audioSampleFromSourceTicks(
        sourceTicksAtTimelineOffset(this.ramp.sourceTimeMap, localFrame + 1),
        this.doc.frameRate,
        this.doc.audioSampleRate,
      )
    }
    const frameSamples = this.cachedFrameEndSample - this.cachedFrameStartSample
    const fraction = frameSamples <= 0
      ? 0
      : (absoluteTimelineSample - this.cachedFrameStartSample) / frameSamples
    return this.cachedSourceStartSample
      + (this.cachedSourceEndSample - this.cachedSourceStartSample) * fraction
  }
}

class WsolaSession implements ConstantRateAudioStretcher {
  private readonly windowSamples: number
  private readonly outputHopSamples: number
  private readonly searchSamples: number
  private readonly inputHopSamples: number
  private readonly rampMapper: RampSourceMapper | null
  private readonly ringSamples: number
  private sourceLeft: Float32Array | null
  private sourceRight: Float32Array | null
  private hann: Float32Array | null
  private overlapLeft: Float32Array | null
  private overlapRight: Float32Array | null
  private overlapWeight: Float32Array | null
  private overlapRef: Float32Array | null
  private overlapRefIndex: Int32Array | null
  private searchLeft: Float32Array | null
  private searchRight: Float32Array | null
  private retainedSourceStart = 0
  private sourceReadEnd = 0
  private nextSourceNominal = 0
  private nextGrainOutputStart = 0
  private nextOutputAdvance: number
  private emittedOutputSamples = 0
  private firstGrain = true
  private closed = false

  constructor(
    stretch: ConstantRateAudioStretch | null,
    sampleRate: number,
    outputStartSample: number,
    rampMapper: RampSourceMapper | null = null,
  ) {
    const constants = wsolaTimeConstants(sampleRate)
    if (
      audioStretchMaximumPcmWorkingBytes(sampleRate)
      > AUDIO_STRETCH_MAX_SESSION_WORKING_BYTES
    ) {
      throw new RangeError('Audio stretch working set exceeds its session budget')
    }
    this.windowSamples = constants.windowSamples
    this.outputHopSamples = constants.outputHopSamples
    this.searchSamples = constants.searchSamples
    this.inputHopSamples = stretch
      ? (
          constants.outputHopSamples * stretch.rate.numerator
        ) / stretch.rate.denominator
      : 0
    this.rampMapper = rampMapper
    this.ringSamples = constants.windowSamples + constants.outputHopSamples
    this.sourceLeft = new Float32Array(
      constants.windowSamples + constants.searchSamples * 2,
    )
    this.sourceRight = new Float32Array(this.sourceLeft.length)
    this.hann = new Float32Array(constants.windowSamples)
    this.overlapLeft = new Float32Array(this.ringSamples)
    this.overlapRight = new Float32Array(this.ringSamples)
    this.overlapWeight = new Float32Array(this.ringSamples)
    this.overlapRef = new Float32Array(constants.windowSamples)
    this.overlapRefIndex = new Int32Array(constants.windowSamples)
    this.searchLeft = new Float32Array(
      constants.searchSamples * 2 + constants.windowSamples,
    )
    this.searchRight = new Float32Array(this.searchLeft.length)
    for (let index = 0; index < constants.windowSamples; index++) {
      this.hann[index] = 0.5 - 0.5 * Math.cos(
        2 * Math.PI * index / (constants.windowSamples - 1),
      )
    }
    const phase = outputStartSample % constants.outputHopSamples
    this.nextOutputAdvance = phase === 0
      ? constants.outputHopSamples
      : constants.outputHopSamples - phase
  }

  async pull(
    outputSampleCount: number,
    readNewSource: (sampleCount: number) => StereoPcm | Promise<StereoPcm>,
  ): Promise<StereoPcm> {
    if (
      !Number.isSafeInteger(outputSampleCount)
      || outputSampleCount < 1
      || outputSampleCount > AUDIO_STRETCH_MAX_OUTPUT_SAMPLES
    ) {
      throw new RangeError(
        `Audio stretch pull count must be an integer from 1 to ${AUDIO_STRETCH_MAX_OUTPUT_SAMPLES}`,
      )
    }
    if (this.closed) throw new Error('Audio stretch session is closed')

    const targetOutputEnd = this.emittedOutputSamples + outputSampleCount
    const requiredSourceEnd = this.requiredSourceEnd(targetOutputEnd)
    const newSourceCount = requiredSourceEnd - this.sourceReadEnd
    let newSource: StereoPcm
    if (newSourceCount > 0) {
      newSource = await readNewSource(newSourceCount)
      this.assertSource(newSource, newSourceCount)
    } else {
      newSource = {
        left: new Float32Array(0),
        right: new Float32Array(0),
      }
    }

    const previousReadEnd = this.sourceReadEnd
    const output: StereoPcm = {
      left: new Float32Array(outputSampleCount),
      right: new Float32Array(outputSampleCount),
    }
    const pullOutputStart = this.emittedOutputSamples
    this.drainOutput(
      output,
      Math.min(this.nextGrainOutputStart, targetOutputEnd),
      pullOutputStart,
    )
    while (this.nextGrainOutputStart < targetOutputEnd) {
      this.addNextGrain(newSource, previousReadEnd)
      const finalizedEnd = Math.min(this.nextGrainOutputStart, targetOutputEnd)
      this.drainOutput(output, finalizedEnd, pullOutputStart)
    }
    if (this.emittedOutputSamples !== targetOutputEnd) {
      throw new Error('Audio stretch produced a short result')
    }

    this.sourceReadEnd = requiredSourceEnd
    this.retainSourceTail(newSource, previousReadEnd)
    this.rampMapper?.applySilence(output, pullOutputStart)
    return output
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.sourceLeft = null
    this.sourceRight = null
    this.hann = null
    this.overlapLeft = null
    this.overlapRight = null
    this.overlapWeight = null
    this.overlapRef = null
    this.overlapRefIndex = null
    this.searchLeft = null
    this.searchRight = null
  }

  private requiredSourceEnd(targetOutputEnd: number): number {
    let grainOutputStart = this.nextGrainOutputStart
    if (grainOutputStart >= targetOutputEnd) return this.sourceReadEnd
    let sourceNominal = this.nextSourceNominal
    let outputAdvance = this.nextOutputAdvance
    let lastSourceNominal = sourceNominal
    while (grainOutputStart < targetOutputEnd) {
      lastSourceNominal = sourceNominal
      grainOutputStart += outputAdvance
      outputAdvance = this.outputHopSamples
      sourceNominal = this.rampMapper
        ? this.rampMapper.sourceNominalAt(grainOutputStart)
        : sourceNominal + this.inputHopSamples
    }
    const throughSearch = lastSourceNominal
      + this.searchSamples
      + this.windowSamples
    return this.firstGrain
      ? Math.max(
          throughSearch,
          this.windowSamples + this.searchSamples,
        )
      : throughSearch
  }

  private assertSource(source: StereoPcm, expectedLength: number): void {
    if (
      !(source.left instanceof Float32Array)
      || !(source.right instanceof Float32Array)
      || source.left.length !== expectedLength
      || source.right.length !== expectedLength
    ) {
      throw new RangeError(
        `Audio stretch source planes must both have length ${expectedLength}`,
      )
    }
    for (let index = 0; index < expectedLength; index++) {
      if (
        !Number.isFinite(source.left[index])
        || !Number.isFinite(source.right[index])
      ) {
        throw new RangeError('Audio stretch source samples must be finite')
      }
    }
  }

  private sourceSample(
    plane: 'left' | 'right',
    sourceIndex: number,
    newSource: StereoPcm,
    previousReadEnd: number,
  ): number {
    if (sourceIndex < previousReadEnd) {
      const scratch = plane === 'left' ? this.sourceLeft! : this.sourceRight!
      return scratch[sourceIndex - this.retainedSourceStart]!
    }
    const fresh = plane === 'left' ? newSource.left : newSource.right
    return fresh[sourceIndex - previousReadEnd]!
  }

  private addNextGrain(
    newSource: StereoPcm,
    previousReadEnd: number,
  ): void {
    const sourceStart = this.firstGrain
      ? this.nextSourceNominal
      : this.bestSourceStart(newSource, previousReadEnd)
    const hann = this.hann!
    const overlapLeft = this.overlapLeft!
    const overlapRight = this.overlapRight!
    const overlapWeight = this.overlapWeight!
    for (let index = 0; index < this.windowSamples; index++) {
      const outputIndex = this.nextGrainOutputStart + index
      const slot = outputIndex % this.ringSamples
      const weight = hann[index]!
      overlapLeft[slot] = overlapLeft[slot]!
        + this.sourceSample('left', sourceStart + index, newSource, previousReadEnd)
        * weight
      overlapRight[slot] = overlapRight[slot]!
        + this.sourceSample('right', sourceStart + index, newSource, previousReadEnd)
        * weight
      overlapWeight[slot] = overlapWeight[slot]! + weight
    }
    this.firstGrain = false
    this.nextGrainOutputStart += this.nextOutputAdvance
    this.nextSourceNominal = this.rampMapper
      ? this.rampMapper.sourceNominalAt(this.nextGrainOutputStart)
      : this.nextSourceNominal + this.inputHopSamples
    this.nextOutputAdvance = this.outputHopSamples
  }

  private bestSourceStart(
    newSource: StereoPcm,
    previousReadEnd: number,
  ): number {
    const minimum = Math.max(
      this.retainedSourceStart,
      this.nextSourceNominal - this.searchSamples,
    )
    const maximum = Math.min(
      previousReadEnd + newSource.left.length - this.windowSamples,
      this.nextSourceNominal + this.searchSamples,
    )
    if (maximum < minimum) return minimum

    // Flatten overlap and source once. The live audio pump runs this on the
    // main thread, so a per-candidate sourceSample walk stalls playhead rAF.

    const overlapLeft = this.overlapLeft!
    const overlapRight = this.overlapRight!
    const overlapWeight = this.overlapWeight!
    const overlapRef = this.overlapRef!
    const overlapRefIndex = this.overlapRefIndex!
    const comparisonSamples = this.windowSamples - this.nextOutputAdvance
    let compactCount = 0
    for (let index = 0; index < comparisonSamples; index++) {
      const slot = (this.nextGrainOutputStart + index) % this.ringSamples
      const weight = overlapWeight[slot]!
      if (weight === 0) continue
      overlapRef[compactCount] = (
        overlapLeft[slot]! + overlapRight[slot]!
      ) / (2 * weight)
      overlapRefIndex[compactCount] = index
      compactCount += 1
    }

    const searchLeft = this.searchLeft!
    const searchRight = this.searchRight!
    const regionLength = maximum - minimum + this.windowSamples
    for (let index = 0; index < regionLength; index++) {
      const sourceIndex = minimum + index
      searchLeft[index] = this.sourceSample(
        'left',
        sourceIndex,
        newSource,
        previousReadEnd,
      )
      searchRight[index] = this.sourceSample(
        'right',
        sourceIndex,
        newSource,
        previousReadEnd,
      )
    }

    let bestStart = minimum
    let bestDifference = Number.POSITIVE_INFINITY
    for (let candidate = minimum; candidate <= maximum; candidate++) {
      const origin = candidate - minimum
      let difference = 0
      for (let compact = 0; compact < compactCount; compact++) {
        const sampleIndex = origin + overlapRefIndex[compact]!
        const candidateMid = (
          searchLeft[sampleIndex]! + searchRight[sampleIndex]!
        ) / 2
        difference += Math.abs(overlapRef[compact]! - candidateMid)
        if (difference >= bestDifference) break
      }
      if (difference < bestDifference) {
        bestDifference = difference
        bestStart = candidate
      }
    }
    return bestStart
  }

  private drainOutput(
    output: StereoPcm,
    finalizedEnd: number,
    pullOutputStart: number,
  ): void {
    const overlapLeft = this.overlapLeft!
    const overlapRight = this.overlapRight!
    const overlapWeight = this.overlapWeight!
    while (this.emittedOutputSamples < finalizedEnd) {
      const slot = this.emittedOutputSamples % this.ringSamples
      const targetIndex = this.emittedOutputSamples - pullOutputStart
      const weight = overlapWeight[slot]!
      output.left[targetIndex] = weight === 0 ? 0 : overlapLeft[slot]! / weight
      output.right[targetIndex] = weight === 0 ? 0 : overlapRight[slot]! / weight
      overlapLeft[slot] = 0
      overlapRight[slot] = 0
      overlapWeight[slot] = 0
      this.emittedOutputSamples++
    }
  }

  private retainSourceTail(
    newSource: StereoPcm,
    previousReadEnd: number,
  ): void {
    const keepStart = Math.max(
      0,
      this.nextSourceNominal - this.searchSamples,
    )
    const keepLength = this.sourceReadEnd - keepStart
    const sourceLeft = this.sourceLeft!
    const sourceRight = this.sourceRight!
    for (let index = 0; index < keepLength; index++) {
      const sourceIndex = keepStart + index
      sourceLeft[index] = this.sourceSample(
        'left',
        sourceIndex,
        newSource,
        previousReadEnd,
      )
      sourceRight[index] = this.sourceSample(
        'right',
        sourceIndex,
        newSource,
        previousReadEnd,
      )
    }
    this.retainedSourceStart = keepStart
  }
}

export function createConstantRateAudioStretcher(args: {
  stretch: ConstantRateAudioStretch
  sampleRate: number
  outputStartSample: number
}): ConstantRateAudioStretcher {
  assertSupportedSampleRate(args.sampleRate)
  if (
    !Number.isSafeInteger(args.outputStartSample)
    || args.outputStartSample < 0
  ) {
    throw new RangeError(
      'Audio stretch output start sample must be a non-negative safe integer',
    )
  }
  return new WsolaSession(
    args.stretch,
    args.sampleRate,
    args.outputStartSample,
  )
}

export function createRampedAudioStretcher(args: {
  ramp: RampedAudioStretch
  frameRate: FrameRate
  sampleRate: number
  timelineStartFrame: number
  clipTimelineStartFrame: number
  outputStartSample: number
}): ConstantRateAudioStretcher {
  assertRampAudioMappingArgs(args)
  if (args.ramp.silent) {
    throw new RangeError('A fully silent audio ramp does not require a stretch session')
  }
  const mapper = new RampSourceMapper(args)
  return new WsolaSession(
    null,
    args.sampleRate,
    args.outputStartSample,
    mapper,
  )
}
