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

export function certifyProjectCropAnimation(project: SequenceProject): CropAnimationProjectCertificateResult {
  const requests: CropAnimationCertificateRequest[] = []
  for (const sequence of project.sequences) for (const track of sequence.tracks) {
    const ranges = new Map<Clip, { start: number; end: number }>()
    const byId = new Map(track.clips.map((clip) => [clip.id, clip]))
    for (const clip of track.clips) {
      if (clip.title !== undefined) continue // Outer title geometry lanes are preserved but inactive.
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
  return certifyCropAnimations(requests)
}

export function projectCropAnimationError(project: SequenceProject): string | null {
  const result = certifyProjectCropAnimation(project)
  return result.ok ? null : `${result.detail}${result.frame === undefined ? '' : ` At local frame ${result.frame}.`}`
}
