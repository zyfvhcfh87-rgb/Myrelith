/** Value-independent temporal traversal shared by existing animation owners. */
export interface AnimationKeyframeTime {
  readonly frame: number
  readonly sourceTimeTicks?: number
}

interface TimedAnimationTrack {
  readonly keyframes: readonly AnimationKeyframeTime[]
}

/**
 * Map already admitted tracks without dropping their typed payload/metadata.
 * Callers own value, frame, source-map and cardinality validation. A rejection
 * publishes no partial result and never changes the input. Retiming alone asks
 * for sorted unique destinations; ordinary origin/source shifts preserve order.
 */
export function mapAnimationTrackKeyframes<Track extends TimedAnimationTrack>(
  sourceTracks: readonly Track[],
  mapKeyframe: (keyframe: Track['keyframes'][number]) => Track['keyframes'][number] | null,
  order: 'preserve' | 'sorted-unique' = 'preserve',
): Track[] | null {
  const tracks: Track[] = []
  for (const track of sourceTracks) {
    const keyframes: Track['keyframes'][number][] = []
    const frames = order === 'sorted-unique' ? new Set<number>() : null
    for (const keyframe of track.keyframes) {
      const mapped = mapKeyframe(keyframe)
      if (mapped === null || frames?.has(mapped.frame)) return null
      frames?.add(mapped.frame)
      keyframes.push(mapped)
    }
    if (frames) keyframes.sort((left, right) => left.frame - right.frame)
    tracks.push({ ...track, keyframes })
  }
  return tracks
}
