/** The animation UI supplies the app-owned immutable catalog; binding is an explicit action. */
import { bindPluginAnimationParameter } from '../domain/animationParameterBinding'
import type { PluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import { findClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { commitPortableProjectEdit } from './portableProjectEdit'

/** Bind one clip plugin-effect parameter to its current declaration as one edit. */
export function bindAnimationParameter(
  readCatalog: () => PluginVideoEffectContributionSnapshot | undefined,
  clipId: string,
  effectId: string,
  parameter: string,
): string | null {
  const { project, projectGeneration, activeSequenceId, doc } = useDocumentStore.getState()
  const catalog = readCatalog()
  if (!catalog) return 'The project, sequence or plugin catalog changed. Review the binding again.'
  const effect = findClip(doc, clipId)?.effects.find((item) => item.id === effectId)
  const declaration = catalog.declarations.find((item) => item.effectType === effect?.type)
  if (!declaration) return 'The plugin declaration is unavailable.'
  const result = bindPluginAnimationParameter(project, activeSequenceId, clipId, effectId, parameter, declaration)
  if (!result.ok) return result.reason
  if (readCatalog() !== catalog) return 'The plugin catalog changed. Review the binding again.'
  return commitPortableProjectEdit(project, projectGeneration, result.project)
}
