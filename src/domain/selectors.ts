/**
 * domain/selectors.ts — Pure derived reads over a TimelineDoc. Phase 3.2+.
 * No browser APIs, no stores — plain functions over plain data.
 */

import type { Clip, ClipId, Track, TimelineDoc } from './schema'
import { rangeContains, rangeEnd } from './time'

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

/**
 * The clip playing on `track` at timeline `frame`, or null when the frame
 * falls in a gap. At most one clip can match (clips on a track are pairwise
 * non-overlapping), and half-open ranges mean a clip's exclusive end frame
 * belongs to the NEXT clip when two clips touch. Relies on the sorted-by-
 * startFrame invariant for an early exit.
 */
export function activeClipAt(track: Track, frame: number): Clip | null {
  for (const clip of track.clips) {
    if (clip.timelineRange.startFrame > frame) break // sorted: no later clip can contain it
    if (rangeContains(clip.timelineRange, frame)) return clip
  }
  return null
}

/** Find a clip anywhere in the document, or null (Inspector lookups). */
export function findClip(doc: TimelineDoc, clipId: ClipId): Clip | null {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) return clip
    }
  }
  return null
}

/**
 * The track a clip lives on, or null. Lets the UI branch on lane kind —
 * e.g. the Inspector shows Volume for clips on audio tracks and the
 * transform fields for clips on video tracks.
 */
export function trackOfClip(doc: TimelineDoc, clipId: ClipId): Track | null {
  for (const track of doc.tracks) {
    if (track.clips.some((clip) => clip.id === clipId)) return track
  }
  return null
}

/**
 * Tracks in TIMELINE DISPLAY order (NLE convention, top row first): video
 * tracks with the topmost composite layer first — i.e. array order
 * REVERSED, since tracks[0] composites at the bottom — then audio tracks
 * in array order, so A1 sits directly under the video stack. Pure
 * reordering: the returned array holds the same Track references, and the
 * doc's own tracks array (the compositing order) is untouched.
 */
export function tracksInDisplayOrder(doc: TimelineDoc): Track[] {
  const videos: Track[] = []
  const audios: Track[] = []
  for (const track of doc.tracks) {
    if (track.kind === 'video') videos.unshift(track)
    else audios.push(track)
  }
  return [...videos, ...audios]
}

/**
 * The audio tracks that belong in the mix — THE single home of the
 * solo/mute rule (schema.ts points here): while any audio track is solo,
 * only solo tracks play; mute always wins, even on a solo track. Phase 5
 * export and future playback audio must use this instead of re-deriving
 * flag logic.
 */
export function audibleTracks(doc: TimelineDoc): Track[] {
  const audio = doc.tracks.filter((t) => t.kind === 'audio')
  const anySolo = audio.some((t) => t.solo)
  return audio.filter((t) => !t.muted && (!anySolo || t.solo))
}

/**
 * Map a timeline frame to the source-asset frame the clip shows there:
 * sourceRange start plus the offset into the clip. Pure integer math (MVP
 * speed 1.0 — source and timeline ranges have equal durations). Only
 * meaningful when `timelineFrame` is inside clip.timelineRange; callers
 * (compositor, split/trim ops) check that via activeClipAt/rangeContains.
 */
export function clipSourceFrame(clip: Clip, timelineFrame: number): number {
  return (
    clip.sourceRange.startFrame + (timelineFrame - clip.timelineRange.startFrame)
  )
}
