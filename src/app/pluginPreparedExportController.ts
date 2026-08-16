/** App-private string-token facade for one prepared plugin-aware export. */

import type { ExportProfile } from '../domain/exportProfile'
import {
  cancelExport,
  startPreparedExport,
  type ExportCallbacks,
  type ExportResult,
} from './exportController'
import type { PluginAppControllerOwner } from './pluginAppController'
import {
  createPluginExportAttemptController,
  type PluginExportAttemptPrepareResult,
  type PluginExportAttemptSnapshot,
  type PluginExportAttemptToken,
  type PluginExportDocumentSnapshot,
  type PluginExportReviewToken,
} from './pluginExportAttemptController'

export type PluginPreparedExportControllerErrorCode =
  | 'closed'
  | 'invalid-token'

export class PluginPreparedExportControllerError extends Error {
  readonly code: PluginPreparedExportControllerErrorCode

  constructor(code: PluginPreparedExportControllerErrorCode, message: string) {
    super(message)
    this.name = 'PluginPreparedExportControllerError'
    this.code = code
  }
}

export type PluginPreparedExportSnapshot =
  | {
      readonly status: 'idle' | 'preparing'
      readonly token: null
      readonly attempt: null
    }
  | {
      readonly status: 'blocked'
      readonly token: string
      readonly attempt: PluginExportAttemptSnapshot
    }
  | {
      readonly status: 'ready'
      readonly token: string
      readonly attempt: PluginExportAttemptSnapshot
    }
  | {
      readonly status: 'running'
      readonly token: null
      readonly attempt: PluginExportAttemptSnapshot
    }
  | {
      readonly status: 'closed'
      readonly token: null
      readonly attempt: null
    }

export interface PluginPreparedExportController {
  getSnapshot(): PluginPreparedExportSnapshot
  prepare(settings: ExportProfile, signal?: AbortSignal): Promise<PluginPreparedExportSnapshot>
  approveReviewedBlockers(
    reviewToken: string,
    signal?: AbortSignal,
  ): Promise<PluginPreparedExportSnapshot>
  start(
    readyToken: string,
    callbacks?: ExportCallbacks,
  ): Promise<ExportResult | undefined>
  cancel(reason: string): Promise<void>
  close(reason: string): Promise<void>
}

export interface PluginPreparedExportControllerDependencies {
  /** The full catalog/runtime port remains private on this app-owned surface. */
  readonly appOwner: Pick<PluginAppControllerOwner, 'exportCompositionPort'>
  getDocumentSnapshot(): PluginExportDocumentSnapshot
  readonly createPublicToken?: () => string
  readonly createAttemptController?: typeof createPluginExportAttemptController
  readonly startExport?: typeof startPreparedExport
  readonly cancelActiveExport?: typeof cancelExport
}

interface RetainedAttempt {
  readonly publicToken: string
  readonly sourceToken: PluginExportAttemptToken | PluginExportReviewToken
  readonly kind: 'ready' | 'review'
  readonly snapshot: PluginExportAttemptSnapshot
}

interface RunningAttempt {
  readonly snapshot: PluginExportAttemptSnapshot
  readonly completion: Promise<ExportResult | undefined>
}

