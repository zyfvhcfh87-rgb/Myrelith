/** Frame-exact and conservative document inputs to the shared pixel ledger. */
import { EMPTY_COLOR_GRADING_CONTEXT, isColorGradingPixel, isColorGradingType, type ColorGradingContext } from './colorGradingEffects'
import { DEFAULT_MASK_BEZIER_PATH, MASK_LIMITS, effectAnimationParameterSpec, effectParamsValidationError, effectRegistration, resolveCanvasEffectStack, resolvePostCompositeEffectStack,
  type CanvasEffectStackResolution, type CanvasPixelEffect, type MaskParams } from './effectStack'
import type { PixelEffectGeometry } from './effectPixels'
import { prepareEffectPathAnimationTrack } from './maskPathAnimation'
import { peakPixelStackWork, pixelStackWorkBudget, pixelWorkGeometryError,
  type PixelWorkBudget, type PixelWorkStage } from './pixelWorkBudget'
import type { VideoEffectStagePlan } from './pluginVideoEffectStagePlan'
import type { Clip, EffectAnimationTrack, EffectDescriptor, TimelineDoc } from './schema'
import { spatialEffectKind } from './spatialEffectDefinitions'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { isProceduralTitleClip } from './textOverlay'
import { resolveVideoBusEffects } from './videoBusStage'
import type { VideoCompositionPlan } from './videoCompositionPlan'

interface WorkStack {
  readonly stages: readonly PixelWorkStage[]
  readonly plugin: boolean
  readonly potentialReadback?: boolean
}

function animatedParameterSpec(clip: Clip | undefined, effect: EffectDescriptor, track: EffectAnimationTrack) {
  if (!effect.enabled || track.effectId !== effect.id || track.parameterIdentity !== undefined
    || !track.keyframes.length || typeof effect.params[track.parameter] !== 'number') return null
  return clip?.title === undefined ? effectAnimationParameterSpec(effect, track.parameter)
    : titleEffectAnimationParameterSpec(clip, effect, track.parameter)
}

/** Resolve potential spatial work before an authored identity can filter it out. */
function reservationEffects(effects: readonly EffectDescriptor[], tracks: readonly EffectAnimationTrack[], clip?: Clip) {
  return effects.map((effect) => {
    if (!spatialEffectKind(effect.type) || effectParamsValidationError(effect)) return effect
    const params = { ...effect.params }
    for (const track of tracks) {
      const spec = animatedParameterSpec(clip, effect, track)
      if (spec) params[track.parameter] = Math.abs(spec.min) > Math.abs(spec.max) ? spec.min : spec.max
    }
    return { ...effect, params }
  })
}

function clipWorkStack(effects: readonly EffectDescriptor[], planned: VideoEffectStagePlan | undefined,
  context: ColorGradingContext, postComposite = false): WorkStack {
  if (!planned?.requiresOrderedPixelPath) return {
    stages: (postComposite ? resolvePostCompositeEffectStack(effects, true, context)
      : resolveCanvasEffectStack(effects, true, true, context)).pixelEffects,
    plugin: false,
  }
  const stages: PixelWorkStage[] = []
  for (const stage of planned.stages) {
    if (stage.kind === 'plugin') {
      if (stage.status === 'ready' && stage.execution) stages.push({ kind: 'plugin' })
    } else if (isColorGradingType(stage.effect.type)) {
      // The real stage executor resolves grading against this frame's catalog.
      stages.push(...resolveCanvasEffectStack([stage.effect], true, true, context).pixelEffects)
    } else if (stage.status === 'ready' && stage.pixelEffect) stages.push(stage.pixelEffect)
  }
  return { stages, plugin: true }
}

/** All expanded child scopes already appear in this flat, authored-order plan. */
export function videoPixelWorkBudget(plan: VideoCompositionPlan, geometry: PixelEffectGeometry,
  context: ColorGradingContext = EMPTY_COLOR_GRADING_CONTEXT): PixelWorkBudget {
  if (pixelWorkGeometryError(geometry)) return pixelStackWorkBudget([], geometry, 'shared-scratch')
  const stacks: WorkStack[] = []
  for (const item of plan.items) {
    if (item.kind === 'title' && !item.title.elements.length) continue
    if ('trackEffects' in item) stacks.push({
      stages: resolveVideoBusEffects(item.trackEffects ?? [], true, context).pixelEffects, plugin: false,
    })
    if (item.kind === 'clip') stacks.push(clipWorkStack(item.request.clip.effects, item.request.effectStagePlan, context))
    else if (item.kind === 'crossfade') {
      for (const request of item.requests) stacks.push(clipWorkStack(request.clip.effects, request.effectStagePlan, context))
    } else if (item.kind === 'text' || item.kind === 'title') stacks.push(clipWorkStack(item.clip.effects, item.effectStagePlan, context, true))
    else if (item.kind === 'adjustment') stacks.push({
      stages: resolvePostCompositeEffectStack(item.adjustment.effects, true, context).pixelEffects, plugin: false,
    })
    else if (item.kind === 'video-bus') stacks.push({ stages: resolveVideoBusEffects(item.effects, true, context).pixelEffects, plugin: false })
  }
  const grading = stacks.some((stack) => stack.stages.some((stage) => stage.kind !== 'plugin' && isColorGradingPixel(stage)))
  return peakPixelStackWork(stacks.map((stack) => pixelStackWorkBudget(stack.stages, geometry,
    stack.plugin ? 'plugin-stages' : stack.stages.some((stage) => stage.kind !== 'plugin' && isColorGradingPixel(stage))
      ? 'isolated-stages' : 'shared-scratch', grading)))
}

