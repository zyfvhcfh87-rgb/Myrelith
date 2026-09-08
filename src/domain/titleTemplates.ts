/** Origin-local data snapshots. Used copies carry all editable title intent in the project. */
import type { Clip, FrameRate, TitleAnimationTrack, TimelineDoc } from './schema'
import type { SequenceProject } from './projectSequences'
import { replaceProjectSequence, sequenceById } from './projectSequences'
import { defaultTitleElement, titleEditOwner, type TitleEditTarget } from './titleEditing'
import { titlePayloadBudget } from './titleBudgets'
import { readTitleDefinition, readTitleElement, type TitleDefinition, type TitleDefinitionV1, type TitleElement } from './titleElements'
import { copyTitleForNewOwner, createTitleElementIdAllocator, titleClipOwnershipError } from './titleOwnership'
import { clipAnimationValidationError } from './clipAnimation'
import { createTextClip, insertClip } from './operations/creation'
import { proceduralTextAssetId } from './textOverlay'
import { validateFrameRate } from './projectFile/validationPrimitives'
import { utf8ByteLength } from './documentMemory'

export const TITLE_TEMPLATE_LIMITS = Object.freeze({ entries: 100, templateBytes: 1024 * 1024, libraryBytes: 8 * 1024 * 1024 })
export interface TitleTemplateV1 {
  readonly version: 1; readonly id: string; readonly name: string
  readonly canvasWidth: number; readonly canvasHeight: number; readonly frameRate: FrameRate; readonly durationFrames: number
  readonly title: TitleDefinitionV1; readonly titleTracks: readonly TitleAnimationTrack[]
}
export interface TitleTemplateSummary { readonly id: string; readonly name: string; readonly elements: number; readonly durationFrames: number; readonly canvasWidth: number; readonly canvasHeight: number; readonly frameRate: FrameRate }
export interface TitleTemplateLibraryView { readonly templates: readonly TitleTemplateSummary[]; readonly unavailable: readonly { index: number; reason: string }[]; readonly readOnlyReason: string | null }
export type TitleTemplateMutation = { readonly kind: 'save'; readonly template: TitleTemplateV1 } | { readonly kind: 'delete'; readonly id: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) }
function fail(reason: string): never { throw new Error(reason) }
export function titleTemplateNameError(name: unknown): string | null {
  return typeof name !== 'string' || name !== name.trim() || !name.length || name.length > 80 || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? 'Use a name of 1–80 characters without surrounding spaces or control characters.' : null
}
export function readTitleTemplate(value: unknown): TitleTemplateV1 {
  // The bounded descriptor walker rejects getters, cycles and non-JSON objects before enumeration or serialization.
  const budget = titlePayloadBudget({ title: value as TitleDefinition })
  if (!budget.ok) fail(budget.reason)
  if (!record(value) || !exact(value, ['version', 'id', 'name', 'canvasWidth', 'canvasHeight', 'frameRate', 'durationFrames', 'title', 'titleTracks']) || value.version !== 1) fail('This title template version or envelope is unavailable.')
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) fail('Invalid template identity.')
  const nameError = titleTemplateNameError(value.name); if (nameError) fail(nameError)
  for (const name of ['canvasWidth', 'canvasHeight'] as const) if (!Number.isSafeInteger(value[name]) || Number(value[name]) < 16 || Number(value[name]) > 65535) fail('Template canvas dimensions must be integers from 16 to 65,535.')
  validateFrameRate(value.frameRate, 'template.frameRate')
  if (!Number.isSafeInteger(value.durationFrames) || Number(value.durationFrames) < 1 || Number(value.durationFrames) > 1_000_000_000) fail('Invalid template frame duration.')
  const definition = readTitleDefinition(value.title)
  if (definition.status !== 'supported') fail(definition.reason)
  const animationError = clipAnimationValidationError({ tracks: [], titleTracks: value.titleTracks as TitleAnimationTrack[] })
  if (animationError) fail(animationError)
  const template = value as unknown as TitleTemplateV1
  const owner = templateClip(template, 'template-validation', 0)
  const ownershipError = titleClipOwnershipError(owner, 'video'); if (ownershipError) fail(ownershipError)
  if (utf8ByteLength(JSON.stringify(value)) > TITLE_TEMPLATE_LIMITS.templateBytes) fail('A template exceeds 1 MiB.')
  return template
}
function templateClip(template: TitleTemplateV1, id: string, startFrame: number): Clip {
  const doc = { width: template.canvasWidth, height: template.canvasHeight } as TimelineDoc
  const { text: _text, ...clip } = createTextClip(doc, startFrame, template.durationFrames)
  return { ...clip, id, assetId: proceduralTextAssetId(id), name: template.name, title: template.title, animation: { tracks: [], effectTracks: [], titleTracks: [...template.titleTracks] } }
}
export function captureTitleTemplate(project: SequenceProject, target: TitleEditTarget, id: string, name: string): TitleTemplateV1 {
  const { sequence, clip } = titleEditOwner(project, target)
  return readTitleTemplate({ version: 1, id, name, canvasWidth: sequence.width, canvasHeight: sequence.height, frameRate: { ...sequence.frameRate },
    durationFrames: clip.timelineRange.durationFrames, title: clip.title, titleTracks: clip.animation?.titleTracks ?? [] })
}
export function titleTemplateConversion(template: TitleTemplateV1, destination: Pick<TimelineDoc, 'width' | 'height' | 'frameRate'>) {
  return { factor: Math.min(destination.width / template.canvasWidth, destination.height / template.canvasHeight),
    converted: template.canvasWidth !== destination.width || template.canvasHeight !== destination.height,
    rateChanged: template.frameRate.num * destination.frameRate.den !== destination.frameRate.num * template.frameRate.den,
    durationSeconds: template.durationFrames * destination.frameRate.den / destination.frameRate.num }
}
function fitElement(element: TitleElement, factor: number): TitleElement {
  const transform = { ...element.transform, x: element.transform.x * factor, y: element.transform.y * factor }
  const scaled = element.kind === 'text' ? { ...element, transform, text: { ...element.text,
    boxWidthPx: element.text.boxWidthPx * factor, boxHeightPx: element.text.boxHeightPx * factor, fontSizePx: element.text.fontSizePx * factor,
    paddingPx: element.text.paddingPx * factor, outlineWidthPx: element.text.outlineWidthPx * factor, shadowBlurPx: element.text.shadowBlurPx * factor,
    shadowOffsetXPx: element.text.shadowOffsetXPx * factor, shadowOffsetYPx: element.text.shadowOffsetYPx * factor } }
    : { ...element, transform, shape: { ...element.shape, boxWidthPx: element.shape.boxWidthPx * factor, boxHeightPx: element.shape.boxHeightPx * factor, outlineWidthPx: element.shape.outlineWidthPx * factor } }
  const parsed = readTitleElement(scaled); if (parsed.status !== 'supported') fail(`Canvas conversion: ${parsed.reason}`)
  return scaled
}
const PIXEL_PROPERTIES = new Set(['position-x', 'position-y', 'box-width', 'box-height', 'font-size', 'outline-width', 'shadow-blur', 'shadow-offset-x', 'shadow-offset-y'])
export function instantiateTitleTemplate(project: SequenceProject, sequenceId: string, trackId: string, frame: number, raw: TitleTemplateV1, factory: () => string): SequenceProject {
  const template = readTitleTemplate(raw), sequence = sequenceById(project, sequenceId)
  if (!sequence) fail('The receiving sequence no longer exists.')
  const track = sequence.tracks.find((item) => item.id === trackId)
  if (!track || track.kind !== 'video' || track.locked) fail('Choose an unlocked video track for the title.')
  const { factor, converted } = titleTemplateConversion(template, sequence)
  const elements = template.title.elements.map((element) => {
    if (!converted) return element
    const parsed = readTitleElement(element)
    if (parsed.status !== 'supported') fail('Unavailable elements cannot be converted to another canvas. Use the original canvas size.')
    return fitElement(parsed.element, factor)
  })
  const titleTracks = template.titleTracks.map((lane) => {
    if (!converted) return lane
    const element = template.title.elements.find((element) => element.id === lane.elementId)
    if (!element || readTitleElement(element).status !== 'supported' || lane.propertyVersion !== 1 || !['rotation', 'opacity', 'scale-x', 'scale-y', ...PIXEL_PROPERTIES].includes(lane.property)) fail('Unavailable animation cannot be converted to another canvas. Use the original canvas size.')
    return PIXEL_PROPERTIES.has(lane.property) ? { ...lane, keyframes: lane.keyframes.map((key) => ({ ...key, value: key.value * factor })) } : lane
  })
  const usedIds = new Set(project.sequences.flatMap((sequence) => sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id))))
  let id = ''
  for (let attempt = 0; attempt < 64; attempt++) { const value = factory(); if (value.trim() && value.length <= 256 && !usedIds.has(value)) { id = value; break } }
  if (!id) fail('Could not allocate a fresh title clip identity.')
  const clip = templateClip({ ...template, title: { version: 1, elements }, titleTracks }, id, frame)
  const copied = copyTitleForNewOwner(clip, createTitleElementIdAllocator(project, factory))
  if (!copied) fail('The template identity contract is unavailable.')
  const inserted = insertClip(sequence, trackId, { ...clip, ...copied })
  if (inserted === sequence) fail('The title cannot fit here. Check the track, overlap and project limits.')
  const candidate = replaceProjectSequence(project, sequenceId, inserted)
  if (candidate === project) fail('The template exceeds the complete receiving project limits.')
  return candidate
}
export function builtInTitleTemplates(): readonly TitleTemplateV1[] {
  const canvas = { width: 1920, height: 1080 }, text = defaultTitleElement('text', 'builtin-text', canvas)
  if (text.kind !== 'text') throw new Error('Expected built-in text.')
  const shape = defaultTitleElement('rectangle', 'builtin-background', canvas)
  return [
    { id: 'centered-title', name: 'Centered title', elements: [text] },
    { id: 'lower-third', name: 'Lower third', elements: [{ ...shape, transform: { ...shape.transform, y: 340 } }, { ...text, transform: { ...text.transform, y: 340 }, text: { ...text.text, content: 'Name\nRole or description', fontSizePx: 54 } }] },
    { id: 'title-card', name: 'Title card', elements: [{ ...shape, shape: { ...('shape' in shape ? shape.shape : { boxWidthPx: 0, boxHeightPx: 0, fillColor: '#243354', outlineEnabled: false, outlineColor: '#ffffff', outlineWidthPx: 0 }), boxWidthPx: 1700, boxHeightPx: 850 } } as TitleElement, text] },
  ].map(({ id, name, elements }) => readTitleTemplate({ version: 1, id, name, canvasWidth: 1920, canvasHeight: 1080, frameRate: { num: 30, den: 1 }, durationFrames: 150, title: { version: 1, elements }, titleTracks: [] }))
}
export function readTitleTemplateLibrary(raw: unknown): { entries: readonly unknown[] | null; view: TitleTemplateLibraryView } {
  const unavailable = (reason: string) => ({ entries: null, view: { templates: [], unavailable: [], readOnlyReason: reason } })
  if (raw === undefined) return { entries: [], view: { templates: [], unavailable: [], readOnlyReason: null } }
  if (typeof raw !== 'string' || raw.length > TITLE_TEMPLATE_LIMITS.libraryBytes || utf8ByteLength(raw) > TITLE_TEMPLATE_LIMITS.libraryBytes) return unavailable('The local title library is invalid or exceeds 8 MiB. It remains untouched.')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return unavailable('The local title library is corrupt. It remains untouched.') }
  if (!record(parsed) || !exact(parsed, ['version', 'templates']) || parsed.version !== 1) return unavailable('This title library envelope is unavailable and read-only.')
  if (!Array.isArray(parsed.templates) || parsed.templates.length > TITLE_TEMPLATE_LIMITS.entries) return unavailable('The local title library exceeds 100 entries or is invalid.')
  try {
    if (parsed.templates.some((entry: unknown) => utf8ByteLength(JSON.stringify(entry)) > TITLE_TEMPLATE_LIMITS.templateBytes)) return unavailable('A stored title record exceeds 1 MiB. The library remains untouched.')
  } catch { return unavailable('A stored title record exceeds bounded JSON depth. The library remains untouched.') }
  const templates: TitleTemplateSummary[] = [], errors: { index: number; reason: string }[] = [], ids = new Set<string>(), names = new Set<string>()
  parsed.templates.forEach((entry: unknown, index: number) => {
    try {
      const template = readTitleTemplate(entry)
      if (ids.has(template.id) || names.has(template.name.toLowerCase())) fail('Duplicate template identity or name.')
      ids.add(template.id); names.add(template.name.toLowerCase())
      const { id, name, durationFrames, canvasWidth, canvasHeight, frameRate } = template
      templates.push({ id, name, durationFrames, canvasWidth, canvasHeight, frameRate, elements: template.title.elements.length })
    } catch (cause) { errors.push({ index, reason: cause instanceof Error ? cause.message : 'Unavailable template.' }) }
  })
  return { entries: parsed.templates, view: { templates, unavailable: errors, readOnlyReason: null } }
}
export function titleTemplateFromLibrary(raw: unknown, id: string): TitleTemplateV1 {
  const { entries, view } = readTitleTemplateLibrary(raw)
  if (!entries || !view.templates.some((item) => item.id === id)) fail(view.readOnlyReason ?? 'The template is unavailable or was removed. Reload the library.')
  for (const entry of entries) {
    if (!record(entry) || entry.id !== id) continue
    try { return readTitleTemplate(entry) } catch { /* Preserve unavailable same-ID siblings; select only the validated record. */ }
  }
  return fail('The supported template is no longer available.')
}
export function mutateTitleTemplateLibrary(raw: unknown, mutation: TitleTemplateMutation): string {
  const { entries, view } = readTitleTemplateLibrary(raw)
  if (!entries) fail(view.readOnlyReason!)
  let next = [...entries]
  if (mutation.kind === 'save') {
    const template = readTitleTemplate(mutation.template)
    if (entries.length >= TITLE_TEMPLATE_LIMITS.entries) fail('The local library already contains 100 templates.')
    if (entries.some((entry) => record(entry) && (entry.id === template.id || typeof entry.name === 'string' && entry.name.toLowerCase() === template.name.toLowerCase()))) fail('A template already uses this identity or name.')
    next.push(template)
  } else {
    if (!view.templates.some((entry) => entry.id === mutation.id)) fail('The template is unavailable or was removed. Reload the library.')
    const index = next.findIndex((entry) => {
      if (!record(entry) || entry.id !== mutation.id) return false
      try { readTitleTemplate(entry); return true } catch { return false }
    })
    if (index < 0) fail('The supported template is no longer available.')
    next.splice(index, 1)
  }
  const encoded = JSON.stringify({ version: 1, templates: next })
  if (utf8ByteLength(encoded) > TITLE_TEMPLATE_LIMITS.libraryBytes) fail('The local title library exceeds 8 MiB.')
  return encoded
}
