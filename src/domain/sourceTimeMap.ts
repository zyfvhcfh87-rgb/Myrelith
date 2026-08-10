/**
 * Deterministic constant and piecewise-speed timeline-to-source mapping.
 *
 * Source positions use one million integer ticks per conformed source frame.
 * Constant rates are reduced 25%-step rationals from 1/4x through 4x. A
 * schema-12 speed curve adds bounded integer-frame handles, explicit freezes,
 * and fixed hold/linear/smooth integration. Every curve position is derived
 * from one integer-valued primitive, so split/trim origins telescope exactly
 * without a floating accumulator or hidden phase.
 */

import type {
  Clip,
  ClipAnimation,
  SourceTimeMap,
  SourceTimeRate,
  SourceTimeSpeedCurve,
  SourceTimeSpeedEasing,
  SourceTimeSpeedPoint,
  TimeRange,
} from './schema'
import { MAX_KEYFRAME_FRAME } from './clipAnimation'

export const SOURCE_TIME_TICKS_PER_FRAME = 1_000_000 as const
export const MIN_SOURCE_TIME_RATE: Readonly<SourceTimeRate> = Object.freeze({
  numerator: 1,
  denominator: 4,
})
export const MAX_SOURCE_TIME_RATE: Readonly<SourceTimeRate> = Object.freeze({
  numerator: 4,
  denominator: 1,
})
export const MAX_SOURCE_TIME_RATE_TERM = 1_000
export const MAX_SOURCE_TIME_SPEED_POINTS = 256
export const MAX_SOURCE_TIME_SPEED_FRAME = 1_000_000_000
export const SOURCE_TIME_SPEED_EASINGS = Object.freeze([
  'hold',
  'linear',
  'smooth',
] as const satisfies readonly SourceTimeSpeedEasing[])

const SPEED_EASING_SET = new Set<SourceTimeSpeedEasing>(SOURCE_TIME_SPEED_EASINGS)

const TICKS = BigInt(SOURCE_TIME_TICKS_PER_FRAME)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return remainder < 0n ? quotient - 1n : quotient
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return -floorDiv(-numerator, denominator)
}

function safeNumber(value: bigint, label: string): number {
  if (value < -MAX_SAFE || value > MAX_SAFE) {
    throw new RangeError(`${label} exceeds the safe integer range`)
  }
  return Number(value)
}

export function canonicalSourceTimeRate(
  numerator: number,
  denominator: number,
): SourceTimeRate {
  if (
    !Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator <= 0
    || denominator <= 0
    || numerator > MAX_SOURCE_TIME_RATE_TERM
    || denominator > MAX_SOURCE_TIME_RATE_TERM
  ) {
    throw new RangeError(
      `Source-time rate terms must be positive safe integers at most ${MAX_SOURCE_TIME_RATE_TERM}`,
    )
  }
  const divisor = greatestCommonDivisor(numerator, denominator)
  const rate = {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  }
  if (
    rate.numerator * MIN_SOURCE_TIME_RATE.denominator
      < MIN_SOURCE_TIME_RATE.numerator * rate.denominator
    || rate.numerator * MAX_SOURCE_TIME_RATE.denominator
      > MAX_SOURCE_TIME_RATE.numerator * rate.denominator
  ) {
    throw new RangeError('Source-time rate must be from 1/4x through 4x')
  }
  const percentNumerator = rate.numerator * 100
  if (
    percentNumerator % rate.denominator !== 0
    || (percentNumerator / rate.denominator) % 25 !== 0
  ) {
    throw new RangeError(
      'Source-time rate must use a whole 25% step at the fixed source-time tick precision',
    )
  }
  return rate
}

export function sourceTimeRateValidationError(
  value: SourceTimeRate,
): string | null {
  try {
    const canonical = canonicalSourceTimeRate(value.numerator, value.denominator)
    if (
      canonical.numerator !== value.numerator
      || canonical.denominator !== value.denominator
    ) return 'rate must be stored in canonical reduced form'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid source-time rate'
  }
}

export function sourceTimeSpeedRateValidationError(
  value: SourceTimeRate,
): string | null {
  if (value.numerator === 0 && value.denominator === 1) return null
  return sourceTimeRateValidationError(value)
}

