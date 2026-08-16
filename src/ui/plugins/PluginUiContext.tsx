import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { PluginAppController } from '../../app/pluginAppController'
import { PluginUiContext, type PluginManagerState, type PluginUiContextValue } from './pluginUiContextValue'

export type { PluginManagerState } from './pluginUiContextValue'

export interface PluginUiProviderProps {
  readonly controller: PluginAppController
  readonly children: ReactNode
}

export function PluginUiProvider({ controller, children }: PluginUiProviderProps) {
  const [managerOpen, setManagerOpen] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const openManager = useCallback((pluginId: string | null = null): void => {
    setSelectedPluginId(pluginId)
    setManagerOpen(true)
  }, [])
  const closeManager = useCallback((): void => {
    setManagerOpen(false)
    setSelectedPluginId(null)
  }, [])
  const manager = useMemo<PluginManagerState>(() => ({
    open: managerOpen,
    selectedPluginId,
    openManager,
    closeManager,
  }), [closeManager, managerOpen, openManager, selectedPluginId])
  const value = useMemo<PluginUiContextValue>(
    () => ({ controller, manager }),
    [controller, manager],
  )
  return <PluginUiContext.Provider value={value}>{children}</PluginUiContext.Provider>
}
