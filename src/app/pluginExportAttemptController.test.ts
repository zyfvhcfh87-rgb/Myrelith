import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import type { PluginDeclarationCatalogSnapshot } from './pluginInstallController'
import {
  PluginExportPreflightError,
  type PluginExportSession,
  type PluginRuntimeController,
} from './pluginRuntimeController'
import {
  createPluginExportAttemptController,
  type PluginExportAttemptControllerDependencies,
  type PluginPreparedExportExecution,
} from './pluginExportAttemptController'
import type { PluginRuntimeFailure } from '../workers/plugin-runtime-protocol'
import type { PluginVideoEffectApplyRequest } from '../pipeline/videoEffectStageExecution'

const DIGEST_A = `sha256:${'1'.repeat(64)}` as const
const DIGEST_B = `sha256:${'2'.repeat(64)}` as const
const SIGNER_A = `sha256:${'3'.repeat(64)}` as const
const SIGNER_B = `sha256:${'4'.repeat(64)}` as const

function declaration(
  pluginId: string,
  contributionId: string,
  availability: 'ready' | 'disabled' | 'incompatible' = 'ready',
) {
  const second = pluginId.endsWith('two')
  return Object.freeze({
    pluginId,
    pluginVersion: '1.0.0',
    packageDigest: second ? DIGEST_B : DIGEST_A,
    signerFingerprint: second ? SIGNER_B : SIGNER_A,
    kind: 'video-effect' as const,
    contributionId,
    contributionName: contributionId,
    contributionVersion: 1,
    descriptorVersion: 1,
    entrypoint: `myrelith_effect_${contributionId}`,
    parameters: Object.freeze([]),
    availability,
    detail: availability === 'ready' ? 'Available.' : 'Unavailable for this test.',
  })
}

function catalog(
  generation = 5,
  secondAvailability: 'ready' | 'disabled' | 'incompatible' = 'ready',
): PluginDeclarationCatalogSnapshot {
  return Object.freeze({
    generation,
    declarations: Object.freeze([
      declaration('com.example.one', 'first'),
      declaration('com.example.two', 'second', secondAvailability),
    ]),
  })
}

function document(): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'plugin-export-doc',
    name: 'Plugin export',
    frameRate: { num: 30, den: 1 },
    width: 2,
    height: 1,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [{
        id: 'clip',
        assetId: 'asset',
        name: 'clip',
        sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 1 },
        timelineRange: { startFrame: 0, durationFrames: 1 },
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          anchorX: 0.5,
          anchorY: 0.5,
        },
        opacity: 1,
        volume: 1,
        effects: [{
          id: 'effect-first',
          type: 'plugin:com.example.one/first',
          version: 1,
          enabled: true,
          params: {},
        }, {
          id: 'effect-second',
          type: 'plugin:com.example.two/second',
          version: 1,
          enabled: true,
          params: {},
        }],
      }],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

interface RuntimeHarness {
  readonly runtime: Pick<PluginRuntimeController, 'preflightExport'>
  readonly requests: Array<Parameters<PluginRuntimeController['preflightExport']>[0]>
  readonly sessions: PluginExportSession[]
  readonly closeReasons: string[]
  failure: PluginExportPreflightError | null
  applyFailure: PluginRuntimeFailure | null
}

function runtimeHarness(): RuntimeHarness {
  const requests: RuntimeHarness['requests'] = []
  const sessions: PluginExportSession[] = []
  const closeReasons: string[] = []
  const harness: RuntimeHarness = {
    requests,
    sessions,
    closeReasons,
    failure: null,
    applyFailure: null,
    runtime: {
      async preflightExport(request) {
        requests.push(request)
        if (harness.failure) throw harness.failure
        let closed = false
        const session: PluginExportSession = {
          async apply(applyRequest) {
            if (closed) throw new Error('closed fake export session')
            if (harness.applyFailure) {
              return Object.freeze({ status: 'failed', failure: harness.applyFailure })
            }
            return Object.freeze({
              status: 'applied',
              effectResult: 'mutated',
              rgbaBytes: applyRequest.rgbaBytes.slice(),
            })
          },
          async close(reason) {
            if (closed) return
            closed = true
            closeReasons.push(reason)
          },
        }
        sessions.push(session)
        return session
      },
    },
  }
  return harness
}