export function sourceTimeSpeedRateFromPercent(percent: number): SourceTimeRate {
  if (percent === 0) return { numerator: 0, denominator: 1 }
  return sourceTimeRateFromPercent(percent)
}

export function sourceTimeSpeedRatePercent(rate: SourceTimeRate): number {
  const error = sourceTimeSpeedRateValidationError(rate)
  if (error) throw new RangeError(error)
  return rate.numerator === 0
    ? 0
    : (rate.numerator * 100) / rate.denominator
}

export function defaultSourceTimeSpeedCurve(): SourceTimeSpeedCurve {
  return { originFrame: 0, points: [] }
}

function speedCurveValidationError(
  curve: SourceTimeSpeedCurve | undefined,
): string | null {
  if (curve === undefined) return null
  if (
    !Number.isSafeInteger(curve.originFrame)
    || curve.originFrame < -MAX_SOURCE_TIME_SPEED_FRAME
    || curve.originFrame > MAX_SOURCE_TIME_SPEED_FRAME
  ) {
    return `speedCurve.originFrame must be a safe integer from ${-MAX_SOURCE_TIME_SPEED_FRAME} to ${MAX_SOURCE_TIME_SPEED_FRAME}`
  }
  if (!Array.isArray(curve.points)) return 'speedCurve.points must be an array'
  if (curve.points.length > MAX_SOURCE_TIME_SPEED_POINTS) {
    return `speedCurve supports at most ${MAX_SOURCE_TIME_SPEED_POINTS} points`
  }
  if (curve.points.length === 0 && curve.originFrame !== 0) {
    return 'an empty speed curve must use originFrame 0'
  }
  let previousFrame: number | null = null
  for (const point of curve.points) {
    if (
      !Number.isSafeInteger(point.frame)
      || point.frame < -MAX_SOURCE_TIME_SPEED_FRAME
      || point.frame > MAX_SOURCE_TIME_SPEED_FRAME
    ) {
      return `speed point frame must be a safe integer from ${-MAX_SOURCE_TIME_SPEED_FRAME} to ${MAX_SOURCE_TIME_SPEED_FRAME}`
    }
    if (previousFrame !== null && point.frame <= previousFrame) {
      return 'speed point frames must be strictly increasing without duplicates'
    }
    const rateError = sourceTimeSpeedRateValidationError(point.rate)
    if (rateError) return `speed point at frame ${point.frame}: ${rateError}`
    if (!SPEED_EASING_SET.has(point.easing)) {
      return `speed point at frame ${point.frame} has unsupported easing`
    }
    previousFrame = point.frame
  }
  if (
    curve.points.length > 0
    && curve.points[curve.points.length - 1]!.rate.numerator === 0
  ) {
    return 'the final speed point must be positive so the mapped duration is finite'
  }
  return null
}

export function sourceTimeSpeedCurveValidationError(
  curve: SourceTimeSpeedCurve | undefined,
): string | null {
  return speedCurveValidationError(curve)
}

function sourceTimeMapBaseValidationError(value: SourceTimeMap): string | null {
  if (
    !Number.isSafeInteger(value.sourceStartTicks)
    || value.sourceStartTicks < 0
  ) return 'sourceStartTicks must be a non-negative safe integer'
  if (
    !Number.isSafeInteger(value.sourceDurationTicks)
    || value.sourceDurationTicks < 1
    || !Number.isSafeInteger(value.sourceStartTicks + value.sourceDurationTicks)
  ) return 'sourceDurationTicks must be a positive safe integer span'
  return sourceTimeRateValidationError(value.rate)
}

export function sourceTimeMapValidationError(value: SourceTimeMap): string | null {
  return sourceTimeMapBaseValidationError(value)
    ?? speedCurveValidationError(value.speedCurve)
}

export function sourceTimeRateFromPercent(percent: number): SourceTimeRate {
  if (!Number.isSafeInteger(percent) || percent % 25 !== 0) {
    throw new RangeError('Speed percent must be a whole 25% step')
  }
  return canonicalSourceTimeRate(percent, 100)
}

