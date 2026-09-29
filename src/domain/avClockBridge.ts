/**
 * Exact bridge between a video track's frame-stamp clock and page time.
 *
 * Chromium 151 stamps MediaStreamTrackProcessor video frames on the system
 * tick clock but audio chunks on the page's performance timeline (Issue #209
 * Step 13 evidence). A `<video>` playing a clone of the same track reports each
 * presented frame's `captureTime` on the page timeline. The same frames
 * therefore appear in both lists, and `stamp − captureTime` is one constant.
 * The constant is the mode of all pairwise differences, confirmed by
 * several pairs agreeing within a small window. Browser timestamps are
 * coarsened (~100 µs), so agreement is tested within ±`tolerance`.
 */

export interface AvClockBridge {
  /** Subtract from a video frame stamp to get page time (µs). */
  readonly offsetUs: number
  /** Frame pairs that agree with the offset. */
  readonly pairs: number
  /** Max−min of the agreeing differences (µs). */
  readonly spreadUs: number
}

export const AV_BRIDGE_MIN_PAIRS = 5
export const AV_BRIDGE_TOLERANCE_US = 500

export function estimateAvClockBridge(
  frameStampsUs: readonly number[],
  captureTimesUs: readonly number[],
  tolerance = AV_BRIDGE_TOLERANCE_US,
): AvClockBridge | null {
  const differences: number[] = []
  for (const stamp of frameStampsUs) {
    if (!Number.isFinite(stamp)) continue
    for (const capture of captureTimesUs) {
      if (Number.isFinite(capture)) differences.push(Math.round(stamp - capture))
    }
  }
  if (differences.length === 0) return null
  differences.sort((a, b) => a - b)
  // Sliding window: the densest ±tolerance cluster of differences.
  let best = { start: 0, end: 0 }
  let end = 0
  for (let start = 0; start < differences.length; start++) {
    while (end < differences.length && differences[end]! - differences[start]! <= 2 * tolerance) end++
    if (end - start > best.end - best.start) best = { start, end }
  }
  const cluster = differences.slice(best.start, best.end)
  if (cluster.length < AV_BRIDGE_MIN_PAIRS) return null
  // A real bridge pairs each frame once; a dense cluster must not be a coincidence
  // of one frame against many (e.g. a frozen stream).
  const uniqueStamps = new Set<number>()
  for (const stamp of frameStampsUs) {
    for (const capture of captureTimesUs) {
      const difference = Math.round(stamp - capture)
      if (difference >= cluster[0]! && difference <= cluster.at(-1)!) uniqueStamps.add(stamp)
    }
  }
  if (uniqueStamps.size < AV_BRIDGE_MIN_PAIRS) return null
  const offsetUs = cluster[Math.floor(cluster.length / 2)]!
  return { offsetUs, pairs: cluster.length, spreadUs: cluster.at(-1)! - cluster[0]! }
}
