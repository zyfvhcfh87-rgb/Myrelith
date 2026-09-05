/** Strict normalized-evidence proof only. This is not a container parser or a trust boundary. */
import type { FrameRate } from './schema'
import { alignmentResearchRateIsSupported } from './multicamAlignmentResearch'

export interface ResearchTimecodeEvidence {
  readonly format: 'normalized-timecode-research-v1'
  readonly label: string
  readonly rate: FrameRate
  readonly counting: 'non-drop'
  readonly origin: 'presentation-frame-zero'
  readonly continuity: 'continuous'
  readonly dayOffset: 0
  /** Supplied by the fixture; a future metadata adapter must establish a shared basis. */
  readonly clockDomain: string
}

type TimecodeFailure =
  | 'invalid-record' | 'unknown-rate' | 'unsupported-semantics' | 'invalid-label'
  | 'different-clocks' | 'different-rates'

export type ResearchTimecodeParseResult =
  | { readonly state: 'valid'; readonly evidence: ResearchTimecodeEvidence; readonly frameCount: number }
  | { readonly state: 'unavailable'; readonly reason: TimecodeFailure }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => keys.includes(key))
}

/** Validating this normalized record cannot establish that its semantic claims are true. */
export function parseResearchTimecode(value: unknown): ResearchTimecodeParseResult {
  if (!record(value) || !exactKeys(value, [
    'format', 'label', 'rate', 'counting', 'origin', 'continuity', 'dayOffset', 'clockDomain',
  ]) || value.format !== 'normalized-timecode-research-v1') {
    return { state: 'unavailable', reason: 'invalid-record' }
  }
  if (
    !record(value.rate) || !exactKeys(value.rate, ['num', 'den'])
    || typeof value.rate.num !== 'number' || typeof value.rate.den !== 'number'
    || !alignmentResearchRateIsSupported({ num: value.rate.num, den: value.rate.den })
  ) return { state: 'unavailable', reason: 'unknown-rate' }
  if (
    value.counting !== 'non-drop' || value.origin !== 'presentation-frame-zero'
    || value.continuity !== 'continuous' || value.dayOffset !== 0
    || typeof value.clockDomain !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value.clockDomain)
  ) return { state: 'unavailable', reason: 'unsupported-semantics' }
  if (typeof value.label !== 'string' || !/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(value.label)) {
    return { state: 'unavailable', reason: 'invalid-label' }
  }
  const [hours, minutes, seconds, frames] = value.label.split(':').map(Number)
  const nominalRate = Math.ceil(value.rate.num / value.rate.den)
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= nominalRate) {
    return { state: 'unavailable', reason: 'invalid-label' }
  }
  const evidence: ResearchTimecodeEvidence = {
    format: 'normalized-timecode-research-v1', label: value.label,
    rate: { num: value.rate.num, den: value.rate.den }, counting: 'non-drop',
    origin: 'presentation-frame-zero', continuity: 'continuous', dayOffset: 0,
    clockDomain: value.clockDomain,
  }
  return {
    state: 'valid', evidence,
    frameCount: ((hours * 60 + minutes) * 60 + seconds) * nominalRate + frames,
  }
}

export function alignResearchTimecodes(
  reference: unknown,
  target: unknown,
  projectRate: FrameRate,
): { readonly state: 'aligned'; readonly offsetFrames: number }
  | { readonly state: 'unavailable'; readonly reason: TimecodeFailure } {
  const ref = parseResearchTimecode(reference)
  if (ref.state === 'unavailable') return ref
  const other = parseResearchTimecode(target)
  if (other.state === 'unavailable') return other
  if (ref.evidence.clockDomain !== other.evidence.clockDomain) {
    return { state: 'unavailable', reason: 'different-clocks' }
  }
  if (
    !alignmentResearchRateIsSupported(projectRate)
    || [ref.evidence.rate, other.evidence.rate].some((rate) => (
      rate.num !== projectRate.num || rate.den !== projectRate.den
    ))
  ) return { state: 'unavailable', reason: 'different-rates' }
  return { state: 'aligned', offsetFrames: other.frameCount - ref.frameCount }
}
