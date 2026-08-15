import { useId, useState } from 'react'
import PluginDialogFrame from './PluginDialogFrame'
import type {
  PluginInstallDecision,
  PluginPackageReviewView,
} from './pluginUiTypes'

export type PluginPackageReviewPhase =
  | 'inspecting'
  | 'review'
  | 'installing'
  | 'cancelling'
  | 'complete'
  | 'error'

export interface PluginPackageReviewDialogProps {
  readonly phase: PluginPackageReviewPhase
  readonly packageView: PluginPackageReviewView | null
  readonly error?: string | null
  readonly onCancel: () => void
  readonly onRetry?: () => void
  readonly onInstall: (decision: PluginInstallDecision) => void
}

function signatureLabel(view: PluginPackageReviewView): string {
  switch (view.signatureState) {
    case 'valid': return 'Signature verified'
    case 'invalid': return 'Invalid signature'
    case 'unsigned': return 'Unsigned package'
    case 'revoked': return 'Revoked signer or package'
  }
}

function trustLabel(view: PluginPackageReviewView): string {
  switch (view.trustState) {
    case 'built-in-trusted': return 'Built-in trusted signer'
    case 'user-trusted': return 'Signer trusted for this plugin ID'
    case 'untrusted': return 'Trust decision required'
    case 'invalid': return 'Signer identity rejected'
    case 'revoked': return 'Signer or package revoked'
  }
}

