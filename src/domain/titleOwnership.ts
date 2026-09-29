/** Procedural title ownership, independent of rendering and authoring UI. */
import type { Clip, ClipAnimation, TrackKind } from './schema'
import type { SequenceProject } from './projectSequences'
import { clipVisualSettings, defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { cloneClipAnimation } from './clipAnimation'
import { remapTitleAnimationElementIds } from './animationCollections'
import { scalarAnimationValueError } from './animationPropertyCatalog'
import { SOURCE_TIME_TICKS_PER_FRAME, clipSourceTimeMap } from './sourceTimeMap'
import { proceduralTextAssetId } from './textOverlay'
import { parsedSupportedTitleElement, readTitleDefinition, titleAnimationPropertySpec, TITLE_LIMITS, type TitleDefinition, type TitleDefinitionResult, type TitleElement } from './titleElements'
import { readTitleDefinitionCached } from './titleDefinitionCache'
import { SEQUENCE_PROJECT_LIMITS } from './sequenceProjectLimits'

export const MAX_PROJECT_TITLE_ELEMENTS = 100_000

/** Canonical seam for animation adapters. Unknown owners/elements stay unavailable;
 * supported disabled elements still retain their editable scalar data.
 */
export function readTitleClipElement(clip: Clip, elementId: string): TitleElement | undefined {
  if (clip.title === undefined) return undefined
  const definition = readTitleDefinitionCached(clip.title)
  if (definition.status !== 'supported') return undefined
  const intent = definition.title.elements.find((element) => element.id === elementId)
  return (intent && parsedSupportedTitleElement(intent)) ?? undefined
}

/** Supported data is copied; bounded unsupported payloads remain immutable intent. */
export function copyTitleDefinition(title: TitleDefinition): TitleDefinition {
  const result = readTitleDefinition(title)
  if (result.status === 'invalid') throw new RangeError(result.reason)
  return result.title
}

function opaqueStringCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === null || typeof value !== 'object') return 0
  return Object.values(value).reduce<number>((sum, child) => sum + opaqueStringCharacters(child), 0)
}

/** Unknown definitions reserve the full element allowance; unknown payload strings
 * count conservatively toward project text limits instead of becoming a loophole.
 * Input has passed the bounded, non-executing title reader before this walk.
 */
export function titleDefinitionUsage(title: TitleDefinition): {
  readonly elements: number; readonly textCharacters: number; readonly elementIds: readonly string[]
} {
  return definitionUsage(readTitleDefinitionCached(title))
}

function definitionUsage(result: TitleDefinitionResult): ReturnType<typeof titleDefinitionUsage> {
  if (result.status === 'invalid') throw new RangeError(result.reason)
  if (result.status === 'unsupported') return { elements: TITLE_LIMITS.elements, textCharacters: opaqueStringCharacters(result.title), elementIds: [] }
  let textCharacters = 0
  for (const element of result.title.elements) {
    const supported = parsedSupportedTitleElement(element)
    if (supported) {
      if (supported.kind === 'text') textCharacters += supported.text.content.length
    } else textCharacters += opaqueStringCharacters(element)
  }
  return { elements: result.title.elements.length, textCharacters, elementIds: result.title.elements.map((element) => element.id) }
}

export function titleClipOwnershipError(clip: Clip, trackKind: TrackKind): string | null {
  if (clip.title === undefined) return null
  return titleOwnerShapeError(clip, trackKind)
    ?? titleDefinitionOwnershipError(clip, readTitleDefinitionCached(clip.title))
}

/** Owner-clip rules checked before the title definition is read. */
function titleOwnerShapeError(clip: Clip, trackKind: TrackKind): string | null {
  if (clip.text !== undefined) return 'A clip cannot own both compact text and an expanded title.'
  if (trackKind !== 'video') return 'Titles require a video track.'
  if (clip.assetId !== proceduralTextAssetId(clip.id)) return 'Titles require their reserved procedural asset id.'
  const duration = clip.timelineRange.durationFrames
  const map = clipSourceTimeMap(clip)
  if (clip.sourceMode !== 'timed' || clip.sourceRange.startFrame !== 0 || clip.sourceRange.durationFrames !== duration
    || map.sourceStartTicks !== 0 || map.sourceDurationTicks !== duration * SOURCE_TIME_TICKS_PER_FRAME
    || map.rate.numerator !== 1 || map.rate.denominator !== 1
    || map.speedCurve?.originFrame !== 0 || map.speedCurve.points.length !== 0) return 'Titles require a fixed local 1x procedural source map.'
  if (clip.lensCorrection !== undefined && clip.lensCorrection !== null) return 'Titles cannot own lens correction.'
  const identity = defaultClipTransform()
  for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'] as const) {
    if (clip.transform[key] !== identity[key]) return 'Expanded title transforms belong to their elements.'
  }
  const visual = clipVisualSettings(clip)
  const defaults = defaultClipVisualSettings()
  if (visual.flipHorizontal !== defaults.flipHorizontal || visual.flipVertical !== defaults.flipVertical
    || visual.scaleLocked !== defaults.scaleLocked || Object.values(visual.crop).some((edge) => edge !== 0)) return 'Expanded title crop and flips belong to their elements.'
  return null
}

