/** ITU-R BS.1770-style integrated loudness and true-peak measurement. */

export const LOUDNESS_ABSOLUTE_GATE_LUFS = -70
export const LOUDNESS_RELATIVE_GATE_LU = -10
export const LOUDNESS_BLOCK_SECONDS = 0.4
export const LOUDNESS_HOP_SECONDS = 0.1
export const DEFAULT_NORMALIZE_TARGET_LUFS = -16

export type LoudnessCoverage = 'complete' | 'incomplete'

/** Explicit document-frame range measured by a loudness scan. End is exclusive. */
export interface LoudnessMeasurementRange {
  readonly startFrame: number
  readonly endFrame: number
}

export interface LoudnessMeasurement {
  readonly integratedLufs: number | null
  readonly truePeakDbtp: number | null
  readonly coverage: LoudnessCoverage
  readonly measuredSamples: number
  readonly expectedSamples: number
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
  x1: number
  x2: number
  y1: number
  y2: number
}

function biquad(b0: number, b1: number, b2: number, a1: number, a2: number): Biquad {
  return { b0, b1, b2, a1, a2, x1: 0, x2: 0, y1: 0, y2: 0 }
}

function processBiquad(sample: number, state: Biquad): number {
  const y = state.b0 * sample + state.b1 * state.x1 + state.b2 * state.x2
    - state.a1 * state.y1 - state.a2 * state.y2
  state.x2 = state.x1
  state.x1 = sample
  state.y2 = state.y1
  state.y1 = y
  return y
}

/** K-weighting high shelf + highpass, bilinear at the given sample rate. */
function kWeightingFilters(sampleRate: number): { shelf: Biquad; highpass: Biquad } {
  // Analog prototypes from BS.1770-4: shelf ~1.5 kHz / +4 dB, HPF ~38 Hz.
  const shelfFreq = 1_681.974_192_317_66
  const highpassFreq = 38.135_470_876_14
  const w = (freq: number) => Math.tan(Math.PI * freq / sampleRate)
  const k = w(shelfFreq)
  const vh = 10 ** (3.999_843_853_973_347 / 20)
  const a0 = 1 + Math.SQRT2 * k + k * k
  const shelf = biquad(
    (vh + Math.sqrt(2 * vh) * k + k * k) / a0,
    2 * (k * k - vh) / a0,
    (vh - Math.sqrt(2 * vh) * k + k * k) / a0,
    2 * (k * k - 1) / a0,
    (1 - Math.SQRT2 * k + k * k) / a0,
  )
  const g = w(highpassFreq)
  const hpA0 = 1 + Math.SQRT2 * g + g * g
  const highpass = biquad(
    1 / hpA0,
    -2 / hpA0,
    1 / hpA0,
    2 * (g * g - 1) / hpA0,
    (1 - Math.SQRT2 * g + g * g) / hpA0,
  )
  return { shelf, highpass }
}

function meanSquareToLufs(meanSquare: number): number {
  if (!(meanSquare > 0)) return -Infinity
  return -0.691 + 10 * Math.log10(meanSquare)
}

/**
 * Annex 2's 48-tap, four-phase true-peak interpolation filter. One input
 * sample advances a fixed 12-sample history; each phase is evaluated without
 * allocating. This exposes inter-sample peaks that linear interpolation
 * cannot reveal.
 */
const TRUE_PEAK_PHASE_TAPS = Object.freeze([
  Object.freeze([0.0017089843750, -0.0291748046875, -0.0189208984375, -0.0083007812500]),
  Object.freeze([0.0109863281250, 0.0292968750000, 0.0330810546875, 0.0148925781250]),
  Object.freeze([-0.0196533203125, -0.0517578125000, -0.0582275390625, -0.0266113281250]),
  Object.freeze([0.0332031250, 0.0891113281250, 0.1015625, 0.0476074218750]),
  Object.freeze([-0.0594482421875, -0.16650390625, -0.2003173828125, -0.1022949218750]),
  Object.freeze([0.1373291015625, 0.4650878906250, 0.77978515625, 0.97216796875]),
  Object.freeze([0.97216796875, 0.77978515625, 0.4650878906250, 0.1373291015625]),
  Object.freeze([-0.1022949218750, -0.2003173828125, -0.16650390625, -0.0594482421875]),
  Object.freeze([0.0476074218750, 0.1015625, 0.0891113281250, 0.0332031250]),
  Object.freeze([-0.0266113281250, -0.0582275390625, -0.0517578125, -0.0196533203125]),
  Object.freeze([0.0148925781250, 0.0330810546875, 0.0292968750, 0.0109863281250]),
  Object.freeze([-0.00830078125, -0.0189208984375, -0.0291748046875, 0.0017089843750]),
] as const)

function advanceTruePeak(history: Float64Array, sample: number): number {
  history.copyWithin(1, 0, history.length - 1)
  history[0] = sample
  let peak = Math.abs(sample)
  for (let phase = 0; phase < 4; phase++) {
    let interpolated = 0
    for (let tap = 0; tap < TRUE_PEAK_PHASE_TAPS.length; tap++) {
      interpolated += history[tap] * TRUE_PEAK_PHASE_TAPS[tap][phase]
    }
    peak = Math.max(peak, Math.abs(interpolated))
  }
  return peak
}

