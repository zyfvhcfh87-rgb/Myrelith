import { useEffect, useRef, useState } from 'react'
import PluginDialogFrame from './PluginDialogFrame'
import PluginManagerPanel, { type PluginManagerPhase } from './PluginManagerPanel'
import PluginPackageReviewDialog, {
  type PluginPackageReviewPhase,
} from './PluginPackageReviewDialog'
import { usePluginAppSnapshot, usePluginUi } from './PluginUiContext'
import type { PluginInstallDecision } from './pluginUiTypes'

function ignored(promise: Promise<unknown>): void {
  void promise.catch(() => {})
}

export default function PluginManagerDialog() {
  const { controller, manager } = usePluginUi()
  const snapshot = usePluginAppSnapshot()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [cancellingInspection, setCancellingInspection] = useState(false)

  useEffect(() => {
    if (!manager.open) return
    ignored(controller.refreshManagement())
  }, [controller, manager.open])

  if (!manager.open) return null

  const inspectionVisible = snapshot.inspectionPhase !== 'idle'
    || snapshot.review !== null
  if (inspectionVisible) {
    const phase: PluginPackageReviewPhase = cancellingInspection
      ? 'cancelling'
      : snapshot.inspectionPhase === 'reading'
        || snapshot.inspectionPhase === 'inspecting'
        ? 'inspecting'
        : snapshot.inspectionPhase === 'review'
          ? 'review'
          : snapshot.inspectionPhase === 'installing'
            ? 'installing'
            : 'error'
    const cancel = (): void => {
      if (cancellingInspection) return
      setCancellingInspection(true)
      void controller.cancelInspection(snapshot.review?.reviewToken).finally(() => {
        setCancellingInspection(false)
      })
    }
    const install = (decision: PluginInstallDecision): void => {
      ignored(controller.installPlugin(decision))
    }
    return (
      <PluginPackageReviewDialog
        phase={phase}
        packageView={snapshot.review}
        error={snapshot.inspectionDetail || null}
        onCancel={cancel}
        onRetry={cancel}
        onInstall={install}
      />
    )
  }

  const phase: PluginManagerPhase = snapshot.managementPhase === 'ready'
    ? 'ready'
    : snapshot.managementPhase === 'error'
      ? 'error'
      : 'loading'
  const closeDisabled = snapshot.action.phase === 'pending'

  return (
    <PluginDialogFrame
      eyebrow="Local and offline"
      title="Manage plugins"
      description="Inspect, install, recover, disable, or remove packages stored only in this browser profile."
      busy={closeDisabled}
      dismissDisabled={closeDisabled}
      onDismiss={manager.closeManager}
      actions={(
        <button
          type="button"
          className="plugin-button-primary"
          disabled={closeDisabled}
          onClick={manager.closeManager}
        >
          Close
        </button>
      )}
    >
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".myrelith-plugin,application/zip"
        aria-label="Choose a plugin package"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) ignored(controller.inspectFile(file))
        }}
      />
      <PluginManagerPanel
        phase={phase}
        packages={snapshot.installedPackages}
        selectedPluginId={manager.selectedPluginId}
        error={snapshot.managementDetail || null}
        onInspectPackage={() => fileInputRef.current?.click()}
        onRetryLoad={() => ignored(controller.refreshManagement())}
        onRetryPlugin={(pluginId) => ignored(controller.retryPlugin(pluginId))}
        onEnablePlugin={(pluginId) => {
          ignored(controller.enablePlugin(pluginId, new AbortController().signal))
        }}
        onDisablePlugin={(pluginId) => ignored(controller.disablePlugin(pluginId))}
        onUninstallPlugin={(pluginId) => ignored(controller.uninstallPlugin(pluginId))}
        onClearDiagnostics={(pluginId) => ignored(controller.clearDiagnostics(pluginId))}
      />
    </PluginDialogFrame>
  )
}
