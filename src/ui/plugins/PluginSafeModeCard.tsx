export interface PluginSafeModeCardProps {
  readonly enabled: boolean
  readonly recommended: boolean
  readonly recommendationReason?: string | null
  readonly installedPluginCount: number
  readonly busy?: boolean
  readonly error?: string | null
  readonly onChange: (enabled: boolean) => void
}

export default function PluginSafeModeCard({
  enabled,
  recommended,
  recommendationReason = null,
  installedPluginCount,
  busy = false,
  error = null,
  onChange,
}: PluginSafeModeCardProps) {
  return (
    <section
      className="plugin-safe-mode-card plugin-surface"
      aria-labelledby="plugin-safe-mode-heading"
    >
      <div className="plugin-safe-mode-copy">
        <span className="plugin-eyebrow">Startup protection</span>
        <h2 id="plugin-safe-mode-heading">Plugin safe mode</h2>
        <p>
          Open the editor without registering or starting third-party packages.
          Built-in effects still work, and plugin effect records remain available
          to bypass, reorder, remove, save, and recover.
        </p>
      </div>
      <label className="plugin-safe-mode-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || installedPluginCount === 0}
          aria-describedby="plugin-safe-mode-detail"
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <strong>Open this editor session in safe mode</strong>
          <small id="plugin-safe-mode-detail">
            {installedPluginCount === 0
              ? 'No third-party plugins are installed.'
              : `${installedPluginCount} installed plugin${installedPluginCount === 1 ? '' : 's'} will stay inactive for this session.`}
          </small>
        </span>
      </label>
      {recommended ? (
        <div className="plugin-callout" data-tone="warning" role="alert">
          <strong>Safe mode recommended</strong>
          <p>
            {recommendationReason
              ?? 'A previous plugin activation did not finish cleanly. Safe mode lets the project open before any retry.'}
          </p>
        </div>
      ) : null}
      <div className="plugin-operation-status" role="status" aria-live="polite" aria-atomic="true">
        {busy ? 'Updating the startup choice…' : enabled ? 'Safe mode selected for this editor session.' : ''}
      </div>
      {error ? <p className="plugin-error" role="alert">{error}</p> : null}
    </section>
  )
}