export function sourceTimeRatePercent(rate: SourceTimeRate): number {
  const error = sourceTimeRateValidationError(rate)
  if (error) throw new RangeError(error)
  return (rate.numerator * 100) / rate.denominator
}

export function isUnitySourceTimeRate(rate: SourceTimeRate): boolean {
  return rate.numerator === rate.denominator
}

export function defaultSourceTimeMap(
  sourceStartFrame = 0,
  sourceDurationFrames = 1,
): SourceTimeMap {
  if (
    !Number.isSafeInteger(sourceStartFrame)
    || sourceStartFrame < 0
    || !Number.isSafeInteger(sourceDurationFrames)
    || sourceDurationFrames < 1
  ) {
    throw new RangeError('Source range must use non-negative safe integer frames')
  }
  const sourceStartTicks = safeNumber(
    BigInt(sourceStartFrame) * TICKS,
    'Source-time origin',
  )
  const sourceDurationTicks = safeNumber(
    BigInt(sourceDurationFrames) * TICKS,
    'Source-time duration',
  )
  return {
    sourceStartTicks,
    sourceDurationTicks,
    rate: { numerator: 1, denominator: 1 },
    speedCurve: defaultSourceTimeSpeedCurve(),
  }
}

/** Legacy-tolerant accessor; persisted schema-11 clips never need fallback. */
export function clipSourceTimeMap(clip: Clip): SourceTimeMap {
  return clip.sourceTimeMap ?? defaultSourceTimeMap(
    clip.sourceRange.startFrame,
    clip.sourceRange.durationFrames,
  )
}

export function cloneSourceTimeMap(map: SourceTimeMap): SourceTimeMap {
  const speedCurve = map.speedCurve ?? defaultSourceTimeSpeedCurve()
  return {
    sourceStartTicks: map.sourceStartTicks,
    sourceDurationTicks: map.sourceDurationTicks,
    rate: { ...map.rate },
    speedCurve: {
      originFrame: speedCurve.originFrame,
      points: speedCurve.points.map((point) => ({
        frame: point.frame,
        rate: { ...point.rate },
        easing: point.easing,
      })),
    },
  }
}

function constantRateTicks(rate: SourceTimeRate, frames: number): bigint {
  return floorDiv(
    BigInt(frames) * BigInt(rate.numerator) * TICKS,
    BigInt(rate.denominator),
  )
}

/**
 * Integer-valued primitive for one curve segment. Every caller subtracts
 * values from this same left-edge primitive, so trim/split composition
 * telescopes even when the exact polynomial lands between source ticks.
 */
function segmentPrimitiveTicks(
  left: SourceTimeRate,
  right: SourceTimeRate,
  easing: SourceTimeSpeedEasing,
  segmentFrames: number,
  offsetFrames: number,
): bigint {
  if (easing === 'hold') return constantRateTicks(left, offsetFrames)

  const length = BigInt(segmentFrames)
  const offset = BigInt(offsetFrames)
  const commonDenominator = BigInt(left.denominator) * BigInt(right.denominator)
  const leftNumerator = BigInt(left.numerator) * BigInt(right.denominator)
  const rightNumerator = BigInt(right.numerator) * BigInt(left.denominator)
  const deltaNumerator = rightNumerator - leftNumerator

  if (easing === 'linear') {
    const denominator = commonDenominator * 2n * length
    const numerator = leftNumerator * offset * 2n * length
      + deltaNumerator * offset * offset
    return floorDiv(numerator * TICKS, denominator)
  }

  const lengthSquared = length * length
  const lengthCubed = lengthSquared * length
  const offsetSquared = offset * offset
  const offsetCubed = offsetSquared * offset
  const offsetFourth = offsetCubed * offset
  const denominator = commonDenominator * 2n * lengthCubed
  const numerator = leftNumerator * offset * 2n * lengthCubed
    + deltaNumerator * (2n * offsetCubed * length - offsetFourth)
  return floorDiv(numerator * TICKS, denominator)
}

