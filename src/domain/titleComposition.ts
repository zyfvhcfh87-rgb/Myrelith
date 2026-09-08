/** Resource-free title paint intent shared by preview, workers and finite export. */
import type { Clip, TextProps } from './schema'
import type { VideoCompositionPlan } from './videoCompositionPlan'
import { readTitleElement, resolveTitleFont, type TitleDefinition, type TitleElement, type TitleShapeElementV1, type TitleTextElementV1 } from './titleElements'
import { isImmutableTitleDefinition, readTitleDefinitionCached } from './titleDefinitionCache'
import { resolveScalarAnimationProperty, resolveTitleElementAnimation, scalarAnimationValueError } from './animationPropertyCatalog'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { keyframesValidationError } from './scalarAnimation'

export type TitlePaintElement =
  | { readonly kind: 'text'; readonly element: TitleTextElementV1; readonly text: TextProps }
  | { readonly kind: 'shape'; readonly element: TitleShapeElementV1 }

export interface TitleCompositionNotice {
  readonly kind: 'unavailable' | 'notice'
  readonly elementId: string | null
  readonly name: string
  readonly detail: string
}
export interface TitleComposition {
  readonly elements: readonly TitlePaintElement[]
  readonly notices: readonly TitleCompositionNotice[]
}
interface PreparedTitle {
  readonly elements: readonly TitleElement[]
  readonly elementIds: ReadonlySet<string>
  readonly notices: readonly TitleCompositionNotice[]
}

function prepareTitle(title: TitleDefinition): PreparedTitle {
  const definition = readTitleDefinitionCached(title)
  if (definition.status !== 'supported') return { elements: [], elementIds: new Set(), notices: [{
    kind: 'unavailable', elementId: null, name: 'Title', detail: definition.reason,
  }] }
  const elements: TitleElement[] = []
  const notices: TitleCompositionNotice[] = []
  for (const intent of definition.title.elements) {
    if (!intent.enabled) continue
    const parsed = readTitleElement(intent)
    if (parsed.status !== 'supported') {
      notices.push({ kind: 'unavailable', elementId: intent.id, name: intent.name, detail: parsed.reason })
    } else elements.push(parsed.element)
  }
  return { elements, elementIds: new Set(definition.title.elements.map((element) => element.id)), notices }
}

/** Retained unavailable lanes never silently become an exportable static title. */
function unavailableTitleAnimation(clip: Clip, title: PreparedTitle): TitleCompositionNotice[] {
  const notices: TitleCompositionNotice[] = []
  const unavailable = (detail: string, elementId: string | null = null) => notices.push({ kind: 'unavailable', name: clip.name, elementId, detail })
  for (const lane of clip.animation?.titleTracks ?? []) {
    if (lane.keyframes.length && !title.elementIds.has(lane.elementId)) unavailable('The animated title element is unavailable; its keys are preserved.', lane.elementId)
  }
  for (const lane of clip.animation?.tracks ?? []) {
    if (!lane.keyframes.length) continue
    const property = resolveScalarAnimationProperty({ kind: 'clip', clip, trackKind: 'video', property: lane.property, propertyVersion: lane.propertyVersion })
    const error = property.status === 'unavailable' ? property.reason
      : keyframesValidationError(lane.keyframes, (value) => scalarAnimationValueError(property.spec, value))
    if (error) unavailable(error)
  }
  for (const lane of clip.animation?.effectTracks ?? []) {
    if (!lane.keyframes.length) continue
    const effect = clip.effects.find((effect) => effect.id === lane.effectId)
    if (effect && !effect.enabled) continue
    if (!effect || !titleEffectAnimationParameterSpec(clip, effect, lane.parameter)) {
      unavailable(`Effect animation ${lane.effectId}.${lane.parameter} is unavailable on this title; its keys are preserved.`)
      continue
    }
    const property = resolveScalarAnimationProperty({ kind: 'effect', effect, parameter: lane.parameter, identity: lane.parameterIdentity })
    const error = property.status === 'unavailable' ? property.reason
      : keyframesValidationError(lane.keyframes, (value) => scalarAnimationValueError(property.spec, value))
    if (error) unavailable(error)
  }
  for (const lane of clip.animation?.effectPathTracks ?? []) {
    if (lane.keyframes.length && clip.effects.find((effect) => effect.id === lane.effectId)?.enabled !== false) unavailable('Path animation is unavailable on titles; its keys are preserved.')
  }
  return notices
}

/** The planner belongs to one immutable document snapshot. No font resources or
 * per-frame results are retained; replacement drops the parsed-definition cache.
 */
export function createTitleCompositionPlanner() {
  const prepared = new WeakMap<TitleDefinition, PreparedTitle>()
  return {
    plan(clip: Clip, timelineFrame: number): TitleComposition {
      if (clip.title === undefined) return { elements: [], notices: [] }
      let title = prepared.get(clip.title)
      if (!title) {
        title = prepareTitle(clip.title)
        if (isImmutableTitleDefinition(clip.title)) prepared.set(clip.title, title)
      }
      const notices = [...title.notices, ...unavailableTitleAnimation(clip, title)]
      const elements: TitlePaintElement[] = []
      const localFrame = timelineFrame - clip.timelineRange.startFrame
      if (!Number.isSafeInteger(localFrame)) return { elements, notices: [{ kind: 'unavailable', elementId: null, name: clip.name, detail: 'Title composition requires an exact integer frame.' }] }
      for (const original of title.elements) {
        const resolved = resolveTitleElementAnimation(original, clip.animation?.titleTracks ?? [], localFrame)
        for (const reason of resolved.unavailable) notices.push({ kind: 'unavailable', elementId: original.id, name: original.name, detail: reason })
        const element = resolved.element
        if (element.kind !== 'text') { elements.push({ kind: 'shape', element }); continue }
        const font = resolveTitleFont(element.font)
        if (font.status === 'unavailable') {
          notices.push({ kind: 'unavailable', elementId: element.id, name: element.name, detail: font.reason })
          continue
        }
        notices.push({ kind: 'notice', elementId: element.id, name: element.name,
          detail: font.usesFallback ? `Using the explicit ${font.family} fallback for ${font.requestedFamily}; appearance depends on this platform.`
            : `${font.family} uses this platform's fonts; appearance can differ on another device.`,
        })
        elements.push({ kind: 'text', element, text: { ...element.text, fontFamily: font.family } })
      }
      return { elements, notices }
    },
  }
}

export function titleCompositionError(title: TitleComposition): string | null {
  const issue = title.notices.find((notice) => notice.kind === 'unavailable')
  return issue ? `${issue.name}: ${issue.detail}` : null
}

export const MAX_VISIBLE_TITLE_ELEMENTS = 4096

/** Count actual expanded occurrences, including repeated nested instances,
 * before any layout, media request or compositor surface is acquired.
 */
export function titleCompositionBudgetError(plan: VideoCompositionPlan): string | null {
  let elements = 0
  for (const item of plan.items) {
    if (item.kind !== 'title') continue
    elements += item.title.elements.length
    if (elements > MAX_VISIBLE_TITLE_ELEMENTS) return 'This frame exceeds 4,096 visible title elements. Disable some title elements or clips.'
  }
  return null
}
