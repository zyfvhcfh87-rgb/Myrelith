/**
 * Deterministic constant-speed timeline-to-source mapping.
 *
 * Source positions use one million integer ticks per conformed source frame.
 * Every position is derived from the stored origin with BigInt arithmetic;
 * callers never advance a floating accumulator. Constant rates are reduced
 * 25%-step rationals from 1/4x through 4x. Restricting the durable vocabulary
 * to steps exactly representable by the fixed precision keeps split/trim
 * composition associative without storing a hidden fractional phase.
 */

import type {
  Clip,
  ClipAnimation,
  SourceTimeMap,
  SourceTimeRate,
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

export function sourceTimeMapValidationError(value: SourceTimeMap): string | null {
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
  }
}

/** Legacy-tolerant accessor; persisted schema-10 clips never need fallback. */
export function clipSourceTimeMap(clip: Clip): SourceTimeMap {
  return clip.sourceTimeMap ?? defaultSourceTimeMap(
    clip.sourceRange.startFrame,
    clip.sourceRange.durationFrames,
  )
}

export function cloneSourceTimeMap(map: SourceTimeMap): SourceTimeMap {
  return {
    sourceStartTicks: map.sourceStartTicks,
    sourceDurationTicks: map.sourceDurationTicks,
    rate: { ...map.rate },
  }
}

/** Exact fixed-point source position at one signed clip-local frame offset. */
export function sourceTicksAtTimelineOffset(
  map: SourceTimeMap,
  timelineOffsetFrames: number,
): number {
  const error = sourceTimeMapValidationError(map)
  if (error) throw new RangeError(error)
  if (!Number.isSafeInteger(timelineOffsetFrames)) {
    throw new RangeError('Timeline offset must be a safe integer')
  }
  const delta = floorDiv(
    BigInt(timelineOffsetFrames) * BigInt(map.rate.numerator) * TICKS,
    BigInt(map.rate.denominator),
  )
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
  const sourceStartTicks = sourceTicksAtTimelineOffset(map, timelineOffsetFrames)
  const consumedTicks = sourceStartTicks - map.sourceStartTicks
  const sourceDurationTicks = map.sourceDurationTicks - consumedTicks
  if (
    !Number.isSafeInteger(sourceDurationTicks)
    || sourceDurationTicks < 1
  ) throw new RangeError('Mapped source span must remain positive')
  return {
    sourceStartTicks,
    sourceDurationTicks,
    rate: { ...map.rate },
  }
}

/** Replace the exact out-point with the mapped end of a timeline duration. */
export function sourceTimeMapForTimelineDuration(
  map: SourceTimeMap,
  timelineDurationFrames: number,
): SourceTimeMap {
  const sourceDurationTicks = sourceTicksAtTimelineOffset(
    map,
    timelineDurationFrames,
  ) - map.sourceStartTicks
  if (sourceDurationTicks < 1) {
    throw new RangeError('Mapped source span must remain positive')
  }
  return { ...cloneSourceTimeMap(map), sourceDurationTicks }
}

/** Integer source-frame envelope touched by a half-open mapped clip interval. */
export function sourceRangeForMap(
  map: SourceTimeMap,
  timelineDurationFrames: number,
): TimeRange {
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

export function sourceTimeMapIsAudioCompatible(map: SourceTimeMap): boolean {
  return isUnitySourceTimeRate(map.rate)
    && map.sourceStartTicks % SOURCE_TIME_TICKS_PER_FRAME === 0
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
      const relativeTicks = BigInt(sourceTicks - newMap.sourceStartTicks)
      let frame: number
      try {
        frame = safeNumber(
          floorDiv(
            relativeTicks * BigInt(newMap.rate.denominator),
            BigInt(newMap.rate.numerator) * TICKS,
          ),
          'Retimed keyframe',
        )
      } catch {
        return null
      }
      if (frame < -MAX_KEYFRAME_FRAME || frame > MAX_KEYFRAME_FRAME) return null
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
  | { status: 'muted'; reason: 'constant-speed-audio-unsupported' }

/**
 * Current Web Audio/export readers do not time-stretch or pitch-shift. Any
 * non-unity (or sub-frame-origin) map is therefore omitted identically from
 * preview playback and export instead of inventing samples or losing sync.
 */
export function sourceTimeAudioPolicy(clip: Clip): SourceTimeAudioPolicy {
  return sourceTimeMapIsAudioCompatible(clipSourceTimeMap(clip))
    ? { status: 'supported' }
    : { status: 'muted', reason: 'constant-speed-audio-unsupported' }
}
