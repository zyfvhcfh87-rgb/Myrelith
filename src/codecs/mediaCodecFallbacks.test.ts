import { describe, expect, test, vi } from 'vitest'
import {
  LOCAL_DECODER_LIMITS,
  MEDIA_DECODER_CAPABILITY_CACHE_LIMITS,
  LocalDecoderLoadError,
  createMediaCodecFallbackRegistry,
  localDecoderBudgetProblem,
  mediaAssetDecoderBudget,
  refineAudioDecoderBudget,
  refineVideoDecoderBudget,
  type DecoderCheckTarget,
  type LocalDecoderBudget,
  type MediaCodecFallbackLoaders,
} from './mediaCodecFallbacks'

const PRORES_BUDGET = {
  fileBytes: 1024,
  durationMicroseconds: 1_000_000,
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
} satisfies LocalDecoderBudget

const AC3_BUDGET = {
  fileBytes: 1024,
  durationMicroseconds: 1_000_000,
  sampleRate: 48_000,
  channels: 6,
} satisfies LocalDecoderBudget

function loaders(
  prores: () => void | Promise<void> = () => undefined,
  ac3: () => void | Promise<void> = () => undefined,
): MediaCodecFallbackLoaders {
  return {
    prores: async () => prores(),
    ac3: async () => ac3(),
  }
}

