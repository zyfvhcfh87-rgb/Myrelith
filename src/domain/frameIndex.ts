/** Immutable point lookup over sorted, pairwise-disjoint frame ranges. */

export interface FrameIndexBounds {
  readonly startFrame: number
  readonly endFrame: number
}

export interface FrameIndex<T> {
  readonly size: number
  /** Return the sole item whose half-open range contains `frame`. */
  activeAt(frame: number): T | null
}

interface FrameIndexEntry<T> extends FrameIndexBounds {
  readonly value: T
}

const emptyFrameIndex: FrameIndex<never> = Object.freeze({
  size: 0,
  activeAt: () => null,
})

function validBounds(bounds: FrameIndexBounds): boolean {
  return Number.isSafeInteger(bounds.startFrame)
    && Number.isSafeInteger(bounds.endFrame)
    && bounds.startFrame >= 0
    && bounds.endFrame > bounds.startFrame
}

/**
 * Snapshot one canonical track-ordered range list. Valid timeline inputs use
 * binary search; malformed direct-call fixtures retain the historical
 * first-match scan instead of making planner failure behavior less safe.
 */
export function createFrameIndex<T>(
  values: readonly T[],
  boundsOf: (value: T) => FrameIndexBounds,
): FrameIndex<T> {
  if (values.length === 0) return emptyFrameIndex

  const entries: FrameIndexEntry<T>[] = []
  let binarySearchable = true
  let previousEnd = -1
  for (const value of values) {
    const bounds = boundsOf(value)
    const entry = Object.freeze({
      startFrame: bounds.startFrame,
      endFrame: bounds.endFrame,
      value,
    })
    if (!validBounds(entry) || entry.startFrame < previousEnd) {
      binarySearchable = false
    }
    previousEnd = entry.endFrame
    entries.push(entry)
  }
  const snapshot = Object.freeze(entries)

  const linearActiveAt = (frame: number): T | null => {
    for (const entry of snapshot) {
      if (entry.startFrame > frame) break
      if (frame >= entry.startFrame && frame < entry.endFrame) {
        return entry.value
      }
    }
    return null
  }

  const binaryActiveAt = (frame: number): T | null => {
    let lower = 0
    let upper = snapshot.length
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2)
      if (snapshot[middle].startFrame <= frame) lower = middle + 1
      else upper = middle
    }
    if (lower === 0) return null
    const candidate = snapshot[lower - 1]
    return frame < candidate.endFrame ? candidate.value : null
  }

  return Object.freeze({
    size: snapshot.length,
    activeAt: binarySearchable ? binaryActiveAt : linearActiveAt,
  })
}
