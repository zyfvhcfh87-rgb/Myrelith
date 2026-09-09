import { describe, expect, test, vi } from 'vitest'
import { ColorGradingCancelledError, ColorGradingRuntime, type ColorGradingFrame } from './colorGradingRuntime'
import type { EffectDescriptor } from '../domain/schema'
import type {
  BuiltInVideoEffectStage,
  PluginVideoEffectStage,
  VideoEffectStagePlan,
} from '../domain/pluginVideoEffectStagePlan'
import {
  applyVideoEffectStagePlanToRgba,
  VideoEffectStageExecutionError,
  type VideoEffectStageExecutionContext,
} from './videoEffectStageExecution'

const CONTEXT: VideoEffectStageExecutionContext = Object.freeze({
  timelineFrame: 12,
  frameRate: Object.freeze({ num: 30, den: 1 }),
  surfaceWidth: 1,
  surfaceHeight: 1,
  projectWidth: 1,
  projectHeight: 1,
})

function descriptor(id: string, type: string): EffectDescriptor {
  return Object.freeze({
    id,
    type,
    version: 1,
    enabled: true,
    params: Object.freeze({}),
  })
}

function builtin(id: string, exposure: number): BuiltInVideoEffectStage {
  const effect = descriptor(id, 'builtin.color-adjust')
  return Object.freeze({
    kind: 'builtin',
    effect,
    label: 'Color adjustment',
    status: 'ready',
    detail: 'Applied in stack order.',
    pixelEffect: Object.freeze({
      kind: 'color-adjust',
      params: Object.freeze({
        exposure,
        contrast: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
      }),
    }),
  })
}

function plugin(id = 'plugin-effect'): PluginVideoEffectStage {
  const effect = descriptor(id, 'plugin:com.example.fixture/fixture')
  return Object.freeze({
    kind: 'plugin',
    effect,
    label: 'Fixture',
    status: 'ready',
    detail: 'Ready.',
    execution: Object.freeze({
      catalogGeneration: 7,
      signerFingerprint: `sha256:${'1'.repeat(64)}`,
      packageDigest: `sha256:${'2'.repeat(64)}`,
      pluginId: 'com.example.fixture',
      pluginVersion: '1.0.0',
      kind: 'video-effect',
      contributionVersion: 1,
      contributionId: 'fixture',
      descriptorVersion: effect.version,
      entrypoint: 'myrelith_fixture',
      parameterRecord: Object.freeze({}),
      canonicalParameterJson: '{}',
    }),
  })
}

function plan(
  stages: VideoEffectStagePlan['stages'],
  requiresOrderedPixelPath = true,
): VideoEffectStagePlan {
  return Object.freeze({
    stages: Object.freeze([...stages]),
    requiresOrderedPixelPath,
  })
}

