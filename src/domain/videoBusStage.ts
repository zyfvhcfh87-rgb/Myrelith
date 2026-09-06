/** Static video bus stage traits and dimension-dependent allocation authority. */
import type { EffectDescriptor, TimelineDoc } from './schema'
import { effectDescriptorBoundsError, EFFECT_STACK_LIMITS } from './effectBounds'
import { cloneEffectDescriptor, effectParamsValidationError, effectRegistration, resolvePostCompositeEffectStack } from './effectStack'
import { renderSurfaceBudget, MAX_RENDER_AGGREGATE_SURFACE_BYTES } from './renderSurfaceBudget'

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
export function resolveVideoBusEffects(effects: readonly EffectDescriptor[], pixelsAvailable: boolean) {
  const supported = effects.filter((effect) => !videoBusEffectIneligibility(effect))
  const executable = resolvePostCompositeEffectStack(supported, pixelsAvailable)
  const all = resolvePostCompositeEffectStack(effects, pixelsAvailable)
  return { ...executable, effects: all.effects.map((resolution) => {
    const reason = videoBusStageIneligibility(resolution.effect)
      ?? (!pixelsAvailable && resolution.status !== 'invalid' && resolution.effect.enabled && effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect)
        ? 'Canvas pixel access is unavailable for video-bus effects.' : null)
    return reason ? { ...resolution, status: 'unsupported' as const, detail: reason, canvasFilter: null } : resolution
  }) }
}
/** Upper bound over all admitted spatial parameters, independently of stack length. */
export function videoBusScratchBytes(width: number, height: number, projectWidth = width, projectHeight = height): number {
  const rx = Math.min(width - 1, Math.round(32 * width / projectWidth))
  const ry = Math.min(height - 1, Math.round(32 * height / projectHeight))
  const outline = width * (6 * ry + 19) + 4 * (rx + 1)
  const shadow = width * (Math.min(height, 2 * Math.round(32 * height / projectHeight) + Math.round(64 * height / projectHeight) + 2) + 8)
  return Math.max(Math.max(width, height) * 4, width * 12, outline, shadow)
}
export function videoBusAdditionalBytes(width: number, height: number, projectWidth = width, projectHeight = height): number {
  return width * height * 4 + videoBusScratchBytes(width, height, projectWidth, projectHeight)
}
export function videoBusRenderBudgetError(width: number, height: number, projectWidth = width, projectHeight = height): string | null {
  const base = renderSurfaceBudget(width, height)
  if (!base.allowed) return base.reason
  const total = base.aggregateBytes + videoBusAdditionalBytes(width, height, projectWidth, projectHeight)
  return !Number.isSafeInteger(total) || total > MAX_RENDER_AGGREGATE_SURFACE_BYTES ? 'Video-bus readback and scratch exceed the render memory limit at this resolution.' : null
}

export function snapshotVideoBusStack(effects: readonly EffectDescriptor[] | undefined): readonly EffectDescriptor[] {
  return Object.freeze((effects ?? []).map((effect) => Object.freeze({ ...cloneEffectDescriptor(effect), params: Object.freeze({ ...effect.params }) })))
}
