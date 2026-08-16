import { useId } from 'react'
import PluginActionButton from './PluginActionButton'
import { pluginEffectStatusLabel } from './pluginUiCopy'
import type { PluginContributionView } from './pluginUiTypes'

export interface PluginContributionPickerProps {
  readonly contributions: readonly PluginContributionView[]
  readonly onSelectContribution: (effectType: string) => void
}

export default function PluginContributionPicker({
  contributions,
  onSelectContribution,
}: PluginContributionPickerProps) {
  const headingId = useId()

  return (
    <section
      className="plugin-contribution-picker plugin-surface"
      aria-labelledby={headingId}
    >
      <header className="plugin-surface-header">
        <div>
          <span className="plugin-eyebrow">Installed video effects</span>
          <h2 id={headingId}>Add a plugin effect</h2>
          <p>Selecting an effect returns its stable type to the editor. Myrelith applies the app-owned defaults and document mutation.</p>
        </div>
      </header>

      {contributions.length === 0 ? (
        <div className="plugin-state-card plugin-empty-state">
          <strong>No plugin effects available</strong>
          <p>Install a compatible local plugin package to add its video effects.</p>
        </div>
      ) : (
        <ul className="plugin-contribution-list" aria-label="Installed plugin video effects">
          {contributions.map((contribution) => (
            <li
              key={contribution.effectType}
              className="plugin-contribution-card"
              data-status={contribution.status}
            >
              <div className="plugin-contribution-copy">
                <div className="plugin-package-heading">
                  <div>
                    <h3>{contribution.contributionName}</h3>
                    <p>{contribution.pluginName} · version {contribution.pluginVersion}</p>
                  </div>
                  <span className="plugin-status" data-status={contribution.status}>
                    {pluginEffectStatusLabel(contribution.status)}
                  </span>
                </div>
                <p>{contribution.detail}</p>
                <code>{contribution.effectType}</code>
              </div>
              <PluginActionButton
                action={contribution.selectAction}
                label="Add effect"
                pendingLabel={`Adding ${contribution.contributionName}…`}
                ariaLabel={`Add ${contribution.contributionName}`}
                className="plugin-button-secondary"
                onAction={() => onSelectContribution(contribution.effectType)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
