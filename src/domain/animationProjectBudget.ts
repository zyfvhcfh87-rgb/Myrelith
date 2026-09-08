/** All-sequence path projections for the shared history/clipboard admission boundary. */
import type { SequenceProject } from './projectSequences'
import { maskPathAnimationRetentionError, MASK_PATH_ANIMATION_LIMITS, type EffectPathAnimationTrack, type MaskPathAnimationSnapshot } from './maskPathAnimation'

export function projectPathAnimationSnapshot(project: SequenceProject): MaskPathAnimationSnapshot {
  const tracks: EffectPathAnimationTrack[] = []
  for (const sequence of project.sequences) for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      for (const lane of clip.animation?.effectPathTracks ?? []) {
        tracks.push(lane)
        if (tracks.length > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { tracks }
      }
    }
    for (const adjustment of track.adjustments ?? []) for (const lane of adjustment.animation.effectPathTracks ?? []) {
      tracks.push(lane)
      if (tracks.length > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { tracks }
    }
  }
  return { tracks }
}

export interface AnimationRetentionState {
  readonly project: SequenceProject
  readonly past: readonly SequenceProject[]
  readonly future: readonly SequenceProject[]
  readonly retainedAttributePathTracks: readonly EffectPathAnimationTrack[]
  readonly retainedKeyPathTracks: readonly EffectPathAnimationTrack[]
}

export function animationRetentionError(
  state: AnimationRetentionState,
  candidate: SequenceProject | MaskPathAnimationSnapshot,
): string | null {
  return maskPathAnimationRetentionError({
    candidate: 'sequences' in candidate ? projectPathAnimationSnapshot(candidate) : candidate,
    current: projectPathAnimationSnapshot(state.project),
    past: state.past.map(projectPathAnimationSnapshot),
    future: state.future.map(projectPathAnimationSnapshot),
    attributeClipboard: { tracks: state.retainedAttributePathTracks },
    keyClipboard: { tracks: state.retainedKeyPathTracks },
  })
}
