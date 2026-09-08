/** Small session-only title selection and guides; never serialized or undoable. */
import { create } from 'zustand'
export const useTitleEditorStore = create<{
  clipId: string | null; ids: readonly string[]; safeGuides: boolean
  select(clipId: string, ids: readonly string[]): void; setSafeGuides(value: boolean): void
}>(() => ({ clipId: null, ids: [], safeGuides: false,
  select: (clipId, ids) => useTitleEditorStore.setState({ clipId, ids: [...new Set(ids)].slice(0, 16) }),
  setSafeGuides: (safeGuides) => useTitleEditorStore.setState({ safeGuides }),
}))
export { readTitleDefinition, readTitleElement, resolveTitleFont, TITLE_ANIMATION_PROPERTIES, titleAnimationPropertySpec } from '../domain/titleElements'
export { titleElementBounds, titleMotionReplacements } from '../domain/titleEditing'
export { resolveTitleElementAnimation } from '../domain/animationPropertyCatalog'
export { TEXT_FONT_FAMILIES } from '../domain/textOverlay'
export { builtInTitleTemplates, titleTemplateConversion } from '../domain/titleTemplates'
