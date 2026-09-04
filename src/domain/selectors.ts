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
import { clipAnimation } from './clipAnimation'
import { clipAudioSettings } from './clipInspector'
import {
  createCrossfadeAudioWindowIndex,
  resolveCrossfadeGeometry,
  type CrossfadeAudioClipWindow,
  type CrossfadeAudioWindowIndex,
} from './crossfadePlan'
import {
  clipSourceTimeMap,
  sourceFrameAtTimelineFrame,
  sourceTimeAudioPolicy,
  sourceTimeAudioWindowIsSilent,
} from './sourceTimeMap'
import { rangeContains, rangeEnd } from './time'
import { adjustmentItems } from './adjustmentItems'
import type { SequenceProject } from './projectSequences'

/**
 * Total document length in frames: the end of the last timeline item across all
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
    for (const instance of track.sequenceInstances ?? []) {
      const end = rangeEnd(instance.timelineRange)
      if (end > last) last = end
    }
    for (const instance of track.multicamInstances ?? []) {
      const end = rangeEnd(instance.timelineRange)
      if (end > last) last = end
    }
    for (const adjustment of adjustmentItems(track)) {
      const end = rangeEnd(adjustment.timelineRange)
      if (end > last) last = end
    }
  }
  for (const track of doc.captionTracks ?? []) {
    for (const item of track.items) {
      const end = rangeEnd(item.range)
      if (end > last) last = end
    }
  }
  return last
}

/**
 * UI-only extent: a marker beyond the last timeline item remains scrollable
 * and fits Full Extent Zoom, while render/export duration ignores markers.
 */
