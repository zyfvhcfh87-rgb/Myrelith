/** Disposable browser-gate observer for Issue #77 resource ownership evidence. */

import type {
  PluginRuntimeLifecycleObserver,
  PluginRuntimeLifecycleSnapshot,
  PluginSandboxLifecycleSnapshot,
} from '../../app/pluginRuntimeLifecycleObserver'

export interface PluginLifecycleEvidence {
  readonly sandboxSnapshots: readonly PluginSandboxLifecycleSnapshot[]
  readonly runtimeSnapshots: readonly PluginRuntimeLifecycleSnapshot[]
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value })
}

function assertTerminalSnapshot(
  snapshot: PluginSandboxLifecycleSnapshot | PluginRuntimeLifecycleSnapshot | undefined,
  label: string,
): void {
  if (!snapshot?.terminal) throw new Error(`${label} did not publish a terminal lifecycle snapshot`)
  if (Object.entries(snapshot).some(([key, value]) => key !== 'terminal' && value !== 0)) {
    throw new Error(`${label} retained owned resources at its terminal boundary`)
  }
}

export function createPluginLifecycleEvidence(): {
  readonly observer: PluginRuntimeLifecycleObserver
  readonly evidence: () => PluginLifecycleEvidence
  assertTerminal(): PluginLifecycleEvidence
} {
  const sandboxSnapshots: PluginSandboxLifecycleSnapshot[] = []
  const runtimeSnapshots: PluginRuntimeLifecycleSnapshot[] = []
  const evidence = (): PluginLifecycleEvidence => Object.freeze({
    sandboxSnapshots: Object.freeze(sandboxSnapshots.map(frozen)),
    runtimeSnapshots: Object.freeze(runtimeSnapshots.map(frozen)),
  })
  return Object.freeze({
    observer: Object.freeze({
      onSandboxSnapshot(snapshot: PluginSandboxLifecycleSnapshot) { sandboxSnapshots.push(frozen(snapshot)) },
      onRuntimeSnapshot(snapshot: PluginRuntimeLifecycleSnapshot) { runtimeSnapshots.push(frozen(snapshot)) },
    }),
    evidence,
    assertTerminal() {
      const result = evidence()
      assertTerminalSnapshot(result.sandboxSnapshots.at(-1), 'Plugin sandbox')
      assertTerminalSnapshot(result.runtimeSnapshots.at(-1), 'Plugin runtime')
      return result
    },
  })
}
