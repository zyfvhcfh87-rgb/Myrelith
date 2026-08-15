import type { PluginDiagnosticView } from './pluginUiTypes'

interface PluginDiagnosticsProps {
  readonly diagnostics: readonly PluginDiagnosticView[]
  readonly label?: string
}

export default function PluginDiagnostics({
  diagnostics,
  label = 'Recent diagnostics',
}: PluginDiagnosticsProps) {
  const visibleDiagnostics = diagnostics.slice(-100)
  return (
    <section className="plugin-diagnostics" aria-label={label}>
      <div className="plugin-section-heading">
        <h3>{label}</h3>
        <span>{visibleDiagnostics.length}</span>
      </div>
      {visibleDiagnostics.length === 0 ? (
        <p className="plugin-empty-copy">No diagnostics recorded for this plugin.</p>
      ) : (
        <ol className="plugin-diagnostic-list">
          {visibleDiagnostics.map((diagnostic) => (
            <li key={diagnostic.id} data-level={diagnostic.level}>
              <div className="plugin-diagnostic-meta">
                <code>{diagnostic.code}</code>
                <time>{diagnostic.occurredAtLabel}</time>
              </div>
              <p>{diagnostic.message.slice(0, 512)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