function truePeakWithTail(
  measured: number,
  leftHistory: Float64Array,
  rightHistory: Float64Array,
): number {
  const left = leftHistory.slice()
  const right = rightHistory.slice()
  let peak = measured
  for (let index = 1; index < TRUE_PEAK_PHASE_TAPS.length; index++) {
    peak = Math.max(
      peak,
      advanceTruePeak(left, 0),
      advanceTruePeak(right, 0),
    )
  }
  return peak
}

export class LoudnessMeter {
  private readonly expectedSamples: number
  private readonly shelfL: Biquad
  private readonly shelfR: Biquad
  private readonly hpL: Biquad
  private readonly hpR: Biquad
  private readonly blockSize: number
  private readonly hopSize: number
  private readonly block: number[] = []
  private readonly gatingSquares: number[] = []
  private measuredSamples = 0
  private truePeak = 0
  private readonly truePeakHistoryL = new Float64Array(TRUE_PEAK_PHASE_TAPS.length)
  private readonly truePeakHistoryR = new Float64Array(TRUE_PEAK_PHASE_TAPS.length)

  constructor(sampleRate: number, expectedSamples: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('loudness sample rate must be a positive finite number')
    }
    if (!Number.isSafeInteger(expectedSamples) || expectedSamples < 0) {
      throw new RangeError('expected sample count must be a non-negative safe integer')
    }
    this.expectedSamples = expectedSamples
    const filters = kWeightingFilters(sampleRate)
    this.shelfL = { ...filters.shelf }
    this.shelfR = { ...filters.shelf }
    this.hpL = { ...filters.highpass }
    this.hpR = { ...filters.highpass }
    this.blockSize = Math.max(1, Math.round(LOUDNESS_BLOCK_SECONDS * sampleRate))
    this.hopSize = Math.max(1, Math.round(LOUDNESS_HOP_SECONDS * sampleRate))
  }

  process(left: Float32Array, right: Float32Array): void {
    if (left.length !== right.length) {
      throw new RangeError('loudness blocks must have matching stereo lengths')
    }
    for (let i = 0; i < left.length; i++) {
      const l = left[i]
      const r = right[i]
      this.truePeak = Math.max(
        this.truePeak,
        advanceTruePeak(this.truePeakHistoryL, l),
        advanceTruePeak(this.truePeakHistoryR, r),
      )
      const weightedL = processBiquad(processBiquad(l, this.shelfL), this.hpL)
      const weightedR = processBiquad(processBiquad(r, this.shelfR), this.hpR)
      // BS.1770 sums the weighted channel energies. Averaging stereo here
      // would under-report ordinary two-channel programme by 3.0103 LU.
      this.block.push(weightedL * weightedL + weightedR * weightedR)
      this.measuredSamples += 1
      if (this.block.length >= this.blockSize) {
        let sum = 0
        for (const value of this.block) sum += value
        this.gatingSquares.push(sum / this.block.length)
        this.block.splice(0, this.hopSize)
      }
    }
  }

  result(): LoudnessMeasurement {
    const coverage: LoudnessCoverage = this.measuredSamples >= this.expectedSamples
      && this.expectedSamples > 0
      ? 'complete'
      : 'incomplete'
    const truePeak = truePeakWithTail(
      this.truePeak,
      this.truePeakHistoryL,
      this.truePeakHistoryR,
    )
    const truePeakDbtp = truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity
    if (this.gatingSquares.length === 0) {
      return {
        integratedLufs: null,
        truePeakDbtp: Number.isFinite(truePeakDbtp) ? truePeakDbtp : null,
        coverage,
        measuredSamples: this.measuredSamples,
        expectedSamples: this.expectedSamples,
      }
    }
    const absGated = this.gatingSquares.filter((meanSquare) =>
      meanSquareToLufs(meanSquare) > LOUDNESS_ABSOLUTE_GATE_LUFS,
    )
    const ungatedMean = absGated.length === 0
      ? 0
      : absGated.reduce((sum, value) => sum + value, 0) / absGated.length
    const relativeThreshold = meanSquareToLufs(ungatedMean) + LOUDNESS_RELATIVE_GATE_LU
    const gated = absGated.filter((meanSquare) =>
      meanSquareToLufs(meanSquare) > relativeThreshold,
    )
    const gatedMean = gated.length === 0
      ? ungatedMean
      : gated.reduce((sum, value) => sum + value, 0) / gated.length
    const integratedLufs = gatedMean > 0 ? meanSquareToLufs(gatedMean) : null
    return {
      integratedLufs: integratedLufs !== null && Number.isFinite(integratedLufs)
        ? integratedLufs
        : null,
      truePeakDbtp: Number.isFinite(truePeakDbtp) ? truePeakDbtp : null,
      coverage,
      measuredSamples: this.measuredSamples,
      expectedSamples: this.expectedSamples,
    }
  }
}

export function normalizeGainFromLufs(
  measuredLufs: number,
  targetLufs: number,
  currentVolume: number,
): number {
  const delta = targetLufs - measuredLufs
  const next = currentVolume * 10 ** (delta / 20)
  if (!Number.isFinite(next)) return currentVolume
  return Math.min(2, Math.max(0, next))
}