export function timelineDisplayDurationFrames(doc: TimelineDoc): number {
  let last = docDurationFrames(doc)
  for (const marker of doc.markers ?? []) {
    if (marker.frame + 1 > last) last = marker.frame + 1
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
 * True when this clip can contribute pixels: authored opacity, or an opacity
 * key that becomes visible. Text clips are not media sources.
 */
export function clipContributesVisualOutput(clip: Clip): boolean {
  if (clip.text) return false
  if (clip.opacity > 0) return true
  return clipAnimation(clip).tracks.some((track) => (
    track.property === 'opacity'
    && track.keyframes.some((keyframe) => keyframe.value > 0)
  ))
}

/**
 * True when this clip can contribute samples: enabled audio, authored gain,
 * or a volume key that becomes audible.
 */
export function clipContributesAudioOutput(clip: Clip): boolean {
  if (clip.text) return false
  if (!clipAudioSettings(clip).enabled) return false
  if (clip.volume > 0) return true
  return clipAnimation(clip).tracks.some((track) => (
    track.property === 'volume'
    && track.keyframes.some((keyframe) => keyframe.value > 0)
  ))
}

/**
 * True when an audible clip needs decoded source samples. A whole-window
 * freeze contributes intentional silence and therefore owns no media Blob or
 * decoder. Linked clips stay conservative because a valid crossfade may
 * reveal source handles outside the authored half-open clip range.
 */
export function clipHasWholeWindowSilentRampedAudio(
  clip: Clip,
): boolean {
  const policy = sourceTimeAudioPolicy(clip)
  return policy.status === 'supported'
    && policy.kind === 'ramped'
    && sourceTimeAudioWindowIsSilent(
      clipSourceTimeMap(clip),
      0,
      clip.timelineRange.durationFrames,
    )
}

export function clipContributesDecodedAudioOutput(
  clip: Clip,
  crossfadeWindow: CrossfadeAudioClipWindow | null = null,
): boolean {
  if (!clipContributesAudioOutput(clip)) return false
  const policy = sourceTimeAudioPolicy(clip)
  if (policy.status !== 'supported') return false
  if (policy.kind !== 'ramped') return true
  const map = clipSourceTimeMap(clip)
  if (!sourceTimeAudioWindowIsSilent(
    map,
    0,
    clip.timelineRange.durationFrames,
  )) return true
  if (!crossfadeWindow) return false
  return !sourceTimeAudioWindowIsSilent(
    map,
    Math.min(
      0,
      crossfadeWindow.startFrame - clip.timelineRange.startFrame,
    ),
    Math.max(
      clip.timelineRange.durationFrames,
      crossfadeWindow.endFrame - clip.timelineRange.startFrame,
    ),
  )
}

/** Visible video clips whose stacks contain a plugin-prefixed descriptor. */
export function documentHasOutputPluginEffects(doc: TimelineDoc): boolean {
  return doc.tracks.some((track) => (
    track.kind === 'video'
    && !track.hidden
    && track.clips.some((clip) => (
      clip.effects.some((effect) => effect.type.startsWith('plugin:'))
    ))
  ))
}

export function projectReachableSequences(
  project: SequenceProject,
  sequenceId = project.rootSequenceId,
): readonly TimelineDoc[] {
  const documents: TimelineDoc[] = []
  const visited = new Set<string>()
  const queue = [sequenceId]
  while (queue.length > 0) {
    const currentId = queue.shift()!
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const document = project.sequences.find((candidate) => candidate.id === currentId)
    if (!document) continue
    documents.push(document)
    for (const track of document.tracks) {
      for (const instance of track.sequenceInstances ?? []) queue.push(instance.sequenceId)
    }
  }
  return documents
}

export function projectHasOutputPluginEffects(
  project: SequenceProject,
  sequenceId = project.rootSequenceId,
): boolean {
  return projectReachableSequences(project, sequenceId)
    .some(documentHasOutputPluginEffects)
}

/** Media sources that can contribute pixels or optionally samples to export. */
export function outputMediaAssetIds(
  doc: TimelineDoc,
  includeAudio = true,
  providedCrossfadeWindows?: CrossfadeAudioWindowIndex,
): Set<AssetId> {
  const ids = new Set<AssetId>()
  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (clipContributesVisualOutput(clip)) ids.add(clip.assetId)
    }
  }
  if (includeAudio) {
    let crossfadeWindows = providedCrossfadeWindows
    for (const track of audibleTracks(doc)) {
      for (const clip of track.clips) {
        if (clipContributesDecodedAudioOutput(clip)) {
          ids.add(clip.assetId)
          continue
        }
        if (!clipHasWholeWindowSilentRampedAudio(clip)) continue
        crossfadeWindows ??= createCrossfadeAudioWindowIndex(doc)
        if (clipContributesDecodedAudioOutput(
          clip,
          crossfadeWindows.get(clip.id) ?? null,
        )) ids.add(clip.assetId)
      }
    }
  }
  return ids
}

export function projectOutputMediaAssetIds(
  project: SequenceProject,
  sequenceId = project.rootSequenceId,
  includeAudio = true,
): Set<AssetId> {
  const ids = new Set<AssetId>()
  for (const document of projectReachableSequences(project, sequenceId)) {
    const crossfadeWindows = includeAudio
      ? createCrossfadeAudioWindowIndex(document)
      : undefined
    for (const assetId of outputMediaAssetIds(
      document,
      includeAudio,
      crossfadeWindows,
    )) ids.add(assetId)
  }
  return ids
}

/**
 * Map a timeline frame to the source-asset frame the clip shows there.
 * Stills always resolve frame 0; timed clips use the canonical rational map.
 * Only meaningful inside clip.timelineRange; callers check that via
 * activeClipAt/rangeContains.
 */
export function clipSourceFrame(clip: Clip, timelineFrame: number): number {
  return sourceFrameAtTimelineFrame(clip, timelineFrame)
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

/** Resolve one transition using the canonical centered crossfade geometry. */
export function resolveCrossfade(
  track: Track,
  transition: Transition,
): ResolvedCrossfade | null {
  return resolveCrossfadeGeometry(track, transition)
}

/** Half-open overlap for two resolved crossfade windows. */
export function crossfadeWindowsOverlap(
  left: Pick<ResolvedCrossfade, 'startFrame' | 'endFrame'>,
  right: Pick<ResolvedCrossfade, 'startFrame' | 'endFrame'>,
): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}
