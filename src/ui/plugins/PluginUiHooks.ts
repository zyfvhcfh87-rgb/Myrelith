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
  const { controller } = usePluginUi()
  const subscribe = useCallback(
    (notify: () => void) => controller.subscribe(() => notify()),
    [controller],
  )
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
