/** Deterministic synthetic quality fixtures; deliberately excluded from product entry graphs. */
import {
  MULTICAM_ALIGNMENT_LIMITS,
  createAudioFingerprintBuilder,
  correlateAudioFingerprints,
  type AudioAlignmentResult,
  type AudioFingerprint,
} from './multicamAlignment'
import type { FrameRate } from './schema'

export type ResearchAudioFixtureKind =
  | 'coded-tone' | 'speech-shaped' | 'noise' | 'steady-tone' | 'silence' | 'repeated'

function noise(index: number, seed: number): number {
  let value = Math.imul(index ^ seed, 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000
}

/** A deterministic sample function, independent of PCM block boundaries. */
export function researchFixtureSample(kind: ResearchAudioFixtureKind, seconds: number, seed = 37): number {
  const tone = Math.sin(2 * Math.PI * 440 * seconds)
  if (kind === 'silence') return 0
  if (kind === 'steady-tone') return 0.5 * tone
  if (kind === 'repeated') {
    return (0.05 + 0.4 * (1 + Math.sin(2 * Math.PI * 2 * seconds))) * tone
  }
  // Irregular 20 ms amplitude events yield a unique timing signature, not a repeated carrier.
  const envelope = 0.015 + 0.7 * noise(Math.floor(seconds * 50), seed) ** 2
  if (kind === 'coded-tone') return envelope * tone
  const breath = 2 * noise(Math.floor(seconds * 8_000), seed + 19) - 1
  if (kind === 'noise') return envelope * breath
  // Voiced harmonics, breath and syllabic gaps. This is not recorded or synthesized human speech.
  const voiced = (
    Math.sin(2 * Math.PI * 117 * seconds)
    + 0.5 * Math.sin(2 * Math.PI * 234 * seconds)
    + 0.25 * Math.sin(2 * Math.PI * 351 * seconds)
  ) / 1.75
  const syllable = noise(Math.floor(seconds * 4), seed + 47) > 0.25 ? 1 : 0.06
  return envelope * syllable * (0.85 * voiced + 0.15 * breath)
}

export interface ResearchAudioFixtureOptions {
  readonly kind?: ResearchAudioFixtureKind
  readonly inputSampleRate?: number
  readonly channels?: 1 | 2
  readonly startSeconds?: number
  readonly durationSeconds?: number
  /** Where this recording's source zero occurs on the shared event clock. */
  readonly recordingStartSeconds?: number
  readonly gain?: number
  readonly invertRightChannel?: boolean
  readonly seed?: number
  readonly blockFrames?: number
}

export function createResearchAudioFixture(
  options: ResearchAudioFixtureOptions = {},
): AudioFingerprint {
  const {
    kind = 'coded-tone', inputSampleRate = 48_000, channels = 1,
    startSeconds = 0, durationSeconds = 10, recordingStartSeconds = 0,
    gain = 1, invertRightChannel = false, seed = 37, blockFrames = 4_096,
  } = options
  const startSample = Math.round(startSeconds * inputSampleRate)
  const binCount = Math.round(durationSeconds * MULTICAM_ALIGNMENT_LIMITS.featureRate)
  const sampleCount = Math.ceil(binCount * inputSampleRate / MULTICAM_ALIGNMENT_LIMITS.featureRate)
  const builder = createAudioFingerprintBuilder({ inputSampleRate, channels, startSample, binCount })
  if (!Number.isSafeInteger(blockFrames) || blockFrames < 1 || blockFrames > 4_096) {
    throw new RangeError('Invalid fixture block size')
  }
  for (let index = 0; index < sampleCount; index += blockFrames) {
    const length = Math.min(blockFrames, sampleCount - index)
    const planes = Array.from({ length: channels }, () => new Float32Array(length))
    for (let frame = 0; frame < length; frame++) {
      const seconds = recordingStartSeconds + (startSample + index + frame) / inputSampleRate
      const value = gain * researchFixtureSample(kind, seconds, seed)
      planes[0][frame] = value
      if (planes[1]) planes[1][frame] = invertRightChannel ? -value : value
    }
    builder.push(planes, startSample + index)
  }
  return builder.finish()
}

export function runAudioCorrelation(
  reference: AudioFingerprint,
  target: AudioFingerprint,
  rate: FrameRate = { num: 30, den: 1 },
  maxLagBins: number = MULTICAM_ALIGNMENT_LIMITS.maxLagBins,
): { readonly result: AudioAlignmentResult; readonly yields: number; readonly maxWorkBetweenYields: number } {
  const iterator = correlateAudioFingerprints(reference, target, rate, maxLagBins)
  let yields = 0
  let lastComparisons = 0
  let maxWorkBetweenYields = 0
  for (;;) {
    const step = iterator.next()
    if (step.done) {
      maxWorkBetweenYields = Math.max(
        maxWorkBetweenYields, step.value.facts.comparisons - lastComparisons,
      )
      return { result: step.value, yields, maxWorkBetweenYields }
    }
    maxWorkBetweenYields = Math.max(maxWorkBetweenYields, step.value.comparisons - lastComparisons)
    lastComparisons = step.value.comparisons
    yields++
  }
}
