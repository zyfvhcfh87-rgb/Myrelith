import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { PluginAppControllerOwner } from './pluginAppController'
import type { PluginDocumentGenerationController } from './pluginDocumentGeneration'
import type { PluginExportAttemptSnapshot } from './pluginExportAttemptController'
import {
  createPluginPreparedExportController,
  type PluginPreparedExportController,
  type PluginPreparedExportControllerDependencies,
  type PluginPreparedExportSnapshot,
} from './pluginPreparedExportController'
import {
  createPluginPreparedExportAccessor,
  createPluginPreparedExportOwner,
  type PluginPreparedExportOwner,
  type PluginPreparedExportPort,
} from './pluginPreparedExportOwner'
import {
  disposeLoadedExport,
  registerLoadedExportDisposer,
  resetLoadedExportDisposer,
} from './exportLifecycle'

beforeEach(() => {
  resetLoadedExportDisposer()
})

function attemptSnapshot(): PluginExportAttemptSnapshot {
  return Object.freeze({
    documentGeneration: 4,
    settings: DEFAULT_EXPORT_PROFILE,
    catalogGeneration: 9,
    effects: Object.freeze([]),
    blockers: Object.freeze([]),
  })
}

function view(
  status: 'idle' | 'preparing' | 'blocked' | 'ready' | 'running' | 'closed',
): PluginPreparedExportSnapshot {
  if (status === 'blocked' || status === 'ready') {
    return Object.freeze({ status, token: `public-${status}-token`, attempt: attemptSnapshot() })
  }
  if (status === 'running') {
    return Object.freeze({ status, token: null, attempt: attemptSnapshot() })
  }
  return Object.freeze({ status, token: null, attempt: null })
}

