/** Exact visible sequence ranges for static title/font export availability. */
import type { SequenceProject } from './projectSequences'
import { createTitleCompositionPlanner, titleCompositionError } from './titleComposition'
import { docDurationFrames } from './selectors'
import { rangeEnd } from './time'
import type { Clip } from './schema'
import { clipAnimationValidationError, evaluateAnimationTrack } from './clipAnimation'

import { admitSequenceFrameRange, type SequenceFrameInterval as Range } from './sequenceFrameCoverage'

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
    for (const range of admitSequenceFrameRange(seen, next.id, next)) {
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
