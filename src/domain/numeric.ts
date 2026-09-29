/**
 * Small numeric guards shared by every layer (pure TypeScript). Callers keep
 * their own limits; the require* helpers share one RangeError wording.
 */

/** `value` limited to [minimum, maximum]; NaN stays NaN. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A finite number within the inclusive range. */
export function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return isFiniteNumber(value) && value >= minimum && value <= maximum
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Return `value`, or throw "`label` must be a positive safe integer". */
export function requirePositiveSafeInteger(value: number, label: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

/** Return `value`, or throw "`label` must be a non-negative safe integer". */
export function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

/** Ceiling division for a non-negative numerator and a positive denominator. */
export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}
