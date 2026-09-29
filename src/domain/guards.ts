/**
 * Small shape guards for untrusted data, shared by every layer (pure
 * TypeScript). Parsers keep their own messages and limits.
 */

/** A non-null, non-array object of any prototype. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** isRecord restricted to plain data: the prototype is Object.prototype or null. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The own enumerable string keys are exactly `expected`, in any order. */
export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length
    && keys.every((key) => expected.includes(key))
}

/** A string of at most `maximum` UTF-16 units, non-empty unless allowed. */
export function isBoundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** A bare lowercase hexadecimal SHA-256 digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value)
}