function integrateCurveForward(
  curve: SourceTimeSpeedCurve,
  startFrame: number,
  endFrame: number,
): bigint {
  if (endFrame <= startFrame) return 0n
  const points = curve.points
  let cursor = startFrame
  let ticks = 0n
  while (cursor < endFrame) {
    const first = points[0]!
    if (cursor < first.frame) {
      const next = Math.min(endFrame, first.frame)
      ticks += constantRateTicks(first.rate, next - cursor)
      cursor = next
      continue
    }

    let pointIndex = points.length - 1
    for (let index = 0; index < points.length - 1; index++) {
      if (cursor < points[index + 1]!.frame) {
        pointIndex = index
        break
      }
    }
    const left = points[pointIndex]!
    const right = points[pointIndex + 1]
    if (!right) {
      ticks += constantRateTicks(left.rate, endFrame - cursor)
      break
    }

    const next = Math.min(endFrame, right.frame)
    const length = right.frame - left.frame
    const fromOffset = cursor - left.frame
    const toOffset = next - left.frame
    ticks += segmentPrimitiveTicks(
      left.rate,
      right.rate,
      left.easing,
      length,
      toOffset,
    ) - segmentPrimitiveTicks(
      left.rate,
      right.rate,
      left.easing,
      length,
      fromOffset,
    )
    cursor = next
  }
  return ticks
}

function curvePrimitiveTicks(
  curve: SourceTimeSpeedCurve,
  frame: number,
): bigint {
  return frame >= 0
    ? integrateCurveForward(curve, 0, frame)
    : -integrateCurveForward(curve, frame, 0)
}

function validSpeedCurve(map: SourceTimeMap): SourceTimeSpeedCurve | null {
  const curve = map.speedCurve
  return curve
    && curve.points.length > 0
    && speedCurveValidationError(curve) === null
    ? curve
    : null
}

export function sourceTimeMapUsesSpeedCurve(map: SourceTimeMap): boolean {
  return validSpeedCurve(map) !== null
}

export function sourceTimeMapHasInvalidSpeedCurve(map: SourceTimeMap): boolean {
  return map.speedCurve !== undefined
    && speedCurveValidationError(map.speedCurve) !== null
}

/** Exact fixed-point source position at one signed clip-local frame offset. */
export function sourceTicksAtTimelineOffset(
  map: SourceTimeMap,
  timelineOffsetFrames: number,
): number {
  const error = sourceTimeMapBaseValidationError(map)
  if (error) throw new RangeError(error)
  if (!Number.isSafeInteger(timelineOffsetFrames)) {
    throw new RangeError('Timeline offset must be a safe integer')
  }
  const curve = validSpeedCurve(map)
  const delta = curve
    ? curvePrimitiveTicks(curve, curve.originFrame + timelineOffsetFrames)
      - curvePrimitiveTicks(curve, curve.originFrame)
    : constantRateTicks(map.rate, timelineOffsetFrames)
  return safeNumber(BigInt(map.sourceStartTicks) + delta, 'Mapped source time')
}

/** Decode-frame choice is the source frame containing the exact source time. */
export function sourceFrameAtTimelineOffset(
  map: SourceTimeMap,
  timelineOffsetFrames: number,
): number {
  const ticks = sourceTicksAtTimelineOffset(map, timelineOffsetFrames)
  return safeNumber(floorDiv(BigInt(ticks), TICKS), 'Mapped source frame')
}

export function sourceFrameAtTimelineFrame(clip: Clip, timelineFrame: number): number {
  if (!Number.isSafeInteger(timelineFrame)) {
    throw new RangeError('Timeline frame must be a safe integer')
  }
  if (clip.sourceMode === 'still') return 0
  return sourceFrameAtTimelineOffset(
    clipSourceTimeMap(clip),
    timelineFrame - clip.timelineRange.startFrame,
  )
}