describe('ordered video effect stage execution', () => {
  test('keeps the historical path byte-exact when no ready plugin requires it', async () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255])
    const applyPluginEffect = vi.fn()

    await applyVideoEffectStagePlanToRgba(
      rgba,
      plan([builtin('color', 1)], false),
      { applyPluginEffect },
      CONTEXT,
    )

    expect([...rgba]).toEqual([10, 20, 30, 255])
    expect(applyPluginEffect).not.toHaveBeenCalled()
  })

  test('executes built-in and plugin stages in authored order', async () => {
    const rgba = new Uint8ClampedArray([20, 30, 40, 255])
    const seen: number[][] = []
    const applyPluginEffect = vi.fn(async (request) => {
      seen.push([...request.rgba])
      const output = new Uint8Array(request.rgba)
      output[0] = Math.min(255, output[0] + 5)
      return { status: 'applied' as const, rgba: output }
    })

    await applyVideoEffectStagePlanToRgba(
      rgba,
      plan([builtin('before', 1), plugin(), builtin('after', -1)]),
      { applyPluginEffect },
      CONTEXT,
    )

    expect(seen).toEqual([[40, 60, 80, 255]])
    expect([...rgba]).toEqual([23, 30, 40, 255])
    expect(applyPluginEffect).toHaveBeenCalledOnce()
    expect(applyPluginEffect.mock.calls[0][0]).toMatchObject({
      timelineFrame: 12,
      frameRate: { num: 30, den: 1 },
      width: 1,
      height: 1,
      stride: 4,
    })
  })

  test('lets preview policy bypass one plugin without skipping later stages', async () => {
    const rgba = new Uint8ClampedArray([20, 30, 40, 255])

    await applyVideoEffectStagePlanToRgba(
      rgba,
      plan([plugin(), builtin('after', 1)]),
      { applyPluginEffect: async () => ({ status: 'bypassed' }) },
      CONTEXT,
    )

    expect([...rgba]).toEqual([40, 60, 80, 255])
  })

  test('fails closed when export policy receives a plugin bypass', async () => {
    const rgba = new Uint8ClampedArray([20, 30, 40, 255])

    await expect(applyVideoEffectStagePlanToRgba(
      rgba,
      plan([builtin('before', 1), plugin()]),
      {
        bypassPolicy: 'fail',
        applyPluginEffect: async () => ({ status: 'bypassed' }),
      },
      CONTEXT,
    )).rejects.toThrow(/bypassed during fail-closed execution/)
    expect([...rgba]).toEqual([20, 30, 40, 255])
  })

  test('does not publish partial pixels when execution fails', async () => {
    const rgba = new Uint8ClampedArray([20, 30, 40, 255])

    const failure = applyVideoEffectStagePlanToRgba(
      rgba,
      plan([builtin('before', 1), plugin()]),
      {
        applyPluginEffect: async () => {
          throw new Error('export runtime failed')
        },
      },
      CONTEXT,
    )
    await expect(failure).rejects.toBeInstanceOf(VideoEffectStageExecutionError)
    await expect(failure).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'export runtime failed' }),
    })
    expect([...rgba]).toEqual([20, 30, 40, 255])
  })

  test('rejects missing executors and malformed success lengths transactionally', async () => {
    const original = [20, 30, 40, 255]
    const missing = new Uint8ClampedArray(original)
    await expect(applyVideoEffectStagePlanToRgba(
      missing,
      plan([plugin()]),
      null,
      CONTEXT,
    )).rejects.toBeInstanceOf(VideoEffectStageExecutionError)
    expect([...missing]).toEqual(original)

    const malformed = new Uint8ClampedArray(original)
    await expect(applyVideoEffectStagePlanToRgba(
      malformed,
      plan([plugin()]),
      {
        applyPluginEffect: async () => ({
          status: 'applied',
          rgba: new Uint8Array(3),
        }),
      },
      CONTEXT,
    )).rejects.toThrow(/invalid RGBA byte length/)
    expect([...malformed]).toEqual(original)
  })

  test('passes a disposable owned copy to the executor', async () => {
    const rgba = new Uint8ClampedArray([20, 30, 40, 255])
    await applyVideoEffectStagePlanToRgba(
      rgba,
      plan([plugin()]),
      {
        applyPluginEffect: async (request) => {
          request.rgba.fill(9)
          return { status: 'bypassed' }
        },
      },
      CONTEXT,
    )
    expect([...rgba]).toEqual([20, 30, 40, 255])
  })
})

