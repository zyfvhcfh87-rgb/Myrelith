import {
  clipAnimation,
  MAX_KEYFRAMES_PER_TRACK,
  MAX_TOTAL_ANIMATION_KEYFRAMES,
} from '../domain/clipAnimation'
import type { Clip, EffectAnimationTrack } from '../domain/schema'

function animationKeyframeCount(clip: Clip): number {
  const animation = clipAnimation(clip)
  return [...animation.tracks, ...(animation.effectTracks ?? [])]
    .reduce((total, track) => total + track.keyframes.length, 0)
}

/** Fill one structurally valid clip to an exact aggregate-key fixture size. */
export function clipWithAnimationKeyframeCount(
  clip: Clip,
  total = MAX_TOTAL_ANIMATION_KEYFRAMES,
): Clip {
  const animation = clipAnimation(clip)
  const current = animationKeyframeCount(clip)
  if (current > total) throw new RangeError('clip already exceeds requested keyframe count')
  let remaining = total - current
  const fillers: EffectAnimationTrack[] = []
  let trackIndex = 0
  while (remaining > 0) {
    const count = Math.min(remaining, MAX_KEYFRAMES_PER_TRACK)
    fillers.push({
      effectId: '__animation-budget-fixture__',
      parameter: `filler-${trackIndex}`,
      keyframes: Array.from({ length: count }, (_unused, frame) => ({
        frame,
        sourceTimeTicks: frame * 1_000_000,
        value: frame,
        easing: { type: 'linear' as const },
      })),
    })
    remaining -= count
    trackIndex++
  }
  return {
    ...clip,
    animation: {
      tracks: animation.tracks,
      effectTracks: [...(animation.effectTracks ?? []), ...fillers],
    },
  }
}
