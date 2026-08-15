import { useId } from 'react'
import { pluginEffectStatusLabel } from './pluginUiCopy'
import type { PluginEffectIssueView } from './pluginUiTypes'

export interface PluginInspectorStatusProps {
  readonly effect: PluginEffectIssueView
  readonly busy?: boolean
  readonly error?: string | null
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onManagePlugin: (pluginId: string) => void
}

export default function PluginInspectorStatus({
  effect,
  busy = false,
  error = null,
  onRetryPlugin,
  onDisablePlugin,
  onManagePlugin,
}: PluginInspectorStatusProps) {
  const headingId = useId()
  const canRetry = effect.status === 'failed' || effect.status === 'incompatible'
  const canDisable = effect.status !== 'disabled'
    && effect.status !== 'safe-mode'
    && effect.status !== 'revoked'

  return (
    <section
      className="plugin-inspector-status"
      aria-labelledby={headingId}
    >
      <div className="plugin-package-heading">
        <div>
          <span className="plugin-eyebrow">Plugin effect</span>
          <h3 id={headingId}>{effect.effectLabel}</h3>
          <p>{effect.pluginName}</p>
        </div>
        <span className="plugin-status" data-status={effect.status}>
          {pluginEffectStatusLabel(effect.status)}
        </span>
      </div>
      <p>{effect.reason}</p>
      <p className="plugin-help-copy">
        {effect.status === 'ready'
          ? 'Preview is using this effect. Export creates and checks a separate fresh plugin instance.'
          : effect.blocksExport
            ? 'The descriptor is preserved and preview is bypassed. Export remains blocked until this is fixed or explicitly reviewed for bypass.'
            : 'The descriptor is preserved and remains editable, reorderable, removable, and saveable.'}
      </p>
      <div className="plugin-card-actions" aria-label={`${effect.effectLabel} plugin actions`}>
        {canRetry ? (
          <button type="button" disabled={busy} onClick={() => onRetryPlugin(effect.pluginId)}>Retry</button>
        ) : null}
        {canDisable ? (
          <button type="button" disabled={busy} onClick={() => onDisablePlugin(effect.pluginId)}>Disable plugin</button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => onManagePlugin(effect.pluginId)}>Manage plugin</button>
      </div>
      <div className="plugin-operation-status" role="status" aria-live="polite" aria-atomic="true">
        {busy ? `Updating ${effect.pluginName}…` : ''}
      </div>
      {error ? <p className="plugin-error" role="alert">{error}</p> : null}
    </section>
  )
}
