import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  PluginAppController,
  PluginAppSnapshot,
} from '../../app/pluginAppController'
import type { PluginAppEditorSnapshot } from '../../app/pluginEditorController'

export interface PluginManagerState {
  readonly open: boolean
  readonly selectedPluginId: string | null
  openManager(pluginId?: string | null): void
  closeManager(): void
}

interface PluginUiContextValue {
  readonly controller: PluginAppController
  readonly manager: PluginManagerState
}

const PluginUiContext = createContext<PluginUiContextValue | null>(null)

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
