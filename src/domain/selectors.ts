/**
 * domain/selectors.ts — Pure derived reads over a TimelineDoc. Phase 3.2+.
 * No browser APIs, no stores — plain functions over plain data.
 */

import type {
  AssetId,
  Clip,
  ClipId,
  Track,
  TimelineDoc,
  Transition,
} from './schema'
import { rangeContains, rangeEnd } from './time'

/**
 * One paint-ordered media layer needed to composite a document frame.
 * This is the canonical visual selection contract shared by preview and
 * export: consumers must not independently re-derive clip visibility,
 * transition source frames, or effective opacity.
 */
export interface VisibleVideoLayer {
  clip: Clip
  sourceFrame: number
  opacity: number
}

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

/** Media sources that can contribute pixels or samples to a full export. */
export function outputMediaAssetIds(doc: TimelineDoc): Set<AssetId> {
  const ids = new Set<AssetId>()
  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (!clip.text && clip.opacity > 0) ids.add(clip.assetId)
    }
  }
  for (const track of audibleTracks(doc)) {
    for (const clip of track.clips) {
      if (!clip.text && clip.volume > 0) ids.add(clip.assetId)
    }
  }
  return ids
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

/**
 * One structurally valid crossfade resolved against its owning track.
 * Operations use the same geometry as rendering so an authored transition
 * cannot be accepted only to fall back to a hard cut in the compositor.
 */
export interface ResolvedCrossfade {
  transition: Transition
  from: Clip
  to: Clip
  startFrame: number
  endFrame: number
  durationFrames: number
}

function clipOpacity(clip: Clip): number {
  if (!Number.isFinite(clip.opacity) || clip.opacity <= 0) return 0
  return Math.min(1, clip.opacity)
}

function validSourceRange(clip: Clip): boolean {
  const { startFrame, durationFrames } = clip.sourceRange
  return (
    Number.isSafeInteger(startFrame) &&
    startFrame >= 0 &&
    Number.isSafeInteger(durationFrames) &&
    durationFrames >= 1 &&
    Number.isSafeInteger(startFrame + durationFrames - 1)
  )
}

/** Resolve one transition using the canonical centered crossfade geometry. */
export function resolveCrossfade(
  track: Track,
  transition: Transition,
): ResolvedCrossfade | null {
  const durationFrames = transition.durationFrames
  if (
    track.kind !== 'video' ||
    transition.type !== 'crossfade' ||
    !Number.isSafeInteger(durationFrames) ||
    durationFrames < 1
  ) {
    return null
  }

  const fromIndex = track.clips.findIndex(
    (clip) => clip.id === transition.fromClipId,
  )
  if (fromIndex < 0 || fromIndex + 1 >= track.clips.length) return null
  const from = track.clips[fromIndex]
  const to = track.clips[fromIndex + 1]
  if (to.id !== transition.toClipId || from.id === to.id) return null
  if (from.text !== undefined || to.text !== undefined) return null
  if (!validSourceRange(from) || !validSourceRange(to)) return null

  const fromStart = from.timelineRange.startFrame
  const cutFrame = rangeEnd(from.timelineRange)
  const toEnd = rangeEnd(to.timelineRange)
  if (
    !Number.isSafeInteger(fromStart) ||
    !Number.isSafeInteger(cutFrame) ||
    !Number.isSafeInteger(toEnd) ||
    cutFrame !== to.timelineRange.startFrame
  ) {
    return null
  }

  const startFrame = cutFrame - Math.floor(durationFrames / 2)
  const endFrame = startFrame + durationFrames
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < fromStart ||
    endFrame > toEnd
  ) {
    return null
  }

  return { transition, from, to, startFrame, endFrame, durationFrames }
}

/** Half-open overlap for two resolved crossfade windows. */
export function crossfadeWindowsOverlap(
  left: Pick<ResolvedCrossfade, 'startFrame' | 'endFrame'>,
  right: Pick<ResolvedCrossfade, 'startFrame' | 'endFrame'>,
): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}

