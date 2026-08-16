import { describe, expect, test, vi } from 'vitest'
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