function maskPossibilities(clip: Clip | undefined, effect: EffectDescriptor,
  pixel: Extract<CanvasPixelEffect, { kind: 'mask' }>): readonly PixelWorkStage[] {
  if (!clip || pixel.params.shape !== 'bezier') return [pixel]
  const scalar = clip.animation?.effectTracks?.filter((track) => track.effectId === effect.id) ?? []
  const geometryCanChange = scalar.some((track) => ['x', 'y', 'width', 'height'].includes(track.parameter))
  const featherCanChange = scalar.some((track) => track.parameter === 'feather')
  if (geometryCanChange) {
    // A document reservation must cover any later frame before dispatch. Frame
    // admission below uses its exact resolved/clipped geometry instead.
    const params: MaskParams = { ...pixel.params, x: 0, y: 0, width: 1, height: 1,
      path: DEFAULT_MASK_BEZIER_PATH, feather: featherCanChange ? MASK_LIMITS.feather.max : pixel.params.feather }
    return [{ kind: 'mask', params }]
  }
  const params = featherCanChange ? { ...pixel.params, feather: MASK_LIMITS.feather.max } : pixel.params
  const variants: PixelWorkStage[] = [{ kind: 'mask', params }]
  for (const track of clip.animation?.effectPathTracks ?? []) {
    if (track.effectId !== effect.id) continue
    const prepared = prepareEffectPathAnimationTrack(track, effect)
    if (prepared.ok) for (const key of prepared.keyframes) {
      variants.push({ kind: 'mask', params: { ...params, path: key.value } })
    }
  }
  return variants
}

/**
 * Reserve all admitted held-path possibilities and potential plugin/grading
 * work before a document enters the renderer. Inactive grading cannot select a
 * cheaper isolated lane for masks that may execute alone at another frame.
 */
export function documentPixelWorkBudget(doc: TimelineDoc, geometry: PixelEffectGeometry,
  context: ColorGradingContext = EMPTY_COLOR_GRADING_CONTEXT): PixelWorkBudget {
  if (pixelWorkGeometryError(geometry)) return pixelStackWorkBudget([], geometry, 'shared-scratch')
  const stacks: WorkStack[] = []
  let grading = false
  const add = (effects: readonly EffectDescriptor[], resolution: CanvasEffectStackResolution,
    clip?: Clip, allowPlugin = false, tracks: readonly EffectAnimationTrack[] = clip?.animation?.effectTracks ?? []) => {
    const plugin = allowPlugin && effects.some((effect) => effect.enabled && effect.type.startsWith('plugin:'))
    const potentialGrading = effects.some((effect) => effect.enabled && isColorGradingType(effect.type))
    const potentialReadback = potentialGrading || effects.some((effect) => !effectParamsValidationError(effect)
      && tracks.some((track) => animatedParameterSpec(clip, effect, track)))
    grading ||= potentialGrading
    const stages: PixelWorkStage[] = []
    if (resolution.pixelEffects.length || plugin || potentialReadback) {
      for (const resolved of resolution.effects) {
        if (plugin && resolved.effect.enabled && resolved.effect.type.startsWith('plugin:')) {
          stages.push({ kind: 'plugin' }); continue
        }
        if (resolved.status !== 'ready') continue
        const pixel = effectRegistration(resolved.effect.type)?.pixelEffect(resolved.effect, context)
        if (pixel) stages.push(...(pixel.kind === 'mask' ? maskPossibilities(clip, resolved.effect, pixel) : [pixel]))
      }
    }
    stacks.push({ stages, plugin, potentialReadback })
  }
  add(doc.masterVideoEffects ?? [], resolveVideoBusEffects(doc.masterVideoEffects ?? [], true, context))
  for (const track of doc.tracks) {
    add(track.videoEffects ?? [], resolveVideoBusEffects(track.videoEffects ?? [], true, context))
    for (const adjustment of track.adjustments ?? []) {
      const effects = reservationEffects(adjustment.effects, adjustment.animation.effectTracks)
      add(effects, resolvePostCompositeEffectStack(effects, true, context), undefined, false, adjustment.animation.effectTracks)
    }
    for (const clip of track.clips) {
      const title = isProceduralTitleClip(clip)
      const effects = reservationEffects(clip.effects, clip.animation?.effectTracks ?? [], clip)
      add(effects, title ? resolvePostCompositeEffectStack(effects, true, context)
        : resolveCanvasEffectStack(effects, true, true, context), clip, !title)
    }
  }
  return peakPixelStackWork(stacks.map((stack) => pixelStackWorkBudget(stack.stages, geometry,
    stack.plugin ? 'plugin-stages' : 'shared-scratch', grading, stack.potentialReadback)))
}
