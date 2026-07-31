/**
 * Pure still-image timing policy.
 *
 * Images have no intrinsic playback duration. Import gives them a canonical
 * five-second default in integer microseconds, then derives the nearest
 * positive document-frame count through the shared rational-time boundary.
 * A future preference can supply a different canonical duration without
 * changing callers or introducing floating-point seconds.
 */

import type { FrameRate } from './schema'
import {
  MICROSECONDS_PER_SECOND,
  microsecondsDurationToFrames,
} from './time'

export const DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS =
  5 * MICROSECONDS_PER_SECOND

export function stillImageDurationFrames(
  rate: FrameRate,
  durationMicroseconds = DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
): number {
  return microsecondsDurationToFrames(durationMicroseconds, rate)
}