function PackageDecisionForm({
  phase,
  packageView,
  error,
  onCancel,
  onInstall,
}: Omit<PluginPackageReviewDialogProps, 'onRetry'> & {
  readonly packageView: PluginPackageReviewView
}) {
  const requiresTrust = packageView.trustState === 'untrusted'
  const compatibilityHeadingId = useId()
  const contributionsHeadingId = useId()
  const installRequirementsId = useId()
  const [trustSigner, setTrustSigner] = useState(!requiresTrust)
  const [grants, setGrants] = useState<ReadonlySet<string>>(() => new Set())
  const busy = phase === 'installing' || phase === 'cancelling'
  const packageBlocked = packageView.signatureState !== 'valid'
    || packageView.trustState === 'invalid'
    || packageView.trustState === 'revoked'
    || packageView.compatibilityState === 'incompatible'
  const missingRequiredGrant = packageView.permissions.some(
    (permission) => permission.required && !grants.has(permission.id),
  )
  const canInstall = !busy
    && !packageBlocked
    && trustSigner
    && !missingRequiredGrant

  const toggleGrant = (id: string, granted: boolean): void => {
    setGrants((current) => {
      const next = new Set(current)
      if (granted) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const install = (): void => {
    if (!canInstall) return
    onInstall({
      trustSigner: requiresTrust,
      grantedPermissionIds: packageView.permissions
        .filter((permission) => grants.has(permission.id))
        .map((permission) => permission.id),
    })
  }

  return (
    <PluginDialogFrame
      eyebrow="Local plugin package"
      title={`Review ${packageView.name}`}
      description="Myrelith inspected this local package without contacting a server. Review its identity and requested frame access before installation."
      busy={busy}
      dismissDisabled={phase === 'cancelling'}
      onDismiss={onCancel}
      actions={(
        <>
          <button
            type="button"
            className="plugin-button-secondary"
            data-plugin-dialog-initial-focus
            disabled={phase === 'cancelling'}
            onClick={onCancel}
          >
            {phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </button>
          <button
            type="button"
            className="plugin-button-primary"
            disabled={!canInstall}
            aria-describedby={!canInstall ? installRequirementsId : undefined}
            onClick={install}
          >
            {phase === 'installing' ? 'Installing…' : 'Install plugin'}
          </button>
        </>
      )}
    >
      <dl className="plugin-fact-grid">
        <div><dt>Plugin</dt><dd>{packageView.id}</dd></div>
        <div><dt>Version</dt><dd>{packageView.version}</dd></div>
        <div><dt>Signer fingerprint</dt><dd><code>{packageView.signerFingerprint}</code></dd></div>
        <div><dt>Package digest</dt><dd><code>{packageView.packageDigest}</code></dd></div>
        <div><dt>Memory limit</dt><dd>{packageView.memoryLimitMiB} MiB</dd></div>
        <div><dt>Failure policy</dt><dd>{packageView.failurePolicy}</dd></div>
      </dl>

      <section className="plugin-callout" data-tone={packageView.signatureState === 'valid' ? 'neutral' : 'danger'}>
        <strong>{signatureLabel(packageView)}</strong>
        <p>
          {packageView.signatureState === 'valid'
            ? 'The package bytes match the displayed signer key. A valid signature does not certify the publisher, code quality, privacy, or safety.'
            : 'This package cannot be installed or executed. Its details are shown for inspection only.'}
        </p>
      </section>

      <section className="plugin-review-section" aria-labelledby={compatibilityHeadingId}>
        <div className="plugin-section-heading">
          <h3 id={compatibilityHeadingId}>Compatibility</h3>
          <span className="plugin-status" data-status={packageView.compatibilityState}>
            {packageView.compatibilityState}
          </span>
        </div>
        {packageView.compatibilityReasons.length === 0 ? (
          <p>This package matches the current plugin API and contribution contracts.</p>
        ) : (
          <ul className="plugin-reason-list">
            {packageView.compatibilityReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </section>

      <section className="plugin-review-section" aria-labelledby={contributionsHeadingId}>
        <h3 id={contributionsHeadingId}>Video effects</h3>
        <ul className="plugin-plain-list">
          {packageView.contributionNames.map((name) => <li key={name}>{name}</li>)}
        </ul>
      </section>

      <fieldset className="plugin-consent-fieldset" disabled={busy || packageBlocked}>
        <legend>Trust and permissions</legend>
        <p className="plugin-fieldset-copy">{trustLabel(packageView)}</p>
        {requiresTrust ? (
          <label className="plugin-consent-row">
            <input
              type="checkbox"
              checked={trustSigner}
              onChange={(event) => setTrustSigner(event.target.checked)}
            />
            <span>
              <strong>Trust this signer for {packageView.id}</strong>
              <small>A different plugin ID or signer change requires another decision.</small>
            </span>
          </label>
        ) : null}
        {packageView.permissions.map((permission) => (
          <label className="plugin-consent-row" key={permission.id}>
            <input
              type="checkbox"
              checked={grants.has(permission.id)}
              onChange={(event) => toggleGrant(permission.id, event.target.checked)}
            />
            <span>
              <strong>{permission.name}{permission.required ? ' — required' : ' — optional'}</strong>
              <small>{permission.detail}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <p id={installRequirementsId} className="plugin-help-copy" role="status" aria-live="polite">
        {packageBlocked
          ? 'Installation is unavailable until signature, trust, and compatibility checks pass.'
          : !trustSigner
            ? 'Choose whether to trust this signer for the exact plugin ID.'
            : missingRequiredGrant
              ? 'Grant every required permission to enable installation, or cancel to keep the package uninstalled.'
              : 'Ready to install. Permission grants can be revoked later by disabling or uninstalling the plugin.'}
      </p>
      {error ? <p className="plugin-error" role="alert">{error}</p> : null}
    </PluginDialogFrame>
  )
}

export default function PluginPackageReviewDialog({
  phase,
  packageView,
  error = null,
  onCancel,
  onRetry,
  onInstall,
}: PluginPackageReviewDialogProps) {
  if (packageView && phase !== 'complete') {
    return (
      <PackageDecisionForm
        key={`${packageView.id}:${packageView.packageDigest}`}
        phase={phase}
        packageView={packageView}
        error={error}
        onCancel={onCancel}
        onInstall={onInstall}
      />
    )
  }

  const inspecting = phase === 'inspecting' || phase === 'cancelling'
  const complete = phase === 'complete'
  const title = inspecting
    ? phase === 'cancelling' ? 'Cancelling package inspection…' : 'Inspecting plugin package…'
    : complete ? 'Plugin installed' : 'Could not inspect plugin'

  return (
    <PluginDialogFrame
      eyebrow="Local plugin package"
      title={title}
      description={complete
        ? 'The verified package and your local decisions were committed together.'
        : 'Package inspection runs before installation, trust, permissions, or plugin execution.'}
      busy={inspecting}
      dismissDisabled={phase === 'cancelling'}
      onDismiss={onCancel}
      actions={(
        <>
          {phase === 'error' && onRetry ? (
            <button
              type="button"
              className="plugin-button-secondary"
              onClick={onRetry}
            >
              Try again
            </button>
          ) : null}
          <button
            type="button"
            className="plugin-button-primary"
            data-plugin-dialog-initial-focus
            disabled={phase === 'cancelling'}
            onClick={onCancel}
          >
            {inspecting
              ? phase === 'cancelling' ? 'Cancelling…' : 'Cancel inspection'
              : 'Close'}
          </button>
        </>
      )}
    >
      {inspecting ? (
        <p className="plugin-progress" role="status" aria-live="polite">
          <span className="plugin-spinner" aria-hidden="true" />
          {phase === 'cancelling'
            ? 'Finishing bounded package cleanup.'
            : 'Checking archive limits, canonical metadata, integrity, signature, and compatibility.'}
        </p>
      ) : null}
      {complete ? (
        <p className="plugin-success" role="status">The plugin remains disabled until an effect needs it.</p>
      ) : null}
      {phase === 'error' ? (
        <p className="plugin-error" role="alert">
          {error ?? 'The package could not be inspected. Nothing was installed or changed.'}
        </p>
      ) : null}
    </PluginDialogFrame>
  )
}
