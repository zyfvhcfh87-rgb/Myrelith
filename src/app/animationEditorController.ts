/** Composition-root instance. The lazy animation workspace uses this facade. */
import { isProceduralTitleClip } from '../domain/textOverlay'
import { readTitleClipElement } from '../domain/titleOwnership'
import { getPluginAppController } from './pluginAppController'
import { createAnimationEditingController } from './animationEditingController'
import { useTransportStore } from '../state/transportStore'
import type { AnimationEditContext } from '../domain/animationOwners'

const titleOwners = Object.freeze({ isTitleClip: isProceduralTitleClip, readElement: readTitleClipElement })

let cachedContext: AnimationEditContext | undefined
export function getAnimationEditorContext(): AnimationEditContext {
  const plugins = getPluginAppController().getContributionSnapshot()
  if (!cachedContext || cachedContext.plugins !== plugins) cachedContext = { plugins, titles: titleOwners }
  return cachedContext
}
export function subscribeAnimationDeclarations(changed: () => void): () => void {
  return getPluginAppController().subscribe(changed)
}

export const animationEditorController = createAnimationEditingController({
  readContext: getAnimationEditorContext,
  subscribeContext: subscribeAnimationDeclarations,
  report: (message) => useTransportStore.getState().announceAnimation(message),
})
