import { useId, useState } from 'react'
import PluginDialogFrame from './PluginDialogFrame'
import { boundedPluginUiText } from './pluginUiCopy'
import type {
  PluginInstallDecision,
  PluginPackageReviewView,
  PluginPackageVersionChange,
  PluginPermissionGrantState,
  PluginPermissionView,
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

function versionChangeLabel(
  change: PluginPackageVersionChange,
  installedVersion: string | null,
): string {
  switch (change) {
    case 'new-install': return 'New installation'
    case 'reinstall': return `Reinstall${installedVersion ? ` ${installedVersion}` : ''}`
    case 'update': return `Update${installedVersion ? ` from ${installedVersion}` : ''}`
    case 'downgrade': return `Downgrade${installedVersion ? ` from ${installedVersion}` : ''}`
  }
}

function grantStateLabel(state: PluginPermissionGrantState): string {
  switch (state) {
    case 'previously-granted': return 'Previously granted'
    case 'new': return 'New grant request'
    case 'widened': return 'Widened grant request'
  }
}

function isGrantable(permission: PluginPermissionView): boolean {
  return permission.available && permission.grantable
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
  const isDowngrade = packageView.versionChange === 'downgrade'
  const compatibilityHeadingId = useId()
  const contributionsHeadingId = useId()
  const installRequirementsId = useId()
  const [trustSigner, setTrustSigner] = useState(!requiresTrust)
  const [confirmDowngrade, setConfirmDowngrade] = useState(false)
  const [grants, setGrants] = useState<ReadonlySet<string>>(() => new Set(
    packageView.permissions
      .filter((permission) => (
        permission.grantState === 'previously-granted' && isGrantable(permission)
      ))
      .map((permission) => permission.id),
  ))
  const busy = phase === 'installing' || phase === 'cancelling'
  const packageBlocked = packageView.signatureState !== 'valid'
    || packageView.trustState === 'invalid'
    || packageView.trustState === 'revoked'
    || packageView.compatibilityState === 'incompatible'
  const requiredUnavailable = packageView.permissions.some(
    (permission) => permission.required && !isGrantable(permission),
  )
  const missingRequiredGrant = packageView.permissions.some(
    (permission) => permission.required
      && isGrantable(permission)
      && !grants.has(permission.id),
  )
  const canInstall = !busy
    && !packageBlocked
    && !requiredUnavailable
    && trustSigner
    && !missingRequiredGrant
    && (!isDowngrade || confirmDowngrade)

  const toggleGrant = (permission: PluginPermissionView, granted: boolean): void => {
    if (!isGrantable(permission)) return
    setGrants((current) => {
      const next = new Set(current)
      if (granted) next.add(permission.id)
      else next.delete(permission.id)
      return next
    })
  }

  const install = (): void => {
    if (!canInstall) return
    onInstall({
      trustSigner: requiresTrust,
      grantedPermissionIds: packageView.permissions
        .filter((permission) => isGrantable(permission) && grants.has(permission.id))
        .map((permission) => permission.id),
      confirmDowngrade: isDowngrade && confirmDowngrade,
    })
  }

  return (
    <PluginDialogFrame
      eyebrow="Local plugin package"
      title={`Review ${packageView.name}`}
      description="Myrelith inspected this local package without contacting a server. Review its identity, version change, and requested frame access before installation."
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
        <div><dt>Package version</dt><dd>{packageView.version}</dd></div>
        <div><dt>Installed version</dt><dd>{packageView.installedVersion ?? 'Not installed'}</dd></div>
        <div><dt>Requested change</dt><dd>{versionChangeLabel(packageView.versionChange, packageView.installedVersion)}</dd></div>
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

      {isDowngrade ? (
        <section className="plugin-callout" data-tone="warning">
          <strong>Downgrade requires explicit confirmation</strong>
          <p>
            The installed version is {packageView.installedVersion ?? 'unknown'}; this package is version {packageView.version}.
            Existing project descriptors are preserved, but the older package may be incompatible with them.
          </p>
        </section>
      ) : null}

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
        <legend>Trust and capabilities</legend>
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
        {packageView.permissions.map((permission) => {
          const grantable = isGrantable(permission)
          return (
            <label className="plugin-consent-row" key={permission.id} data-available={permission.available}>
              <input
                type="checkbox"
                checked={grantable && grants.has(permission.id)}
                disabled={!grantable}
                onChange={(event) => toggleGrant(permission, event.target.checked)}
              />
              <span>
                <strong>{permission.name}{permission.required ? ' — required' : ' — optional'}</strong>
                <small>{permission.detail}</small>
                <span className="plugin-capability-meta">
                  <code>{permission.id}@{permission.selectedVersion}</code>
                  <span>{permission.available ? 'Available' : 'Unavailable'}</span>
                  <span>{grantable ? 'Grantable' : 'Not grantable'}</span>
                  <span>{grantStateLabel(permission.grantState)}</span>
                </span>
                {!permission.available && permission.unavailableReason ? (
                  <small className="plugin-capability-unavailable">
                    {boundedPluginUiText(permission.unavailableReason)}
                  </small>
                ) : null}
              </span>
            </label>
          )
        })}
        {isDowngrade ? (
          <label className="plugin-consent-row plugin-downgrade-confirmation">
            <input
              type="checkbox"
              checked={confirmDowngrade}
              onChange={(event) => setConfirmDowngrade(event.target.checked)}
            />
            <span>
              <strong>Install this older package version</strong>
              <small>This confirms only the displayed downgrade from {packageView.installedVersion ?? 'the installed version'} to {packageView.version}.</small>
            </span>
          </label>
        ) : null}
      </fieldset>

      <p className="plugin-help-copy">
        Plugin access stops while the plugin is disabled. Uninstalling removes the local package and grants.
      </p>

      <p id={installRequirementsId} className="plugin-help-copy" role="status" aria-live="polite" aria-atomic="true">
        {packageBlocked
          ? 'Installation is unavailable until signature, trust, and compatibility checks pass.'
          : requiredUnavailable
            ? 'A required capability is unavailable or cannot be granted.'
            : !trustSigner
              ? 'Choose whether to trust this signer for the exact plugin ID.'
              : missingRequiredGrant
                ? 'Grant every required capability to enable installation, or cancel to keep the package unchanged.'
                : isDowngrade && !confirmDowngrade
                  ? 'Confirm the exact downgrade before installing this older package.'
                  : 'Ready to install with the displayed trust and capability decisions.'}
      </p>
      {error ? <p className="plugin-error" role="alert">{boundedPluginUiText(error)}</p> : null}
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
        ? 'The inspected package and your local decisions were committed together.'
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
          {boundedPluginUiText(error ?? 'The package could not be inspected. Nothing was installed or changed.')}
        </p>
      ) : null}
    </PluginDialogFrame>
  )
}
