import { useState } from 'react'
import PluginActionButton from './PluginActionButton'
import PluginDiagnostics from './PluginDiagnostics'
import type { InstalledPluginView, PluginPackageStatus } from './pluginUiTypes'

export type PluginManagerPhase = 'loading' | 'ready' | 'error'

export interface PluginManagerPanelProps {
  readonly phase: PluginManagerPhase
  readonly packages: readonly InstalledPluginView[]
  readonly error?: string | null
  readonly onInspectPackage: () => void
  readonly onRetryLoad?: () => void
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onEnablePlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onUninstallPlugin: (pluginId: string) => void
  readonly onClearDiagnostics: (pluginId: string) => void
}

function statusLabel(status: PluginPackageStatus): string {
  switch (status) {
    case 'ready': return 'Ready'
    case 'disabled': return 'Disabled'
    case 'incompatible': return 'Incompatible'
    case 'failed': return 'Failed'
    case 'revoked': return 'Revoked'
    case 'untrusted': return 'Trust required'
    case 'quarantined': return 'Quarantined'
    case 'safe-mode': return 'Safe mode'
  }
}

function PluginCard({
  plugin,
  pendingUninstall,
  setPendingUninstall,
  onRetryPlugin,
  onEnablePlugin,
  onDisablePlugin,
  onUninstallPlugin,
  onClearDiagnostics,
}: {
  readonly plugin: InstalledPluginView
  readonly pendingUninstall: boolean
  readonly setPendingUninstall: (pluginId: string | null) => void
  readonly onRetryPlugin: (pluginId: string) => void
  readonly onEnablePlugin: (pluginId: string) => void
  readonly onDisablePlugin: (pluginId: string) => void
  readonly onUninstallPlugin: (pluginId: string) => void
  readonly onClearDiagnostics: (pluginId: string) => void
}) {
  const { actions } = plugin
  const uninstallConfirmationId = `plugin-uninstall-${plugin.id}`

  return (
    <li className="plugin-package-card" data-status={plugin.status}>
      <div className="plugin-package-heading">
        <div>
          <h3>{plugin.name}</h3>
          <p><code>{plugin.id}</code> · version {plugin.version}</p>
        </div>
        <span className="plugin-status" data-status={plugin.status}>
          {statusLabel(plugin.status)}
        </span>
      </div>
      <p className="plugin-package-detail">{plugin.statusDetail}</p>

      <dl className="plugin-compact-facts">
        <div><dt>Signer</dt><dd><code>{plugin.signerFingerprint}</code></dd></div>
        <div><dt>Digest</dt><dd><code>{plugin.packageDigest}</code></dd></div>
        <div>
          <dt>Frame access</dt>
          <dd>{plugin.permissionNames.length === 0 ? 'No grants' : plugin.permissionNames.join(', ')}</dd>
        </div>
        <div>
          <dt>Effects</dt>
          <dd>{plugin.contributionNames.length === 0 ? 'None' : plugin.contributionNames.join(', ')}</dd>
        </div>
      </dl>

      <div className="plugin-card-actions" aria-label={`${plugin.name} actions`}>
        <PluginActionButton
          action={actions.retry}
          label="Retry"
          pendingLabel={`Retrying ${plugin.name}…`}
          onAction={() => onRetryPlugin(plugin.id)}
        />
        <PluginActionButton
          action={actions.enable}
          label="Enable"
          pendingLabel={`Enabling ${plugin.name}…`}
          onAction={() => onEnablePlugin(plugin.id)}
        />
        <PluginActionButton
          action={actions.disable}
          label="Disable"
          pendingLabel={`Disabling ${plugin.name}…`}
          onAction={() => onDisablePlugin(plugin.id)}
        />
        <PluginActionButton
          action={actions.uninstall}
          label="Review uninstall"
          pendingLabel={`Uninstalling ${plugin.name}…`}
          className="plugin-button-danger-quiet"
          ariaExpanded={pendingUninstall}
          ariaControls={uninstallConfirmationId}
          onAction={() => setPendingUninstall(pendingUninstall ? null : plugin.id)}
        />
      </div>

      {pendingUninstall && actions.uninstall.available ? (
        <section
          id={uninstallConfirmationId}
          className="plugin-inline-confirmation"
          aria-label={`Confirm uninstall of ${plugin.name}`}
        >
          <strong>Uninstall {plugin.name}?</strong>
          <p>
            This removes its local package and grants. Project effect records stay
            preserved and bypassed, so opening and saving remain available.
          </p>
          <div>
            <button
              type="button"
              disabled={actions.uninstall.pending}
              onClick={() => setPendingUninstall(null)}
            >
              Keep plugin
            </button>
            <button
              type="button"
              className="plugin-button-danger"
              disabled={actions.uninstall.pending || Boolean(actions.uninstall.disabledReason)}
              onClick={() => onUninstallPlugin(plugin.id)}
            >
              {actions.uninstall.pending ? 'Uninstalling…' : 'Confirm uninstall'}
            </button>
          </div>
        </section>
      ) : null}

      <details className="plugin-diagnostics-disclosure">
        <summary>Diagnostics ({plugin.diagnostics.length})</summary>
        <PluginDiagnostics diagnostics={plugin.diagnostics} label={`${plugin.name} diagnostics`} />
        <div>
          <PluginActionButton
            action={actions.clearDiagnostics}
            label="Clear diagnostics"
            pendingLabel={`Clearing ${plugin.name} diagnostics…`}
            className="plugin-clear-diagnostics"
            onAction={() => onClearDiagnostics(plugin.id)}
          />
        </div>
      </details>
    </li>
  )
}