function cachedTarget(
  sourceId: string,
  canDecode: () => Promise<boolean>,
  over: Partial<DecoderCheckTarget> = {},
): DecoderCheckTarget {
  return {
    codec: 'avc',
    configuration: {
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      description: new Uint8Array([1, 2, 3, 4]),
    },
    trackKind: 'video',
    sourceId,
    boundary: 'probe',
    policy: 'reuse',
    canDecode,
    ...over,
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

  test.each([
    {
      label: 'missing ProRes metadata',
      codec: 'prores',
      budget: undefined,
    },
    {
      label: 'incomplete ProRes metadata',
      codec: 'prores',
      budget: {
        fileBytes: 1024,
        durationMicroseconds: 1_000_000,
        width: 1920,
        height: 1080,
      },
    },
    {
      label: 'invalid ProRes metadata',
      codec: 'prores',
      budget: { ...PRORES_BUDGET, width: 0 },
    },
    {
      label: 'invalid common file size',
      codec: 'prores',
      budget: { ...PRORES_BUDGET, fileBytes: -1 },
    },
    {
      label: 'incomplete AC-3 metadata',
      codec: 'ac3',
      budget: {
        fileBytes: 1024,
        durationMicroseconds: 1_000_000,
        sampleRate: 48_000,
      },
    },
    {
      label: 'invalid E-AC-3 metadata',
      codec: 'eac3',
      budget: { ...AC3_BUDGET, channels: 0 },
    },
    {
      label: 'invalid common duration',
      codec: 'ac3',
      budget: { ...AC3_BUDGET, durationMicroseconds: 0 },
    },
  ])('fails closed for $label before loading a decoder', async ({
    codec,
    budget,
  }) => {
    const loadProres = vi.fn()
    const loadAc3 = vi.fn()
    const canDecode = vi.fn(async () => false)
    const registry = createMediaCodecFallbackRegistry(
      loaders(loadProres, loadAc3),
    )

    await expect(registry.ensureDecodable({
      codec,
      budget,
      canDecode,
    })).resolves.toMatchObject({
      decodable: false,
      path: null,
      attemptedFallback: codec === 'prores' ? 'prores' : 'ac3',
      failure: { reason: 'resource-limit' },
    })
    expect(canDecode).toHaveBeenCalledOnce()
    expect(loadProres).not.toHaveBeenCalled()
    expect(loadAc3).not.toHaveBeenCalled()
  })

  test('fails closed before using an already-registered fallback', async () => {
    let registered = false
    const loadProres = vi.fn(() => {
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(loaders(loadProres))
    await registry.ensureDecodable({
      codec: 'prores',
      budget: PRORES_BUDGET,
      canDecode: async () => registered,
    })

    const canDecode = vi.fn(async () => true)
    await expect(registry.ensureDecodable({
      codec: 'prores',
      configuration: {
        codec: 'apch',
        codedWidth: 1920,
        codedHeight: 1080,
      },
      trackKind: 'video',
      canDecodeNatively: async () => false,
      canDecode,
    })).resolves.toMatchObject({
      decodable: false,
      path: null,
      attemptedFallback: 'prores',
      failure: { reason: 'resource-limit' },
    })
    expect(loadProres).toHaveBeenCalledOnce()
    expect(canDecode).not.toHaveBeenCalled()
  })

  test('loads ProRes once, rechecks support, and remembers the local path', async () => {
    let registered = false
    const loadProres = vi.fn(() => {
      registered = true
    })
    const registry = createMediaCodecFallbackRegistry(loaders(loadProres))
    const target = {
      codec: 'prores',
      budget: PRORES_BUDGET,
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
      budget: AC3_BUDGET,
      canDecode: async () => registered,
    })
    const eac3 = await registry.ensureDecodable({
      codec: 'eac3',
      budget: AC3_BUDGET,
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
      budget: PRORES_BUDGET,
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
      budget: PRORES_BUDGET,
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

  test('cancellation settles before an in-flight load and cannot publish success', async () => {
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
    const controller = new AbortController()
    const pending = registry.ensureDecodable({
      codec: 'prores',
      budget: PRORES_BUDGET,
      canDecode: async () => registered,
    }, controller.signal)

    await vi.waitFor(() => expect(loadProres).toHaveBeenCalledOnce())
    controller.abort()
    const outcome = pending.then(
      () => 'resolved',
      (cause: unknown) => cause instanceof Error ? cause.name : 'unknown',
    )
    try {
      await expect(Promise.race([
        outcome,
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('still-pending'), 25)
        }),
      ])).resolves.toBe('AbortError')
      expect(registered).toBe(false)
    } finally {
      release()
      await Promise.allSettled([pending])
    }
    await vi.waitFor(() => expect(registered).toBe(true))
    await expect(registry.ensureDecodable({
      codec: 'prores',
      budget: PRORES_BUDGET,
      canDecode: async () => registered,
    })).resolves.toMatchObject({ path: 'local-prores' })
  })

  test('reuses only an exact configuration at the same boundary', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    const firstCheck = vi.fn(async () => true)
    const cachedCheck = vi.fn(async () => false)
    registry.beginSource('source-a')

    await expect(registry.ensureDecodable(
      cachedTarget('source-a', firstCheck),
    )).resolves.toMatchObject({ decodable: true, path: 'native' })
    registry.beginSource('source-b')
    await expect(registry.ensureDecodable(cachedTarget(
      'source-b',
      cachedCheck,
      {
        configuration: {
          codedHeight: 1080,
          description: new Uint8Array([1, 2, 3, 4]),
          codec: 'avc1.640028',
          codedWidth: 1920,
        },
      },
    ))).resolves.toMatchObject({ decodable: true, path: 'native' })
    expect(firstCheck).toHaveBeenCalledOnce()
    expect(cachedCheck).not.toHaveBeenCalled()

    const changedDescription = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-b',
      changedDescription,
      {
        configuration: {
          codec: 'avc1.640028',
          codedWidth: 1920,
          codedHeight: 1080,
          description: new Uint8Array([1, 2, 3, 5]),
        },
      },
    ))).resolves.toMatchObject({ decodable: false })
    expect(changedDescription).toHaveBeenCalledOnce()

    const changedBoundary = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-b',
      changedBoundary,
      { boundary: 'filmstrip' },
    ))).resolves.toMatchObject({ decodable: false })
    expect(changedBoundary).toHaveBeenCalledOnce()
  })

  test('runtime boundaries revalidate and refresh a warm result', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    await registry.ensureDecodable(cachedTarget('source-a', async () => true))

    const recheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      recheck,
      { policy: 'revalidate' },
    ))).resolves.toMatchObject({ decodable: false })
    expect(recheck).toHaveBeenCalledOnce()

    const shouldStayCached = vi.fn(async () => true)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      shouldStayCached,
    ))).resolves.toMatchObject({ decodable: false })
    expect(shouldStayCached).not.toHaveBeenCalled()
  })

  test('never honors reuse policy at a runtime decode boundary', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    await registry.ensureDecodable(cachedTarget('source-a', async () => true, {
      boundary: 'render',
      policy: 'revalidate',
    }))

    const runtimeCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      runtimeCheck,
      { boundary: 'render', policy: 'reuse' },
    ))).resolves.toMatchObject({ decodable: false })
    expect(runtimeCheck).toHaveBeenCalledOnce()
  })

  test('a repeated source generation and runtime invalidation force fresh checks', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    await registry.ensureDecodable(cachedTarget('source-a', async () => true))

    registry.beginSource('source-a')
    const afterReplacement = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      afterReplacement,
    ))).resolves.toMatchObject({ decodable: false })
    expect(afterReplacement).toHaveBeenCalledOnce()

    registry.invalidateRuntime()
    const afterRuntimeChange = vi.fn(async () => true)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      afterRuntimeChange,
    ))).resolves.toMatchObject({ decodable: true })
    expect(afterRuntimeChange).toHaveBeenCalledOnce()
  })

  test('invalidation prevents a late check from repopulating the cache', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const lateCheck = vi.fn(async () => {
      markStarted()
      await gate
      return true
    })
    const pendingCheck = registry.ensureDecodable(cachedTarget(
      'source-a',
      lateCheck,
    ))

    await started
    registry.invalidateSource('source-a')
    release()
    await expect(pendingCheck).resolves.toMatchObject({ decodable: true })

    registry.beginSource('source-a')
    const freshCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      freshCheck,
    ))).resolves.toMatchObject({ decodable: false })
    expect(freshCheck).toHaveBeenCalledOnce()
  })

  test('an invalidated source cannot consume a shared warm answer', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    await registry.ensureDecodable(cachedTarget('source-a', async () => true))
    registry.beginSource('source-b')
    await registry.ensureDecodable(cachedTarget(
      'source-b',
      async () => false,
    ))

    registry.invalidateSource('source-a')
    const freshCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      freshCheck,
    ))).resolves.toMatchObject({ decodable: false })
    expect(freshCheck).toHaveBeenCalledOnce()
  })

  test('removes settled facts before the same source id begins again', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    await registry.ensureDecodable(cachedTarget('source-a', async () => true))

    registry.invalidateSource('source-a')
    registry.beginSource('source-a')
    const replacementCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      replacementCheck,
    ))).resolves.toMatchObject({ decodable: false })
    expect(replacementCheck).toHaveBeenCalledOnce()
  })

  test('an old fallback load cannot publish across a remove and re-add ABA', async () => {
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
    const target = cachedTarget('source-a', async () => registered, {
      codec: 'prores',
      configuration: { codec: 'apch' },
      canDecodeNatively: async () => false,
      budget: PRORES_BUDGET,
    })
    registry.beginSource('source-a')
    const oldCheck = registry.ensureDecodable(target)
    await vi.waitFor(() => expect(loadProres).toHaveBeenCalledOnce())

    registry.invalidateSource('source-a')
    registry.beginSource('source-a')
    release()
    await expect(oldCheck).resolves.toMatchObject({
      decodable: true,
      path: 'local-prores',
    })

    const freshCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable({
      ...target,
      canDecode: freshCheck,
    })).resolves.toMatchObject({ decodable: false })
    expect(freshCheck).toHaveBeenCalledOnce()
  })

  test('reapplies the current source budget to cached local support', async () => {
    let registered = false
    const registry = createMediaCodecFallbackRegistry(loaders(() => {
      registered = true
    }))
    const configuration: VideoDecoderConfig = {
      codec: 'apch',
      codedWidth: 1920,
      codedHeight: 1080,
    }
    const smallTarget = cachedTarget('small', async () => registered, {
      codec: 'prores',
      configuration,
      canDecodeNatively: async () => false,
      budget: {
        fileBytes: 1024,
        durationMicroseconds: 1_000_000,
        width: 1920,
        height: 1080,
        framesPerSecond: 30,
      },
    })
    registry.beginSource('small')
    await expect(registry.ensureDecodable(smallTarget)).resolves.toMatchObject({
      decodable: true,
      path: 'local-prores',
    })

    registry.beginSource('large')
    const cachedCheck = vi.fn(async () => true)
    await expect(registry.ensureDecodable({
      ...smallTarget,
      sourceId: 'large',
      canDecode: cachedCheck,
      budget: {
        ...smallTarget.budget,
        fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
      } as NonNullable<DecoderCheckTarget['budget']>,
    })).resolves.toMatchObject({
      decodable: false,
      failure: { reason: 'resource-limit' },
    })
    expect(cachedCheck).not.toHaveBeenCalled()
  })

  test('keeps an over-budget result honest after its fallback is registered', async () => {
    let registered = false
    const registry = createMediaCodecFallbackRegistry(loaders(() => {
      registered = true
    }))
    await registry.ensureDecodable({
      codec: 'prores',
      budget: PRORES_BUDGET,
      canDecode: async () => registered,
    })

    await expect(registry.ensureDecodable({
      codec: 'prores',
      canDecode: async () => false,
      budget: {
        ...PRORES_BUDGET,
        fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
      },
    })).resolves.toMatchObject({
      decodable: false,
      attemptedFallback: 'prores',
      failure: { reason: 'resource-limit' },
    })
  })

  test('keeps native provenance after a fallback family is registered', async () => {
    let registered = false
    const registry = createMediaCodecFallbackRegistry(loaders(() => {
      registered = true
    }))
    registry.beginSource('local')
    await registry.ensureDecodable(cachedTarget('local', async () => registered, {
      codec: 'prores',
      configuration: { codec: 'apch' },
      canDecodeNatively: async () => false,
      budget: PRORES_BUDGET,
    }))

    registry.beginSource('native')
    const effective = vi.fn(async () => true)
    await expect(registry.ensureDecodable(cachedTarget('native', effective, {
      codec: 'prores',
      configuration: { codec: 'ap4h' },
      canDecodeNatively: async () => true,
      policy: 'revalidate',
    }))).resolves.toMatchObject({ path: 'native' })
    expect(effective).not.toHaveBeenCalled()
  })

  test('bounds the settled capability LRU without retaining old answers', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('many')
    for (
      let index = 0;
      index <= MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxEntries;
      index++
    ) {
      await registry.ensureDecodable(cachedTarget('many', async () => true, {
        configuration: { codec: `avc1.${index}` },
      }))
    }

    const evictedCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget('many', evictedCheck, {
      configuration: { codec: 'avc1.0' },
    }))).resolves.toMatchObject({ decodable: false })
    expect(evictedCheck).toHaveBeenCalledOnce()
  })

  test('keeps the newer result when same-key revalidations finish out of order', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    let releaseOlder!: () => void
    let releaseNewer!: () => void
    let markOlderStarted!: () => void
    let markNewerStarted!: () => void
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve })
    const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve })
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve
    })
    const newerStarted = new Promise<void>((resolve) => {
      markNewerStarted = resolve
    })
    const older = registry.ensureDecodable(cachedTarget(
      'source-a',
      async () => {
        markOlderStarted()
        await olderGate
        return true
      },
      { policy: 'revalidate' },
    ))
    await olderStarted
    const newer = registry.ensureDecodable(cachedTarget(
      'source-a',
      async () => {
        markNewerStarted()
        await newerGate
        return false
      },
      { policy: 'revalidate' },
    ))
    await newerStarted

    releaseNewer()
    await expect(newer).resolves.toMatchObject({ decodable: false })
    releaseOlder()
    await expect(older).resolves.toMatchObject({ decodable: true })

    const shouldStayCached = vi.fn(async () => true)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      shouldStayCached,
    ))).resolves.toMatchObject({ decodable: false })
    expect(shouldStayCached).not.toHaveBeenCalled()
  })

  test('bypasses caching for oversized decoder configurations', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('source-a')
    const description = new Uint8Array(
      MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxConfigurationBytes + 1,
    )
    await registry.ensureDecodable(cachedTarget('source-a', async () => true, {
      configuration: {
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        description,
      },
    }))

    const freshCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'source-a',
      freshCheck,
      {
        configuration: {
          codec: 'avc1.640028',
          codedWidth: 1920,
          codedHeight: 1080,
          description,
        },
      },
    ))).resolves.toMatchObject({ decodable: false })
    expect(freshCheck).toHaveBeenCalledOnce()
  })

  test('bounds remembered source generations and drops older facts', async () => {
    const registry = createMediaCodecFallbackRegistry(loaders())
    registry.beginSource('oldest')
    await registry.ensureDecodable(cachedTarget('oldest', async () => true))
    for (
      let index = 0;
      index < MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxSources;
      index++
    ) registry.beginSource(`source-${index}`)

    const freshCheck = vi.fn(async () => false)
    await expect(registry.ensureDecodable(cachedTarget(
      'oldest',
      freshCheck,
    ))).resolves.toMatchObject({ decodable: false })
    expect(freshCheck).toHaveBeenCalledOnce()
  })
})

