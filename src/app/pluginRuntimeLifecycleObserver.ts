/** Injection-only, data-only lifecycle evidence for the Issue 77 browser gate. */

export interface PluginSandboxLifecycleSnapshot {
  readonly brokerIframeCount: number
  readonly candidateWorkerCount: number
  readonly privatePortCount: number
  readonly watchdogCount: number
  readonly pendingActivationCount: number
  readonly pendingRequestCount: number
  readonly sessionCount: number
  readonly terminal: boolean
}

export interface PluginRuntimeLifecycleSnapshot {
  readonly queuedCallCount: number
  readonly activeCallCount: number
  readonly liveOwnerCount: number
  readonly migrationReservationCount: number
  readonly residentRuntimeCount: number
  readonly rawCacheEntryCount: number
  readonly rawCacheByteLength: number
  readonly terminal: boolean
}

export interface PluginRuntimeLifecycleObserver {
  onSandboxSnapshot(snapshot: PluginSandboxLifecycleSnapshot): void
  onRuntimeSnapshot(snapshot: PluginRuntimeLifecycleSnapshot): void
}
