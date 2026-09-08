import { isColorGradingType } from '../domain/colorGradingEffects'
import { effectRegistration, resolveEffectStack } from '../domain/effectStack'
import type { ColorGradingFrame } from './colorGradingRuntime'
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
      /**
       * Fresh exact-length, whole-ArrayBuffer straight RGBA8 output. Ownership
       * transfers to the stage caller, which wipes it immediately after copying
       * or rejecting it. The executor must not retain or reuse returned bytes.
       */
      readonly rgba: Uint8Array
    }
  | {
      /** The injected preview policy may visibly bypass a failed stage. */
      readonly status: 'bypassed'
    }

/** Preview and export inject distinct lifecycle owners behind this one contract. */
export interface VideoEffectStageExecutor {
  /** Preview may disclose a visible bypass; export must fail closed. */
  readonly bypassPolicy?: 'allow' | 'fail'
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
  grading?: ColorGradingFrame,
): Promise<void> {
  if (!plan.requiresOrderedPixelPath) return
  const expectedLength = checkedContext(pixels, context)
  const working = new Uint8ClampedArray(pixels)

  for (const stage of plan.stages) {
    grading?.check()
    if (stage.kind === 'builtin') {
      if (grading && isColorGradingType(stage.effect.type)) {
        const resolved = resolveEffectStack([stage.effect], new Set(['canvas2d-filter', 'canvas2d-pixel-access']), grading.context)[0]
        if (resolved.status !== 'ready') {
          if (stage.effect.enabled && grading.policy === 'fail') throw new VideoEffectStageExecutionError(`${resolved.label}: ${resolved.detail}`)
          continue
        }
        const pixel = effectRegistration(stage.effect.type)?.pixelEffect(stage.effect, grading.context)
        if (pixel) await grading.runtime.apply(working, [pixel], context, grading.check)
        continue
      }
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

    let result: PluginVideoEffectApplyResult | undefined
    const input = new Uint8Array(working)
    try {
      try {
        result = await executor.applyPluginEffect({
          execution: stage.execution,
          effect: stage.effect,
          timelineFrame: context.timelineFrame,
          frameRate: context.frameRate,
          width: context.surfaceWidth,
          height: context.surfaceHeight,
          stride: context.surfaceWidth * 4,
          // Keep the transactional working copy if the executor transfers input
          // or chooses the visible preview-bypass result.
          rgba: input,
        })
      } catch (cause) {
        throw new VideoEffectStageExecutionError(
          `Plugin effect ${stage.effect.id} execution failed`,
          cause,
        )
      }
      grading?.check()
      if (result.status === 'bypassed') {
        if (executor.bypassPolicy === 'fail') {
          throw new VideoEffectStageExecutionError(
            `Plugin effect ${stage.effect.id} was bypassed during fail-closed execution`,
          )
        }
        continue
      }
      if (!(result.rgba instanceof Uint8Array)
        || result.rgba.byteLength !== expectedLength
        || !(result.rgba.buffer instanceof ArrayBuffer)
        || result.rgba.byteOffset !== 0
        || result.rgba.buffer.byteLength !== expectedLength
        || result.rgba.buffer === pixels.buffer
        || result.rgba.buffer === working.buffer) {
        throw new VideoEffectStageExecutionError(
          `Plugin effect ${stage.effect.id} returned an invalid RGBA byte length or ownership`,
        )
      }
      working.set(result.rgba)
    } finally {
      // The host can transfer/detach input. Any attached request copy and the
      // caller-owned returned view end here, including cancellation/validation
      // failures. Frame owners must not retain outputs across subsequent stages.
      if (input.byteLength > 0) input.fill(0)
      if (result?.status === 'applied' && result.rgba instanceof Uint8Array
        && result.rgba.buffer !== pixels.buffer && result.rgba.buffer !== working.buffer
        && result.rgba.byteLength > 0) result.rgba.fill(0)
    }
  }

  grading?.check()
  pixels.set(working)
}
