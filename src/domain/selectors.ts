/**
 * domain/selectors.ts — Pure derived reads over a TimelineDoc. Phase 3.2+.
 * No browser APIs, no stores — plain functions over plain data.
 */

import type { TimelineDoc } from './schema'
import { rangeEnd } from './time'

/**
 * Total document length in frames: the end of the last clip across all
 * tracks (0 for an empty project). Derived on demand — never stored on the
 * doc, so it can never go stale (see schema.ts).
 */
export function docDurationFrames(doc: TimelineDoc): number {
  let last = 0
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const end = rangeEnd(clip.timelineRange)
      if (end > last) last = end
    }
  }
  return last
}
