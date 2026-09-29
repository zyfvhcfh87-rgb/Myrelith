/**
 * Exact bridge between a video track's frame-stamp clock and page time.
 *
 * Chromium 151 stamps MediaStreamTrackProcessor video frames on the system
 * tick clock but audio chunks on the page's performance timeline (Issue #209
 * Step 13 evidence). A `<video>` playing a clone of the same track reports each
 * presented frame's `captureTime` on the page timeline. The same frames appear
 * in both lists, so `stamp − captureTime` is one constant.
 *
 * Pairwise differences form one dense cluster per frame lag. With jittery
 * frame spacing only the true lag is dense. With very regular spacing,
 * neighbouring lags are equally dense, so causality decides: a frame cannot
 * reach the page before it was captured. Each (stamp, delivery) pair therefore
 * bounds the offset from below: offset ≥ stamp − delivery. The smallest dense
 * cluster that respects that bound is the true lag, provided the page
 * delivery latency is below one frame interval (true in every Step 13
 * measurement). Browser timestamps are coarsened (~100 µs), so agreement is
 * tested within ±`tolerance`.
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

interface Cluster { readonly values: number[]; readonly stamps: Set<number> }

/**
 * @param deliveriesUs page time at which each stamp's frame was read (same
 *   order as `frameStampsUs`); used only to reject non-causal pairings.
 */
export function estimateAvClockBridge(
  frameStampsUs: readonly number[],
  captureTimesUs: readonly number[],
  deliveriesUs: readonly number[] = [],
  tolerance = AV_BRIDGE_TOLERANCE_US,
): AvClockBridge | null {
  const pairs: Array<{ difference: number; stamp: number }> = []
  for (const stamp of frameStampsUs) {
    if (!Number.isFinite(stamp)) continue
    for (const capture of captureTimesUs) {
      if (Number.isFinite(capture)) pairs.push({ difference: Math.round(stamp - capture), stamp })
    }
  }
  if (pairs.length === 0) return null
  pairs.sort((a, b) => a.difference - b.difference)
  // Greedy clustering: consecutive differences within 2×tolerance of the first.
  const clusters: Cluster[] = []
  for (const pair of pairs) {
    const current = clusters.at(-1)
    if (current && pair.difference - current.values[0]! <= 2 * tolerance) {
      current.values.push(pair.difference)
      current.stamps.add(pair.stamp)
    } else clusters.push({ values: [pair.difference], stamps: new Set([pair.stamp]) })
  }
  // A real bridge pairs many distinct frames; one frame against many is not one.
  const dense = clusters.filter((cluster) => cluster.values.length >= AV_BRIDGE_MIN_PAIRS &&
    cluster.stamps.size >= AV_BRIDGE_MIN_PAIRS)
  if (dense.length === 0) return null
  const densest = Math.max(...dense.map((cluster) => cluster.values.length))
  const contenders = dense.filter((cluster) => cluster.values.length >= densest * 0.8)
  let lowerBound = -Infinity
  frameStampsUs.forEach((stamp, index) => {
    const delivery = deliveriesUs[index]
    if (Number.isFinite(stamp) && delivery !== undefined && Number.isFinite(delivery)) {
      lowerBound = Math.max(lowerBound, Math.round(stamp - delivery))
    }
  })
  const median = (cluster: Cluster) => cluster.values[Math.floor(cluster.values.length / 2)]!
  const causal = contenders.filter((cluster) => median(cluster) >= lowerBound - tolerance)
  if (causal.length === 0) return null
  // Without deliveries, only an unambiguous (single) contender is accepted.
  if (deliveriesUs.length === 0 && causal.length > 1) return null
  const chosen = causal.reduce((best, cluster) => (median(cluster) < median(best) ? cluster : best))
  return { offsetUs: median(chosen), pairs: chosen.values.length,
    spreadUs: chosen.values.at(-1)! - chosen.values[0]! }
}
