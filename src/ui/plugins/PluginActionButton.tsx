import { useId } from 'react'
import { boundedPluginUiText } from './pluginUiCopy'
import type { PluginActionView } from './pluginUiTypes'

export interface PluginActionButtonProps {
  readonly action: PluginActionView
  readonly label: string
  readonly pendingLabel: string
  readonly className?: string
  readonly ariaLabel?: string
  readonly ariaExpanded?: boolean
  readonly ariaControls?: string
  readonly onAction: () => void
}

export default function PluginActionButton({
  action,
  label,
  pendingLabel,
  className,
  ariaLabel,
  ariaExpanded,
  ariaControls,
  onAction,
}: PluginActionButtonProps) {
  const disabledReasonId = useId()
  if (!action.available) return null

  const disabledReason = action.disabledReason
    ? boundedPluginUiText(action.disabledReason)
    : null
  const error = action.error ? boundedPluginUiText(action.error) : null
  const disabled = action.pending || disabledReason !== null

  return (
    <div className="plugin-projected-action">
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-describedby={disabledReason ? disabledReasonId : undefined}
        onClick={onAction}
      >
        {action.pending ? pendingLabel : label}
      </button>
      {disabledReason ? (
        <small id={disabledReasonId} className="plugin-action-disabled-reason">
          {disabledReason}
        </small>
      ) : null}
      {action.pending ? (
        <span
          className="plugin-action-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {pendingLabel}
        </span>
      ) : null}
      {error ? <small className="plugin-action-error" role="alert">{error}</small> : null}
    </div>
  )
}
