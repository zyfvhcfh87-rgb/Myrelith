import { useId } from 'react'
import PluginActionButton from './PluginActionButton'
import { pluginEffectStatusLabel } from './pluginUiCopy'
import type {
  PluginEffectIssueView,
  PluginRecoveryActionsView,
} from './pluginUiTypes'

export interface PluginInspectorStatusProps {
  readonly effect: PluginEffectIssueView
  readonly actions: PluginRecoveryActionsView
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onManagePlugin: (pluginId: string) => void
}

export default function PluginInspectorStatus({
  effect,
  actions,
  onRetryPlugin,
  onDisablePlugin,
  onManagePlugin,
}: PluginInspectorStatusProps) {
  const headingId = useId()

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
        <PluginActionButton
          action={actions.retry}
          label="Retry"
          pendingLabel={`Retrying ${effect.pluginName}…`}
          onAction={() => onRetryPlugin(effect.pluginId)}
        />
        <PluginActionButton
          action={actions.disable}
          label="Disable plugin"
          pendingLabel={`Disabling ${effect.pluginName}…`}
          onAction={() => onDisablePlugin(effect.pluginId)}
        />
        <PluginActionButton
          action={actions.manage}
          label="Manage plugin"
          pendingLabel={`Opening ${effect.pluginName} management…`}
          onAction={() => onManagePlugin(effect.pluginId)}
        />
      </div>
    </section>
  )
}
