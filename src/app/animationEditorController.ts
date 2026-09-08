/** Composition-root instance. The lazy animation workspace uses this facade. */
import { LEGACY_ANIMATION_TITLE_OWNERS } from '../domain/animationOwners'
import { getPluginAppController } from './pluginAppController'
import { createAnimationEditingController } from './animationEditingController'

export const animationEditorController = createAnimationEditingController({
  readContext: () => ({ plugins: getPluginAppController().getContributionSnapshot(), titles: LEGACY_ANIMATION_TITLE_OWNERS }),
  subscribeContext: (changed) => getPluginAppController().subscribe(() => changed()),
})