function controllerHarness(options: {
  readonly catalog?: PluginDeclarationCatalogSnapshot
  readonly runtime?: RuntimeHarness
  readonly document?: TimelineDoc
} = {}) {
  let generation = 9
  let doc = options.document ?? document()
  let currentCatalog = options.catalog ?? catalog()
  const runtime = options.runtime ?? runtimeHarness()
  const dependencies: PluginExportAttemptControllerDependencies = {
    getDocumentSnapshot: () => ({ generation, document: doc }),
    getDeclarationCatalog: vi.fn(async () => currentCatalog),
    runtime: runtime.runtime,
  }
  return {
    controller: createPluginExportAttemptController(dependencies),
    dependencies,
    runtime,
    changeDocument(next = { ...doc }) {
      doc = next
      generation++
    },
    changeCatalog(next = catalog(currentCatalog.generation + 1)) {
      currentCatalog = next
    },
  }
}

function failure(code: PluginRuntimeFailure['code']): PluginRuntimeFailure {
  return Object.freeze({
    code,
    message: `Host ${code}.`,
    terminal: true,
  })
}

function applyRequest(
  declaration: PluginPreparedExportExecution['pluginSnapshot']['declarations'][number],
  rgba: Uint8Array,
): PluginVideoEffectApplyRequest {
  return {
    execution: {
      catalogGeneration: declaration.catalogGeneration,
      signerFingerprint: declaration.signerFingerprint,
      packageDigest: declaration.packageDigest,
      pluginId: declaration.pluginId,
      pluginVersion: declaration.pluginVersion,
      kind: declaration.kind,
      contributionVersion: declaration.contributionVersion,
      contributionId: declaration.contributionId,
      descriptorVersion: declaration.descriptorVersion,
      entrypoint: declaration.entrypoint,
      parameterRecord: Object.freeze({}),
      canonicalParameterJson: '{}',
    },
    effect: {
      id: 'effect-first',
      type: declaration.effectType,
      version: 1,
      enabled: true,
      params: {},
    },
    timelineFrame: 0,
    frameRate: { num: 30, den: 1 },
    width: 1,
    height: 1,
    stride: 4,
    rgba,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('plugin export attempt controller', () => {
  test('preflights unaffected ready plugins while returning every static blocker', async () => {
    const h = controllerHarness({ catalog: catalog(5, 'incompatible') })

    const result = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked attempt')
    expect(result.snapshot.blockers).toEqual([expect.objectContaining({
      descriptorId: 'effect-second',
      pluginId: 'com.example.two',
      contributionId: 'second',
      status: 'incompatible',
    })])
    expect(h.runtime.requests).toHaveLength(1)
    expect(h.runtime.requests[0].requiredEffects.map((item) => item.pluginId))
      .toEqual(['com.example.one'])
    expect(h.runtime.requests[0].requiredEffects[0]).toMatchObject({
      maximumSurfaceWidth: 2,
      maximumSurfaceHeight: 1,
      maximumSurfaceStride: 8,
      maximumSurfaceByteLength: 8,
    })
    expect(h.runtime.closeReasons).toEqual(['plugin-export-blocked'])
    expect(Object.isFrozen(result.snapshot)).toBe(true)
    expect(Object.isFrozen(result.snapshot.effects)).toBe(true)
  })

  test('aggregates activation failures by exact instance and reviewed bypass excludes only them', async () => {
    const runtime = runtimeHarness()
    runtime.failure = new PluginExportPreflightError([{
      pluginId: 'com.example.one',
      failure: failure('activation-failed'),
    }, {
      pluginId: 'com.example.two',
      failure: failure('timeout'),
    }])
    const h = controllerHarness({ runtime })
    const blocked = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(blocked.status).toBe('blocked')
    if (blocked.status !== 'blocked') throw new Error('expected blocked attempt')
    expect(blocked.snapshot.blockers.map((item) => [item.descriptorId, item.status])).toEqual([
      ['effect-first', 'runtime-activation-failed'],
      ['effect-second', 'runtime-timeout'],
    ])

    runtime.failure = null
    const ready = await h.controller.approveReviewedBlockers(
      blocked.reviewToken,
      blocked.snapshot.blockers.map((item) => item.key),
    )

    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    expect(runtime.requests).toHaveLength(1)
    const execution = await h.controller.consume(ready.token)
    expect(execution.pluginSnapshot.declarations.map((item) => item.availability))
      .toEqual(['failed', 'failed'])
    const input = Uint8Array.of(5, 6, 7, 255)
    await expect(execution.videoEffectStageExecutor.applyPluginEffect(
      applyRequest(execution.pluginSnapshot.declarations[0], input),
    )).rejects.toThrow(/No ready plugin runtime/)
    expect([...input]).toEqual([0, 0, 0, 0])
    await execution.close('test-complete')
  })

  test('rejects partial, duplicate, stale, and reused review or attempt tokens', async () => {
    const h = controllerHarness()
    const blocked = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    expect(blocked.status).toBe('ready')
    if (blocked.status !== 'ready') throw new Error('expected ready attempt')
    const execution = await h.controller.consume(blocked.token)
    await expect(h.controller.consume(blocked.token)).rejects.toMatchObject({
      code: 'already-used',
    })
    await execution.close('test-complete')

    const staticBlocked = controllerHarness({ catalog: catalog(5, 'incompatible') })
    const first = await staticBlocked.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (first.status !== 'blocked') throw new Error('expected blocked attempt')
    await expect(staticBlocked.controller.approveReviewedBlockers(
      first.reviewToken,
      [],
    )).rejects.toMatchObject({ code: 'invalid-review' })
    await expect(staticBlocked.controller.approveReviewedBlockers(
      first.reviewToken,
      [first.snapshot.blockers[0].key, first.snapshot.blockers[0].key],
    )).rejects.toMatchObject({ code: 'invalid-review' })

    const stale = controllerHarness()
    const prepared = await stale.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (prepared.status !== 'ready') throw new Error('expected ready attempt')
    stale.changeDocument()
    await expect(stale.controller.consume(prepared.token)).rejects.toMatchObject({
      code: 'stale-attempt',
    })
    expect(stale.runtime.closeReasons).toEqual(['plugin-export-consume-failed'])

    const catalogDrift = controllerHarness()
    const catalogPrepared = await catalogDrift.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (catalogPrepared.status !== 'ready') throw new Error('expected ready attempt')
    catalogDrift.changeCatalog(catalog(5, 'disabled'))
    await expect(catalogDrift.controller.consume(catalogPrepared.token)).rejects.toMatchObject({
      code: 'stale-attempt',
    })
    expect(catalogDrift.runtime.closeReasons).toEqual(['plugin-export-consume-failed'])
  })

  test('closes preflight when exact catalog content drifts without a generation change', async () => {
    const h = controllerHarness()
    const getCatalog = h.dependencies.getDeclarationCatalog as ReturnType<typeof vi.fn>
    getCatalog
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(catalog(5, 'disabled'))

    await expect(h.controller.prepare(DEFAULT_EXPORT_PROFILE)).rejects.toMatchObject({
      code: 'stale-attempt',
    })
    expect(h.runtime.closeReasons).toEqual(['plugin-export-preflight-failed'])
  })

  test('inventories plugin effects on an animated clip whose base opacity is zero', async () => {
    const animated = document()
    const clip = animated.tracks[0].clips[0]
    const h = controllerHarness({
      document: {
        ...animated,
        tracks: [{
          ...animated.tracks[0],
          clips: [{
            ...clip,
            sourceRange: { ...clip.sourceRange, durationFrames: 2 },
            timelineRange: { ...clip.timelineRange, durationFrames: 2 },
            opacity: 0,
            animation: {
              tracks: [{
                property: 'opacity',
                keyframes: [{
                  frame: 0,
                  value: 0,
                  easing: { type: 'linear' },
                }, {
                  frame: 1,
                  value: 1,
                  easing: { type: 'linear' },
                }],
              }],
              effectTracks: [],
            },
          }],
        }],
      },
    })

    const prepared = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)

    expect(prepared.snapshot.effects.map((effect) => effect.descriptorId))
      .toEqual(['effect-first', 'effect-second'])
    expect(h.runtime.requests[0].requiredEffects).toHaveLength(2)
    if (prepared.status === 'ready') await h.controller.close(prepared.token, 'test-complete')
  })

  test('closes a replaced ready session and creates fresh isolated retry ownership', async () => {
    const h = controllerHarness()
    const first = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (first.status !== 'ready') throw new Error('expected ready attempt')
    const second = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (second.status !== 'ready') throw new Error('expected ready retry')

    expect(h.runtime.sessions).toHaveLength(2)
    expect(h.runtime.closeReasons).toEqual(['plugin-export-replaced'])
    await expect(h.controller.consume(first.token)).rejects.toMatchObject({
      code: 'already-used',
    })
    const execution = await h.controller.consume(second.token)
    await execution.close('retry-complete')
    expect(h.runtime.closeReasons).toEqual(['plugin-export-replaced', 'retry-complete'])
  })

  test('drains an abort-ignoring preparation before a fresh retry can preflight', async () => {
    const runtime = runtimeHarness()
    const firstPreflight = deferred<PluginExportSession>()
    const firstClose = vi.fn(async () => undefined)
    const firstSession: PluginExportSession = {
      async apply() {
        throw new Error('late first session must never apply')
      },
      close: firstClose,
    }
    const normalPreflight = runtime.runtime.preflightExport.bind(runtime.runtime)
    let preflightCount = 0
    runtime.runtime.preflightExport = vi.fn(async (request, signal) => {
      preflightCount++
      if (preflightCount === 1) {
        runtime.requests.push(request)
        return firstPreflight.promise
      }
      return normalPreflight(request, signal)
    })
    const h = controllerHarness({ runtime })

    const first = h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    await vi.waitFor(() => expect(preflightCount).toBe(1))
    const retry = h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    await Promise.resolve()
    expect(preflightCount).toBe(1)
    firstPreflight.resolve(firstSession)

    await expect(first).rejects.toMatchObject({ code: 'stale-attempt' })
    expect(firstClose).toHaveBeenCalledExactlyOnceWith('plugin-export-preflight-failed')
    const ready = await retry
    expect(preflightCount).toBe(2)
    if (ready.status === 'ready') await h.controller.close(ready.token, 'retry-complete')
  })

  test('teardown waits for abort-ignoring preparation rollback and remains idempotent', async () => {
    const runtime = runtimeHarness()
    const latePreflight = deferred<PluginExportSession>()
    const lateClose = vi.fn(async () => undefined)
    runtime.runtime.preflightExport = vi.fn(async () => latePreflight.promise)
    const h = controllerHarness({ runtime })
    const preparing = h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    await vi.waitFor(() => expect(runtime.runtime.preflightExport).toHaveBeenCalledOnce())

    let teardownSettled = false
    const teardown = h.controller.teardown('app-terminal').finally(() => {
      teardownSettled = true
    })
    const duplicate = h.controller.teardown('ignored-duplicate-reason')
    await Promise.resolve()
    expect(teardownSettled).toBe(false)
    latePreflight.resolve({
      async apply() {
        throw new Error('late teardown session must never apply')
      },
      close: lateClose,
    })

    await expect(preparing).rejects.toMatchObject({ code: 'closed' })
    await expect(teardown).resolves.toBeUndefined()
    await expect(duplicate).resolves.toBeUndefined()
    expect(lateClose).toHaveBeenCalledExactlyOnceWith('plugin-export-preflight-failed')
  })

  test('rejects a late consume after replacement and cannot resurrect its closed session', async () => {
    const h = controllerHarness()
    const ready = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    const pendingCatalog = deferred<PluginDeclarationCatalogSnapshot>()
    const getCatalog = h.dependencies.getDeclarationCatalog as ReturnType<typeof vi.fn>
    getCatalog.mockImplementationOnce(async () => pendingCatalog.promise)

    const consuming = h.controller.consume(ready.token)
    await vi.waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(3))
    const replacement = h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    pendingCatalog.resolve(catalog())

    await expect(consuming).rejects.toMatchObject({ code: 'stale-attempt' })
    const next = await replacement
    expect(next.status).toBe('ready')
    expect(h.runtime.closeReasons).toEqual(['plugin-export-replaced'])
    if (next.status === 'ready') await h.controller.close(next.token, 'test-complete')
  })

  test('honors cancellation after an abort-ignoring consume catalog read settles', async () => {
    const h = controllerHarness()
    const ready = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    const pendingCatalog = deferred<PluginDeclarationCatalogSnapshot>()
    const getCatalog = h.dependencies.getDeclarationCatalog as ReturnType<typeof vi.fn>
    getCatalog.mockImplementationOnce(async () => pendingCatalog.promise)
    const abort = new AbortController()

    const consuming = h.controller.consume(ready.token, abort.signal)
    await vi.waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(3))
    abort.abort()
    pendingCatalog.resolve(catalog())

    await expect(consuming).rejects.toMatchObject({ code: 'aborted' })
    expect(h.runtime.closeReasons).toEqual(['plugin-export-consume-failed'])
  })

  test('maps runtime apply failure to a hard export error and closes exactly once', async () => {
    const h = controllerHarness()
    const ready = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    h.runtime.applyFailure = failure('plugin-failure')
    const execution = await h.controller.consume(ready.token)
    const declaration = execution.pluginSnapshot.declarations[0]

    const input = Uint8Array.of(1, 2, 3, 255)
    await expect(execution.videoEffectStageExecutor.applyPluginEffect({
      execution: {
        catalogGeneration: declaration.catalogGeneration,
        signerFingerprint: declaration.signerFingerprint,
        packageDigest: declaration.packageDigest,
        pluginId: declaration.pluginId,
        pluginVersion: declaration.pluginVersion,
        kind: declaration.kind,
        contributionVersion: declaration.contributionVersion,
        contributionId: declaration.contributionId,
        descriptorVersion: declaration.descriptorVersion,
        entrypoint: declaration.entrypoint,
        parameterRecord: Object.freeze({}),
        canonicalParameterJson: '{}',
      },
      effect: {
        id: 'effect-first',
        type: declaration.effectType,
        version: 1,
        enabled: true,
        params: {},
      },
      timelineFrame: 0,
      frameRate: { num: 30, den: 1 },
      width: 1,
      height: 1,
      stride: 4,
      rgba: input,
    })).rejects.toThrow('Host plugin-failure.')
    expect([...input]).toEqual([0, 0, 0, 0])

    await execution.close('failed-export')
    await execution.close('failed-export-again')
    expect(h.runtime.closeReasons).toEqual(['failed-export'])
  })

  test('threads attempt cancellation into an in-flight runtime call as typed cancellation', async () => {
    const h = controllerHarness()
    const ready = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    const applyStarted = deferred<void>()
    const appliedSignal = deferred<AbortSignal>()
    h.runtime.sessions[0].apply = vi.fn(async (_request, signal) => {
      if (!signal) throw new Error('expected attempt-owned signal')
      appliedSignal.resolve(signal)
      applyStarted.resolve()
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return Object.freeze({ status: 'failed', failure: failure('closed') })
    })
    const execution = await h.controller.consume(ready.token)
    const input = Uint8Array.of(1, 2, 3, 255)
    const applying = execution.videoEffectStageExecutor.applyPluginEffect(
      applyRequest(execution.pluginSnapshot.declarations[0], input),
    )
    await applyStarted.promise

    const closing = execution.close('plugin-export-cancelled')

    await expect(applying).rejects.toMatchObject({ code: 'aborted' })
    await expect(closing).resolves.toBeUndefined()
    expect((await appliedSignal.promise).aborted).toBe(true)
    expect([...input]).toEqual([0, 0, 0, 0])
    expect(h.runtime.closeReasons).toEqual(['plugin-export-cancelled'])
  })

  test('returns distinct output while clearing the executor-owned input copy', async () => {
    const h = controllerHarness()
    const ready = await h.controller.prepare(DEFAULT_EXPORT_PROFILE)
    if (ready.status !== 'ready') throw new Error('expected ready attempt')
    const execution = await h.controller.consume(ready.token)
    const declaration = execution.pluginSnapshot.declarations[0]
    const input = Uint8Array.of(9, 8, 7, 255)

    const result = await execution.videoEffectStageExecutor.applyPluginEffect({
      execution: {
        catalogGeneration: declaration.catalogGeneration,
        signerFingerprint: declaration.signerFingerprint,
        packageDigest: declaration.packageDigest,
        pluginId: declaration.pluginId,
        pluginVersion: declaration.pluginVersion,
        kind: declaration.kind,
        contributionVersion: declaration.contributionVersion,
        contributionId: declaration.contributionId,
        descriptorVersion: declaration.descriptorVersion,
        entrypoint: declaration.entrypoint,
        parameterRecord: Object.freeze({}),
        canonicalParameterJson: '{}',
      },
      effect: {
        id: 'effect-first',
        type: declaration.effectType,
        version: 1,
        enabled: true,
        params: {},
      },
      timelineFrame: 0,
      frameRate: { num: 30, den: 1 },
      width: 1,
      height: 1,
      stride: 4,
      rgba: input,
    })

    expect(result).toMatchObject({ status: 'applied' })
    if (result.status !== 'applied') throw new Error('expected applied output')
    expect([...result.rgba]).toEqual([9, 8, 7, 255])
    expect(result.rgba).not.toBe(input)
    expect([...input]).toEqual([0, 0, 0, 0])
    await execution.close('test-complete')
  })
})
