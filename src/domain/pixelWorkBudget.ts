/** Logical owned-buffer lifetimes for the three real pixel execution lanes. */
import type { CanvasPixelEffect } from './effectStack'
import type { PixelEffectGeometry } from './effectPixels'
import { isColorGradingPixel } from './colorGradingEffects'
import { COLOR_LUT_LIMITS } from './colorLut'
import { maskPixelWork } from './maskPixelWork'
import { renderSurfaceBudget } from './renderSurfaceBudget'
import { spatialEffectScratchBytes } from './spatialEffectPixels'

export type PixelWorkStage = CanvasPixelEffect | { readonly kind: 'plugin' }
export type PixelExecutionLane = 'shared-scratch' | 'isolated-stages' | 'plugin-stages'

export interface PixelWorkBudget {
  readonly readbackBytes: number
  readonly workingBytes: number
  readonly pluginInputBytes: number
  readonly pluginResultBytes: number
  readonly maskInsideBytes: number
  readonly maskDistanceBytes: number
  readonly spatialBytes: number
  readonly gradingCacheBytes: number
  /** Peak co-live bytes; the separate component maxima need not coincide. */
  readonly peakAdditionalBytes: number
  readonly reason: string | null
}

const EMPTY_WORK: PixelWorkBudget = Object.freeze({
  readbackBytes: 0, workingBytes: 0, pluginInputBytes: 0, pluginResultBytes: 0,
  maskInsideBytes: 0, maskDistanceBytes: 0, spatialBytes: 0, gradingCacheBytes: 0,
  peakAdditionalBytes: 0, reason: null,
})

export function pixelWorkGeometryError(geometry: PixelEffectGeometry): string | null {
  return renderSurfaceBudget(geometry.surfaceWidth, geometry.surfaceHeight).reason
    ?? renderSurfaceBudget(geometry.projectWidth, geometry.projectHeight).reason
}

/**
 * A shared-scratch call retains the largest mask arrays until the entire list
 * returns, including during a later spatial stage. Grading and plugin lanes
 * execute built-ins as separate calls. Plugin inputs/results end at each stage;
 * only the transactional working copy lives across the ordered plugin stack.
 */
export function pixelStackWorkBudget(
  stages: readonly PixelWorkStage[],
  geometry: PixelEffectGeometry,
  lane: PixelExecutionLane,
  retainGradingCache = false,
  potentialReadback = false,
): PixelWorkBudget {
  const reason = pixelWorkGeometryError(geometry)
  if (reason) return { ...EMPTY_WORK, reason }
  if (lane !== 'plugin-stages' && stages.some((stage) => stage.kind === 'plugin')) {
    return { ...EMPTY_WORK, reason: 'A plugin stage requires the transactional pixel execution lane.' }
  }
  const frameBytes = geometry.surfaceWidth * geometry.surfaceHeight * 4
  const readbackBytes = stages.length || potentialReadback ? frameBytes : 0
  const workingBytes = stages.length && lane === 'plugin-stages' ? frameBytes : 0
  const gradingCacheBytes = retainGradingCache ? COLOR_LUT_LIMITS.runtimeBytes : 0
  let maskInsideBytes = 0, maskDistanceBytes = 0, spatialBytes = 0
  let retainedInside = 0, retainedDistance = 0, scratchPeak = 0
  let pluginInputBytes = 0, pluginResultBytes = 0
  for (const stage of stages) {
    let inside = 0, distance = 0, spatial = 0, plugin = 0
    if (stage.kind === 'plugin') {
      pluginInputBytes = pluginResultBytes = frameBytes
      plugin = pluginInputBytes + pluginResultBytes
    } else if (stage.kind === 'mask') {
      const work = maskPixelWork(stage.params, geometry)
      inside = work.insidePixels; distance = work.distancePixels * 4
      maskInsideBytes = Math.max(maskInsideBytes, inside)
      maskDistanceBytes = Math.max(maskDistanceBytes, distance)
    } else if (stage.kind !== 'color-adjust' && stage.kind !== 'chroma-key' && !isColorGradingPixel(stage)) {
      spatial = spatialEffectScratchBytes(stage, geometry)
      spatialBytes = Math.max(spatialBytes, spatial)
    }
    if (lane === 'shared-scratch') {
      retainedInside = Math.max(retainedInside, inside)
      retainedDistance = Math.max(retainedDistance, distance)
      scratchPeak = Math.max(scratchPeak, retainedInside + retainedDistance + spatial)
    } else {
      scratchPeak = Math.max(scratchPeak, inside + distance + spatial + plugin)
    }
  }
  const peakAdditionalBytes = readbackBytes + workingBytes + scratchPeak + gradingCacheBytes
  return { readbackBytes, workingBytes, pluginInputBytes, pluginResultBytes,
    maskInsideBytes, maskDistanceBytes, spatialBytes, gradingCacheBytes,
    peakAdditionalBytes,
    reason: Number.isSafeInteger(peakAdditionalBytes) ? null : 'Pixel work byte accounting overflowed.' }
}

/** Serial stacks release their call-scoped buffers; the grading cache persists. */
export function peakPixelStackWork(budgets: readonly PixelWorkBudget[]): PixelWorkBudget {
  const failure = budgets.find((budget) => budget.reason)
  if (failure) return failure
  const gradingCacheBytes = budgets.reduce((peak, budget) => Math.max(peak, budget.gradingCacheBytes), 0)
  return budgets.reduce<PixelWorkBudget>((peak, budget) => ({
    readbackBytes: Math.max(peak.readbackBytes, budget.readbackBytes),
    workingBytes: Math.max(peak.workingBytes, budget.workingBytes),
    pluginInputBytes: Math.max(peak.pluginInputBytes, budget.pluginInputBytes),
    pluginResultBytes: Math.max(peak.pluginResultBytes, budget.pluginResultBytes),
    maskInsideBytes: Math.max(peak.maskInsideBytes, budget.maskInsideBytes),
    maskDistanceBytes: Math.max(peak.maskDistanceBytes, budget.maskDistanceBytes),
    spatialBytes: Math.max(peak.spatialBytes, budget.spatialBytes),
    gradingCacheBytes: Math.max(peak.gradingCacheBytes, budget.gradingCacheBytes),
    peakAdditionalBytes: Math.max(peak.peakAdditionalBytes,
      budget.peakAdditionalBytes - budget.gradingCacheBytes + gradingCacheBytes),
    reason: null,
  }), EMPTY_WORK)
}
