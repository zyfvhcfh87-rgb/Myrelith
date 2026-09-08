import { COLOR_LUT_LIMITS } from './colorLut'
import { isColorGradingPixel, isColorGradingType, type ColorGradingContext } from './colorGradingEffects'
import { effectRegistration, resolveEffectStack, type EffectCapability } from './effectStack'
import { renderSurfaceBudget, MAX_RENDER_AGGREGATE_SURFACE_BYTES } from './renderSurfaceBudget'
import { videoBusScratchBytes } from './videoBusStage'
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
export function colorGradingAdditionalBytes(effects: readonly EffectDescriptor[], width: number, height: number, projectWidth = width, projectHeight = height): number {
  if (!effects.some((effect) => effect.enabled && isColorGradingType(effect.type))) return 0
  const active = effects.filter((effect) => effect.enabled)
  const pixels = width * height
  const copies = active.some((effect) => effect.type.startsWith('plugin:')) ? 4 : 1
  const scratch = Math.max(
    active.some((effect) => effect.type === 'builtin.mask' && effect.params.shape === 'bezier') ? pixels * 5 : 0,
    active.some((effect) => ['builtin.box-blur', 'builtin.sharpen', 'builtin.vignette', 'builtin.drop-shadow', 'builtin.outline'].includes(effect.type)) ? videoBusScratchBytes(width, height, projectWidth, projectHeight) : 0,
  )
  return pixels * 4 * copies + scratch + COLOR_LUT_LIMITS.runtimeBytes
}
export function colorGradingPlanError(plan: VideoCompositionPlan, width: number, height: number, context: ColorGradingContext, policy: 'bypass' | 'fail', pixelsAvailable: boolean, projectWidth = width, projectHeight = height): string | null {
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
  if (!stages) return null
  const base = renderSurfaceBudget(width, height)
  if (base.reason) return base.reason
  const bytes = base.aggregateBytes + colorGradingAdditionalBytes(stacks.flat(), width, height, projectWidth, projectHeight)
  return bytes > MAX_RENDER_AGGREGATE_SURFACE_BYTES ? 'Color grading, plugin copies, readback and scratch exceed the 256 MiB render surface allowance.' : null
}

export function colorGradingPlanNeedsPixels(plan: VideoCompositionPlan, context: ColorGradingContext): boolean {
  const capabilities = new Set<EffectCapability>(['canvas2d-filter', 'canvas2d-pixel-access'])
  return gradingPlanStacks(plan).some((stack) => resolveEffectStack(stack.filter((effect) => effect.enabled && isColorGradingType(effect.type)), capabilities, context)
    .some((resolution) => resolution.status === 'ready' && effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect, context)))
}