/** Shift the affine origin without changing rate or performing float math. */
export function sourceTimeMapAtOffset(
  map: SourceTimeMap,
  timelineOffsetFrames: number,
): SourceTimeMap {
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)
  const sourceStartTicks = sourceTicksAtTimelineOffset(map, timelineOffsetFrames)
  const consumedTicks = sourceStartTicks - map.sourceStartTicks
  const sourceDurationTicks = map.sourceDurationTicks - consumedTicks
  if (
    !Number.isSafeInteger(sourceDurationTicks)
    || sourceDurationTicks < 1
  ) throw new RangeError('Mapped source span must remain positive')
  const next = cloneSourceTimeMap(map)
  next.sourceStartTicks = sourceStartTicks
  next.sourceDurationTicks = sourceDurationTicks
  if (next.speedCurve && next.speedCurve.points.length > 0) {
    const originFrame = next.speedCurve.originFrame + timelineOffsetFrames
    if (
      !Number.isSafeInteger(originFrame)
      || originFrame < -MAX_SOURCE_TIME_SPEED_FRAME
      || originFrame > MAX_SOURCE_TIME_SPEED_FRAME
    ) throw new RangeError('Shifted speed-curve origin exceeds authored frame bounds')
    next.speedCurve.originFrame = originFrame
  }
  return next
}

/** Replace the exact out-point with the mapped end of a timeline duration. */
export function sourceTimeMapForTimelineDuration(
  map: SourceTimeMap,
  timelineDurationFrames: number,
): SourceTimeMap {
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)
  const mappedDurationTicks = sourceTicksAtTimelineOffset(
    map,
    timelineDurationFrames,
  ) - map.sourceStartTicks
  const sourceDurationTicks = Math.max(1, mappedDurationTicks)
  return { ...cloneSourceTimeMap(map), sourceDurationTicks }
}

/** Integer source-frame envelope touched by a half-open mapped clip interval. */
export function sourceRangeForMap(
  map: SourceTimeMap,
  timelineDurationFrames: number,
): TimeRange {
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)
  if (!Number.isSafeInteger(timelineDurationFrames) || timelineDurationFrames < 1) {
    throw new RangeError('Timeline duration must be a positive safe integer')
  }
  const startTicks = BigInt(map.sourceStartTicks)
  const mappedEndTicks = BigInt(
    sourceTicksAtTimelineOffset(map, timelineDurationFrames),
  )
  const endTicks = startTicks + BigInt(map.sourceDurationTicks)
  if (mappedEndTicks > endTicks) {
    throw new RangeError('Timeline duration exceeds the preserved source span')
  }
  if (startTicks < 0n || endTicks <= startTicks) {
    throw new RangeError('Mapped source interval must be positive')
  }
  const startFrame = safeNumber(floorDiv(startTicks, TICKS), 'Source-range start')
  const endFrame = safeNumber(ceilDiv(endTicks, TICKS), 'Source-range end')
  return { startFrame, durationFrames: endFrame - startFrame }
}

export function sourceSpanTicks(
  map: SourceTimeMap,
): number {
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)
  return map.sourceDurationTicks
}

/** Maximum whole timeline frames that fit in an exact source-tick capacity. */
export function timelineFramesWithinSourceTicks(
  availableSourceTicks: number,
  rate: SourceTimeRate,
): number {
  if (!Number.isSafeInteger(availableSourceTicks) || availableSourceTicks < 0) {
    throw new RangeError('Available source ticks must be a non-negative safe integer')
  }
  const error = sourceTimeRateValidationError(rate)
  if (error) throw new RangeError(error)
  return safeNumber(
    floorDiv(
      BigInt(availableSourceTicks) * BigInt(rate.denominator),
      BigInt(rate.numerator) * TICKS,
    ),
    'Timeline capacity',
  )
}

function mappedDeltaTicks(
  map: SourceTimeMap,
  fromOffset: number,
  toOffset: number,
): number {
  return sourceTicksAtTimelineOffset(map, toOffset)
    - sourceTicksAtTimelineOffset(map, fromOffset)
}

