import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import type { PluginDeclarationCatalogSnapshot } from './pluginInstallController'
import {
  createPluginPreparedExportController,
  type PluginPreparedExportControllerDependencies,
} from './pluginPreparedExportController'
import {
  createPluginExportAttemptController,
  type PluginExportAttemptController,
  type PluginExportAttemptControllerDependencies,
  type PluginExportAttemptPrepareResult,
  type PluginExportAttemptSnapshot,
  type PluginExportAttemptToken,
  type PluginExportReviewToken,
} from './pluginExportAttemptController'
import type { PluginExportCompositionPort } from './pluginAppController'

const DIGEST = `sha256:${'1'.repeat(64)}` as const
const SIGNER = `sha256:${'2'.repeat(64)}` as const

function attemptSnapshot(blocked = false): PluginExportAttemptSnapshot {
  return Object.freeze({
    documentGeneration: 7,
    settings: DEFAULT_EXPORT_PROFILE,
    catalogGeneration: 11,
    effects: Object.freeze([Object.freeze({
      key: 'clip/effect',
      descriptorId: 'effect',
      effectType: 'plugin:com.example.fixture/invert',
      enabled: true,
      pluginId: 'com.example.fixture',
      pluginVersion: '1.0.0',
      packageDigest: DIGEST,
      signerFingerprint: SIGNER,
      contributionId: 'invert',
      contributionVersion: 1,
      descriptorVersion: 1,
      status: blocked ? 'disabled' as const : 'ready' as const,
      reason: blocked ? 'Disabled.' : 'Available.',
    })]),
    blockers: blocked
      ? Object.freeze([Object.freeze({
          key: 'clip/effect',
          descriptorId: 'effect',
          pluginId: 'com.example.fixture',
          contributionId: 'invert',
          status: 'disabled' as const,
          reason: 'Disabled.',
        })])
      : Object.freeze([]),
  })
}

function reviewResult(
  token: object,
  snapshot = attemptSnapshot(true),
): PluginExportAttemptPrepareResult {
  return Object.freeze({
    status: 'blocked',
    reviewToken: token as PluginExportReviewToken,
    snapshot,
  }) as PluginExportAttemptPrepareResult
}

function readyResult(
  token: object,
  snapshot = attemptSnapshot(),
): PluginExportAttemptPrepareResult {
  return Object.freeze({
    status: 'ready',
    token: token as PluginExportAttemptToken,
    snapshot,
  })
}

function fakeAttemptHarness(options: {
  readonly prepareResults: PluginExportAttemptPrepareResult[]
  readonly approvedResult?: PluginExportAttemptPrepareResult
}) {
  let dependencies: PluginExportAttemptControllerDependencies | undefined
  const prepareResults = [...options.prepareResults]
  const controller: PluginExportAttemptController = {
    prepare: vi.fn(async () => {
      const result = prepareResults.shift()
      if (!result) throw new Error('missing fake prepare result')
      return result
    }),
    approveReviewedBlockers: vi.fn(async () => {
      if (!options.approvedResult) throw new Error('missing fake approval result')
      return options.approvedResult
    }),
    consume: vi.fn(async () => {
      throw new Error('fake consume is owned by the injected export starter')
    }),
    close: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  }
  return {
    controller,
    factory: ((input: PluginExportAttemptControllerDependencies) => {
      dependencies = input
      return controller
    }) as typeof createPluginExportAttemptController,
    dependencies: () => dependencies!,
  }
}

function appOwner(port: PluginExportCompositionPort) {
  return Object.freeze({ exportCompositionPort: port })
}

function baseDependencies(
  attempt: ReturnType<typeof fakeAttemptHarness>,
  port: PluginExportCompositionPort,
  tokenValues: string[],
  overrides: Partial<PluginPreparedExportControllerDependencies> = {},
): PluginPreparedExportControllerDependencies {
  return {
    appOwner: appOwner(port),
    getDocumentSnapshot: () => ({ generation: 7, document: document() }),
    createAttemptController: attempt.factory,
    createPublicToken: () => tokenValues.shift() ?? 'plugin-export-token-fallback',
    ...overrides,
  }
}

