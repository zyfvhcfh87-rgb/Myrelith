/** The completed title surface supports only exact registered numeric effects. */
import type { Clip, EffectDescriptor } from './schema'
import { effectAnimationParameterSpec, effectSupportsSurface, type EffectAnimationParameterSpec } from './effectStack'
import { readTitleDefinitionCached } from './titleDefinitionCache'

export function titleEffectAnimationParameterSpec(
  clip: Clip,
  effect: EffectDescriptor,
  parameter: string,
): EffectAnimationParameterSpec | null {
  if (clip.title === undefined || clip.text !== undefined
    || !effectSupportsSurface(effect, 'post-composite')) return null
  const spec = effectAnimationParameterSpec(effect, parameter)
  if (!spec) return null
  return readTitleDefinitionCached(clip.title).status === 'supported' ? spec : null
}