/** Definition and key rules; `definition` is the parse of `clip.title`. */
function titleDefinitionOwnershipError(clip: Clip, definition: TitleDefinitionResult): string | null {
  if (definition.status === 'invalid') return definition.reason
  for (const lane of clip.animation?.titleTracks ?? []) {
    for (const key of lane.keyframes) {
      const ticks = key.frame * SOURCE_TIME_TICKS_PER_FRAME
      if (!Number.isSafeInteger(ticks) || (key.sourceTimeTicks !== undefined && key.sourceTimeTicks !== ticks)) return 'Title key source intent must use exact local procedural ticks.'
    }
    if (definition.status !== 'supported') continue
    const intent = definition.title.elements.find((item) => item.id === lane.elementId)
    const element = intent && parsedSupportedTitleElement(intent)
    if (!element) continue
    const property = titleAnimationPropertySpec(element, lane.propertyVersion, lane.property)
    if (property.status !== 'available') continue
    for (const key of lane.keyframes) {
      if (scalarAnimationValueError(property.spec, key.value)) return 'A title key exceeds its property or static padding bounds.'
    }
  }
  return null
}

/** Used by live whole-project admission and the portable boundary. */
export function projectTitleOwnershipError(project: Pick<SequenceProject, 'sequences'>): string | null {
  let elements = 0
  let textCharacters = 0
  const ids = new Set<string>()
  try {
    for (const sequence of project.sequences) for (const track of sequence.tracks) for (const clip of track.clips) {
      let definition: TitleDefinitionResult | null = null
      if (clip.title !== undefined) {
        const shapeError = titleOwnerShapeError(clip, track.kind)
        if (shapeError) return shapeError
        // One parse serves both the ownership check and the usage totals.
        definition = readTitleDefinitionCached(clip.title)
        const definitionError = titleDefinitionOwnershipError(clip, definition)
        if (definitionError) return definitionError
      }
      if (clip.text !== undefined) { elements++; textCharacters += clip.text.content.length }
      if (definition !== null) {
        const usage = definitionUsage(definition)
        elements += usage.elements
        textCharacters += usage.textCharacters
        for (const id of usage.elementIds) {
          if (ids.has(id)) return 'Title element IDs must be unique across every sequence.'
          ids.add(id)
        }
      }
      if (elements > MAX_PROJECT_TITLE_ELEMENTS) return 'The project exceeds 100,000 logical title elements.'
      if (textCharacters > SEQUENCE_PROJECT_LIMITS.maxTotalTextCharacters) return 'The project exceeds 10,000,000 text characters.'
    }
    return null
  } catch (error) { return error instanceof Error ? error.message : 'Invalid title ownership.' }
}

/** Reserve actual elements and every dangling lane before any fresh allocation. */
export function createTitleElementIdAllocator(project: Pick<SequenceProject, 'sequences'>, factory: () => string): () => string {
  const used = new Set<string>()
  for (const sequence of project.sequences) for (const track of sequence.tracks) for (const clip of track.clips) {
    if (clip.title !== undefined) for (const id of titleDefinitionUsage(clip.title).elementIds) used.add(id)
    for (const lane of clip.animation?.titleTracks ?? []) used.add(lane.elementId)
  }
  return () => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = factory()
      if (id.trim().length > 0 && id.length <= TITLE_LIMITS.idCharacters && !used.has(id)) { used.add(id); return id }
    }
    throw new RangeError('Could not allocate a unique title element id.')
  }
}

/** Future element headers have known IDs; an opaque future definition cannot be
 * duplicated safely until its identity contract is understood. Preserve it unchanged.
 */
export function copyTitleForNewOwner(clip: Clip, allocate: () => string): { title?: TitleDefinition; animation: ClipAnimation } | null {
  const parsed = clip.title === undefined ? null : readTitleDefinition(clip.title)
  if (parsed !== null && parsed.status !== 'supported') return null
  const replacements = new Map<string, string>()
  const remap = (id: string): string => {
    const existing = replacements.get(id)
    if (existing !== undefined) return existing
    const next = allocate()
    replacements.set(id, next)
    return next
  }
  const elements = parsed?.title.elements.map((element) => ({ ...element, id: remap(element.id) }))
  for (const lane of clip.animation?.titleTracks ?? []) remap(lane.elementId)
  return { ...(elements === undefined ? {} : { title: { version: 1 as const, elements } }), animation: remapTitleAnimationElementIds(cloneClipAnimation(clip.animation ?? { tracks: [], effectTracks: [] }), replacements) }
}
