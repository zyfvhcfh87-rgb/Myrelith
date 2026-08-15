/** Context-neutral execution of one declarative, authored-order effect plan. */

import type { FrameRate } from '../domain/schema'
import type {
  PluginVideoEffectExecutionPlan,
  PluginVideoEffectStage,
  VideoEffectStagePlan,
} from '../domain/pluginVideoEffectStagePlan'
import { applyOrderedPixelEffectsToRgba } from '../domain/effectPixels'

export interface VideoEffectStageExecutionContext {
  readonly timelineFrame: number
  readonly frameRate: FrameRate
  readonly surfaceWidth: number
  readonly surfaceHeight: number
  readonly projectWidth: number
  readonly projectHeight: number
}

export interface PluginVideoEffectApplyRequest {
  readonly execution: PluginVideoEffectExecutionPlan
  readonly effect: PluginVideoEffectStage['effect']
  readonly timelineFrame: number
  readonly frameRate: FrameRate
  readonly width: number
  readonly height: number
  readonly stride: number
  /** Fresh owned bytes. The executor may transfer or detach this buffer. */
  readonly rgba: Uint8Array
}

export type PluginVideoEffectApplyResult =
  | {
      readonly status: 'applied'
      /** Fresh exact-length straight RGBA8 output owned by the caller. */
      readonly rgba: Uint8Array
    }
  | {
      /** The injected preview policy may visibly bypass a failed stage. */
      readonly status: 'bypassed'
    }

/** Preview and export inject distinct lifecycle owners behind this one contract. */
export interface VideoEffectStageExecutor {
  applyPluginEffect(
    request: PluginVideoEffectApplyRequest,
  ): Promise<PluginVideoEffectApplyResult>
}

export class VideoEffectStageExecutionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VideoEffectStageExecutionError'
  }
}

function checkedRgbaLength(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
  ) throw new VideoEffectStageExecutionError('Effect surface dimensions are invalid')
  const pixels = width * height
  const bytes = pixels * 4
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
    throw new VideoEffectStageExecutionError('Effect surface byte length overflowed')
  }
  return bytes
}

function checkedContext(
  pixels: Uint8ClampedArray,
  context: VideoEffectStageExecutionContext,
): number {
  if (
    !Number.isSafeInteger(context.timelineFrame)
    || context.timelineFrame < 0
    || !Number.isSafeInteger(context.frameRate.num)
    || !Number.isSafeInteger(context.frameRate.den)
    || context.frameRate.num < 1
    || context.frameRate.den < 1
    || !Number.isSafeInteger(context.projectWidth)
    || !Number.isSafeInteger(context.projectHeight)
    || context.projectWidth < 1
    || context.projectHeight < 1
  ) throw new VideoEffectStageExecutionError('Effect execution context is invalid')
  const expected = checkedRgbaLength(context.surfaceWidth, context.surfaceHeight)
  if (pixels.byteLength !== expected) {
    throw new VideoEffectStageExecutionError(
      `Effect surface has ${pixels.byteLength} bytes; expected ${expected}`,
    )
  }
  return expected
}

/**
 * Execute a ready plugin plan transactionally. Built-ins and plugins share
 * one authored-order working copy; the caller's ImageData changes only after
 * every non-bypassed stage succeeds.
 */
export async function applyVideoEffectStagePlanToRgba(
  pixels: Uint8ClampedArray,
  plan: VideoEffectStagePlan,
  executor: VideoEffectStageExecutor | null | undefined,
  context: VideoEffectStageExecutionContext,
): Promise<void> {
  if (!plan.requiresOrderedPixelPath) return
  const expectedLength = checkedContext(pixels, context)
  const working = new Uint8ClampedArray(pixels)

  for (const stage of plan.stages) {
    if (stage.kind === 'builtin') {
      if (stage.status !== 'ready' || stage.pixelEffect === null) continue
      applyOrderedPixelEffectsToRgba(working, [stage.pixelEffect], {
        surfaceWidth: context.surfaceWidth,
        surfaceHeight: context.surfaceHeight,
        projectWidth: context.projectWidth,
        projectHeight: context.projectHeight,
      })
      continue
    }
    if (stage.status !== 'ready' || stage.execution === null) continue
    if (!executor) {
      throw new VideoEffectStageExecutionError(
        `Plugin executor is unavailable for effect ${stage.effect.id}`,
      )
    }

    let result: PluginVideoEffectApplyResult
    try {
      result = await executor.applyPluginEffect({
        execution: stage.execution,
        effect: stage.effect,
        timelineFrame: context.timelineFrame,
        frameRate: context.frameRate,
        width: context.surfaceWidth,
        height: context.surfaceHeight,
        stride: context.surfaceWidth * 4,
        // Retain the transactional working copy if the executor transfers input
        // or chooses the visible preview-bypass result.
        rgba: new Uint8Array(working),
      })
    } catch (cause) {
      throw new VideoEffectStageExecutionError(
        `Plugin effect ${stage.effect.id} execution failed`,
        cause,
      )
    }
    if (result.status === 'bypassed') continue
    if (!(result.rgba instanceof Uint8Array) || result.rgba.byteLength !== expectedLength) {
      throw new VideoEffectStageExecutionError(
        `Plugin effect ${stage.effect.id} returned an invalid RGBA byte length`,
      )
    }
    working.set(result.rgba)
  }

  pixels.set(working)
}
