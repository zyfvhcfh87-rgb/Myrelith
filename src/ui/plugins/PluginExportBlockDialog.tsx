import { useState } from 'react'
import PluginDialogFrame from './PluginDialogFrame'
import type { PluginEffectIssueView } from './pluginUiTypes'

export interface PluginExportBlockDialogProps {
  readonly issues: readonly PluginEffectIssueView[]
  readonly busy?: boolean
  readonly error?: string | null
  readonly onCancel: () => void
  readonly onRetry?: () => void
  readonly onExportBypassed: (effectInstanceIds: readonly string[]) => void
}

function BlockingIssueList({ issues }: { readonly issues: readonly PluginEffectIssueView[] }) {
  return (
    <ol className="plugin-export-issue-list" aria-label="Plugin effects missing from export">
      {issues.map((issue) => (
        <li key={issue.effectInstanceId}>
          <div>
            <strong>{issue.effectLabel}</strong>
            <span>{issue.pluginName}</span>
          </div>
          <p>{issue.reason}</p>
        </li>
      ))}
    </ol>
  )
}

function PluginExportBlockDialogBody({
  issues,
  busy = false,
  error = null,
  onCancel,
  onRetry,
  onExportBypassed,
}: PluginExportBlockDialogProps) {
  const [reviewingBypass, setReviewingBypass] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const exportBypassed = (): void => {
    if (!confirmed || busy) return
    onExportBypassed(issues.map((issue) => issue.effectInstanceId))
  }

  if (reviewingBypass) {
    return (
      <PluginDialogFrame
        key="confirm-bypass"
        eyebrow="Second confirmation"
        title="Export without these plugin effects?"
        description="The exported file will visibly differ from the project preview and authored effect stack. Review every listed instance before continuing."
        busy={busy}
        dismissDisabled={busy}
        onDismiss={onCancel}
        actions={(
          <>
            <button
              type="button"
              className="plugin-button-secondary"
              data-plugin-dialog-initial-focus
              disabled={busy}
              onClick={() => {
                setConfirmed(false)
                setReviewingBypass(false)
              }}
            >
              Back to blocked effects
            </button>
            <button
              type="button"
              className="plugin-button-danger"
              disabled={!confirmed || busy}
              aria-describedby="plugin-export-bypass-requirement"
              onClick={exportBypassed}
            >
              {busy ? 'Starting reviewed export…' : 'Export with listed plugins bypassed'}
            </button>
          </>
        )}
      >
        <BlockingIssueList issues={issues} />
        <label className="plugin-bypass-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            <strong>I understand these exact effects will be omitted</strong>
            <small>The project data is unchanged. This decision applies only to this export attempt.</small>
          </span>
        </label>
        <p id="plugin-export-bypass-requirement" className="plugin-help-copy" role="status" aria-live="polite">
          {confirmed
            ? 'Reviewed bypass confirmed for the listed effect instances.'
            : 'Confirm that the listed effects may be omitted from this export.'}
        </p>
        {error ? <p className="plugin-error" role="alert">{error}</p> : null}
      </PluginDialogFrame>
    )
  }

  return (
    <PluginDialogFrame
      key="blocked"
      eyebrow="Export preflight"
      title="Plugin effects block export"
      description="Myrelith did not acquire an output file or start an encoder. Fix the listed effects, or explicitly review a one-time bypass."
      busy={busy}
      dismissDisabled={busy}
      onDismiss={onCancel}
      actions={(
        <>
          <button
            type="button"
            className="plugin-button-primary"
            data-plugin-dialog-initial-focus
            disabled={busy}
            onClick={onCancel}
          >
            Back to editor
          </button>
          {onRetry ? (
            <button type="button" className="plugin-button-secondary" disabled={busy} onClick={onRetry}>
              Retry checks
            </button>
          ) : null}
          <button
            type="button"
            className="plugin-button-danger-quiet"
            disabled={busy}
            onClick={() => setReviewingBypass(true)}
          >
            Review bypass…
          </button>
        </>
      )}
    >
      <div className="plugin-callout" data-tone="danger">
        <strong>No silent export fallback</strong>
        <p>Each unavailable effect is preserved. Export stays blocked unless you fix it or confirm the exact omissions below.</p>
      </div>
      <BlockingIssueList issues={issues} />
      {error ? <p className="plugin-error" role="alert">{error}</p> : null}
    </PluginDialogFrame>
  )
}

export default function PluginExportBlockDialog(props: PluginExportBlockDialogProps) {
  const blockingIssues = props.issues.filter((issue) => issue.blocksExport)
  if (blockingIssues.length === 0) return null
  const issueKey = blockingIssues
    .map((issue) => `${issue.effectInstanceId}:${issue.status}:${issue.reason}`)
    .join('|')
  return <PluginExportBlockDialogBody key={issueKey} {...props} issues={blockingIssues} />
}
