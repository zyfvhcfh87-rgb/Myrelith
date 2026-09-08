/** Prepared held paths use the #198 geometry adapter and the canonical clip-local frame. */
import {
  prepareEffectPathAnimationTrack, evaluatePreparedEffectPathAnimationTrack,
  type EffectPathAnimationTrack, type PreparedEffectPathAnimationTrack,
} from './maskPathAnimation'
import type { Clip, EffectDescriptor } from './schema'
import { maskNonPathParamsValidationError } from './effectStack'

interface PreparedEntry {
  readonly effectType: string
  readonly effectVersion: number
  readonly effectId: string
  readonly shape: unknown
  readonly parameter: string
  readonly valueType: string
  readonly valueVersion: number
  readonly keys: readonly { readonly frame: number; readonly value: string; readonly easing: string }[]
  readonly prepared: PreparedEffectPathAnimationTrack
}
const preparedTracks = new WeakMap<EffectPathAnimationTrack, PreparedEntry>()

/** Shared by resolution and editing status; keeps validation in one prepared cache. */
export function prepareCachedEffectPathAnimationTrack(track: EffectPathAnimationTrack, effect: EffectDescriptor): PreparedEffectPathAnimationTrack {
  const cached = preparedTracks.get(track)
  if (cached && cached.effectId === effect.id && cached.effectType === effect.type && cached.effectVersion === effect.version
    && cached.shape === effect.params.shape && cached.parameter === track.parameter && cached.valueType === track.valueType
    && cached.valueVersion === track.valueVersion && cached.keys.length === track.keyframes.length
    && cached.keys.every((key, index) => key.frame === track.keyframes[index].frame && key.value === track.keyframes[index].value && key.easing === track.keyframes[index].easing.type)) return cached.prepared
  const prepared = prepareEffectPathAnimationTrack(track, effect)
  preparedTracks.set(track, {
    effectId: effect.id, effectType: effect.type, effectVersion: effect.version, shape: effect.params.shape,
    parameter: track.parameter, valueType: track.valueType, valueVersion: track.valueVersion,
    keys: track.keyframes.map((key) => ({ frame: key.frame, value: key.value, easing: key.easing.type })), prepared,
  })
  return prepared
}

/** Caller has accepted the complete shared animation envelope before this adapter. */
export function resolveEffectPathAnimation(clip: Clip, tracks: readonly EffectPathAnimationTrack[], localFrame: number): Clip {
  if (!tracks.length) return clip
  let effects: EffectDescriptor[] | null = null
  for (let index = 0; index < clip.effects.length; index++) {
    const effect = clip.effects[index]
    for (const track of tracks) {
      if (track.effectId !== effect.id) continue
      const fallback = effect.params[track.parameter]
      if (typeof fallback !== 'string') continue
      const prepared = prepareCachedEffectPathAnimationTrack(track, effect)
      if (!prepared.ok) continue
      const value = evaluatePreparedEffectPathAnimationTrack(prepared, localFrame, fallback)
      if (value === fallback) continue
      const replacement = { ...effect, params: { ...effect.params, [track.parameter]: value } }
      if (maskNonPathParamsValidationError(replacement.params)) continue
      effects ??= clip.effects.slice()
      effects[index] = replacement
    }
  }
  return effects ? { ...clip, effects } : clip
}
