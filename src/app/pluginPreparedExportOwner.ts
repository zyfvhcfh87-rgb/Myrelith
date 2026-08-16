/** Lazy production ownership for one project-scoped prepared export facade. */

import {
  getPluginAppControllerOwner,
  type PluginAppControllerOwner,
} from './pluginAppController'
import {
  createPluginDocumentGenerationController,
  type PluginDocumentGenerationController,
} from './pluginDocumentGeneration'
import {
  createPluginPreparedExportController,
  type PluginPreparedExportController,
  type PluginPreparedExportControllerDependencies,
} from './pluginPreparedExportController'
import { registerLoadedExportDisposer } from './exportLifecycle'

export type PluginPreparedExportPort = Pick<
  PluginPreparedExportController,
  | 'getSnapshot'
  | 'prepare'
  | 'approveReviewedBlockers'
  | 'start'
  | 'cancel'
>

export interface PluginPreparedExportOwner {
  readonly port: PluginPreparedExportPort
  close(reason: string): Promise<void>
}

type PluginDocumentGenerationOwner = Pick<
  PluginDocumentGenerationController,
  'getDocumentSnapshot' | 'dispose'
>

type ExportDisposerUnregister = (() => void) & {
  readonly joinedDisposal?: Promise<void> | null
}

type ExportDisposerRegistration = (
  disposer: () => Promise<void>,
) => ExportDisposerUnregister

export interface PluginPreparedExportOwnerDependencies {
  readonly appOwner: Pick<PluginAppControllerOwner, 'exportCompositionPort'>
  readonly documentGeneration: PluginDocumentGenerationOwner
  readonly createPreparedController?: typeof createPluginPreparedExportController
  readonly registerExportDisposer?: ExportDisposerRegistration
  readonly onClosing?: (completion: Promise<void>) => void
}

export interface PluginPreparedExportAccessorDependencies {
  getAppOwner(): Pick<PluginAppControllerOwner, 'exportCompositionPort'>
  createDocumentGeneration(): PluginDocumentGenerationOwner
  readonly createOwner?: typeof createPluginPreparedExportOwner
}

export interface PluginPreparedExportAccessor {
  getPort(): PluginPreparedExportPort
  close(reason: string): Promise<void>
}

function frozenPort(
  controller: PluginPreparedExportController,
): PluginPreparedExportPort {
  return Object.freeze({
    getSnapshot: () => controller.getSnapshot(),
    prepare: (settings, signal) => controller.prepare(settings, signal),
    approveReviewedBlockers: (token, signal) => (
      controller.approveReviewedBlockers(token, signal)
    ),
    start: (token, callbacks) => controller.start(token, callbacks),
    cancel: (reason) => controller.cancel(reason),
  })
}

function throwCleanupFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Plugin prepared export owner cleanup failed')
  }
}

class ProjectExportDisposalInProgressError extends Error {
  readonly completion: Promise<void>

  constructor(completion: Promise<void>) {
    super('Plugin prepared export ownership cannot open during project export disposal')
    this.name = 'ProjectExportDisposalInProgressError'
    this.completion = completion
  }
}

function observeClosing(
  current: Promise<void> | null,
  completion: Promise<void>,
  clear: () => void,
): Promise<void> {
  if (current) return current
  void completion.then(clear, clear)
  return completion
}

export function createPluginPreparedExportOwner(
  dependencies: PluginPreparedExportOwnerDependencies,
): PluginPreparedExportOwner {
  const createController = dependencies.createPreparedController
    ?? createPluginPreparedExportController
  const registerDisposer = dependencies.registerExportDisposer
    ?? registerLoadedExportDisposer
  const controllerDependencies: PluginPreparedExportControllerDependencies = {
    appOwner: dependencies.appOwner,
    getDocumentSnapshot: () => dependencies.documentGeneration.getDocumentSnapshot(),
  }
  let controller: PluginPreparedExportController
  try {
    controller = createController(controllerDependencies)
  } catch (cause) {
    try {
      dependencies.documentGeneration.dispose()
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        'Plugin prepared export owner creation and cleanup failed',
      )
    }
    throw cause
  }
  const port = frozenPort(controller)
  let closePromise: Promise<void> | null = null
  let unregister: ExportDisposerUnregister = (): void => {}

  const close = (reason: string): Promise<void> => {
    if (closePromise) return closePromise
    const completion = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      try {
        await controller.close(reason)
      } catch (cause) {
        failures.push(cause)
      }
      try {
        dependencies.documentGeneration.dispose()
      } catch (cause) {
        failures.push(cause)
      }
      unregister()
      throwCleanupFailures(failures)
    })
    closePromise = completion
    dependencies.onClosing?.(completion)
    return completion
  }

  unregister = registerDisposer(() => close('project-export-disposed'))
  if (unregister.joinedDisposal) {
    throw new ProjectExportDisposalInProgressError(unregister.joinedDisposal)
  }
  return Object.freeze({ port, close })
}

export function createPluginPreparedExportAccessor(
  dependencies: PluginPreparedExportAccessorDependencies,
): PluginPreparedExportAccessor {
  const createOwner = dependencies.createOwner ?? createPluginPreparedExportOwner
  let activeOwner: PluginPreparedExportOwner | null = null
  let closing: Promise<void> | null = null

  const accessor: PluginPreparedExportAccessor = {
    getPort() {
      if (activeOwner) return activeOwner.port
      if (closing) {
        throw new Error('Plugin prepared export ownership is still closing')
      }
      const appOwner = dependencies.getAppOwner()
      const documentGeneration = dependencies.createDocumentGeneration()
      let candidate: PluginPreparedExportOwner | null = null
      const onClosing = (completion: Promise<void>): void => {
        if (activeOwner === candidate) activeOwner = null
        closing = observeClosing(closing, completion, () => {
          if (closing === completion) closing = null
        })
      }
      try {
        candidate = createOwner({ appOwner, documentGeneration, onClosing })
      } catch (cause) {
        if (cause instanceof ProjectExportDisposalInProgressError) {
          onClosing(cause.completion)
        }
        throw cause
      }
      activeOwner = candidate
      return candidate.port
    },

    close(reason) {
      if (closing) return closing
      const retiring = activeOwner
      activeOwner = null
      if (!retiring) return Promise.resolve()
      return retiring.close(reason)
    },
  }

  return Object.freeze(accessor)
}

const productionAccessor = createPluginPreparedExportAccessor({
  getAppOwner: getPluginAppControllerOwner,
  createDocumentGeneration: createPluginDocumentGenerationController,
})

/** Lazy UI-facing production accessor. The private app owner never crosses it. */
export function getPluginPreparedExportPort(): PluginPreparedExportPort {
  return productionAccessor.getPort()
}

/** Test/HMR seam; project replacement ordinarily reaches this through exportLifecycle. */
export function disposePluginPreparedExportOwner(reason: string): Promise<void> {
  return productionAccessor.close(reason)
}
