import PluginActionButton from './PluginActionButton'
import { pluginEffectStatusLabel } from './pluginUiCopy'
import type {
  PluginActionView,
  PluginPreviewIssueView,
} from './pluginUiTypes'

export interface PluginPreviewNoticeProps {
  readonly issues: readonly PluginPreviewIssueView[]
  readonly manageAction: PluginActionView
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onManagePlugins: () => void
}

export default function PluginPreviewNotice({
  issues,
  manageAction,
  onRetryPlugin,
  onDisablePlugin,
  onManagePlugins,
}: PluginPreviewNoticeProps) {
  if (issues.length === 0) return null
  const blockingCount = issues.filter((issue) => issue.blocksExport).length

  return (
    <aside
      className="plugin-preview-notice"
      aria-labelledby="plugin-preview-heading"
    >
      <div className="plugin-preview-heading">
        <div>
          <span className="plugin-eyebrow">Preview bypass</span>
          <h2 id="plugin-preview-heading">
            {issues.length} plugin effect{issues.length === 1 ? '' : 's'} unavailable
          </h2>
        </div>
        <PluginActionButton
          action={manageAction}
          label="Manage plugins"
          pendingLabel="Opening plugin management…"
          onAction={onManagePlugins}
        />
      </div>
      <p>
        Preview continues with the listed effects visibly bypassed.
        {blockingCount > 0
          ? ` ${blockingCount} ${blockingCount === 1 ? 'effect blocks' : 'effects block'} export until fixed or explicitly reviewed for bypass.`
          : ''}
      </p>
      <p
        className="plugin-preview-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {issues.length} plugin effect{issues.length === 1 ? '' : 's'} bypassed. Export blockers: {blockingCount}.
      </p>
      <ul className="plugin-preview-issue-list">
        {issues.map((issue) => (
          <li key={issue.effectInstanceId}>
            <div>
              <strong>{issue.effectLabel}</strong>
              <span>{issue.pluginName} · {pluginEffectStatusLabel(issue.status)}</span>
              <p>{issue.reason}</p>
            </div>
            <div className="plugin-card-actions" aria-label={`${issue.effectLabel} recovery actions`}>
              <PluginActionButton
                action={issue.actions.retry}
                label="Retry"
                pendingLabel={`Retrying ${issue.pluginName}…`}
                ariaLabel={`Retry ${issue.pluginName}`}
                onAction={() => onRetryPlugin(issue.pluginId)}
              />
              <PluginActionButton
                action={issue.actions.disable}
                label="Disable plugin"
                pendingLabel={`Disabling ${issue.pluginName}…`}
                ariaLabel={`Disable ${issue.pluginName}`}
                onAction={() => onDisablePlugin(issue.pluginId)}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