function greatestMappedFrameWithin(
  map: SourceTimeMap,
  fromOffset: number,
  availableSourceTicks: number,
  direction: 1 | -1,
): number {
  if (!Number.isSafeInteger(availableSourceTicks) || availableSourceTicks < 0) {
    throw new RangeError('Available source ticks must be a non-negative safe integer')
  }
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)

  const curve = validSpeedCurve(map)
  if (curve && direction === -1 && curve.points[0]!.rate.numerator === 0) {
    const firstLocalFrame = curve.points[0]!.frame - curve.originFrame
    const framesToFirst = Math.max(0, fromOffset - firstLocalFrame)
    const ticksToFirst = mappedDeltaTicks(
      map,
      fromOffset - framesToFirst,
      fromOffset,
    )
    if (ticksToFirst <= availableSourceTicks) return Number.POSITIVE_INFINITY
  }

  const consumedAt = (frames: number): number => {
    try {
      return direction === 1
        ? mappedDeltaTicks(map, fromOffset, fromOffset + frames)
        : mappedDeltaTicks(map, fromOffset - frames, fromOffset)
    } catch {
      // Exponential probing may intentionally step beyond the safe mapped
      // range. Treat that probe as over capacity; the following binary search
      // still finds the exact greatest representable frame below it.
      return Number.POSITIVE_INFINITY
    }
  }

  let low = 0
  let high = 1
  while (consumedAt(high) <= availableSourceTicks) {
    low = high
    if (high > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
      return Number.POSITIVE_INFINITY
    }
    high *= 2
  }
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (consumedAt(middle) <= availableSourceTicks) low = middle
    else high = middle
  }
  return low
}

/** Greatest whole local duration whose mapped end fits the preserved span. */
export function timelineFramesWithinSourceMap(map: SourceTimeMap): number {
  return greatestMappedFrameWithin(map, 0, map.sourceDurationTicks, 1)
}

/** Exact source-handle capacity around any local timeline boundary. */
export function timelineFramesWithinMappedSourceTicks(
  map: SourceTimeMap,
  fromOffset: number,
  availableSourceTicks: number,
  direction: 1 | -1,
): number {
  if (!Number.isSafeInteger(fromOffset)) {
    throw new RangeError('Timeline offset must be a safe integer')
  }
  return greatestMappedFrameWithin(
    map,
    fromOffset,
    availableSourceTicks,
    direction,
  )
}

/**
 * Invert the monotone integer mapping over an explicit bounded interval.
 * Equal source positions created by a freeze choose the latest frame in the
 * plateau, matching floor-style constant-rate inversion deterministically.
 */
export function timelineOffsetAtSourceTicks(
  map: SourceTimeMap,
  sourceTicks: number,
  minimumOffset: number,
  maximumOffset: number,
): number | null {
  if (
    !Number.isSafeInteger(sourceTicks)
    || !Number.isSafeInteger(minimumOffset)
    || !Number.isSafeInteger(maximumOffset)
    || minimumOffset > maximumOffset
  ) return null
  const error = sourceTimeMapValidationError(map)
  if (error) return null
  let low = minimumOffset
  let high = maximumOffset
  let lowTicks: number
  let highTicks: number
  try {
    lowTicks = sourceTicksAtTimelineOffset(map, low)
    highTicks = sourceTicksAtTimelineOffset(map, high)
  } catch {
    return null
  }
  if (sourceTicks < lowTicks || sourceTicks > highTicks) return null
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2)
    let mapped: number
    try {
      mapped = sourceTicksAtTimelineOffset(map, middle)
    } catch {
      return null
    }
    if (mapped <= sourceTicks) low = middle
    else high = middle - 1
  }
  return low
}

export function sourceTimeMapIsAudioCompatible(map: SourceTimeMap): boolean {
  if (sourceTimeMapValidationError(map)) return false
  const curve = validSpeedCurve(map)
  return map.sourceStartTicks % SOURCE_TIME_TICKS_PER_FRAME === 0
    && (curve === null
      ? isUnitySourceTimeRate(map.rate)
      : curve.points.every((point) => isUnitySourceTimeRate(point.rate)))
}

