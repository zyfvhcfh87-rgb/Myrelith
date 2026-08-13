import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { MotionAnalysisController } from './motionAnalysisController'

let controller: MotionAnalysisController | null = null
let unsubscribeDocument: (() => void) | null = null
let unsubscribeMedia: (() => void) | null = null
let initializationPromise: Promise<void> | null = null
let disposalPromise: Promise<void> | null = null
const leases = new Set<object>()

async function initialize(): Promise<void> {
  if (controller) return
  const next = new MotionAnalysisController()
  controller = next
  unsubscribeDocument = useDocumentStore.subscribe((current, previous) => {
    if (current.doc !== previous.doc) next.reconcile()
  })
  unsubscribeMedia = useMediaStore.subscribe((current, previous) => {
    if (current.assets !== previous.assets || current.descriptors !== previous.descriptors) {
      next.reconcile()
    }
  })
}

async function disposeRuntime(): Promise<void> {
  if (disposalPromise) return disposalPromise
  disposalPromise = (async () => {
    if (initializationPromise) await initializationPromise.catch(() => undefined)
    unsubscribeDocument?.()
    unsubscribeMedia?.()
    unsubscribeDocument = null
    unsubscribeMedia = null
    const retiring = controller
    controller = null
    await retiring?.dispose()
  })().finally(() => {
    disposalPromise = null
  })
  return disposalPromise
}

/** Acquire one StrictMode-safe editor lifecycle lease. */
export async function initMotionAnalysisRuntime(): Promise<() => Promise<void>> {
  const lease = {}
  leases.add(lease)
  try {
    if (disposalPromise) await disposalPromise
    if (initializationPromise) await initializationPromise
    else if (!controller) {
      initializationPromise = initialize().finally(() => {
        initializationPromise = null
      })
      await initializationPromise
    }
  } catch (cause) {
    leases.delete(lease)
    if (leases.size === 0) await disposeRuntime()
    throw cause
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    leases.delete(lease)
    if (leases.size === 0) await disposeRuntime()
  }
}

export function getMotionAnalysisController(): MotionAnalysisController | null {
  return controller
}

/** Force-release all leases; tests and application teardown only. */
export async function disposeMotionAnalysisRuntime(): Promise<void> {
  leases.clear()
  await disposeRuntime()
}