function defaultPublicToken(): string {
  const bytes = new Uint8Array(18)
  globalThis.crypto.getRandomValues(bytes)
  return `plugin-export-${[...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

function freezeAttemptSnapshot(
  source: PluginExportAttemptSnapshot,
): PluginExportAttemptSnapshot {
  return Object.freeze({
    documentGeneration: source.documentGeneration,
    settings: Object.freeze({ ...source.settings }),
    catalogGeneration: source.catalogGeneration,
    effects: Object.freeze(source.effects.map((effect) => Object.freeze({ ...effect }))),
    blockers: Object.freeze(source.blockers.map((blocker) => Object.freeze({ ...blocker }))),
  })
}

function idleSnapshot(): PluginPreparedExportSnapshot {
  return Object.freeze({ status: 'idle', token: null, attempt: null })
}

function fail(
  code: PluginPreparedExportControllerErrorCode,
  message: string,
): never {
  throw new PluginPreparedExportControllerError(code, message)
}

/**
 * Wrap opaque object-capability attempts in app-minted, one-use string tokens.
 * The retained exact blocker keys never cross this facade.
 */
export function createPluginPreparedExportController(
  dependencies: PluginPreparedExportControllerDependencies,
): PluginPreparedExportController {
  const createAttempt = dependencies.createAttemptController
    ?? createPluginExportAttemptController
  const startExport = dependencies.startExport ?? startPreparedExport
  const cancelActiveExport = dependencies.cancelActiveExport ?? cancelExport
  const createPublicToken = dependencies.createPublicToken ?? defaultPublicToken
  const exportPort = dependencies.appOwner.exportCompositionPort
  const attemptController = createAttempt({
    getDocumentSnapshot: dependencies.getDocumentSnapshot,
    getDeclarationCatalog: (signal) => exportPort.getDeclarationCatalog(signal),
    runtime: Object.freeze({
      preflightExport: (request, signal) => exportPort.preflightExport(request, signal),
    }),
  })
  let closed = false
  let retained: RetainedAttempt | null = null
  let running: RunningAttempt | null = null
  let operationAbort: AbortController | null = null
  let transition = Promise.resolve()
  let closePromise: Promise<void> | null = null
  let snapshot: PluginPreparedExportSnapshot = idleSnapshot()
  let publicTokenSequence = 0

  const runExclusive = <T>(task: () => Promise<T> | T): Promise<T> => {
    const previous = transition.catch(() => undefined)
    const result = previous.then(task)
    transition = result.then(() => undefined, () => undefined)
    return result
  }

  const publishResult = async (
    result: PluginExportAttemptPrepareResult,
  ): Promise<PluginPreparedExportSnapshot> => {
    const sourceToken = result.status === 'ready' ? result.token : result.reviewToken
    let publicToken: string
    try {
      const entropy = createPublicToken()
      if (typeof entropy !== 'string' || entropy.length < 16 || entropy.length > 224) {
        throw new TypeError('Plugin export public token factory returned an invalid token')
      }
      if (publicTokenSequence >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Plugin export public token sequence is exhausted')
      }
      publicTokenSequence++
      publicToken = `${entropy}.${publicTokenSequence.toString(36)}`
    } catch (cause) {
      try {
        await attemptController.close(sourceToken, 'plugin-export-public-token-invalid')
      } catch {
        // Invalid authority remains primary; the attempt close is terminal before rejection.
      }
      throw cause
    }
    const attempt = freezeAttemptSnapshot(result.snapshot)
    retained = result.status === 'ready'
      ? {
          publicToken,
          sourceToken: result.token,
          kind: 'ready',
          snapshot: attempt,
        }
      : {
          publicToken,
          sourceToken: result.reviewToken,
          kind: 'review',
          snapshot: attempt,
        }
    snapshot = Object.freeze({
      status: result.status,
      token: publicToken,
      attempt,
    })
    return snapshot
  }

  const requireRetained = (
    publicToken: string,
    kind: RetainedAttempt['kind'],
  ): RetainedAttempt => {
    const current = retained
    if (!current || current.publicToken !== publicToken || current.kind !== kind) {
      fail('invalid-token', 'Plugin export token is invalid, stale, or already used')
    }
    return current
  }

  const clearRunningView = (current: RunningAttempt): void => {
    if (running !== current) return
    running = null
    if (!closed) snapshot = idleSnapshot()
  }

  const drainCurrent = async (reason: string): Promise<void> => {
    const pending = operationAbort
    operationAbort = null
    pending?.abort(reason)

    const currentRunning = running
    if (currentRunning) {
      let cancellationFailure: unknown
      let completionFailure: unknown
      try {
        await cancelActiveExport()
      } catch (cause) {
        cancellationFailure = cause
      }
      try {
        await currentRunning.completion
      } catch (cause) {
        completionFailure = cause
      } finally {
        clearRunningView(currentRunning)
      }
      if (completionFailure !== undefined) throw completionFailure
      if (cancellationFailure !== undefined) throw cancellationFailure
      return
    }

    const current = retained
    retained = null
    if (current) {
      try {
        await attemptController.close(current.sourceToken, reason)
      } finally {
        if (!closed) snapshot = idleSnapshot()
      }
    }
  }

  const controller: PluginPreparedExportController = {
    getSnapshot() {
      return snapshot
    },

    prepare(settings, signal) {
      operationAbort?.abort('plugin-export-replaced')
      return runExclusive(async () => {
        if (closed) fail('closed', 'Plugin prepared export controller is closed')
        await drainCurrent('plugin-export-replaced')
        if (closed) fail('closed', 'Plugin prepared export controller is closed')
        const abort = new AbortController()
        operationAbort = abort
        const forwardAbort = (): void => abort.abort(signal?.reason)
        if (signal?.aborted) abort.abort(signal.reason)
        else signal?.addEventListener('abort', forwardAbort, { once: true })
        snapshot = Object.freeze({ status: 'preparing', token: null, attempt: null })
        try {
          return await publishResult(await attemptController.prepare(settings, abort.signal))
        } catch (cause) {
          if (!closed) snapshot = idleSnapshot()
          throw cause
        } finally {
          signal?.removeEventListener('abort', forwardAbort)
          if (operationAbort === abort) operationAbort = null
        }
      })
    },

    approveReviewedBlockers(reviewToken, signal) {
      return runExclusive(async () => {
        if (closed) fail('closed', 'Plugin prepared export controller is closed')
        const current = requireRetained(reviewToken, 'review')
        retained = null
        const abort = new AbortController()
        operationAbort = abort
        const forwardAbort = (): void => abort.abort(signal?.reason)
        if (signal?.aborted) abort.abort(signal.reason)
        else signal?.addEventListener('abort', forwardAbort, { once: true })
        snapshot = Object.freeze({ status: 'preparing', token: null, attempt: null })
        try {
          const blockerKeys = Object.freeze(
            current.snapshot.blockers.map((blocker) => blocker.key),
          )
          return await publishResult(await attemptController.approveReviewedBlockers(
            current.sourceToken as PluginExportReviewToken,
            blockerKeys,
            abort.signal,
          ))
        } catch (cause) {
          if (!closed) snapshot = idleSnapshot()
          throw cause
        } finally {
          signal?.removeEventListener('abort', forwardAbort)
          if (operationAbort === abort) operationAbort = null
        }
      })
    },

    async start(readyToken, callbacks = {}) {
      const launched = await runExclusive(async () => {
        if (closed) fail('closed', 'Plugin prepared export controller is closed')
        const current = requireRetained(readyToken, 'ready')
        retained = null
        let completion: Promise<ExportResult | undefined>
        try {
          completion = startExport(
            current.sourceToken as PluginExportAttemptToken,
            attemptController,
            callbacks,
          )
        } catch (cause) {
          try {
            await attemptController.close(current.sourceToken, 'plugin-export-start-failed')
          } catch {
            // The synchronous start failure remains primary after terminal cleanup.
          }
          snapshot = idleSnapshot()
          throw cause
        }
        const active: RunningAttempt = { snapshot: current.snapshot, completion }
        running = active
        snapshot = Object.freeze({
          status: 'running',
          token: null,
          attempt: current.snapshot,
        })
        void completion.then(
          () => clearRunningView(active),
          () => clearRunningView(active),
        )
        return active
      })
      return launched.completion
    },

    cancel(reason) {
      operationAbort?.abort(reason)
      return runExclusive(async () => {
        if (closed) return
        await drainCurrent(reason)
        snapshot = idleSnapshot()
      })
    },

    close(reason) {
      if (closePromise) return closePromise
      closed = true
      operationAbort?.abort(reason)
      closePromise = runExclusive(async () => {
        const failures: unknown[] = []
        try {
          await drainCurrent(reason)
        } catch (cause) {
          failures.push(cause)
        }
        try {
          await attemptController.teardown(reason)
        } catch (cause) {
          failures.push(cause)
        }
        snapshot = Object.freeze({ status: 'closed', token: null, attempt: null })
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Plugin prepared export cleanup failed')
        }
      })
      return closePromise
    },
  }

  return Object.freeze(controller)
}
