import { pluginEffectStatusLabel } from './pluginUiCopy'
import type { PluginEffectIssueView } from './pluginUiTypes'

export interface PluginPreviewNoticeProps {
  readonly issues: readonly PluginEffectIssueView[]
  readonly busyPluginIds?: readonly string[]
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onManagePlugins: () => void
}

export default function PluginPreviewNotice({
  issues,
  busyPluginIds = [],
  onRetryPlugin,
  onDisablePlugin,
  onManagePlugins,
}: PluginPreviewNoticeProps) {
  if (issues.length === 0) return null
  const busy = new Set(busyPluginIds)
  const blockingCount = issues.filter((issue) => issue.blocksExport).length

  return (
    <aside
      className="plugin-preview-notice"
      aria-labelledby="plugin-preview-heading"
      aria-live="polite"
    >
      <div className="plugin-preview-heading">
        <div>
          <span className="plugin-eyebrow">Preview bypass</span>
          <h2 id="plugin-preview-heading">
            {issues.length} plugin effect{issues.length === 1 ? '' : 's'} unavailable
          </h2>
        </div>
        <button type="button" onClick={onManagePlugins}>Manage plugins</button>
      </div>
      <p>
        Preview continues with the listed effects visibly bypassed.
        {blockingCount > 0
          ? ` ${blockingCount} ${blockingCount === 1 ? 'effect blocks' : 'effects block'} export until fixed or explicitly reviewed for bypass.`
          : ''}
      </p>
      <ul className="plugin-preview-issue-list">
        {issues.map((issue) => {
          const pluginBusy = busy.has(issue.pluginId)
          return (
            <li key={issue.effectInstanceId}>
              <div>
                <strong>{issue.effectLabel}</strong>
                <span>{issue.pluginName} · {pluginEffectStatusLabel(issue.status)}</span>
                <p>{issue.reason}</p>
              </div>
              <div className="plugin-card-actions" aria-label={`${issue.effectLabel} recovery actions`}>
                {(issue.status === 'failed' || issue.status === 'incompatible') ? (
                  <button
                    type="button"
                    disabled={pluginBusy}
                    aria-label={`Retry ${issue.pluginName}`}
                    onClick={() => onRetryPlugin(issue.pluginId)}
                  >
                    Retry
                  </button>
                ) : null}
                {issue.status !== 'disabled' && issue.status !== 'safe-mode' ? (
                  <button
                    type="button"
                    disabled={pluginBusy}
                    aria-label={`Disable ${issue.pluginName}`}
                    onClick={() => onDisablePlugin(issue.pluginId)}
                  >
                    Disable plugin
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