function crossfadeAt(track: Track, frame: number): ResolvedCrossfade | null {
  const idCounts = new Map<string, number>()
  for (const transition of track.transitions) {
    idCounts.set(transition.id, (idCounts.get(transition.id) ?? 0) + 1)
  }
  const candidates = track.transitions
    .map((transition) => resolveCrossfade(track, transition))
    .filter(
      (candidate): candidate is ResolvedCrossfade =>
        candidate !== null && idCounts.get(candidate.transition.id) === 1,
    )

  const active = candidates.filter(
    (candidate) =>
      frame >= candidate.startFrame && frame < candidate.endFrame,
  )
  if (active.length !== 1) return null

  // Invalidate an overlapping/duplicate transition for its WHOLE window.
  // Looking only for another transition active at this frame would let a
  // malformed dissolve start, hard-cut in the overlap, then resume. Checking
  // only the one active candidate against the full valid set also keeps this
  // selector linear in transition count for every rendered frame.
  const selected = active[0]
  const ambiguous = candidates.some(
    (candidate) =>
      candidate !== selected &&
      crossfadeWindowsOverlap(selected, candidate),
  )
  return ambiguous ? null : selected
}

function clampedTransitionSourceFrame(clip: Clip, frame: number): number {
  const first = clip.sourceRange.startFrame
  const last = first + clip.sourceRange.durationFrames - 1
  return Math.max(first, Math.min(last, clipSourceFrame(clip, frame)))
}

function ordinaryVideoLayer(track: Track, frame: number): VisibleVideoLayer[] {
  const clip = activeClipAt(track, frame)
  if (!clip || clip.text !== undefined) return []
  const opacity = clipOpacity(clip)
  if (opacity <= 0) return []
  return [{ clip, sourceFrame: clipSourceFrame(clip, frame), opacity }]
}

/**
 * Return every visual media layer needed for `frame`, in exact paint order.
 * Hidden/audio tracks, text clips, and non-positive opacity are omitted.
 *
 * Crossfades are centered on the touching edit point. Because TimelineDoc
 * has no source-handle metadata, the incoming first frame freezes before the
 * cut and the outgoing last frame freezes after it; every request therefore
 * remains inside its clip's declared source range. The outgoing clip paints
 * first and the incoming clip fades over it. The opacity adjustment avoids
 * the dark midpoint produced by naively source-over drawing two
 * complementary globalAlpha values for ordinary opaque video.
 *
 * Invalid, stale, overlapping, or ambiguous transitions fall back to the
 * normal hard-cut selection.
 */
export function visibleVideoLayersAtFrame(
  doc: TimelineDoc,
  frame: number,
): VisibleVideoLayer[] {
  const layers: VisibleVideoLayer[] = []

  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    const transition = crossfadeAt(track, frame)
    if (!transition) {
      layers.push(...ordinaryVideoLayer(track, frame))
      continue
    }

    const index = frame - transition.startFrame
    const progress = (index + 1) / (transition.durationFrames + 1)
    const fromBaseOpacity = clipOpacity(transition.from)
    const toBaseOpacity = clipOpacity(transition.to)
    const toOpacity = progress * toBaseOpacity
    const uncovered = 1 - toOpacity
    const fromOpacity =
      uncovered > 0
        ? ((1 - progress) * fromBaseOpacity) / uncovered
        : 0

    // Outgoing then incoming: source-over now produces a linear dissolve for
    // full-frame opaque media while still honoring intrinsic opacity.
    if (fromOpacity > 0) {
      layers.push({
        clip: transition.from,
        sourceFrame: clampedTransitionSourceFrame(transition.from, frame),
        opacity: Math.min(1, fromOpacity),
      })
    }
    if (toOpacity > 0) {
      layers.push({
        clip: transition.to,
        sourceFrame: clampedTransitionSourceFrame(transition.to, frame),
        opacity: Math.min(1, toOpacity),
      })
    }
  }

  return layers
}
