import type { FrameRate, MediaSourceBounds, SourceTimestampBounds } from '../schema';
import { LENS_CORRECTION_MODEL_VERSION, lensCorrectionValidationError, type LensCorrectionIntent, type ManualLensCorrectionModel } from '../lensCorrection';
import { PROJECT_FILE_LIMITS, ProjectFileError } from './projectTypes';

export type JsonRecord = Record<string, unknown>

export function fail(path: string, problem: string): never {
  throw new ProjectFileError(`${path}: ${problem}`)
}

export function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(path, 'expected an object')
  return value
}

export function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(path, `missing field ${key}`)
    }
  }
}

export function stringValue(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string') fail(path, 'expected a string')
  if (value.length > maxLength) fail(path, `exceeds ${maxLength} characters`)
  if (!allowEmpty && value.trim().length === 0) fail(path, 'must not be empty')
}

export function booleanValue(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
}

export function safeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `expected a safe integer from ${minimum} to ${maximum}`)
  }
}

export function finiteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `expected a finite number from ${minimum} to ${maximum}`)
  }
}

interface LensIntentBudget {
  entries: number
  stringCharacters: number
}

export function validateLensIntentJson(
  value: unknown,
  path: string,
  depth: number,
  budget: LensIntentBudget,
): void {
  if (depth > PROJECT_FILE_LIMITS.maxLensIntentDepth) {
    fail(path, `exceeds ${PROJECT_FILE_LIMITS.maxLensIntentDepth} nested levels`)
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'expected a finite JSON number')
    return
  }
  if (typeof value === 'string') {
    budget.stringCharacters += value.length
    if (budget.stringCharacters > PROJECT_FILE_LIMITS.maxLensIntentStringCharacters) {
      fail(path, `exceeds ${PROJECT_FILE_LIMITS.maxLensIntentStringCharacters} string characters`)
    }
    return
  }
  if (Array.isArray(value)) {
    budget.entries += value.length
    if (budget.entries > PROJECT_FILE_LIMITS.maxLensIntentEntries) {
      fail(path, `exceeds ${PROJECT_FILE_LIMITS.maxLensIntentEntries} entries`)
    }
    for (let index = 0; index < value.length; index++) {
      validateLensIntentJson(value[index], `${path}[${index}]`, depth + 1, budget)
    }
    return
  }
  const object = record(value, path)
  const keys = Object.keys(object)
  budget.entries += keys.length
  if (budget.entries > PROJECT_FILE_LIMITS.maxLensIntentEntries) {
    fail(path, `exceeds ${PROJECT_FILE_LIMITS.maxLensIntentEntries} entries`)
  }
  for (const key of keys) {
    if (key.length === 0 || key.length > PROJECT_FILE_LIMITS.maxLensIntentKeyCharacters) {
      fail(`${path}.${key}`, 'lens intent key is empty or too long')
    }
    validateLensIntentJson(object[key], `${path}.${key}`, depth + 1, budget)
  }
}

export function validateLensCorrectionIntent(
  value: unknown,
  path: string,
): asserts value is LensCorrectionIntent | null {
  if (value === null) return
  const intent = record(value, path)
  safeInteger(intent.version, `${path}.version`, 1)
  if (intent.version !== LENS_CORRECTION_MODEL_VERSION) {
    validateLensIntentJson(intent, path, 0, { entries: 0, stringCharacters: 0 })
    return
  }
  exactKeys(
    intent,
    [
      'version',
      'centerX',
      'centerY',
      'focalX',
      'focalY',
      'k1',
      'k2',
      'k3',
      'p1',
      'p2',
      'strength',
      'outputScale',
    ],
    [],
    path,
  )
  const error = lensCorrectionValidationError(intent as unknown as ManualLensCorrectionModel)
  if (error) fail(path, error)
}

export function boundedArray(
  value: unknown,
  path: string,
  maximum: number,
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  if (value.length > maximum) fail(path, `exceeds ${maximum} entries`)
}

export function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

export function validateFrameRate(value: unknown, path: string): asserts value is FrameRate {
  const candidate = record(value, path)
  exactKeys(candidate, ['num', 'den'], [], path)
  safeInteger(candidate.num, `${path}.num`, 1, PROJECT_FILE_LIMITS.maxRatePart)
  safeInteger(candidate.den, `${path}.den`, 1, PROJECT_FILE_LIMITS.maxRatePart)
  if (greatestCommonDivisor(candidate.num, candidate.den) !== 1) {
    fail(path, 'frame rate must be reduced to an exact rational')
  }
  if (candidate.num / candidate.den > PROJECT_FILE_LIMITS.maxFramesPerSecond) {
    fail(path, `frame rate exceeds ${PROJECT_FILE_LIMITS.maxFramesPerSecond} fps`)
  }
}

export function validateNullableFrameRate(
  value: unknown,
  path: string,
): asserts value is FrameRate | null {
  if (value !== null) validateFrameRate(value, path)
}

export function validateNullableSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number | null {
  if (value !== null) safeInteger(value, path, minimum, maximum)
}

export function validateSourceTimestampBounds(
  value: unknown,
  path: string,
): asserts value is SourceTimestampBounds {
  const bounds = record(value, path)
  if (bounds.status === 'unknown') {
    exactKeys(bounds, ['status'], [], path)
    return
  }
  if (bounds.status !== 'exact') {
    fail(`${path}.status`, 'expected exact or unknown')
  }
  exactKeys(bounds, ['status', 'firstTimestampUs', 'endTimestampUs'], [], path)
  safeInteger(
    bounds.firstTimestampUs,
    `${path}.firstTimestampUs`,
    -Number.MAX_SAFE_INTEGER,
  )
  safeInteger(bounds.endTimestampUs, `${path}.endTimestampUs`, 0)
  if (bounds.endTimestampUs <= bounds.firstTimestampUs) {
    fail(path, 'endTimestampUs must be greater than firstTimestampUs')
  }
}

export function validateMediaSourceBounds(
  value: unknown,
  path: string,
): asserts value is MediaSourceBounds {
  const bounds = record(value, path)
  exactKeys(bounds, ['video', 'audio'], [], path)
  if (bounds.video !== null) {
    validateSourceTimestampBounds(bounds.video, `${path}.video`)
  }
  if (bounds.audio !== null) {
    validateSourceTimestampBounds(bounds.audio, `${path}.audio`)
  }
}
