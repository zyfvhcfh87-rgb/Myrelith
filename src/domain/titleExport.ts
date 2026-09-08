/** Exact visible sequence ranges for static title/font export availability. */
import type { SequenceProject } from './projectSequences'
import { createTitleCompositionPlanner, titleCompositionError } from './titleComposition'
import { docDurationFrames } from './selectors'
import { rangeEnd } from './time'
import type { Clip } from './schema'
import { clipAnimationValidationError, evaluateAnimationTrack } from './clipAnimation'

interface Range { start: number; end: number }

function contributesInRange(clip: Clip, range: Range): boolean {
  const animation = clip.animation
  const lane = animation?.tracks.find((lane) => lane.property === 'opacity' && (lane.propertyVersion ?? 1) === 1)
  if (!lane || clipAnimationValidationError(animation!)) return clip.opacity > 0
  const start = range.start - clip.timelineRange.startFrame, end = range.end - clip.timelineRange.startFrame - 1
  // Supported easing stays inside its endpoint envelope. Endpoints plus actual
  // interior key instants cover a half-open integer range, including held keys.
  return evaluateAnimationTrack(lane, start, clip.opacity) > 0
    || evaluateAnimationTrack(lane, end, clip.opacity) > 0
    || lane.keyframes.some((key) => key.frame > start && key.frame < end && key.value > 0)
}

/** Record visited frame coverage so overlapping/repeated instances do not repeat
 * a child's work. Gaps remain gaps; no widening to a bounding interval.
 */
function admitRange(seen: Map<string, Range[]>, id: string, input: Range): Range[] {
  const covered = seen.get(id) ?? []
  let pending = [input]
  for (const range of covered) pending = pending.flatMap((part) => {
    if (part.end <= range.start || part.start >= range.end) return [part]
    return [...(part.start < range.start ? [{ start: part.start, end: range.start }] : []),
      ...(part.end > range.end ? [{ start: range.end, end: part.end }] : [])]
  })
  if (!pending.length) return pending
  const merged: Range[] = []
  for (const range of [...covered, ...pending].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  seen.set(id, merged)
  return pending
}

export function projectTitleExportError(project: SequenceProject, sequenceId: string): string | null {
  const sequences = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))
  const root = sequences.get(sequenceId)
  if (!root) return 'The title export sequence is unavailable.'
  const planner = createTitleCompositionPlanner()
  const blockers = new Map<string, { clip: Clip; start: number; end: number; error: string }[]>()
  for (const sequence of project.sequences) for (const track of sequence.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (clip.title === undefined) continue
      if (!contributesInRange(clip, { start: clip.timelineRange.startFrame, end: rangeEnd(clip.timelineRange) })) continue
      const error = titleCompositionError(planner.plan(clip, clip.timelineRange.startFrame))
      if (!error) continue
      const list = blockers.get(sequence.id) ?? []
      list.push({ clip, start: clip.timelineRange.startFrame, end: rangeEnd(clip.timelineRange), error: `${clip.name}: ${error}` })
      blockers.set(sequence.id, list)
    }
  }
  if (!blockers.size) return null
  const seen = new Map<string, Range[]>()
  const queue = [{ id: sequenceId, start: 0, end: docDurationFrames(root) }]
  for (let index = 0; index < queue.length; index++) {
    const next = queue[index]
    if (next.end <= next.start) continue
    const sequence = sequences.get(next.id)
    if (!sequence) return 'A referenced title export sequence is unavailable.'
    for (const range of admitRange(seen, next.id, next)) {
      for (const blocker of blockers.get(next.id) ?? []) {
        const start = Math.max(blocker.start, range.start), end = Math.min(blocker.end, range.end)
        if (end > start && contributesInRange(blocker.clip, { start, end })) return blocker.error
      }
      for (const track of sequence.tracks) {
        if (track.kind !== 'video' || track.hidden) continue
        for (const instance of track.sequenceInstances ?? []) {
          const start = Math.max(range.start, instance.timelineRange.startFrame)
          const end = Math.min(range.end, rangeEnd(instance.timelineRange))
          if (end > start) queue.push({ id: instance.sequenceId,
            start: instance.sourceStartFrame + start - instance.timelineRange.startFrame,
            end: instance.sourceStartFrame + end - instance.timelineRange.startFrame,
          })
        }
      }
    }
  }
  return null
}
