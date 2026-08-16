import { createContext } from 'react'
import type { PluginAppController } from '../../app/pluginAppController'

export interface PluginManagerState {
  readonly open: boolean
  readonly selectedPluginId: string | null
  openManager(pluginId?: string | null): void
  closeManager(): void
}

export interface PluginUiContextValue {
  readonly controller: PluginAppController
  readonly manager: PluginManagerState
}

export const PluginUiContext = createContext<PluginUiContextValue | null>(null)