export default function PluginManagerPanel({
  phase,
  packages,
  error = null,
  onInspectPackage,
  onRetryLoad,
  onRetryPlugin,
  onEnablePlugin,
  onDisablePlugin,
  onUninstallPlugin,
  onClearDiagnostics,
}: PluginManagerPanelProps) {
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null)

  return (
    <section className="plugin-manager plugin-surface" aria-labelledby="plugin-manager-heading">
      <header className="plugin-surface-header">
        <div>
          <span className="plugin-eyebrow">Local and offline</span>
          <h2 id="plugin-manager-heading">Plugins</h2>
          <p>Packages stay on this browser profile. Projects never carry plugin code or permission grants.</p>
        </div>
        <button
          type="button"
          className="plugin-button-primary"
          disabled={phase !== 'ready'}
          onClick={onInspectPackage}
        >
          Inspect package…
        </button>
      </header>

      {phase === 'loading' ? (
        <p className="plugin-progress" role="status" aria-live="polite" aria-busy="true">
          <span className="plugin-spinner" aria-hidden="true" />
          Reading the local plugin registry…
        </p>
      ) : null}

      {phase === 'error' ? (
        <div className="plugin-state-card" role="alert">
          <strong>Plugins are unavailable</strong>
          <p>{error ?? 'The local plugin registry could not be read. No package was activated.'}</p>
          {onRetryLoad ? <button type="button" onClick={onRetryLoad}>Try again</button> : null}
        </div>
      ) : null}

      {phase === 'ready' && packages.length === 0 ? (
        <div className="plugin-state-card plugin-empty-state">
          <strong>No plugins installed</strong>
          <p>Inspect a signed local <code>.myrelith-plugin</code> package to review its identity and frame access.</p>
        </div>
      ) : null}

      {phase === 'ready' && packages.length > 0 ? (
        <ul className="plugin-package-list" aria-label="Installed plugins">
          {packages.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              pendingUninstall={pendingUninstallId === plugin.id}
              setPendingUninstall={setPendingUninstallId}
              onRetryPlugin={onRetryPlugin}
              onEnablePlugin={onEnablePlugin}
              onDisablePlugin={onDisablePlugin}
              onUninstallPlugin={onUninstallPlugin}
              onClearDiagnostics={onClearDiagnostics}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
