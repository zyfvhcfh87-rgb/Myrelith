import { boundedPluginUiText } from './pluginUiCopy'

export interface PluginSafeModeCardProps {
  readonly enabled: boolean
  readonly recommended: boolean
  readonly recommendationReason?: string | null
  readonly installedPluginCount: number
  readonly busy?: boolean
  readonly error?: string | null
  readonly onEnterSafeMode: () => void
}

export default function PluginSafeModeCard({
  enabled,
  recommended,
  recommendationReason = null,
  installedPluginCount,
  busy = false,
  error = null,
  onEnterSafeMode,
}: PluginSafeModeCardProps) {
  const unavailable = installedPluginCount === 0
  const actionDisabled = enabled || busy || unavailable
  const actionDescription = unavailable
    ? 'No third-party plugins are installed.'
    : enabled
      ? 'Safe mode is locked for this editor session. Restart the editor or begin a new session without safe mode to leave it.'
      : `${installedPluginCount} installed plugin${installedPluginCount === 1 ? '' : 's'} will stay inactive for this session.`

  return (
    <section
      className="plugin-safe-mode-card"
      aria-labelledby="plugin-safe-mode-heading"
    >
      <div className="plugin-safe-mode-copy">
        <span className="plugin-safe-mode-eyebrow">Startup protection</span>
        <h2 id="plugin-safe-mode-heading">Plugin safe mode</h2>
        <p>
          Open the editor without registering or starting third-party packages.
          Built-in effects still work, and plugin effect records remain available
          to bypass, reorder, remove, save, and recover.
        </p>
      </div>

      <div className="plugin-safe-mode-action">
        <button
          type="button"
          disabled={actionDisabled}
          aria-describedby="plugin-safe-mode-detail"
          onClick={onEnterSafeMode}
        >
          {busy ? 'Entering safe mode…' : enabled ? 'Safe mode active' : 'Enter safe mode'}
        </button>
        <p id="plugin-safe-mode-detail">{actionDescription}</p>
      </div>

      {recommended ? (
        <div className="plugin-safe-mode-callout" data-tone="warning" role="alert">
          <strong>Safe mode recommended</strong>
          <p>
            {recommendationReason
              ? boundedPluginUiText(recommendationReason)
              : 'A previous plugin activation did not finish cleanly. Safe mode lets the project open before any retry.'}
          </p>
        </div>
      ) : null}

      <div
        className="plugin-safe-mode-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {busy ? 'Entering safe mode for this editor session…' : enabled ? 'Safe mode is active and locked for this editor session.' : ''}
      </div>
      {error ? <p className="plugin-safe-mode-error" role="alert">{boundedPluginUiText(error)}</p> : null}
    </section>
  )
}
