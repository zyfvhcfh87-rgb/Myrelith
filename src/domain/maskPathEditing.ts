/** Mask-owned held values; shared animation collections and source timing remain authoritative. */
import { clipAnimation, clipAnimationValidationError } from './clipAnimation'
import { effectPathAnimationTracks } from './animationCollections'
import { maskBezierPathValidationError } from './maskPath'
import { evaluatePreparedEffectPathAnimationTrack, MASK_PATH_ANIMATION_LIMITS, MASK_PATH_VALUE_TYPE, MASK_PATH_VALUE_VERSION, type EffectPathAnimationTrack } from './maskPathAnimation'
import { prepareCachedEffectPathAnimationTrack } from './effectPathAnimationResolution'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'
import type { Clip, ClipAnimation, EffectDescriptor } from './schema'

export type MaskPathKeyEdit =
  | { readonly kind: 'set'; readonly frame: number; readonly value: string }
  | { readonly kind: 'remove'; readonly frame: number }
  | { readonly kind: 'clear' }

export function maskPathAnimationStatus(clip: Clip, effect: EffectDescriptor): {
  readonly track: EffectPathAnimationTrack | undefined
  readonly reason: string | null
  readonly dormant: boolean
} {
  const animation = clipAnimation(clip)
  const track = effectPathAnimationTracks(animation).find((item) => item.effectId === effect.id && item.parameter === 'path')
  const dormant = effect.params.shape !== 'bezier'
  const commonError = clipAnimationValidationError(animation)
  if (commonError) return { track, dormant, reason: commonError }
  if (clip.text) return { track, dormant, reason: 'Text mask paths stay static.' }
  if (effect.type !== 'builtin.mask' || effect.version !== 1) return { track, dormant, reason: 'This mask effect version is unavailable.' }
  if (animation.effectTracks?.some((item) => item.effectId === effect.id && item.parameter === 'path')) {
    return { track, dormant, reason: 'Preserved scalar intent already owns the path parameter.' }
  }
  if (track) {
    // Dormancy does not make valid stored keys unavailable for inspection/removal.
    const prepared = prepareCachedEffectPathAnimationTrack(track, { ...effect, params: { ...effect.params, shape: 'bezier' } })
    if (!prepared.ok) return { track, dormant, reason: prepared.reason }
  }
  return { track, dormant, reason: null }
}

export function heldMaskPathAtFrame(clip: Clip, effect: EffectDescriptor, localFrame: number): string {
  const status = maskPathAnimationStatus(clip, effect)
  if (status.reason) throw new Error(status.reason)
  const fallback = String(effect.params.path)
  return status.track ? evaluatePreparedEffectPathAnimationTrack(
    prepareCachedEffectPathAnimationTrack(status.track, { ...effect, params: { ...effect.params, shape: 'bezier' } }), localFrame, fallback,
  ) : fallback
}

/** Set replaces one occupied frame; removal of the last key restores static fallback. */
export function editMaskPathKeys(clip: Clip, effect: EffectDescriptor, edit: MaskPathKeyEdit): ClipAnimation {
  const current = clipAnimation(clip), status = maskPathAnimationStatus(clip, effect)
  if (status.reason) throw new Error(status.reason)
  const existing = status.track
  if (edit.kind !== 'clear' && (!Number.isSafeInteger(edit.frame) || Math.abs(edit.frame) > MASK_PATH_ANIMATION_LIMITS.maximumFrameMagnitude)) throw new Error('Path key frames must be bounded integers.')
  let replacement: EffectPathAnimationTrack | undefined
  if (edit.kind === 'set') {
    if (status.dormant) throw new Error('Choose Bezier before adding path keys.')
    const error = maskBezierPathValidationError(edit.value)
    if (error) throw new Error(error)
    const occupied = existing?.keyframes.find((key) => key.frame === edit.frame)
    if (!occupied && (existing?.keyframes.length ?? 0) >= MASK_PATH_ANIMATION_LIMITS.keysPerTrack) throw new Error('A path track can hold at most 256 keys.')
    const sourceTimeTicks = sourceTicksAtTimelineOffset(clipSourceTimeMap(clip), edit.frame)
    if (occupied?.value === edit.value && occupied.sourceTimeTicks === sourceTimeTicks) return current
    const keyframes = (existing?.keyframes ?? []).filter((key) => key.frame !== edit.frame)
    keyframes.push({ frame: edit.frame, sourceTimeTicks, value: edit.value, easing: { type: 'hold' } })
    keyframes.sort((left, right) => left.frame - right.frame)
    replacement = { effectId: effect.id, parameter: 'path', valueType: MASK_PATH_VALUE_TYPE, valueVersion: MASK_PATH_VALUE_VERSION, keyframes }
  } else {
    if (!existing) return current
    if (edit.kind === 'remove') {
      const keyframes = existing.keyframes.filter((key) => key.frame !== edit.frame)
      if (keyframes.length === existing.keyframes.length) return current
      if (keyframes.length) replacement = { ...existing, keyframes }
    }
  }
  const tracks = effectPathAnimationTracks(current).filter((track) => track !== existing)
  const next = { ...current, effectPathTracks: replacement ? [...tracks, replacement] : tracks }
  const error = clipAnimationValidationError(next)
  if (error) throw new Error(error)
  return next
}
