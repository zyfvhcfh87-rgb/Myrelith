/**
 * Pure still-image timing policy.
 *
 * Images have no intrinsic playback duration. Import gives them a canonical
 * five-second default in integer microseconds, then derives the nearest
 * positive document-frame count through the shared rational-time boundary.
 * The persisted user preference remains integer microseconds at every
 * non-UI boundary so locale-dependent decimal seconds never enter the model.
 */

import type { FrameRate } from './schema'
import {
  MICROSECONDS_PER_SECOND,
  microsecondsDurationToFrames,
} from './time'

export const DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS =
  5 * MICROSECONDS_PER_SECOND

export const STILL_IMAGE_DURATION_PREFERENCE_LIMITS = Object.freeze({
  minMicroseconds: 100_000,
  maxMicroseconds: 60 * 60 * MICROSECONDS_PER_SECOND,
})

export function isValidStillImageDurationMicroseconds(
  value: unknown,
): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= STILL_IMAGE_DURATION_PREFERENCE_LIMITS.minMicroseconds
    && (value as number) <= STILL_IMAGE_DURATION_PREFERENCE_LIMITS.maxMicroseconds
}

export function stillImageDurationFrames(
  rate: FrameRate,
  durationMicroseconds = DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
): number {
  if (!isValidStillImageDurationMicroseconds(durationMicroseconds)) {
    throw new TypeError(
      'Still-image duration must be an integer between 100,000 and 3,600,000,000 microseconds',
    )
  }
  return microsecondsDurationToFrames(durationMicroseconds, rate)
}
