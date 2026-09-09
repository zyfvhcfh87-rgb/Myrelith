import { COLOR_LUT_LIMITS } from './colorLut'
import { isColorGradingPixel, isColorGradingType, type ColorGradingContext } from './colorGradingEffects'
import { effectRegistration, resolveEffectStack, type EffectCapability } from './effectStack'
import type { EffectDescriptor, TimelineDoc } from './schema'
import type { VideoCompositionPlan } from './videoCompositionPlan'

export function gradingPlanStacks(plan: VideoCompositionPlan): readonly (readonly EffectDescriptor[])[] {
  return plan.items.flatMap((item): (readonly EffectDescriptor[])[] => {
    if (item.kind === 'title' && !item.title.elements.length) return []
    const tracks = 'trackEffects' in item ? [item.trackEffects ?? []] : []
    if (item.kind === 'clip') return [...tracks, item.request.clip.effects]
    if (item.kind === 'crossfade') return [...tracks, ...item.requests.map((request) => request.clip.effects)]
    if (item.kind === 'text' || item.kind === 'title') return [...tracks, item.clip.effects]
    if (item.kind === 'adjustment') return [item.adjustment.effects]
    if (item.kind === 'video-bus') return [item.effects]
    return []
  })
}
export function documentGradingEffects(doc: TimelineDoc): EffectDescriptor[] {
  return [...(doc.masterVideoEffects ?? []), ...doc.tracks.flatMap((track) => [...(track.videoEffects ?? []), ...track.clips.flatMap((clip) => clip.effects), ...(track.adjustments ?? []).flatMap((item) => item.effects)])]
}
/** Grading availability and visit limits; all buffer admission uses videoPixelWorkBudget. */
export function colorGradingPlanError(plan: VideoCompositionPlan, width: number, height: number, context: ColorGradingContext, policy: 'bypass' | 'fail', pixelsAvailable: boolean): string | null {
  const stacks = gradingPlanStacks(plan)
  if (!stacks.some((stack) => stack.some((effect) => effect.enabled && isColorGradingType(effect.type)))) return null
  const available = new Set<EffectCapability>(['canvas2d-filter', ...(pixelsAvailable ? ['canvas2d-pixel-access' as const] : [])])
  let stages = 0
  for (const stack of stacks) for (const resolution of resolveEffectStack(stack, available, context)) {
    if (!resolution.effect.enabled || !isColorGradingType(resolution.effect.type)) continue
    if (resolution.status !== 'ready') { if (policy === 'fail') return `${resolution.label}: ${resolution.detail}`; continue }
    const pixel = effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect, context)
    if (pixel && isColorGradingPixel(pixel)) stages++
  }
  if (stages * width * height > COLOR_LUT_LIMITS.pixelStageVisits) return 'This frame exceeds 134,217,728 color-grading pixel-stage visits. Bypass some grading stages or reduce the preview resolution.'
  return null
}

export function colorGradingPlanNeedsPixels(plan: VideoCompositionPlan, context: ColorGradingContext): boolean {
  const capabilities = new Set<EffectCapability>(['canvas2d-filter', 'canvas2d-pixel-access'])
  return gradingPlanStacks(plan).some((stack) => resolveEffectStack(stack.filter((effect) => effect.enabled && isColorGradingType(effect.type)), capabilities, context)
    .some((resolution) => resolution.status === 'ready' && effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect, context)))
}
