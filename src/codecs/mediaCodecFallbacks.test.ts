import { describe, expect, test, vi } from 'vitest'
import {
  LOCAL_DECODER_LIMITS,
  LocalDecoderLoadError,
  createMediaCodecFallbackRegistry,
  localDecoderBudgetProblem,
  type MediaCodecFallbackLoaders,
} from './mediaCodecFallbacks'

function loaders(
  prores: () => void | Promise<void> = () => undefined,
  ac3: () => void | Promise<void> = () => undefined,
): MediaCodecFallbackLoaders {
  return {
    prores: async () => prores(),
    ac3: async () => ac3(),
  }
}

describe('media codec fallback registry', () => {
  test('leaves native support alone and loads no fallback chunk', async () => {
    const loadProres = vi.fn()
    const loadAc3 = vi.fn()
    const registry = createMediaCodecFallbackRegistry(
      loaders(loadProres, loadAc3),
    )

    const result = await registry.ensureDecodable({
      codec: 'avc',
      canDecode: async () => true,
    })

    expect(result).toEqual({
      decodable: true,
      path: 'native',
      attemptedFallback: null,
      failure: null,
    })
    expect(loadProres).not.toHaveBeenCalled()
    expect(loadAc3).not.toHaveBeenCalled()
  })

  test('keeps an unknown unsupported codec honest without loading code', async () => {
    const loadProres = vi.fn()
    const loadAc3 = vi.fn()
    const registry = createMediaCodecFallbackRegistry(
      loaders(loadProres, loadAc3),
    )

    const result = await registry.ensureDecodable({
      codec: 'theora',
      canDecode: async () => false,
    })

    expect(result.decodable).toBe(false)
    expect(result.attemptedFallback).toBeNull()
    expect(result.failure?.reason).toBe('unsupported-codec')
    expect(loadProres).not.toHaveBeenCalled()
    expect(loadAc3).not.toHaveBeenCalled()
  })

  test('loads ProRes once, rechecks support, and remembers the local path', async () => {
    let registered = false
    const loadProres = vi.fn(() => {
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(loaders(loadProres))
    const target = {
      codec: 'prores',
      canDecode: vi.fn(async () => registered),
    }

    await expect(registry.ensureDecodable(target)).resolves.toMatchObject({
      decodable: true,
      path: 'local-prores',
      attemptedFallback: 'prores',
    })
    await expect(registry.ensureDecodable(target)).resolves.toMatchObject({
      decodable: true,
      path: 'local-prores',
    })
    expect(target.canDecode).toHaveBeenCalledTimes(3)
    expect(loadProres).toHaveBeenCalledTimes(1)
  })

  test('AC-3 and E-AC-3 share one registration', async () => {
    let registered = false
    const loadAc3 = vi.fn(() => {
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(
      loaders(undefined, loadAc3),
    )

    const ac3 = await registry.ensureDecodable({
      codec: 'ac3',
      canDecode: async () => registered,
    })
    const eac3 = await registry.ensureDecodable({
      codec: 'eac3',
      canDecode: async () => registered,
    })

    expect(ac3.path).toBe('local-ac3')
    expect(eac3.path).toBe('local-ac3')
    expect(loadAc3).toHaveBeenCalledTimes(1)
  })

  test('coalesces concurrent registration in one realm', async () => {
    let registered = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loadProres = vi.fn(async () => {
      await gate
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(loaders(loadProres))
    const target = {
      codec: 'prores',
      canDecode: async () => registered,
    }

    const first = registry.ensureDecodable(target)
    const second = registry.ensureDecodable(target)
    await vi.waitFor(() => expect(loadProres).toHaveBeenCalledTimes(1))
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ path: 'local-prores' }),
      expect.objectContaining({ path: 'local-prores' }),
    ])
  })

  test('surfaces a load failure and permits a later explicit retry', async () => {
    let registered = false
    const loadProres = vi.fn(() => {
      if (loadProres.mock.calls.length === 1) throw new Error('chunk failed')
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(loaders(loadProres))
    const target = {
      codec: 'prores',
      canDecode: async () => registered,
    }

    await expect(registry.ensureDecodable(target)).rejects.toEqual(
      expect.objectContaining({
        name: 'LocalDecoderLoadError',
        decoderId: 'prores',
        cause: expect.objectContaining({ message: 'chunk failed' }),
      } satisfies Partial<LocalDecoderLoadError>),
    )
    await expect(registry.ensureDecodable(target)).resolves.toMatchObject({
      path: 'local-prores',
    })
    expect(loadProres).toHaveBeenCalledTimes(2)
  })

  test('cancellation cannot publish success after an in-flight load', async () => {
    let registered = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = createMediaCodecFallbackRegistry(loaders(async () => {
      await gate
      registered = true
    }))
    const controller = new AbortController()
    const pending = registry.ensureDecodable({
      codec: 'prores',
      canDecode: async () => registered,
    }, controller.signal)

    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(registry.ensureDecodable({
      codec: 'prores',
      canDecode: async () => registered,
    })).resolves.toMatchObject({ path: 'local-prores' })
  })
})

describe('local decoder budgets', () => {
  const base = {
    fileBytes: 1024,
    durationMicroseconds: 1_000_000,
  }

  test('warns before loading files above the automatic fallback size', () => {
    expect(localDecoderBudgetProblem('prores', {
      ...base,
      fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
    })).toMatchObject({ reason: 'resource-limit' })
  })

  test('bounds ProRes pixel throughput at DCI 4K30', () => {
    expect(localDecoderBudgetProblem('prores', {
      ...base,
      width: 4096,
      height: 2160,
      framesPerSecond: 30,
    })).toBeNull()
    expect(localDecoderBudgetProblem('prores', {
      ...base,
      width: 4096,
      height: 2160,
      framesPerSecond: 60,
    })).toMatchObject({ reason: 'resource-limit' })
  })

  test('bounds local AC-3/E-AC-3 channel count and sample rate', () => {
    expect(localDecoderBudgetProblem('ac3', {
      ...base,
      channels: 8,
      sampleRate: 48_000,
    })).toBeNull()
    expect(localDecoderBudgetProblem('eac3', {
      ...base,
      channels: 9,
      sampleRate: 48_000,
    })).toMatchObject({ reason: 'resource-limit' })
    expect(localDecoderBudgetProblem('ac3', {
      ...base,
      channels: 6,
      sampleRate: 96_000,
    })).toMatchObject({ reason: 'resource-limit' })
  })
})
