/** Crop admission covers all sequences and the complete integer ranges of both transition legs. */
import type { SequenceProject } from './projectSequences'
import type { Clip, ClipAnimationTrack } from './schema'
import { clipVisualSettings } from './clipInspector'
import { CROP_ANIMATION_PROPERTIES } from './clipAnimationProperties'
import { crossfadeWindowAtCut } from './crossfadePlan'
import { certifyCropAnimations, type CropAnimationCertificateRequest, type CropAnimationProjectCertificateResult } from './cropAnimationCertificate'
import { MAX_KEYFRAME_FRAME } from './scalarAnimation'

export function cropAnimationTracks(clip: Clip): CropAnimationCertificateRequest['tracks'] {
  const tracks: Partial<Record<'left' | 'right' | 'top' | 'bottom', ClipAnimationTrack>> = {}
  for (const track of clip.animation?.tracks ?? []) {
    if ((track.propertyVersion ?? 1) !== 1) continue
    for (const property of CROP_ANIMATION_PROPERTIES) {
      if (track.property === property) tracks[property.slice(5) as keyof typeof tracks] = track
    }
  }
  return tracks
}

/** The owning project is immutable. Each cached result binds the complete snapshot and ranges. */
const admittedFrozenProjects = new WeakMap<SequenceProject, CropAnimationProjectCertificateResult>()

export function certifyProjectCropAnimation(project: SequenceProject): CropAnimationProjectCertificateResult {
  const cached = admittedFrozenProjects.get(project)
  if (cached) return cached
  const requests: CropAnimationCertificateRequest[] = []
  for (const sequence of project.sequences) for (const track of sequence.tracks) {
    const ranges = new Map<Clip, { start: number; end: number }>()
    const byId = new Map(track.clips.map((clip) => [clip.id, clip]))
    for (const clip of track.clips) {
      if (clip.animation?.tracks.some((lane) => (lane.propertyVersion ?? 1) === 1
        && CROP_ANIMATION_PROPERTIES.some((property) => property === lane.property))) {
        ranges.set(clip, { start: 0, end: clip.timelineRange.durationFrames - 1 })
      }
    }
    for (const transition of track.transitions) {
      const from = byId.get(transition.fromClipId), to = byId.get(transition.toClipId)
      if (!from || !to || (!ranges.has(from) && !ranges.has(to))) continue
      const cut = from.timelineRange.startFrame + from.timelineRange.durationFrames
      if (cut !== to.timelineRange.startFrame) continue
      const window = crossfadeWindowAtCut(cut, transition.durationFrames)
      if (!window) continue // Structural transition admission owns invalid windows.
      for (const clip of [from, to]) {
        const range = ranges.get(clip)
        if (!range) continue
        range.start = Math.min(range.start, window.startFrame - clip.timelineRange.startFrame)
        range.end = Math.max(range.end, window.endFrame - 1 - clip.timelineRange.startFrame)
      }
    }
    for (const [clip, range] of ranges) {
      // Beyond the key-frame bound the scalar evaluator is exactly endpoint-held;
      // clamping the requested bounds includes the identical held endpoint values.
      const bounded = (frame: number) => Math.min(MAX_KEYFRAME_FRAME, Math.max(-MAX_KEYFRAME_FRAME, frame))
      requests.push({ crop: clipVisualSettings(clip).crop, tracks: cropAnimationTracks(clip), startFrame: bounded(range.start), endFrame: bounded(range.end) })
    }
  }
  const result = certifyCropAnimations(requests)
  // Only deeply frozen owned graphs may be cached. Mutable parser/test inputs are
  // rechecked; freezing the root alone is not treated as immutable geometry.
  const frozen = Object.isFrozen(project) && Object.isFrozen(project.sequences)
    && project.sequences.every((sequence) => Object.isFrozen(sequence) && Object.isFrozen(sequence.tracks)
      && sequence.tracks.every((track) => Object.isFrozen(track) && Object.isFrozen(track.clips)
        && Object.isFrozen(track.transitions) && track.transitions.every(Object.isFrozen)
        && track.clips.every((clip) => Object.isFrozen(clip) && Object.isFrozen(clip.timelineRange)
          && (clip.animation === undefined || (Object.isFrozen(clip.animation) && Object.isFrozen(clip.animation.tracks)
            && clip.animation.tracks.every((lane) => Object.isFrozen(lane) && Object.isFrozen(lane.keyframes)
              && lane.keyframes.every((key) => Object.isFrozen(key) && Object.isFrozen(key.easing)))))
          && (clip.visual === undefined || (Object.isFrozen(clip.visual) && Object.isFrozen(clip.visual.crop))))))
  if (frozen) admittedFrozenProjects.set(project, result)
  return result
}

export function projectCropAnimationError(project: SequenceProject): string | null {
  const result = certifyProjectCropAnimation(project)
  return result.ok ? null : `${result.detail}${result.frame === undefined ? '' : ` At local frame ${result.frame}.`}`
}
