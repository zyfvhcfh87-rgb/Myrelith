/** Eager, sentinel-only plugin startup decision. No package/runtime work belongs here. */

import {
  createPluginSessionSafety,
  createStaleActivationAcknowledgement,
  readPluginStartupSafety,
  type PluginSafetyStorage,
  type PluginSessionSafety,
  type PluginSessionStartupMode,
  type PluginStartupSafety,
} from './pluginSafetyController'

export interface PluginStartupSnapshot {
  readonly mode: PluginSessionStartupMode
  readonly sentinelStatus: PluginStartupSafety['status']
  readonly safeModeRecommended: boolean
  readonly recommendationReason: string
  readonly staleBatchId: string | null
}

export interface PluginStartupController {
  getSnapshot(): PluginStartupSnapshot
  subscribe(listener: (snapshot: PluginStartupSnapshot) => void): () => void
  enterSafeMode(): boolean
  continueWithReviewedNormalStartup(): boolean
  /** App-composition seam; never project/UI state. */
  getSessionSafety(): PluginSessionSafety
}

function recommendationReason(startup: PluginStartupSafety): string {
  switch (startup.status) {
    case 'clean':
      return ''
    case 'stale-activation':
      return 'Myrelith closed during plugin activation. Review this session before plugins initialize.'
    case 'invalid-sentinel':
      return 'The previous plugin activation state could not be verified. Safe mode is required.'
    case 'storage-unavailable':
      return 'Plugin activation state is unavailable. Safe mode is required.'
  }
}

function snapshotFor(
  startup: PluginStartupSafety,
  session: PluginSessionSafety,
): PluginStartupSnapshot {
  const mode = session.startupMode()
  const decisionPending = mode === 'review-required'
  return Object.freeze({
    mode,
    sentinelStatus: startup.status,
    safeModeRecommended: decisionPending && startup.offerSafeMode,
    recommendationReason: decisionPending ? recommendationReason(startup) : '',
    staleBatchId: startup.status === 'stale-activation' ? startup.batchId : null,
  })
}

export function createPluginStartupController(
  storage: PluginSafetyStorage,
): PluginStartupController {
  const startup = readPluginStartupSafety(storage)
  const acknowledgeStaleActivation = createStaleActivationAcknowledgement(storage)
  const session = createPluginSessionSafety(startup)
  const listeners = new Set<(snapshot: PluginStartupSnapshot) => void>()
  let snapshot = snapshotFor(startup, session)

  const publishIfChanged = (): boolean => {
    const next = snapshotFor(startup, session)
    if (next.mode === snapshot.mode) return false
    snapshot = next
    for (const listener of listeners) listener(snapshot)
    return true
  }

  const enterSafeMode = (): boolean => {
    session.enterSafeMode()
    return publishIfChanged()
  }

  const continueWithReviewedNormalStartup = (): boolean => {
    if (!session.continueWithReviewedNormalStartup()) return false
    acknowledgeStaleActivation()
    publishIfChanged()
    return true
  }

  const sessionFacade: PluginSessionSafety = Object.freeze({
    enterSafeMode: () => { enterSafeMode() },
    continueWithReviewedNormalStartup,
    startupMode: session.startupMode,
    isSafeMode: session.isSafeMode,
    thirdPartyInitializationAllowed: session.thirdPartyInitializationAllowed,
  })

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: (snapshot: PluginStartupSnapshot) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    enterSafeMode,
    continueWithReviewedNormalStartup,
    getSessionSafety: () => sessionFacade,
  })
}