function document(): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'prepared-export-doc',
    name: 'Prepared export',
    frameRate: { num: 30, den: 1 },
    width: 2,
    height: 1,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

function catalog(detail = 'Available.'): PluginDeclarationCatalogSnapshot {
  return Object.freeze({
    generation: 11,
    declarations: Object.freeze([Object.freeze({
      pluginId: 'com.example.fixture',
      pluginVersion: '1.0.0',
      packageDigest: DIGEST,
      signerFingerprint: SIGNER,
      kind: 'video-effect' as const,
      contributionId: 'invert',
      contributionName: 'Invert',
      contributionVersion: 1,
      descriptorVersion: 1,
      entrypoint: 'myrelith_effect_invert',
      parameters: Object.freeze([]),
      availability: 'ready' as const,
      detail,
    })]),
  })
}

function driftedCatalog(
  kind: 'status' | 'detail' | 'schema',
): PluginDeclarationCatalogSnapshot {
  const source = catalog()
  const declaration = source.declarations[0]
  return Object.freeze({
    generation: source.generation,
    declarations: Object.freeze([Object.freeze({
      ...declaration,
      ...(kind === 'status'
        ? { availability: 'disabled' as const }
        : kind === 'detail'
          ? { detail: 'Safe mode changed availability.' }
          : {
              parameters: Object.freeze([Object.freeze({
                key: 'strength',
                name: 'Strength',
                kind: 'number' as const,
                default: 1,
                min: 0,
                max: 1,
                step: 0.1,
                animatable: false,
              })]),
            }),
    })]),
  })
}

function expectFrozenDataOnly(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    expect(typeof value).not.toBe('function')
    return
  }
  expect(Object.isFrozen(value)).toBe(true)
  for (const nested of Object.values(value)) expectFrozenDataOnly(nested)
}

