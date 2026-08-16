import { useState } from 'react'
import { useTransportStore } from '../../state/transportStore'
import PluginContributionPicker from './PluginContributionPicker'
import PluginInspectorStatus from './PluginInspectorStatus'
import PluginParameterFields from './PluginParameterFields'
import PluginPreviewNotice from './PluginPreviewNotice'
import { useOptionalPluginEditorSnapshot, useOptionalPluginUi, usePluginAppSnapshot, usePluginUi } from './PluginUiHooks'
import type { PluginEffectIssueView, PluginPreviewIssueView } from './pluginUiTypes'

function ignored(promise: Promise<unknown>): void {
  void promise.catch(() => {})
}

function issueView<T extends {
  readonly effectInstanceId: string
  readonly effectLabel: string
  readonly pluginId: string | null
  readonly pluginName: string | null
  readonly pluginVersion: string | null
  readonly packageDigest: string | null
  readonly status: PluginEffectIssueView['status']
  readonly reason: string
  readonly blocksExport: boolean
}>(value: T): PluginEffectIssueView {
  return {
    effectInstanceId: value.effectInstanceId,
    effectLabel: value.effectLabel,
    pluginId: value.pluginId ?? 'unknown-plugin',
    pluginName: value.pluginName ?? 'Unknown plugin',
    pluginVersion: value.pluginVersion,
    packageDigest: value.packageDigest,
    status: value.status,
    reason: value.reason,
    blocksExport: value.blocksExport,
  }
}

function PluginInspectorContent() {
  const selectedClipId = useTransportStore((state) => state.selectedClipId)
  const { controller, manager } = usePluginUi()
  const app = usePluginAppSnapshot()
  const editor = useOptionalPluginEditorSnapshot()
  const [feedback, setFeedback] = useState<string | null>(null)
  const [migratingEffectId, setMigratingEffectId] = useState<string | null>(null)

  if (!editor || !editor.coherent || editor.catalogGeneration === null || !selectedClipId) return null
  const effects = editor.effects.filter((effect) => effect.clipId === selectedClipId)
  const addEffect = (effectType: string): void => {
    const result = controller.addPluginEffect({
      documentGeneration: editor.documentGeneration,
      catalogGeneration: editor.catalogGeneration!,
      clipId: selectedClipId,
      effectType,
    })
    setFeedback(result.status === 'rejected' ? result.detail : null)
  }
  const setParameter = (effectInstanceId: string, key: string, value: number | boolean | string): void => {
    const result = controller.setPluginEffectParameter({
      documentGeneration: editor.documentGeneration,
      catalogGeneration: editor.catalogGeneration!,
      clipId: selectedClipId,
      effectInstanceId,
      key,
      value,
    })
    setFeedback(result.status === 'rejected' ? result.detail : null)
  }
  const migrateEffect = (effectInstanceId: string): void => {
    setMigratingEffectId(effectInstanceId)
    setFeedback(null)
    void controller.migratePluginEffects([effectInstanceId]).then(
      () => { setFeedback(null) },
      (cause: unknown) => {
        setFeedback(cause instanceof Error ? cause.message : 'The effect update did not complete.')
      },
    ).finally(() => { setMigratingEffectId(null) })
  }

  return (
    <div className="plugin-editor-surfaces" data-testid="plugin-editor-surfaces">
      <PluginContributionPicker contributions={app.contributions} onSelectContribution={addEffect} />
      {effects.map((effect) => (
        <div key={effect.effectInstanceId}>
          <PluginInspectorStatus
            effect={issueView(effect)}
            actions={effect.actions}
            onRetryPlugin={(pluginId) => ignored(controller.retryPlugin(pluginId))}
            onDisablePlugin={(pluginId) => ignored(controller.disablePlugin(pluginId))}
            onManagePlugin={(pluginId) => manager.openManager(pluginId)}
            migrationAction={effect.status === 'version-mismatch' ? {
              available: true,
              disabledReason: migratingEffectId !== null
                && migratingEffectId !== effect.effectInstanceId
                ? 'Another effect update is still finishing.'
                : null,
              pending: migratingEffectId === effect.effectInstanceId,
              error: null,
            } : undefined}
            onMigrateEffect={effect.status === 'version-mismatch' ? migrateEffect : undefined}
          />
          <PluginParameterFields
            effectType={effect.effectType}
            effectLabel={effect.effectLabel}
            fields={effect.parameters}
            onChangeParameter={(_effectType, key, value) => setParameter(effect.effectInstanceId, key, value)}
          />
        </div>
      ))}
      {feedback ? <p className="plugin-error" role="alert">{feedback}</p> : null}
    </div>
  )
}

export function PluginInspectorSurfaces() {
  const pluginUi = useOptionalPluginUi()
  return pluginUi ? <PluginInspectorContent /> : null
}

function PluginPreviewContent() {
  const { controller, manager } = usePluginUi()
  const editor = useOptionalPluginEditorSnapshot()
  if (!editor || !editor.coherent) return null
  return (
    <PluginPreviewNotice
      issues={editor.previewIssues.map((issue): PluginPreviewIssueView => ({
        ...issueView(issue),
        actions: issue.actions,
      }))}
      manageAction={editor.manageAction}
      onRetryPlugin={(pluginId) => ignored(controller.retryPlugin(pluginId))}
      onDisablePlugin={(pluginId) => ignored(controller.disablePlugin(pluginId))}
      onManagePlugins={() => manager.openManager()}
    />
  )
}

export function PluginPreviewSurface() {
  const pluginUi = useOptionalPluginUi()
  return pluginUi ? <PluginPreviewContent /> : null
}
