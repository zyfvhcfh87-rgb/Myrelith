import { useCallback, useContext, useSyncExternalStore } from 'react'
import type { PluginAppSnapshot } from '../../app/pluginAppController'
import type { PluginAppEditorSnapshot } from '../../app/pluginEditorController'
import { PluginUiContext, type PluginUiContextValue } from './pluginUiContextValue'

export function useOptionalPluginUi(): PluginUiContextValue | null {
  return useContext(PluginUiContext)
}

export function usePluginUi(): PluginUiContextValue {
  const value = useOptionalPluginUi()
  if (!value) throw new Error('Plugin UI requires PluginUiProvider.')
  return value
}

export function usePluginAppSnapshot(): PluginAppSnapshot {
  const snapshot = useOptionalPluginAppSnapshot()
  if (!snapshot) throw new Error('Plugin UI requires PluginUiProvider.')
  return snapshot
}

/**
 * Fire-and-forget controller command from a UI event. Its rejection is
 * deliberately swallowed so it never surfaces as an unhandled rejection.
 */
export function ignorePluginCommandRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {})
}

export function useOptionalPluginEditorSnapshot(): PluginAppEditorSnapshot | null {
  const value = useOptionalPluginUi()
  const subscribe = useCallback(
    (notify: () => void) => value?.controller.subscribeEditor(() => notify()) ?? (() => {}),
    [value],
  )
  const getSnapshot = useCallback(
    () => value?.controller.getEditorSnapshot() ?? null,
    [value],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useOptionalPluginAppSnapshot(): PluginAppSnapshot | null {
  // Key on the controller, not the context value, which also changes with
  // manager open/selection state.
  const controller = useOptionalPluginUi()?.controller ?? null
  const subscribe = useCallback(
    (notify: () => void) => controller?.subscribe(() => notify()) ?? (() => {}),
    [controller],
  )
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? null, [controller])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
