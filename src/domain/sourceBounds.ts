/** Pure comparison and cloning helpers for durable per-stream source bounds. */

import type {
  MediaSourceBounds,
  SourceTimestampBounds,
} from './schema'

export function sourceTimestampBoundsEqual(
  left: SourceTimestampBounds,
  right: SourceTimestampBounds,
): boolean {
  if (left.status !== right.status) return false
  return left.status === 'unknown'
    || (
      right.status === 'exact'
      && left.firstTimestampUs === right.firstTimestampUs
      && left.endTimestampUs === right.endTimestampUs
    )
}

export function mediaSourceBoundsEqual(
  left: MediaSourceBounds,
  right: MediaSourceBounds,
): boolean {
  return streamBoundsEqual(left.video, right.video)
    && streamBoundsEqual(left.audio, right.audio)
}

/**
 * Exact durable facts must match exactly. A legacy `unknown` fact accepts an
 * exact analyzed extent for the same present stream so relinking can upgrade
 * the catalog without fabricating handles during migration.
 */
export function mediaSourceBoundsAcceptAnalyzed(
  durable: MediaSourceBounds,
  analyzed: MediaSourceBounds,
): boolean {
  return streamBoundsAcceptAnalyzed(durable.video, analyzed.video)
    && streamBoundsAcceptAnalyzed(durable.audio, analyzed.audio)
}

export function cloneMediaSourceBounds(
  bounds: MediaSourceBounds,
): MediaSourceBounds {
  return {
    video: bounds.video === null ? null : { ...bounds.video },
    audio: bounds.audio === null ? null : { ...bounds.audio },
  }
}

function streamBoundsEqual(
  left: SourceTimestampBounds | null,
  right: SourceTimestampBounds | null,
): boolean {
  if (left === null || right === null) return left === right
  return sourceTimestampBoundsEqual(left, right)
}

function streamBoundsAcceptAnalyzed(
  durable: SourceTimestampBounds | null,
  analyzed: SourceTimestampBounds | null,
): boolean {
  if (durable === null || analyzed === null) return durable === analyzed
  return durable.status === 'unknown'
    ? analyzed.status === 'exact'
    : sourceTimestampBoundsEqual(durable, analyzed)
}