export function sourceTimeSpeedAtTimelineOffset(
  map: SourceTimeMap,
  timelineOffsetFrames: number,
): number {
  const curve = validSpeedCurve(map)
  if (!curve) return map.rate.numerator / map.rate.denominator
  const frame = curve.originFrame + timelineOffsetFrames
  const points = curve.points
  if (frame <= points[0]!.frame) {
    return points[0]!.rate.numerator / points[0]!.rate.denominator
  }
  const last = points[points.length - 1]!
  if (frame >= last.frame) return last.rate.numerator / last.rate.denominator
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index]!
    const right = points[index + 1]!
    if (frame > right.frame) continue
    const start = left.rate.numerator / left.rate.denominator
    if (left.easing === 'hold') return start
    const end = right.rate.numerator / right.rate.denominator
    const linearProgress = (frame - left.frame) / (right.frame - left.frame)
    const progress = left.easing === 'smooth'
      ? linearProgress * linearProgress * (3 - 2 * linearProgress)
      : linearProgress
    return start + (end - start) * progress
  }
  return last.rate.numerator / last.rate.denominator
}

export function sourceTimeSpeedPointsAtClip(
  map: SourceTimeMap,
): SourceTimeSpeedPoint[] {
  const curve = map.speedCurve
  if (!curve || speedCurveValidationError(curve)) return []
  return curve.points.map((point) => ({
    frame: point.frame - curve.originFrame,
    rate: { ...point.rate },
    easing: point.easing,
  }))
}

export function sourceTimeMapWithSpeedPoint(
  map: SourceTimeMap,
  localFrame: number,
  rate: SourceTimeRate,
  easing: SourceTimeSpeedEasing,
): SourceTimeMap {
  const mapError = sourceTimeMapValidationError(map)
  if (mapError) throw new RangeError(mapError)
  if (
    !Number.isSafeInteger(localFrame)
    || localFrame < -MAX_SOURCE_TIME_SPEED_FRAME
    || localFrame > MAX_SOURCE_TIME_SPEED_FRAME
  ) throw new RangeError('Speed-point frame is outside authored bounds')
  const rateError = sourceTimeSpeedRateValidationError(rate)
  if (rateError) throw new RangeError(rateError)
  if (!SPEED_EASING_SET.has(easing)) throw new RangeError('Unsupported speed easing')

  const next = cloneSourceTimeMap(map)
  const curve = next.speedCurve!
  if (curve.points.length === 0) {
    curve.originFrame = 0
    curve.points.push({
      frame: 0,
      rate: { ...map.rate },
      easing: 'linear',
    })
  }
  const curveFrame = curve.originFrame + localFrame
  if (
    !Number.isSafeInteger(curveFrame)
    || curveFrame < -MAX_SOURCE_TIME_SPEED_FRAME
    || curveFrame > MAX_SOURCE_TIME_SPEED_FRAME
  ) throw new RangeError('Speed-point frame is outside authored bounds')
  const replacement = {
    frame: curveFrame,
    rate: { ...rate },
    easing,
  }
  const existingIndex = curve.points.findIndex((point) => point.frame === curveFrame)
  if (existingIndex >= 0) curve.points[existingIndex] = replacement
  else curve.points.push(replacement)
  curve.points.sort((left, right) => left.frame - right.frame)
  const curveError = speedCurveValidationError(curve)
  if (curveError) throw new RangeError(curveError)
  return next
}

export function sourceTimeMapWithoutSpeedPoint(
  map: SourceTimeMap,
  localFrame: number,
): SourceTimeMap {
  const mapError = sourceTimeMapValidationError(map)
  if (mapError) throw new RangeError(mapError)
  const next = cloneSourceTimeMap(map)
  const curve = next.speedCurve!
  const curveFrame = curve.originFrame + localFrame
  const index = curve.points.findIndex((point) => point.frame === curveFrame)
  if (index < 0) return next
  curve.points.splice(index, 1)
  if (curve.points.length === 0) curve.originFrame = 0
  const curveError = speedCurveValidationError(curve)
  if (curveError) throw new RangeError(curveError)
  return next
}

export function sourceTimeMapWithoutSpeedCurve(map: SourceTimeMap): SourceTimeMap {
  const next = cloneSourceTimeMap(map)
  next.speedCurve = defaultSourceTimeSpeedCurve()
  return next
}

