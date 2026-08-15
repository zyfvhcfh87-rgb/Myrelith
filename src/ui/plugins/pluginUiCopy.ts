import type { PluginEffectStatus } from './pluginUiTypes'

export function pluginEffectStatusLabel(status: PluginEffectStatus): string {
  switch (status) {
    case 'ready': return 'Ready'
    case 'disabled': return 'Disabled'
    case 'missing': return 'Package missing'
    case 'incompatible': return 'Incompatible'
    case 'failed': return 'Failed'
    case 'revoked': return 'Revoked'
    case 'untrusted': return 'Trust required'
    case 'safe-mode': return 'Safe mode'
  }
}
