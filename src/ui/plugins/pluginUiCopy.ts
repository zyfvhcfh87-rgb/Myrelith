import type { PluginEffectStatus } from './pluginUiTypes'

const MAX_PLUGIN_UI_TEXT_LENGTH = 512

export function boundedPluginUiText(value: string): string {
  return value.slice(0, MAX_PLUGIN_UI_TEXT_LENGTH)
}

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
    case 'quarantined': return 'Quarantined'
    case 'version-mismatch': return 'Version mismatch'
    case 'invalid': return 'Invalid descriptor'
    case 'unsupported': return 'Unsupported descriptor'
  }
}
