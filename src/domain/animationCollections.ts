/** Shared collection traversal interprets time/ownership, never typed values. */
import type { ClipAnimation, ClipAnimationTrack, EffectAnimationTrack, TitleAnimationTrack } from './schema'
import type { EffectPathAnimationTrack } from './maskPathAnimation'

export const MAX_CLIP_SCALAR_ANIMATION_TRACKS = 64
export const MAX_TITLE_ANIMATION_TRACKS = 256
export const MAX_ANIMATION_PROPERTY_CHARACTERS = 256

export type AnyAnimationTrack = ClipAnimationTrack | EffectAnimationTrack | TitleAnimationTrack | EffectPathAnimationTrack

export function titleAnimationTracks(animation: ClipAnimation): readonly TitleAnimationTrack[] {
  return animation.titleTracks ?? []
}

export function effectPathAnimationTracks(animation: ClipAnimation): readonly EffectPathAnimationTrack[] {
  return animation.effectPathTracks ?? []
}

export function forEachAnimationTrack(animation: ClipAnimation, visit: (track: AnyAnimationTrack) => void): void {
  for (const track of animation.tracks) visit(track)
  for (const track of animation.effectTracks ?? []) visit(track)
  for (const track of animation.titleTracks ?? []) visit(track)
  for (const track of animation.effectPathTracks ?? []) visit(track)
}

/** Preserve absent new fields and exact typed track metadata; reject all or none. */
export function mapAnimationCollections(
  animation: ClipAnimation,
  map: <T extends AnyAnimationTrack>(tracks: readonly T[]) => T[] | null,
): ClipAnimation | null {
  const tracks = map(animation.tracks)
  if (!tracks) return null
  const effectTracks = map(animation.effectTracks ?? [])
  if (!effectTracks) return null
  const titleTracks = animation.titleTracks === undefined ? undefined : map(animation.titleTracks)
  if (titleTracks === null) return null
  const effectPathTracks = animation.effectPathTracks === undefined ? undefined : map(animation.effectPathTracks)
  if (effectPathTracks === null) return null
  return {
    tracks, effectTracks,
    ...(titleTracks === undefined ? {} : { titleTracks }),
    ...(effectPathTracks === undefined ? {} : { effectPathTracks }),
  }
}

/** The title owner supplies its element-id mapping during duplicate/paste. */
export function remapTitleAnimationElementIds(animation: ClipAnimation, replacements: ReadonlyMap<string, string>): ClipAnimation {
  if (animation.titleTracks === undefined) return animation
  return { ...animation, titleTracks: animation.titleTracks.map((track) => ({
    ...track, elementId: replacements.get(track.elementId) ?? track.elementId,
  })) }
}
