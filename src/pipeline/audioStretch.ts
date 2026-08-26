/**
 * First-party WSOLA after Verhelst and Roelands, 1993,
 * "An overlap-add technique based on waveform similarity for high quality
 * time-scale modification of speech."
 */

import type { ConstantRateAudioStretch } from '../domain/audioMixPlan'

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

class WsolaSession implements ConstantRateAudioStretcher {
  private readonly windowSamples: number
  private readonly outputHopSamples: number
  private readonly searchSamples: number
  private readonly inputHopSamples: number
  private readonly ringSamples: number
  private sourceLeft: Float32Array | null
  private sourceRight: Float32Array | null
  private hann: Float32Array | null
  private overlapLeft: Float32Array | null
  private overlapRight: Float32Array | null
  private overlapWeight: Float32Array | null
  private retainedSourceStart = 0
  private sourceReadEnd = 0
  private nextSourceNominal = 0
  private nextGrainOutputStart = 0
  private nextOutputAdvance: number
  private emittedOutputSamples = 0
  private firstGrain = true
  private closed = false

  constructor(
    stretch: ConstantRateAudioStretch,
    sampleRate: number,
    outputStartSample: number,
  ) {
    const constants = wsolaTimeConstants(sampleRate)
    this.windowSamples = constants.windowSamples
    this.outputHopSamples = constants.outputHopSamples
    this.searchSamples = constants.searchSamples
    this.inputHopSamples = (
      constants.outputHopSamples * stretch.rate.numerator
    ) / stretch.rate.denominator
    this.ringSamples = constants.windowSamples + constants.outputHopSamples
    this.sourceLeft = new Float32Array(
      constants.windowSamples + constants.searchSamples * 2,
    )
    this.sourceRight = new Float32Array(this.sourceLeft.length)
    this.hann = new Float32Array(constants.windowSamples)
    this.overlapLeft = new Float32Array(this.ringSamples)
    this.overlapRight = new Float32Array(this.ringSamples)
    this.overlapWeight = new Float32Array(this.ringSamples)
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
      sourceNominal += this.inputHopSamples
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
    this.nextSourceNominal += this.inputHopSamples
    this.nextGrainOutputStart += this.nextOutputAdvance
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
    let bestStart = minimum
    let bestDifference = Number.POSITIVE_INFINITY
    const overlapLeft = this.overlapLeft!
    const overlapRight = this.overlapRight!
    const overlapWeight = this.overlapWeight!
    const comparisonSamples = this.windowSamples - this.nextOutputAdvance
    for (let candidate = minimum; candidate <= maximum; candidate++) {
      let difference = 0
      for (let index = 0; index < comparisonSamples; index++) {
        const slot = (this.nextGrainOutputStart + index) % this.ringSamples
        const weight = overlapWeight[slot]!
        if (weight === 0) continue
        const reference = (
          overlapLeft[slot]! + overlapRight[slot]!
        ) / (2 * weight)
        const candidateMid = (
          this.sourceSample(
            'left',
            candidate + index,
            newSource,
            previousReadEnd,
          )
          + this.sourceSample(
            'right',
            candidate + index,
            newSource,
            previousReadEnd,
          )
        ) / 2
        difference += Math.abs(reference - candidateMid)
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