describe('local decoder budgets', () => {
  const base = {
    fileBytes: 1024,
    durationMicroseconds: 1_000_000,
  }

  test('derives a complete session budget and keeps the larger Blob size', () => {
    expect(mediaAssetDecoderBudget({
      size: 1024,
      durationMicroseconds: 2_000_000,
      frameRate: { num: 60_000, den: 1_001 },
      width: 3840,
      height: 2160,
      audioSampleRate: 48_000,
      audioChannels: 6,
    }, 2048)).toEqual({
      fileBytes: 2048,
      durationMicroseconds: 2_000_000,
      framesPerSecond: 60_000 / 1_001,
      width: 3840,
      height: 2160,
      sampleRate: 48_000,
      channels: 6,
    })
  })

  test('keeps the dimension pair with the larger pixel cost', () => {
    const rememberedLarge = {
      ...PRORES_BUDGET,
      width: 4096,
      height: 2160,
    }
    expect(refineVideoDecoderBudget(
      rememberedLarge,
      512,
      { codec: 'apch', codedWidth: 1920, codedHeight: 1080 },
    )).toEqual(rememberedLarge)

    expect(refineVideoDecoderBudget(
      PRORES_BUDGET,
      2048,
      { codec: 'apch', codedWidth: 4096, codedHeight: 2160 },
    )).toEqual({
      ...PRORES_BUDGET,
      fileBytes: 2048,
      width: 4096,
      height: 2160,
    })
  })

  test('keeps an equal-area rotated dimension pair without inflating it', () => {
    const portrait = {
      ...PRORES_BUDGET,
      width: 2160,
      height: 4096,
    }
    expect(refineVideoDecoderBudget(
      portrait,
      portrait.fileBytes,
      { codec: 'apch', codedWidth: 4096, codedHeight: 2160 },
    )).toEqual(portrait)
  })

  test('maxes live audio limits independently without lowering either fact', () => {
    expect(refineAudioDecoderBudget({
      ...AC3_BUDGET,
      sampleRate: 96_000,
      channels: 2,
    }, 2048, {
      codec: 'ec-3',
      sampleRate: 48_000,
      numberOfChannels: 8,
    })).toEqual({
      ...AC3_BUDGET,
      fileBytes: 2048,
      sampleRate: 96_000,
      channels: 8,
    })
  })

  test('does not repair invalid immutable fallback metadata', () => {
    expect(refineVideoDecoderBudget({
      ...PRORES_BUDGET,
      width: null,
    }, 2048, {
      codec: 'apch',
      codedWidth: 1920,
      codedHeight: 1080,
    })).toMatchObject({ width: null })
    expect(refineAudioDecoderBudget({
      ...AC3_BUDGET,
      channels: null,
    }, 2048, {
      codec: 'ac-3',
      sampleRate: 48_000,
      numberOfChannels: 6,
    })).toMatchObject({ channels: null })
  })

  test('warns before loading files above the automatic fallback size', () => {
    expect(localDecoderBudgetProblem('prores', {
      ...PRORES_BUDGET,
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