describe('plugin prepared export controller', () => {
  test('binds only the private full-catalog/preflight port and exposes frozen data only', async () => {
    const review = Object.freeze({ kind: 'plugin-export-review-token' })
    const attempt = fakeAttemptHarness({ prepareResults: [reviewResult(review)] })
    const getDeclarationCatalog = vi.fn(async () => catalog())
    const preflightExport = vi.fn(async () => ({
      apply: vi.fn(),
      close: vi.fn(async () => undefined),
    }))
    const startExport = vi.fn(async () => undefined)
    const port = Object.freeze({ getDeclarationCatalog, preflightExport })
    const controller = createPluginPreparedExportController(baseDependencies(
      attempt,
      port,
      ['plugin-export-review-0001'],
      { startExport },
    ))

    const view = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(view).toMatchObject({
      status: 'blocked',
      token: 'plugin-export-review-0001.1',
      attempt: { catalogGeneration: 11 },
    })
    expectFrozenDataOnly(view)
    expect(JSON.stringify(view)).not.toContain('declarations')
    expect(JSON.stringify(view)).not.toContain('preflightExport')
    expect(startExport).not.toHaveBeenCalled()

    const captured = attempt.dependencies()
    await captured.getDeclarationCatalog()
    const request = Object.freeze({ requiredEffects: Object.freeze([]) })
    await captured.runtime.preflightExport(request)
    expect(getDeclarationCatalog).toHaveBeenCalledOnce()
    expect(preflightExport).toHaveBeenCalledWith(request, undefined)
  })

  test('rotates one-use tokens and approves only the retained exact blocker set', async () => {
    const review = Object.freeze({ kind: 'plugin-export-review-token' })
    const ready = Object.freeze({ kind: 'plugin-export-attempt-token' })
    const attempt = fakeAttemptHarness({
      prepareResults: [reviewResult(review)],
      approvedResult: readyResult(ready),
    })
    const startExport = vi.fn(async () => undefined)
    const controller = createPluginPreparedExportController(baseDependencies(
      attempt,
      Object.freeze({
        getDeclarationCatalog: vi.fn(async () => catalog()),
        preflightExport: vi.fn(),
      }),
      ['plugin-export-review-0001', 'plugin-export-ready-00002'],
      { startExport },
    ))

    const blocked = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    await expect(controller.approveReviewedBlockers('plugin-export-forged')).rejects.toMatchObject({
      code: 'invalid-token',
    })
    const approved = await controller.approveReviewedBlockers(blocked.token!)
    expect(approved).toMatchObject({ status: 'ready', token: 'plugin-export-ready-00002.2' })
    expect(attempt.controller.approveReviewedBlockers).toHaveBeenCalledWith(
      review,
      Object.freeze(['clip/effect']),
      expect.any(AbortSignal),
    )
    await expect(controller.approveReviewedBlockers(blocked.token!)).rejects.toMatchObject({
      code: 'invalid-token',
    })
    await expect(controller.start('plugin-export-forged')).rejects.toMatchObject({
      code: 'invalid-token',
    })
    await expect(controller.start(approved.token!)).resolves.toBeUndefined()
    await expect(controller.start(approved.token!)).rejects.toMatchObject({
      code: 'invalid-token',
    })
    expect(startExport).toHaveBeenCalledOnce()
  })

  test('closes replaced authority and rejects every stale public token', async () => {
    const firstSource = Object.freeze({ kind: 'plugin-export-attempt-token' })
    const secondSource = Object.freeze({ kind: 'plugin-export-attempt-token' })
    const attempt = fakeAttemptHarness({
      prepareResults: [readyResult(firstSource), readyResult(secondSource)],
    })
    const controller = createPluginPreparedExportController(baseDependencies(
      attempt,
      Object.freeze({ getDeclarationCatalog: vi.fn(), preflightExport: vi.fn() }),
      ['plugin-export-ready-00001', 'plugin-export-ready-00002'],
    ))

    const first = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    const second = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(attempt.controller.close).toHaveBeenCalledWith(firstSource, 'plugin-export-replaced')
    await expect(controller.start(first.token!)).rejects.toMatchObject({ code: 'invalid-token' })
    expect(second).toMatchObject({ status: 'ready', token: 'plugin-export-ready-00002.2' })
  })

  test('keeps duplicate token entropy unique without retaining an unbounded history', async () => {
    const attempt = fakeAttemptHarness({
      prepareResults: [
        readyResult(Object.freeze({ kind: 'plugin-export-attempt-token' })),
        readyResult(Object.freeze({ kind: 'plugin-export-attempt-token' })),
      ],
    })
    const controller = createPluginPreparedExportController(baseDependencies(
      attempt,
      Object.freeze({ getDeclarationCatalog: vi.fn(), preflightExport: vi.fn() }),
      ['plugin-export-same-token', 'plugin-export-same-token'],
    ))

    const first = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    const second = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(first.token).toBe('plugin-export-same-token.1')
    expect(second.token).toBe('plugin-export-same-token.2')
    await expect(controller.start(first.token!)).rejects.toMatchObject({ code: 'invalid-token' })
  })

  test('terminally closes rejected authority without masking token or start failures', async () => {
    const invalidSource = Object.freeze({ kind: 'plugin-export-attempt-token' })
    const invalidAttempt = fakeAttemptHarness({
      prepareResults: [readyResult(invalidSource)],
    })
    vi.mocked(invalidAttempt.controller.close).mockRejectedValue(new Error('close failed'))
    const invalidController = createPluginPreparedExportController(baseDependencies(
      invalidAttempt,
      Object.freeze({ getDeclarationCatalog: vi.fn(), preflightExport: vi.fn() }),
      ['short'],
    ))

    await expect(invalidController.prepare(DEFAULT_EXPORT_PROFILE)).rejects.toThrow(
      'public token factory returned an invalid token',
    )
    expect(invalidAttempt.controller.close).toHaveBeenCalledWith(
      invalidSource,
      'plugin-export-public-token-invalid',
    )
    expect(invalidController.getSnapshot()).toEqual({ status: 'idle', token: null, attempt: null })

    const startSource = Object.freeze({ kind: 'plugin-export-attempt-token' })
    const startAttempt = fakeAttemptHarness({
      prepareResults: [readyResult(startSource)],
    })
    vi.mocked(startAttempt.controller.close).mockRejectedValue(new Error('close failed'))
    const startFailure = new Error('synchronous export start failed')
    const startController = createPluginPreparedExportController(baseDependencies(
      startAttempt,
      Object.freeze({ getDeclarationCatalog: vi.fn(), preflightExport: vi.fn() }),
      ['plugin-export-ready-start'],
      { startExport: vi.fn(() => { throw startFailure }) },
    ))

    const ready = await startController.prepare(DEFAULT_EXPORT_PROFILE)
    await expect(startController.start(ready.token!)).rejects.toBe(startFailure)
    expect(startAttempt.controller.close).toHaveBeenCalledWith(
      startSource,
      'plugin-export-start-failed',
    )
    expect(startController.getSnapshot()).toEqual({ status: 'idle', token: null, attempt: null })
  })

  test.each(['status', 'detail', 'schema'] as const)(
    'fences same-generation catalog %s drift before export start',
    async (drift) => {
    const doc = document()
    let currentCatalog = catalog()
    const port: PluginExportCompositionPort = Object.freeze({
      getDeclarationCatalog: vi.fn(async () => currentCatalog),
      preflightExport: vi.fn(async () => {
        throw new Error('empty plan must not preflight runtime')
      }),
    })
    const consumingStart = vi.fn(async (
      token: PluginExportAttemptToken,
      controller: Pick<PluginExportAttemptController, 'consume'>,
    ) => {
      const execution = await controller.consume(token)
      await execution.close('test-complete')
      return undefined
    })
    const controller = createPluginPreparedExportController({
      appOwner: appOwner(port),
      getDocumentSnapshot: () => ({ generation: 7, document: doc }),
      createPublicToken: () => 'plugin-export-ready-drift',
      startExport: consumingStart,
    })

    const ready = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    currentCatalog = driftedCatalog(drift)
    await expect(controller.start(ready.token!)).rejects.toMatchObject({
      code: 'stale-attempt',
    })
    expect(port.preflightExport).not.toHaveBeenCalled()
    },
  )

  test('cancellation, retry, and terminal close drain each retained owner exactly once', async () => {
    const sources = [
      Object.freeze({ kind: 'plugin-export-attempt-token' }),
      Object.freeze({ kind: 'plugin-export-attempt-token' }),
    ]
    const attempt = fakeAttemptHarness({
      prepareResults: [readyResult(sources[0]), readyResult(sources[1])],
    })
    let finishRun!: () => void
    const completion = new Promise<undefined>((resolve) => { finishRun = () => resolve(undefined) })
    const startExport = vi.fn(() => completion)
    const cancelActiveExport = vi.fn(async () => { finishRun() })
    const controller = createPluginPreparedExportController(baseDependencies(
      attempt,
      Object.freeze({ getDeclarationCatalog: vi.fn(), preflightExport: vi.fn() }),
      ['plugin-export-ready-00001', 'plugin-export-ready-00002'],
      { startExport, cancelActiveExport },
    ))

    const first = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    const running = controller.start(first.token!)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(controller.getSnapshot()).toMatchObject({ status: 'running', token: null })
    await controller.cancel('user-cancelled')
    await expect(running).resolves.toBeUndefined()
    expect(cancelActiveExport).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'idle', token: null, attempt: null })

    const retry = await controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(retry.token).toBe('plugin-export-ready-00002.2')
    await controller.close('app-terminal')
    await controller.close('ignored-second-close')
    expect(attempt.controller.close).toHaveBeenCalledWith(sources[1], 'app-terminal')
    expect(attempt.controller.teardown).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'closed', token: null, attempt: null })
  })
})
