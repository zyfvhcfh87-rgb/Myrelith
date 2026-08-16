import { useState } from 'react'
import { useTransportStore } from '../../state/transportStore'
import PluginContributionPicker from './PluginContributionPicker'
import PluginInspectorStatus from './PluginInspectorStatus'
import PluginParameterFields from './PluginParameterFields'
import PluginPreviewNotice from './PluginPreviewNotice'
import { useOptionalPluginEditorSnapshot, useOptionalPluginUi, usePluginAppSnapshot, usePluginUi } from './PluginUiContext'
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
}>(value: T): PluginEffectIssueView | null {
  if (value.pluginId === null || value.pluginName === null) return null
  return {
    effectInstanceId: value.effectInstanceId,
    effectLabel: value.effectLabel,
    pluginId: value.pluginId,
    pluginName: value.pluginName,
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

  if (!editor || !editor.coherent || editor.catalogGeneration === null || !selectedClipId) return null
  const effects = editor.effects.filter(
    (effect) => effect.clipId === selectedClipId && issueView(effect) !== null,
  )
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

  return (
    <div className="plugin-editor-surfaces" data-testid="plugin-editor-surfaces">
      <PluginContributionPicker contributions={app.contributions} onSelectContribution={addEffect} />
      {effects.map((effect) => (
        <div key={effect.effectInstanceId}>
          <PluginInspectorStatus
            effect={issueView(effect)!}
            actions={effect.actions}
            onRetryPlugin={(pluginId) => ignored(controller.retryPlugin(pluginId))}
            onDisablePlugin={(pluginId) => ignored(controller.disablePlugin(pluginId))}
            onManagePlugin={(pluginId) => manager.openManager(pluginId)}
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
      issues={editor.previewIssues.flatMap((issue): PluginPreviewIssueView[] => {
        const view = issueView(issue)
        return view === null ? [] : [{ ...view, actions: issue.actions }]
      })}
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