function fakeController(initial = view('idle')) {
  const snapshot = initial
  const controller: PluginPreparedExportController = {
    getSnapshot: vi.fn(() => snapshot),
    prepare: vi.fn(async () => snapshot),
    approveReviewedBlockers: vi.fn(async () => snapshot),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  return {
    controller,
  }
}

function privateAppOwner(): Pick<PluginAppControllerOwner, 'exportCompositionPort'> {
  return {
    exportCompositionPort: Object.freeze({
      getDeclarationCatalog: vi.fn(async () => Object.freeze({
        generation: 0,
        declarations: Object.freeze([]),
      })),
      preflightExport: vi.fn(async () => {
        throw new Error('not used by the owner unit test')
      }),
    }),
  }
}

function documentGeneration() {
  const snapshot = Object.freeze({
    generation: 4,
    document: createTimelineDoc('owner-doc', DEFAULT_PROJECT_SETTINGS, 'Owner document'),
  })
  const controller: Pick<
    PluginDocumentGenerationController,
    'getDocumentSnapshot' | 'dispose'
  > = {
    getDocumentSnapshot: vi.fn(() => snapshot),
    dispose: vi.fn(),
  }
  return { controller, snapshot }
}

function port(): PluginPreparedExportPort {
  return Object.freeze({
    getSnapshot: () => view('idle'),
    prepare: async () => view('idle'),
    approveReviewedBlockers: async () => view('idle'),
    start: async () => undefined,
    cancel: async () => undefined,
  })
}

describe('plugin prepared export production owner', () => {
  test('binds private dependencies and exposes only the exact frozen five-method port', async () => {
    const appOwner = privateAppOwner()
    const generation = documentGeneration()
    const prepared = fakeController(view('ready'))
    const captured: { value?: PluginPreparedExportControllerDependencies } = {}
    let registeredDisposer: (() => Promise<void>) | null = null
    const unregister = vi.fn()
    const createPrepared = vi.fn((dependencies: PluginPreparedExportControllerDependencies) => {
      captured.value = dependencies
      return prepared.controller
    }) as typeof createPluginPreparedExportController
    const register = vi.fn((disposer: () => Promise<void>) => {
      registeredDisposer = disposer
      return unregister
    })

    const owner = createPluginPreparedExportOwner({
      appOwner,
      documentGeneration: generation.controller,
      createPreparedController: createPrepared,
      registerExportDisposer: register,
    })

    expect(Object.isFrozen(owner)).toBe(true)
    expect(Object.isFrozen(owner.port)).toBe(true)
    expect(Object.keys(owner.port)).toEqual([
      'getSnapshot',
      'prepare',
      'approveReviewedBlockers',
      'start',
      'cancel',
    ])
    expect('close' in owner.port).toBe(false)
    expect('exportCompositionPort' in owner.port).toBe(false)
    expect('appOwner' in owner.port).toBe(false)
    expect('documentGeneration' in owner.port).toBe(false)
    expect(register).toHaveBeenCalledOnce()
    expect(registeredDisposer).not.toBeNull()
    expect(captured.value?.appOwner).toBe(appOwner)
    expect(captured.value?.getDocumentSnapshot()).toBe(generation.snapshot)

    expect(owner.port.getSnapshot()).toBe(prepared.controller.getSnapshot())
    await owner.port.prepare(DEFAULT_EXPORT_PROFILE)
    await owner.port.approveReviewedBlockers('public-review-token')
    await owner.port.start('public-ready-token')
    await owner.port.cancel('dialog-replaced')

    expect(prepared.controller.prepare).toHaveBeenCalledOnce()
    expect(prepared.controller.approveReviewedBlockers).toHaveBeenCalledOnce()
    expect(prepared.controller.start).toHaveBeenCalledOnce()
    expect(prepared.controller.cancel).toHaveBeenCalledOnce()
  })

  test.each(['preparing', 'blocked', 'ready', 'running'] as const)(
    'keeps %s ownership registered until terminal close and generation disposal',
    async (status) => {
      const generation = documentGeneration()
      let releaseClose!: () => void
      const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
      const prepared = fakeController(view(status))
      prepared.controller.close = vi.fn(async () => closeGate)
      let registeredDisposer: (() => Promise<void>) | null = null
      const unregister = vi.fn()
      const owner = createPluginPreparedExportOwner({
        appOwner: privateAppOwner(),
        documentGeneration: generation.controller,
        createPreparedController: (() => prepared.controller) as typeof createPluginPreparedExportController,
        registerExportDisposer(disposer) {
          registeredDisposer = disposer
          return unregister
        },
      })

      const first = registeredDisposer!()
      const second = owner.close('concurrent-close')
      expect(second).toBe(first)
      await Promise.resolve()
      expect(prepared.controller.close).toHaveBeenCalledWith('project-export-disposed')
      expect(generation.controller.dispose).not.toHaveBeenCalled()
      expect(unregister).not.toHaveBeenCalled()

      releaseClose()
      await first

      expect(prepared.controller.close).toHaveBeenCalledOnce()
      expect(generation.controller.dispose).toHaveBeenCalledOnce()
      expect(unregister).toHaveBeenCalledOnce()
    },
  )

  test('disposes generation and unregisters after controller failure, aggregating both failures', async () => {
    const closeFailure = new Error('prepared controller close failed')
    const generationFailure = new Error('generation dispose failed')
    const generation = documentGeneration()
    generation.controller.dispose = vi.fn(() => { throw generationFailure })
    const prepared = fakeController()
    prepared.controller.close = vi.fn(async () => { throw closeFailure })
    const unregister = vi.fn()
    const owner = createPluginPreparedExportOwner({
      appOwner: privateAppOwner(),
      documentGeneration: generation.controller,
      createPreparedController: (() => prepared.controller) as typeof createPluginPreparedExportController,
      registerExportDisposer: () => unregister,
    })

    const failure = await owner.close('project-replaced').catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([closeFailure, generationFailure])
    expect(unregister).toHaveBeenCalledOnce()
  })

  test('clears the singleton before awaiting close and creates a fresh next-project owner', async () => {
    const created: Array<{
      readonly owner: PluginPreparedExportOwner
      readonly release: () => void
    }> = []
    const createOwner = vi.fn((dependencies) => {
      let release!: () => void
      const terminal = new Promise<void>((resolve) => { release = resolve })
      let completion: Promise<void> | null = null
      const owner: PluginPreparedExportOwner = Object.freeze({
        port: port(),
        close: vi.fn(() => {
          if (completion) return completion
          completion = terminal
          dependencies.onClosing?.(completion)
          return completion
        }),
      })
      created.push({ owner, release })
      return owner
    })
    const createGeneration = vi.fn(() => documentGeneration().controller)
    const accessor = createPluginPreparedExportAccessor({
      getAppOwner: privateAppOwner,
      createDocumentGeneration: createGeneration,
      createOwner,
    })

    const first = accessor.getPort()
    expect(accessor.getPort()).toBe(first)
    const closing = accessor.close('project-a-replaced')
    expect(() => accessor.getPort()).toThrow('still closing')
    expect(created[0].owner.close).toHaveBeenCalledOnce()

    created[0].release()
    await closing
    const second = accessor.getPort()

    expect(second).not.toBe(first)
    expect(createOwner).toHaveBeenCalledTimes(2)
    expect(createGeneration).toHaveBeenCalledTimes(2)
    const finalClose = accessor.close('test-complete')
    created[1].release()
    await finalClose
  })

  test('never exposes an owner registered during disposal and joins its cleanup', async () => {
    let releaseExisting!: () => void
    const existingGate = new Promise<void>((resolve) => { releaseExisting = resolve })
    registerLoadedExportDisposer(async () => existingGate)
    const disposal = disposeLoadedExport()
    await Promise.resolve()

    let releasePrepared!: () => void
    let markPreparedCloseStarted!: () => void
    const preparedGate = new Promise<void>((resolve) => { releasePrepared = resolve })
    const preparedCloseStarted = new Promise<void>((resolve) => {
      markPreparedCloseStarted = resolve
    })
    const generations = [documentGeneration(), documentGeneration()]
    const preparedControllers = [fakeController(), fakeController()]
    preparedControllers[0].controller.close = vi.fn(async () => {
      markPreparedCloseStarted()
      await preparedGate
    })
    let index = 0
    const accessor = createPluginPreparedExportAccessor({
      getAppOwner: privateAppOwner,
      createDocumentGeneration: () => generations[index].controller,
      createOwner(dependencies) {
        const prepared = preparedControllers[index]
        index += 1
        return createPluginPreparedExportOwner({
          ...dependencies,
          createPreparedController: (() => prepared.controller) as typeof createPluginPreparedExportController,
        })
      },
    })

    expect(() => accessor.getPort()).toThrow(
      'cannot open during project export disposal',
    )
    expect(() => accessor.getPort()).toThrow('still closing')
    expect(index).toBe(1)
    expect(preparedControllers[0].controller.close).not.toHaveBeenCalled()

    releaseExisting()
    await preparedCloseStarted
    expect(preparedControllers[0].controller.close).toHaveBeenCalledOnce()
    expect(generations[0].controller.dispose).not.toHaveBeenCalled()

    let settled = false
    void disposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    releasePrepared()
    await disposal
    expect(generations[0].controller.dispose).toHaveBeenCalledOnce()

    const freshPort = accessor.getPort()
    expect(Object.isFrozen(freshPort)).toBe(true)
    expect(Object.keys(freshPort)).toEqual([
      'getSnapshot',
      'prepare',
      'approveReviewedBlockers',
      'start',
      'cancel',
    ])
    expect(index).toBe(2)
    await accessor.close('test-complete')
    expect(preparedControllers[1].controller.close).toHaveBeenCalledOnce()
    expect(generations[1].controller.dispose).toHaveBeenCalledOnce()
  })
})
