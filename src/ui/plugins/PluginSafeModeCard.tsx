import { useId } from 'react'
import { boundedPluginUiText } from './pluginUiCopy'
import type { PluginActionView, PluginStartupModeView } from './pluginUiTypes'

interface PluginSafeModeCardBaseProps {
  readonly startupReason?: string | null
  readonly installedPluginCount?: number | null
}

interface PluginNormalStartupCardProps extends PluginSafeModeCardBaseProps {
  readonly startupMode: Extract<PluginStartupModeView, 'normal'>
  readonly enterSafeModeAction: PluginActionView
  readonly onEnterSafeMode: () => void
}

interface PluginReviewedStartupCardProps extends PluginSafeModeCardBaseProps {
  readonly startupMode: Extract<PluginStartupModeView, 'review-required'>
  readonly startupReason: string
  readonly enterSafeModeAction: PluginActionView
  readonly continueReviewedNormalAction: PluginActionView
  readonly onEnterSafeMode: () => void
  readonly onContinueReviewedNormal: () => void
}

interface PluginSafeModeActiveCardProps extends PluginSafeModeCardBaseProps {
  readonly startupMode: Extract<PluginStartupModeView, 'safe-mode'>
}

export type PluginSafeModeCardProps =
  | PluginNormalStartupCardProps
  | PluginReviewedStartupCardProps
  | PluginSafeModeActiveCardProps

interface SafeModeActionProps {
  readonly action: PluginActionView
  readonly label: string
  readonly pendingLabel: string
  readonly descriptionId: string
  readonly onAction: () => void
}

function SafeModeAction({
  action,
  label,
  pendingLabel,
  descriptionId,
  onAction,
}: SafeModeActionProps) {
  const disabledReasonId = useId()
  if (!action.available) return null

  const disabledReason = action.disabledReason
    ? boundedPluginUiText(action.disabledReason)
    : null
  const error = action.error ? boundedPluginUiText(action.error) : null
  const disabled = action.pending || disabledReason !== null
  const describedBy = disabledReason
    ? `${descriptionId} ${disabledReasonId}`
    : descriptionId

  return (
    <div className="plugin-safe-mode-action-item">
      <button
        type="button"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={onAction}
      >
        {action.pending ? pendingLabel : label}
      </button>
      {disabledReason ? <p id={disabledReasonId}>{disabledReason}</p> : null}
      {action.pending ? (
        <span className="plugin-safe-mode-status" role="status" aria-live="polite" aria-atomic="true">
          {pendingLabel}
        </span>
      ) : null}
      {error ? <p className="plugin-safe-mode-error" role="alert">{error}</p> : null}
    </div>
  )
}

export default function PluginSafeModeCard(props: PluginSafeModeCardProps) {
  const { startupMode, startupReason = null, installedPluginCount = null } = props
  const safeModeActive = startupMode === 'safe-mode'
  const reviewRequired = startupMode === 'review-required'
  const actionDescription = safeModeActive
    ? 'Safe mode is locked for this editor session. Restart the editor or begin a new session without safe mode to leave it.'
    : reviewRequired
      ? 'Third-party plugins remain blocked until you choose reviewed normal startup or safe mode for this session.'
      : installedPluginCount === null
        ? 'Installed plugins are not enumerated during this protected startup check. Enter safe mode to keep every third-party package inactive.'
        : installedPluginCount === 0
          ? 'No third-party plugins are installed.'
          : `${installedPluginCount} installed plugin${installedPluginCount === 1 ? '' : 's'} will stay inactive if you enter safe mode.`

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

      {props.startupMode === 'review-required' ? (
        <div className="plugin-safe-mode-callout" data-tone="warning" role="alert">
          <strong>Startup review required</strong>
          <p>{boundedPluginUiText(props.startupReason)}</p>
        </div>
      ) : props.startupMode === 'safe-mode' && startupReason ? (
        <div className="plugin-safe-mode-callout" data-tone="warning" role="alert">
          <strong>Safe mode required</strong>
          <p>{boundedPluginUiText(startupReason)}</p>
        </div>
      ) : null}

      <div className="plugin-safe-mode-action">
        {safeModeActive ? (
          <button type="button" disabled aria-describedby="plugin-safe-mode-detail">
            Safe mode active
          </button>
        ) : (
          <>
            <SafeModeAction
              action={props.enterSafeModeAction}
              label="Enter safe mode"
              pendingLabel="Entering safe modeâ€¦"
              descriptionId="plugin-safe-mode-detail"
              onAction={props.onEnterSafeMode}
            />
            {props.startupMode === 'review-required' ? (
              <SafeModeAction
                action={props.continueReviewedNormalAction}
                label="Continue normally after review"
                pendingLabel="Continuing normallyâ€¦"
                descriptionId="plugin-safe-mode-detail"
                onAction={props.onContinueReviewedNormal}
              />
            ) : null}
          </>
        )}
        <p id="plugin-safe-mode-detail">{actionDescription}</p>
      </div>

      <div
        className="plugin-safe-mode-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {safeModeActive
          ? 'Safe mode is active and locked for this editor session.'
          : reviewRequired
            ? 'Choose reviewed normal startup or safe mode before third-party plugins initialize.'
            : ''}
      </div>
    </section>
  )
}
