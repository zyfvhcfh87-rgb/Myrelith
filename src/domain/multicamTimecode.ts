/** Pure normalized timecode validation and arithmetic; metadata trust belongs to the app adapter. */
import type { FrameRate } from './schema'
import { alignmentRateIsSupported } from './multicamAlignment'

export interface TimecodeEvidence {
  readonly format: 'normalized-timecode-v1'
  readonly label: string
  readonly rate: FrameRate
  readonly counting: 'non-drop'
  readonly origin: 'presentation-frame-zero'
  readonly continuity: 'continuous'
  readonly dayOffset: 0
  /** The app adapter supplies this after explicit shared-clock/day confirmation. */
  readonly clockDomain: string
}

type TimecodeFailure =
  | 'invalid-record' | 'unknown-rate' | 'unsupported-semantics' | 'invalid-label'
  | 'different-clocks' | 'different-rates'

export type TimecodeParseResult =
  | { readonly state: 'valid'; readonly evidence: TimecodeEvidence; readonly frameCount: number }
  | { readonly state: 'unavailable'; readonly reason: TimecodeFailure }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => keys.includes(key))
}

/** Validating this normalized record cannot establish that its semantic claims are true. */
export function parseTimecode(value: unknown): TimecodeParseResult {
  if (!record(value) || !exactKeys(value, [
    'format', 'label', 'rate', 'counting', 'origin', 'continuity', 'dayOffset', 'clockDomain',
  ]) || value.format !== 'normalized-timecode-v1') {
    return { state: 'unavailable', reason: 'invalid-record' }
  }
  if (
    !record(value.rate) || !exactKeys(value.rate, ['num', 'den'])
    || typeof value.rate.num !== 'number' || typeof value.rate.den !== 'number'
    || !alignmentRateIsSupported({ num: value.rate.num, den: value.rate.den })
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
  const evidence: TimecodeEvidence = {
    format: 'normalized-timecode-v1', label: value.label,
    rate: { num: value.rate.num, den: value.rate.den }, counting: 'non-drop',
    origin: 'presentation-frame-zero', continuity: 'continuous', dayOffset: 0,
    clockDomain: value.clockDomain,
  }
  return {
    state: 'valid', evidence,
    frameCount: ((hours * 60 + minutes) * 60 + seconds) * nominalRate + frames,
  }
}

export function alignTimecodes(
  reference: unknown,
  target: unknown,
  projectRate: FrameRate,
): { readonly state: 'aligned'; readonly offsetFrames: number }
  | { readonly state: 'unavailable'; readonly reason: TimecodeFailure } {
  const ref = parseTimecode(reference)
  if (ref.state === 'unavailable') return ref
  const other = parseTimecode(target)
  if (other.state === 'unavailable') return other
  if (ref.evidence.clockDomain !== other.evidence.clockDomain) {
    return { state: 'unavailable', reason: 'different-clocks' }
  }
  if (
    !alignmentRateIsSupported(projectRate)
    || [ref.evidence.rate, other.evidence.rate].some((rate) => (
      rate.num !== projectRate.num || rate.den !== projectRate.den
    ))
  ) return { state: 'unavailable', reason: 'different-rates' }
  return { state: 'aligned', offsetFrames: other.frameCount - ref.frameCount }
}
