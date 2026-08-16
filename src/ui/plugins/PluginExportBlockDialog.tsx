import { useId, useState, type ReactNode } from 'react'
import PluginDialogFrame from './PluginDialogFrame'
import { boundedPluginUiText } from './pluginUiCopy'
import type { PluginEffectIssueView } from './pluginUiTypes'

export interface PluginExportBlockDialogProps {
  readonly issues: readonly PluginEffectIssueView[]
  readonly reviewToken: string
  readonly documentRevision: string
  readonly busy?: boolean
  readonly error?: string | null
  readonly onCancel: () => void
  readonly onRetry?: () => void
  readonly onExportBypassed: (reviewToken: string) => void
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
          <dl className="plugin-export-package-identity">
            <div><dt>Plugin ID</dt><dd><code>{issue.pluginId}</code></dd></div>
            <div><dt>Package version</dt><dd>{issue.pluginVersion}</dd></div>
            <div><dt>Package digest</dt><dd><code>{issue.packageDigest}</code></dd></div>
            <div><dt>Block reason</dt><dd>{issue.reason}</dd></div>
          </dl>
        </li>
      ))}
    </ol>
  )
}

interface ExportReviewSurfaceProps {
  readonly inline: boolean
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly busy: boolean
  readonly dismissDisabled: boolean
  readonly onDismiss: () => void
  readonly children: ReactNode
  readonly actions: ReactNode
}

function ExportReviewSurface({
  inline,
  eyebrow,
  title,
  description,
  busy,
  dismissDisabled,
  onDismiss,
  children,
  actions,
}: ExportReviewSurfaceProps) {
  const titleId = useId()
  const descriptionId = useId()

  if (!inline) {
    return (
      <PluginDialogFrame
        eyebrow={eyebrow}
        title={title}
        description={description}
        busy={busy}
        dismissDisabled={dismissDisabled}
        onDismiss={onDismiss}
        actions={actions}
      >
        {children}
      </PluginDialogFrame>
    )
  }

  return (
    <section
      className="plugin-export-inline"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
    >
      <header className="plugin-export-inline-header">
        <span className="plugin-eyebrow">{eyebrow}</span>
        <h3 id={titleId}>{title}</h3>
        <p id={descriptionId}>{description}</p>
      </header>
      <div className="plugin-export-inline-body">{children}</div>
      <footer className="plugin-export-inline-actions">{actions}</footer>
    </section>
  )
}

function PluginExportBlockReview({
  issues,
  reviewToken,
  busy = false,
  error = null,
  onCancel,
  onRetry,
  onExportBypassed,
  inline,
}: PluginExportBlockDialogProps & { readonly inline: boolean }) {
  const [reviewingBypass, setReviewingBypass] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const bypassRequirementId = useId()

  const exportBypassed = (): void => {
    if (!confirmed || busy) return
    onExportBypassed(reviewToken)
  }

  if (reviewingBypass) {
    return (
      <ExportReviewSurface
        key="confirm-bypass"
        inline={inline}
        eyebrow="Second confirmation"
        title="Export without these plugin effects?"
        description="The exported file will visibly differ from the project preview and authored effect stack. Review every exact package and effect instance before continuing."
        busy={busy}
        dismissDisabled={busy}
        onDismiss={onCancel}
        actions={(
          <>
            <button
              type="button"
              className="plugin-button-secondary"
              data-plugin-dialog-initial-focus={!inline || undefined}
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
              aria-describedby={bypassRequirementId}
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
            <strong>I understand these exact effects and packages will be omitted</strong>
            <small>The project data is unchanged. This app-reviewed decision applies only to the current document snapshot and export attempt.</small>
          </span>
        </label>
        <p id={bypassRequirementId} className="plugin-help-copy" role="status" aria-live="polite" aria-atomic="true">
          {confirmed
            ? 'Reviewed bypass confirmed for the listed effect instances and exact package digests.'
            : 'Confirm that the listed effects from these exact packages may be omitted from this export.'}
        </p>
        {error ? <p className="plugin-error" role="alert">{boundedPluginUiText(error)}</p> : null}
      </ExportReviewSurface>
    )
  }

  return (
    <ExportReviewSurface
      key="blocked"
      inline={inline}
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
            data-plugin-dialog-initial-focus={!inline || undefined}
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
        <p>Each unavailable effect is preserved. Export stays blocked unless you fix it or confirm the exact package-backed omissions below.</p>
      </div>
      <BlockingIssueList issues={issues} />
      {error ? <p className="plugin-error" role="alert">{boundedPluginUiText(error)}</p> : null}
    </ExportReviewSurface>
  )
}

function reviewKey(
  props: PluginExportBlockDialogProps,
  issues: readonly PluginEffectIssueView[],
): string {
  return JSON.stringify([
    props.reviewToken,
    props.documentRevision,
    issues.map((issue) => [
      issue.effectInstanceId,
      issue.pluginId,
      issue.pluginVersion,
      issue.packageDigest,
      issue.status,
      issue.reason,
    ]),
  ])
}

function PluginExportBlockSurface({
  inline,
  ...props
}: PluginExportBlockDialogProps & { readonly inline: boolean }) {
  const blockingIssues = props.issues.filter((issue) => issue.blocksExport)
  if (blockingIssues.length === 0) return null
  return (
    <PluginExportBlockReview
      key={reviewKey(props, blockingIssues)}
      {...props}
      issues={blockingIssues}
      inline={inline}
    />
  )
}

export function PluginExportBlockBody(props: PluginExportBlockDialogProps) {
  return <PluginExportBlockSurface {...props} inline />
}

export default function PluginExportBlockDialog(props: PluginExportBlockDialogProps) {
  return <PluginExportBlockSurface {...props} inline={false} />
}