describe('immediate plugin result ownership', () => {
  test.each(['bypass', 'failure'] as const)('wipes a retained attached input copy on %s', async (outcome) => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255)
    let retained: Uint8Array | undefined
    const operation = applyVideoEffectStagePlanToRgba(pixels, plan([plugin()]), {
      applyPluginEffect: async (request) => {
        retained = request.rgba
        if (outcome === 'failure') throw new Error('executor rejected input')
        return { status: 'bypassed' }
      },
    }, CONTEXT)
    if (outcome === 'failure') await expect(operation).rejects.toThrow(/execution failed/)
    else await operation
    expect([...(retained ?? [])]).toEqual([0, 0, 0, 0])
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('rejects a subarray backed by an unaccounted larger buffer and wipes only its returned view', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), backing = new Uint8Array(6).fill(9)
    await expect(applyVideoEffectStagePlanToRgba(pixels, plan([plugin()]), {
      applyPluginEffect: async () => ({ status: 'applied', rgba: backing.subarray(1, 5) }),
    }, CONTEXT)).rejects.toThrow(/invalid RGBA byte length or ownership/)
    expect([...backing]).toEqual([9, 0, 0, 0, 0, 9])
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('rejects an injected alias to caller pixels without clearing or publishing them', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255)
    await expect(applyVideoEffectStagePlanToRgba(pixels, plan([builtin('before', 1), plugin()]), {
      applyPluginEffect: async () => ({ status: 'applied', rgba: new Uint8Array(pixels.buffer) }),
    }, CONTEXT)).rejects.toThrow(/invalid RGBA byte length or ownership/)
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('rejects a detached result without replacing validation failure during cleanup', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), output = Uint8Array.of(9, 8, 7, 255)
    structuredClone(output, { transfer: [output.buffer] })
    await expect(applyVideoEffectStagePlanToRgba(pixels, plan([plugin()]), {
      applyPluginEffect: async () => ({ status: 'applied', rgba: output }),
    }, CONTEXT)).rejects.toThrow(/invalid RGBA byte length or ownership/)
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('copies then wipes each output before requesting the next plugin stage', async () => {
    const original = [20, 30, 40, 255], pixels = new Uint8ClampedArray(original)
    const outputs = [Uint8Array.of(3, 4, 5, 255), Uint8Array.of(7, 8, 9, 255)]
    let index = 0
    await applyVideoEffectStagePlanToRgba(pixels, plan([plugin('first'), plugin('second')]), {
      applyPluginEffect: async (request) => {
        expect([...pixels]).toEqual(original)
        if (index === 1) {
          expect([...outputs[0]!]).toEqual([0, 0, 0, 0])
          expect([...request.rgba]).toEqual([3, 4, 5, 255])
        }
        return { status: 'applied', rgba: outputs[index++]! }
      },
    }, CONTEXT)
    expect([...pixels]).toEqual([7, 8, 9, 255])
    expect(outputs.map((output) => [...output])).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]])
  })

  test('wipes a returned output when grading cancels between awaiting it and copying it', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), output = Uint8Array.of(7, 8, 9, 255)
    const runtime = new ColorGradingRuntime(), cancellation = new ColorGradingCancelledError()
    let cancelled = false
    const grading: ColorGradingFrame = { runtime, context: runtime.context, policy: 'fail', check: () => { if (cancelled) throw cancellation } }
    try {
      await expect(applyVideoEffectStagePlanToRgba(pixels, plan([builtin('before', 1), plugin()]), {
        applyPluginEffect: async () => { cancelled = true; return { status: 'applied', rgba: output } },
      }, CONTEXT, grading)).rejects.toBe(cancellation)
      expect([...output]).toEqual([0, 0, 0, 0])
      expect([...pixels]).toEqual([20, 30, 40, 255])
    } finally { runtime.dispose() }
  })

  test.each([3, 5])('wipes an invalid %i-byte result without publishing earlier stages', async (length) => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), output = new Uint8Array(length).fill(9)
    await expect(applyVideoEffectStagePlanToRgba(pixels, plan([builtin('before', 1), plugin()]), {
      applyPluginEffect: async () => ({ status: 'applied', rgba: output }),
    }, CONTEXT)).rejects.toThrow(/invalid RGBA byte length/)
    expect([...output]).toEqual(Array(length).fill(0))
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('prior output is already wiped if a later plugin rejects, and original pixels stay unchanged', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), output = Uint8Array.of(7, 8, 9, 255)
    let called = false
    await expect(applyVideoEffectStagePlanToRgba(pixels, plan([plugin('first'), plugin('second')]), {
      applyPluginEffect: async () => {
        if (!called) { called = true; return { status: 'applied', rgba: output } }
        expect([...output]).toEqual([0, 0, 0, 0])
        throw new Error('later stage failed')
      },
    }, CONTEXT)).rejects.toThrow(/execution failed/)
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test.each(['allow', 'fail'] as const)('detached input and bypass preserve original pixels under %s policy', async (bypassPolicy) => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255)
    const result = applyVideoEffectStagePlanToRgba(pixels, plan([plugin()]), {
      bypassPolicy,
      applyPluginEffect: async (request) => {
        structuredClone(request.rgba, { transfer: [request.rgba.buffer] })
        expect(request.rgba.byteLength).toBe(0)
        return { status: 'bypassed' }
      },
    }, CONTEXT)
    if (bypassPolicy === 'fail') await expect(result).rejects.toThrow(/fail-closed/)
    else await result
    expect([...pixels]).toEqual([20, 30, 40, 255])
  })

  test('detached request input does not prevent copying and wiping fresh output', async () => {
    const pixels = Uint8ClampedArray.of(20, 30, 40, 255), output = Uint8Array.of(7, 8, 9, 255)
    await applyVideoEffectStagePlanToRgba(pixels, plan([plugin()]), {
      applyPluginEffect: async (request) => {
        structuredClone(request.rgba, { transfer: [request.rgba.buffer] })
        return { status: 'applied', rgba: output }
      },
    }, CONTEXT)
    expect([...pixels]).toEqual([7, 8, 9, 255]); expect([...output]).toEqual([0, 0, 0, 0])
  })
})
