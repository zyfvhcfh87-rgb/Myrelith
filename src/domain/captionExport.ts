/** Exact reachable caption intervals for burned-in export availability. */
import { combineCaptionStyleOverrides } from './captionStyle'
import { resolveCaptionPaint } from './captionPaint'
import type { SequenceProject } from './projectSequences'
import type { CaptionItem, CaptionTrack, TimelineDoc } from './schema'
import { docDurationFrames } from './selectors'
import { rangeEnd } from './time'

import { admitSequenceFrameRange, type SequenceFrameInterval as FrameInterval } from './sequenceFrameCoverage'
export interface CaptionExportBlocker {
  readonly sequenceId: string
  readonly trackId: string
  readonly cueId: string
  readonly frame: number
  readonly reason: string
}
export type CaptionPaintError = (doc: TimelineDoc, track: CaptionTrack, cue: CaptionItem,
  stackIndex: number, stackSize: number) => string | null

interface ActiveCue { track: CaptionTrack; cue: CaptionItem; trackIndex: number }
interface StackChange { entry: ActiveCue; active: boolean }

/** Tracks contain sorted, non-overlapping cues. Binary-search the interval;
 * sweep only intersecting cue boundaries, never scan all cues at every frame.
 */
function stackChanges(sequence: TimelineDoc, range: FrameInterval): Map<number, StackChange[]> {
  const events = new Map<number, StackChange[]>()
  const put = (frame: number, change: StackChange) => {
    const bucket = events.get(frame)
    if (bucket) bucket.push(change)
    else events.set(frame, [change])
  }
  for (const [trackIndex, track] of (sequence.captionTracks ?? []).entries()) {
    if (track.hidden) continue
    let low = 0, high = track.items.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (rangeEnd(track.items[middle]!.range) <= range.start) low = middle + 1
      else high = middle
    }
    for (let index = low; index < track.items.length; index++) {
      const cue = track.items[index]!
      if (cue.range.startFrame >= range.end) break
      const entry = { track, cue, trackIndex }
      put(Math.max(range.start, cue.range.startFrame), { entry, active: true })
      if (rangeEnd(cue.range) < range.end) put(rangeEnd(cue.range), { entry, active: false })
    }
  }
  return events
}

/** Validated immutable project input. No media, stores, caches, or model origin
 * interpretation. Check boundaries at which the active caption stack changes;
 * geometry can become unavailable when another caption starts or ends.
 */
export function firstCaptionExportBlocker(project: SequenceProject, sequenceId: string,
  paintError: CaptionPaintError = (doc, track, cue, index, size) =>
    resolveCaptionPaint(doc, track, cue, index, size).unavailable[0]?.reason ?? null): CaptionExportBlocker | null {
  const sequences = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))
  const root = sequences.get(sequenceId)
  if (!root) throw new RangeError('The caption export sequence is unavailable.')
  const seen = new Map<string, FrameInterval[]>()
  const queue = [{ id: sequenceId, start: 0, end: docDurationFrames(root) }]
  for (let index = 0; index < queue.length; index++) {
    const next = queue[index]!
    if (next.end <= next.start) continue
    const sequence = sequences.get(next.id)
    if (!sequence) throw new RangeError('A referenced caption export sequence is unavailable.')
    for (const range of admitSequenceFrameRange(seen, next.id, next)) {
      const changes = stackChanges(sequence, range)
      const activeById = new Map<string, ActiveCue>()
      for (const [frame, events] of [...changes].sort(([a], [b]) => a - b)) {
        for (const event of events) {
          if (event.active) activeById.set(event.entry.cue.id, event.entry)
          else activeById.delete(event.entry.cue.id)
        }
        const active = [...activeById.values()].sort((a, b) => a.trackIndex - b.trackIndex)
        for (let stackIndex = 0; stackIndex < active.length; stackIndex++) {
          const { track, cue } = active[stackIndex]!
          const overrides = combineCaptionStyleOverrides(track.style, cue.style)
          const reason = overrides.unavailable[0]?.reason ?? paintError?.(sequence, track, cue, stackIndex, active.length)
          if (reason) return { sequenceId: sequence.id, trackId: track.id, cueId: cue.id, frame, reason }
        }
      }
      for (const track of sequence.tracks) {
        if (track.kind !== 'video' || track.hidden) continue
        for (const instance of track.sequenceInstances ?? []) {
          const start = Math.max(range.start, instance.timelineRange.startFrame)
          const end = Math.min(range.end, rangeEnd(instance.timelineRange))
          if (end > start) queue.push({ id: instance.sequenceId,
            start: instance.sourceStartFrame + start - instance.timelineRange.startFrame,
            end: instance.sourceStartFrame + end - instance.timelineRange.startFrame })
        }
      }
    }
  }
  return null
}
