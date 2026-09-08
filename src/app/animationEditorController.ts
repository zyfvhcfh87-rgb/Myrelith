/** Composition-root instance. The lazy animation workspace uses this facade. */
import { isProceduralTitleClip } from '../domain/textOverlay'
import { readTitleClipElement } from '../domain/titleOwnership'
import { getPluginAppController } from './pluginAppController'
import { createAnimationEditingController } from './animationEditingController'

const titleOwners = Object.freeze({ isTitleClip: isProceduralTitleClip, readElement: readTitleClipElement })

export const animationEditorController = createAnimationEditingController({
  readContext: () => ({ plugins: getPluginAppController().getContributionSnapshot(), titles: titleOwners }),
  subscribeContext: (changed) => getPluginAppController().subscribe(() => changed()),
})