/** Attach recoverable absolute source-time intent to legacy timeline-only keys. */
export function animationWithSourceTimeIntent(
  animation: ClipAnimation,
  map: SourceTimeMap,
): ClipAnimation {
  return {
    tracks: animation.tracks.map((track) => ({
      property: track.property,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        sourceTimeTicks: keyframe.sourceTimeTicks
          ?? sourceTicksAtTimelineOffset(map, keyframe.frame),
        easing: { ...keyframe.easing },
      })),
    })),
  }
}

/** Re-anchor authored source intent after a slip keeps timeline keys fixed. */
export function shiftClipAnimationSourceTimeIntent(
  animation: ClipAnimation,
  oldMap: SourceTimeMap,
  sourceDeltaTicks: number,
): ClipAnimation | null {
  if (!Number.isSafeInteger(sourceDeltaTicks)) return null
  let withIntent: ClipAnimation
  try {
    withIntent = animationWithSourceTimeIntent(animation, oldMap)
  } catch {
    return null
  }
  const tracks: ClipAnimation['tracks'] = []
  for (const track of withIntent.tracks) {
    const keyframes: typeof track.keyframes = []
    for (const keyframe of track.keyframes) {
      const sourceTimeTicks = keyframe.sourceTimeTicks! + sourceDeltaTicks
      if (!Number.isSafeInteger(sourceTimeTicks)) return null
      keyframes.push({
        ...keyframe,
        sourceTimeTicks,
        easing: { ...keyframe.easing },
      })
    }
    tracks.push({ property: track.property, keyframes })
  }
  return { tracks }
}

export function retimeClipAnimation(
  animation: ClipAnimation,
  oldMap: SourceTimeMap,
  newMap: SourceTimeMap,
  newDurationFrames: number,
): ClipAnimation | null {
  if (!Number.isSafeInteger(newDurationFrames) || newDurationFrames < 1) {
    throw new RangeError('Retimed animation duration must be a positive safe integer')
  }
  const tracks: ClipAnimation['tracks'] = []
  for (const track of animation.tracks) {
    const remapped = new Map<number, typeof track.keyframes[number]>()
    for (const keyframe of track.keyframes) {
      let sourceTicks: number
      try {
        sourceTicks = keyframe.sourceTimeTicks
          ?? sourceTicksAtTimelineOffset(oldMap, keyframe.frame)
      } catch {
        return null
      }
      if (!Number.isSafeInteger(sourceTicks)) return null
      const frame = timelineOffsetAtSourceTicks(
        newMap,
        sourceTicks,
        -MAX_KEYFRAME_FRAME,
        MAX_KEYFRAME_FRAME,
      )
      if (frame === null) return null
      // Integer-frame animation cannot represent two independently authored
      // source instants on one frame. Reject the whole retime rather than
      // silently discarding either key; the caller preserves the document.
      if (remapped.has(frame)) return null
      remapped.set(frame, {
        ...keyframe,
        frame,
        sourceTimeTicks: sourceTicks,
        easing: { ...keyframe.easing },
      })
    }
    tracks.push({
      property: track.property,
      keyframes: [...remapped.values()].sort((left, right) => left.frame - right.frame),
    })
  }
  return { tracks }
}

export type SourceTimeAudioPolicy =
  | { status: 'supported' }
  | {
      status: 'muted'
      reason:
        | 'constant-speed-audio-unsupported'
        | 'speed-ramp-audio-unsupported'
        | 'invalid-speed-curve'
    }

/**
 * Current Web Audio/export readers do not time-stretch or pitch-shift. Any
 * non-unity (or sub-frame-origin) map is therefore omitted identically from
 * preview playback and export instead of inventing samples or losing sync.
 */
export function sourceTimeAudioPolicy(clip: Clip): SourceTimeAudioPolicy {
  const map = clipSourceTimeMap(clip)
  if (sourceTimeMapHasInvalidSpeedCurve(map)) {
    return { status: 'muted', reason: 'invalid-speed-curve' }
  }
  if (sourceTimeMapIsAudioCompatible(map)) return { status: 'supported' }
  return {
    status: 'muted',
    reason: sourceTimeMapUsesSpeedCurve(map)
      ? 'speed-ramp-audio-unsupported'
      : 'constant-speed-audio-unsupported',
  }
}
