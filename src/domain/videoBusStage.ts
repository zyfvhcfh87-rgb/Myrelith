import type { ColorGradingContext } from './colorGradingEffects'
/** Static video bus stage traits and dimension-dependent allocation authority. */
import type { EffectDescriptor, TimelineDoc } from './schema'
import { effectDescriptorBoundsError, EFFECT_STACK_LIMITS } from './effectBounds'
import { cloneEffectDescriptor, effectParamsValidationError, effectRegistration, resolvePostCompositeEffectStack } from './effectStack'
import { renderWorkSurfaceBudget } from './renderSurfaceBudget'
import { peakPixelStackWork, pixelStackWorkBudget } from './pixelWorkBudget'
import { spatialEffectScratchBytes } from './spatialEffectPixels'
import { SPATIAL_EFFECT_PARAMETERS, type SpatialEffectKind, type SpatialPixelEffect } from './spatialEffectDefinitions'

export function videoBusStacks(doc: TimelineDoc): readonly (readonly EffectDescriptor[])[] {
  return [doc.masterVideoEffects ?? [], ...doc.tracks.map((track) => track.videoEffects ?? [])]
}
export function hasVideoBusEffects(doc: TimelineDoc): boolean { return videoBusStacks(doc).some((effects) => effects.length > 0) }
export function videoBusStageIneligibility(effect: EffectDescriptor): string | null {
  const registration = effectRegistration(effect.type)
  if (!registration || registration.version !== effect.version) return `${effect.type} v${effect.version} has no supported video-bus stage.`
  if (!registration.surfaces.includes('post-composite') || !registration.preservesOpaqueInput) return `${registration.label} is available on clips only; video buses require an opaque-preserving post-composite effect.`
  return null
}
export function videoBusEffectIneligibility(effect: EffectDescriptor): string | null {
  return videoBusStageIneligibility(effect) ?? effectParamsValidationError(effect)
}
export function videoBusStackBoundsError(effects: readonly EffectDescriptor[]): string | null {
  if (!Array.isArray(effects) || effects.length > EFFECT_STACK_LIMITS.maxEffectsPerClip) return `A video bus supports at most ${EFFECT_STACK_LIMITS.maxEffectsPerClip} effects.`
  for (const effect of effects) {
    const error = effectDescriptorBoundsError(effect)
    if (error) return error
  }
  return null
}
export function resolveVideoBusEffects(effects: readonly EffectDescriptor[], pixelsAvailable: boolean, context?: ColorGradingContext) {
  const supported = effects.filter((effect) => !videoBusEffectIneligibility(effect))
  const executable = resolvePostCompositeEffectStack(supported, pixelsAvailable, context)
  const all = resolvePostCompositeEffectStack(effects, pixelsAvailable, context)
  return { ...executable, effects: all.effects.map((resolution) => {
    const reason = videoBusStageIneligibility(resolution.effect)
      ?? (!pixelsAvailable && resolution.status !== 'invalid' && resolution.effect.enabled && effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect)
        ? 'Canvas pixel access is unavailable for video-bus effects.' : null)
    return reason ? { ...resolution, status: 'unsupported' as const, detail: reason, canvasFilter: null } : resolution
  }) }
}
/** Upper bound over all admitted spatial parameters, independently of stack length. */
const MAXIMUM_SPATIAL_STAGES: readonly SpatialPixelEffect[] = (Object.keys(SPATIAL_EFFECT_PARAMETERS) as SpatialEffectKind[])
  .map((kind) => ({ kind, params: Object.freeze({ color: '#000000',
    ...Object.fromEntries(Object.entries(SPATIAL_EFFECT_PARAMETERS[kind]).map(([key, spec]) => [key, spec.max])) }) }))
export function videoBusScratchBytes(width: number, height: number, projectWidth = width, projectHeight = height): number {
  const geometry = { surfaceWidth: width, surfaceHeight: height, projectWidth, projectHeight }
  return Math.max(...MAXIMUM_SPATIAL_STAGES.map((stage) => spatialEffectScratchBytes(stage, geometry)))
}
export function videoBusAdditionalBytes(width: number, height: number, projectWidth = width, projectHeight = height): number {
  const geometry = { surfaceWidth: width, surfaceHeight: height, projectWidth, projectHeight }
  const budget = peakPixelStackWork(MAXIMUM_SPATIAL_STAGES.map((stage) => pixelStackWorkBudget([stage], geometry, 'shared-scratch')))
  return budget.reason ? Number.POSITIVE_INFINITY : budget.peakAdditionalBytes
}
export function videoBusRenderBudgetError(width: number, height: number, projectWidth = width, projectHeight = height): string | null {
  return renderWorkSurfaceBudget(width, height, {
    additionalOwnedBytes: videoBusAdditionalBytes(width, height, projectWidth, projectHeight),
  }).reason
}

export function snapshotVideoBusStack(effects: readonly EffectDescriptor[] | undefined): readonly EffectDescriptor[] {
  return Object.freeze((effects ?? []).map((effect) => Object.freeze({ ...cloneEffectDescriptor(effect), params: Object.freeze({ ...effect.params }) })))
}
