/**
 * Lightweight lifecycle seam for the lazily loaded export controller.
 *
 * Project replacement must stop an active export, but importing the heavy
 * controller only to discover that no export ever started defeats first-use
 * loading. The controller registers its disposer when its chunk evaluates.
 */

type ExportDisposer = () => Promise<void>

interface RegisteredExportDisposer {
  readonly dispose: ExportDisposer
  registered: boolean
}

interface ExportDisposalState {
  readonly pending: RegisteredExportDisposer[]
  readonly completion: Promise<void>
}

export interface LoadedExportDisposerRegistration {
  (): void
  /** The active project-disposal boundary this late registration joined. */
  readonly joinedDisposal: Promise<void> | null
}

const loadedExportDisposers: RegisteredExportDisposer[] = []
let disposalState: ExportDisposalState | null = null

/**
 * Register one lazily loaded export owner without displacing earlier owners.
 * Newer owners dispose first so an app facade can drain its active controller
 * before the lower-level export controller observes the same terminal state.
 */
export function registerLoadedExportDisposer(
  disposer: ExportDisposer,
): LoadedExportDisposerRegistration {
  const entry: RegisteredExportDisposer = { dispose: disposer, registered: true }
  loadedExportDisposers.push(entry)
  const joinedDisposal = disposalState?.completion ?? null
  if (disposalState) disposalState.pending.push(entry)

  const unregister = (): void => {
    if (!entry.registered) return
    entry.registered = false
    const index = loadedExportDisposers.lastIndexOf(entry)
    if (index >= 0) loadedExportDisposers.splice(index, 1)
  }
  return Object.assign(unregister, { joinedDisposal })
}

export function disposeLoadedExport(): Promise<void> {
  if (disposalState) return disposalState.completion

  let resolveCompletion!: () => void
  let rejectCompletion!: (cause: unknown) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const state: ExportDisposalState = {
    pending: [...loadedExportDisposers],
    completion,
  }
  disposalState = state

  void Promise.resolve().then(async () => {
    const failures: unknown[] = []
    while (state.pending.length > 0) {
      const entry = state.pending.pop()
      if (!entry?.registered) continue
      try {
        await entry.dispose()
      } catch (cause) {
        failures.push(cause)
      }
    }
    disposalState = null
    if (failures.length === 1) rejectCompletion(failures[0])
    else if (failures.length > 1) {
      rejectCompletion(new AggregateError(failures, 'Loaded export cleanup failed'))
    } else resolveCompletion()
  })
  return completion
}

/** Test/HMR seam. */
export function resetLoadedExportDisposer(): void {
  loadedExportDisposers.length = 0
  disposalState = null
}
