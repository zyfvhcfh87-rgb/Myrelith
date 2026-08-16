import type { ReactNode } from 'react'
import { getPluginAppController } from '../../app/pluginAppController'
import PluginManagerDialog from './PluginManagerDialog'
import PluginStartupSurface from './PluginStartupSurface'
import { PluginUiProvider } from './PluginUiContext'

const pluginAppController = getPluginAppController()

export interface PluginAppRootProps {
  readonly showStartupCard: boolean
  readonly children: ReactNode
}

/** Lazy boundary that keeps plugin management/runtime code out of the launcher entry chunk. */
export default function PluginAppRoot({ showStartupCard, children }: PluginAppRootProps) {
  return (
    <PluginUiProvider controller={pluginAppController}>
      <PluginStartupSurface showCard={showStartupCard}>
        {children}
      </PluginStartupSurface>
      <PluginManagerDialog />
    </PluginUiProvider>
  )
}
