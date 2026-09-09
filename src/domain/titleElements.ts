/** Pure title data and scalar adapters. No Clip, animation evaluator or runtime owner. */
import type { ClipVisualSettings, TextFontFamily, TextProps, Transform } from './schema'
import { clipVisualSettingsValidationError, MAX_CLIP_SCALE, MIN_CLIP_SCALE } from './clipInspector'
import { isSupportedTextColor, isSupportedTextFontFamily, textPropsValidationError, TEXT_OVERLAY_LIMITS } from './textOverlay'
import { utf8ByteLength } from './documentMemory'

export const TITLE_VERSION = 1
export const TITLE_PROPERTY_VERSION = 1
export const TITLE_LIMITS = Object.freeze({
  elements: 16,
  nameCharacters: 80,
  idCharacters: 256,
  propertyAndFontCharacters: 128,
  contentCharacters: 80_000,
  serializedBytes: 1024 * 1024,
  jsonDepth: 8,
  jsonEntries: 4096,
  jsonKeyCharacters: 128,
  finiteMagnitude: 1_000_000_000,
})

export type TitleTextStyle = Readonly<Omit<TextProps, 'fontFamily'>>
export interface TitleFontIntent {
  readonly family: string
  readonly fallbackFamily: TextFontFamily | null
}
interface TitleElementBaseV1 {
  readonly id: string
  readonly version: 1
  readonly name: string
  readonly enabled: boolean
  readonly transform: Readonly<Transform>
  readonly visual: Readonly<Omit<ClipVisualSettings, 'crop'>> & {
    readonly crop: Readonly<ClipVisualSettings['crop']>
  }
  readonly opacity: number
}
export interface TitleTextElementV1 extends TitleElementBaseV1 {
  readonly kind: 'text'
  readonly text: TitleTextStyle
  readonly font: TitleFontIntent
}
export interface TitleShapeElementV1 extends TitleElementBaseV1 {
  readonly kind: 'rectangle' | 'ellipse'
  readonly shape: Readonly<{
    boxWidthPx: number
    boxHeightPx: number
    fillColor: string
    outlineEnabled: boolean
    outlineColor: string
    outlineWidthPx: number
  }>
}
export type TitleElement = TitleTextElementV1 | TitleShapeElementV1

/** Returned only after the complete non-executing JSON envelope is checked. */
export interface UnknownTitleElementIntent {
  readonly id: string
  readonly version: number
  readonly kind: string
  readonly name: string
  readonly enabled: boolean
  readonly [key: string]: unknown
}
export type TitleElementIntent = TitleElement | UnknownTitleElementIntent
export interface TitleDefinitionV1 {
  readonly version: 1
  readonly elements: readonly TitleElementIntent[]
}
export interface UnknownTitleDefinitionIntent {
  readonly version: number
  readonly [key: string]: unknown
}
export type TitleDefinition = TitleDefinitionV1 | UnknownTitleDefinitionIntent

type InvalidTitle = { readonly status: 'invalid'; readonly reason: string }
export type TitleElementResult =
  | { readonly status: 'supported'; readonly element: TitleElement }
  | { readonly status: 'unsupported'; readonly element: UnknownTitleElementIntent; readonly reason: string }
  | InvalidTitle
export type TitleDefinitionResult =
  | { readonly status: 'supported'; readonly title: TitleDefinitionV1 }
  | { readonly status: 'unsupported'; readonly title: UnknownTitleDefinitionIntent; readonly reason: string }
  | InvalidTitle

class TitleDataError extends Error {}
function fail(reason: string): never { throw new TitleDataError(reason) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Expected a title object.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('Title objects must contain plain JSON data.')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, required: readonly string[]): void {
  if (Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) fail('Title object has missing or unknown fields.')
}
function string(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.trim().length === 0)) {
    fail(`Expected a ${empty ? '' : 'non-empty '}string of at most ${maximum} characters.`)
  }
  return value
}
function number(value: unknown, min: number = -TITLE_LIMITS.finiteMagnitude, max: number = TITLE_LIMITS.finiteMagnitude): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`Expected a finite number from ${min} to ${max}.`)
  }
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('Expected a boolean title value.')
  return value
}
function version(value: unknown): number {
  const result = number(value, 1, Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(result)) fail('Title version must be a positive safe integer.')
  return result
}
function color(value: unknown): string {
  if (!isSupportedTextColor(value)) fail('Title colors must be hexadecimal CSS colors.')
  return value
}

/** Descriptor inspection rejects getters, hidden fields, holes and cycles before property reads. */
function checkJson(value: unknown): void {
  let entries = 0
  let bytes = 0
  const ancestors = new Set<object>()
  const charge = (amount: number) => {
    bytes += amount
    if (bytes > TITLE_LIMITS.serializedBytes) fail('Title JSON exceeds the 1 MiB limit.')
  }
  const walk = (entry: unknown, depth: number): void => {
    if (depth > TITLE_LIMITS.jsonDepth) fail('Title JSON exceeds eight nested levels.')
    if (entry === null || typeof entry === 'boolean') { charge(entry === null ? 4 : entry ? 4 : 5); return }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail('Title JSON numbers must be finite.')
      charge(JSON.stringify(entry).length)
      return
    }
    if (typeof entry === 'string') {
      if (entry.length > TEXT_OVERLAY_LIMITS.maxCharacters) fail('Title JSON string exceeds 20,000 characters.')
      charge(utf8ByteLength(JSON.stringify(entry)))
      return
    }
    if (typeof entry !== 'object') fail('Title JSON contains a non-JSON value.')
    if (ancestors.has(entry)) fail('Title JSON must not contain cycles.')
    const array = Array.isArray(entry)
    if (array) {
      if (Object.getPrototypeOf(entry) !== Array.prototype) fail('Title arrays must be plain arrays.')
      if (entry.length > TITLE_LIMITS.jsonEntries - entries) fail('Title JSON exceeds 4,096 entries.')
    } else object(entry)
    const ownKeys = Reflect.ownKeys(entry)
    const dataKeys = ownKeys.filter((key) => !(array && key === 'length'))
    entries += dataKeys.length
    if (entries > TITLE_LIMITS.jsonEntries) fail('Title JSON exceeds 4,096 entries.')
    if (array && dataKeys.length !== entry.length) fail('Title arrays must be dense without extra fields.')
    charge(2 + Math.max(0, dataKeys.length - 1))
    ancestors.add(entry)
    try {
      for (let index = 0; index < dataKeys.length; index++) {
        const key = dataKeys[index]
        if (typeof key !== 'string') fail('Title JSON cannot contain symbol keys.')
        if (array) {
          if (key !== String(index)) fail('Title arrays must have only ordered index fields.')
        } else {
          if (key.length === 0 || key.length > TITLE_LIMITS.jsonKeyCharacters
            || key === '__proto__' || key === 'constructor' || key === 'prototype') fail('Unsafe title JSON key.')
          charge(utf8ByteLength(JSON.stringify(key)) + 1)
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('Title JSON cannot contain accessors or hidden fields.')
        walk(descriptor.value, depth + 1)
      }
    } finally { ancestors.delete(entry) }
  }
  walk(value, 0)
}

function transform(value: unknown): Transform {
  const item = object(value)
  keys(item, ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'])
  return {
    x: number(item.x), y: number(item.y), rotation: number(item.rotation),
    scaleX: number(item.scaleX, MIN_CLIP_SCALE, MAX_CLIP_SCALE),
    scaleY: number(item.scaleY, MIN_CLIP_SCALE, MAX_CLIP_SCALE),
    anchorX: number(item.anchorX, 0, 1), anchorY: number(item.anchorY, 0, 1),
  }
}
function visual(value: unknown): ClipVisualSettings {
  const item = object(value)
  keys(item, ['crop', 'flipHorizontal', 'flipVertical', 'scaleLocked'])
  const crop = object(item.crop)
  keys(crop, ['left', 'right', 'top', 'bottom'])
  const result = {
    crop: { left: number(crop.left), right: number(crop.right), top: number(crop.top), bottom: number(crop.bottom) },
    flipHorizontal: boolean(item.flipHorizontal), flipVertical: boolean(item.flipVertical), scaleLocked: boolean(item.scaleLocked),
  }
  const error = clipVisualSettingsValidationError(result)
  if (error) fail(error)
  return result
}

export function titleFontValidationError(value: unknown): string | null {
  try {
    checkJson(value)
    readFont(value)
    return null
  } catch (error) { if (error instanceof TitleDataError) return error.message; throw error }
}
function readFont(value: unknown): TitleFontIntent {
  const item = object(value)
  keys(item, ['family', 'fallbackFamily'])
  const family = string(item.family, TITLE_LIMITS.propertyAndFontCharacters)
  if (family !== family.trim() || !/^[\p{L}\p{N} ._-]+$/u.test(family)) fail('Title font must be a literal family identifier, not CSS or a URL.')
  const fallbackFamily = item.fallbackFamily
  if (fallbackFamily !== null && !isSupportedTextFontFamily(fallbackFamily)) fail('Title fallback must be an explicit supported generic family or null.')
  return { family, fallbackFamily }
}
export type TitleFontResolution =
  | { readonly status: 'platform-generic'; readonly family: TextFontFamily; readonly requestedFamily: string; readonly usesFallback: boolean }
  | { readonly status: 'unavailable'; readonly requestedFamily: string; readonly reason: string }

/** Facts from explicit intent only; this never probes, fetches or claims font-byte identity. */
export function resolveTitleFont(font: TitleFontIntent): TitleFontResolution {
  if (font.fallbackFamily !== null) {
    return { status: 'platform-generic', family: font.fallbackFamily, requestedFamily: font.family, usesFallback: true }
  }
  if (isSupportedTextFontFamily(font.family)) {
    return { status: 'platform-generic', family: font.family, requestedFamily: font.family, usesFallback: false }
  }
  return { status: 'unavailable', requestedFamily: font.family, reason: 'Requested font is not a supported generic family; choose an explicit fallback.' }
}

const TEXT_KEYS = [
  'content', 'fontSizePx', 'color', 'align', 'bold', 'italic', 'boxWidthPx', 'boxHeightPx', 'paddingPx',
  'backgroundEnabled', 'backgroundColor', 'outlineEnabled', 'outlineColor', 'outlineWidthPx',
  'shadowEnabled', 'shadowColor', 'shadowBlurPx', 'shadowOffsetXPx', 'shadowOffsetYPx',
] as const satisfies readonly (keyof TitleTextStyle)[]
function textStyle(value: unknown): TitleTextStyle {
  const item = object(value)
  keys(item, TEXT_KEYS)
  const align = item.align
  if (align !== 'left' && align !== 'center' && align !== 'right') fail('Unsupported title text alignment.')
  const result: TitleTextStyle = {
    content: string(item.content, TEXT_OVERLAY_LIMITS.maxCharacters, true),
    fontSizePx: number(item.fontSizePx), color: color(item.color), align,
    bold: boolean(item.bold), italic: boolean(item.italic),
    boxWidthPx: number(item.boxWidthPx), boxHeightPx: number(item.boxHeightPx), paddingPx: number(item.paddingPx),
    backgroundEnabled: boolean(item.backgroundEnabled), backgroundColor: color(item.backgroundColor),
    outlineEnabled: boolean(item.outlineEnabled), outlineColor: color(item.outlineColor), outlineWidthPx: number(item.outlineWidthPx),
    shadowEnabled: boolean(item.shadowEnabled), shadowColor: color(item.shadowColor), shadowBlurPx: number(item.shadowBlurPx),
    shadowOffsetXPx: number(item.shadowOffsetXPx), shadowOffsetYPx: number(item.shadowOffsetYPx),
  }
  // Validate the unchanged legacy style rules. This family is never a render fallback.
  const error = textPropsValidationError({ ...result, fontFamily: 'sans-serif' })
  if (error) fail(error)
  return result
}

function readElement(value: unknown): Exclude<TitleElementResult, InvalidTitle> {
  const item = object(value)
  const header = {
    id: string(item.id, TITLE_LIMITS.idCharacters), version: version(item.version),
    kind: string(item.kind, TITLE_LIMITS.propertyAndFontCharacters),
    name: string(item.name, TITLE_LIMITS.nameCharacters), enabled: boolean(item.enabled),
  }
  if (header.version !== TITLE_VERSION || !['text', 'rectangle', 'ellipse'].includes(header.kind)) {
    // All JSON members and the complete minimum header were validated above.
    const element = item as unknown as UnknownTitleElementIntent
    return { status: 'unsupported', element, reason: 'Unsupported title element kind or version.' }
  }
  const commonKeys = ['id', 'version', 'kind', 'name', 'enabled', 'transform', 'visual', 'opacity']
  const base = {
    id: header.id, version: TITLE_VERSION, name: header.name, enabled: header.enabled,
    transform: transform(item.transform), visual: visual(item.visual), opacity: number(item.opacity, 0, 1),
  } as const
  if (header.kind === 'text') {
    keys(item, [...commonKeys, 'text', 'font'])
    return { status: 'supported', element: { ...base, kind: 'text', text: textStyle(item.text), font: readFont(item.font) } }
  }
  keys(item, [...commonKeys, 'shape'])
  const shape = object(item.shape)
  keys(shape, ['boxWidthPx', 'boxHeightPx', 'fillColor', 'outlineEnabled', 'outlineColor', 'outlineWidthPx'])
  if (header.kind !== 'rectangle' && header.kind !== 'ellipse') fail('Unsupported shape kind.')
  return { status: 'supported', element: { ...base, kind: header.kind, shape: {
    boxWidthPx: number(shape.boxWidthPx, TEXT_OVERLAY_LIMITS.minBoxSizePx, TEXT_OVERLAY_LIMITS.maxBoxSizePx),
    boxHeightPx: number(shape.boxHeightPx, TEXT_OVERLAY_LIMITS.minBoxSizePx, TEXT_OVERLAY_LIMITS.maxBoxSizePx),
    fillColor: color(shape.fillColor), outlineEnabled: boolean(shape.outlineEnabled),
    outlineColor: color(shape.outlineColor), outlineWidthPx: number(shape.outlineWidthPx, 0, TEXT_OVERLAY_LIMITS.maxOutlineWidthPx),
  } } }
}

/** Boundary parser; supported output is a defensive data copy, future intent stays opaque. */
export function readTitleElement(value: unknown): TitleElementResult {
  try { checkJson(value); return readElement(value) }
  catch (error) { if (error instanceof TitleDataError) return { status: 'invalid', reason: error.message }; throw error }
}
export function titleElementValidationError(value: unknown): string | null {
  const result = readTitleElement(value)
  return result.status === 'invalid' ? result.reason : null
}
export function readTitleDefinition(value: unknown): TitleDefinitionResult {
  try {
    checkJson(value)
    const item = object(value)
    const titleVersion = version(item.version)
    if (titleVersion !== TITLE_VERSION) {
      // The bounded JSON record and positive version are proven; no payload is interpreted.
      return { status: 'unsupported', title: item as UnknownTitleDefinitionIntent, reason: 'Unsupported title definition version.' }
    }
    keys(item, ['version', 'elements'])
    if (!Array.isArray(item.elements) || item.elements.length < 1 || item.elements.length > TITLE_LIMITS.elements) fail('Titles require from 1 to 16 elements.')
    const elements: TitleElementIntent[] = []
    const ids = new Set<string>()
    let characters = 0
    for (const value of item.elements) {
      const result = readElement(value)
      if (ids.has(result.element.id)) fail('Duplicate title element id.')
      ids.add(result.element.id)
      if (result.status === 'supported' && result.element.kind === 'text') characters += result.element.text.content.length
      if (characters > TITLE_LIMITS.contentCharacters) fail('Title content exceeds 80,000 characters.')
      elements.push(result.element)
    }
    return { status: 'supported', title: { version: TITLE_VERSION, elements } }
  } catch (error) { if (error instanceof TitleDataError) return { status: 'invalid', reason: error.message }; throw error }
}
export function titleDefinitionValidationError(value: unknown): string | null {
  const result = readTitleDefinition(value)
  return result.status === 'invalid' ? result.reason : null
}

export const TITLE_ANIMATION_PROPERTIES = Object.freeze([
  'position-x', 'position-y', 'scale-x', 'scale-y', 'rotation', 'opacity',
  'box-width', 'box-height', 'font-size', 'outline-width', 'shadow-blur', 'shadow-offset-x', 'shadow-offset-y',
] as const)
export type TitleAnimationProperty = (typeof TITLE_ANIMATION_PROPERTIES)[number]
interface PropertySpec {
  readonly property: TitleAnimationProperty
  readonly label: string
  readonly unit: 'px' | 'degrees' | 'multiplier'
  readonly min: number
  readonly max: number
  readonly step: number
}
const property = (property: TitleAnimationProperty, label: string, unit: PropertySpec['unit'], min: number, max: number, step = 1): PropertySpec =>
  Object.freeze({ property, label, unit, min, max, step })
const PROPERTY_SPECS: readonly PropertySpec[] = Object.freeze([
  property('position-x', 'Position X', 'px', -1e9, 1e9), property('position-y', 'Position Y', 'px', -1e9, 1e9),
  property('scale-x', 'Scale X', 'multiplier', MIN_CLIP_SCALE, MAX_CLIP_SCALE, 0.01), property('scale-y', 'Scale Y', 'multiplier', MIN_CLIP_SCALE, MAX_CLIP_SCALE, 0.01),
  property('rotation', 'Rotation', 'degrees', -1e9, 1e9), property('opacity', 'Opacity', 'multiplier', 0, 1, 0.01),
  property('box-width', 'Box width', 'px', 16, 65_535), property('box-height', 'Box height', 'px', 16, 65_535),
  property('font-size', 'Font size', 'px', 8, 1024), property('outline-width', 'Outline width', 'px', 0, 64),
  property('shadow-blur', 'Shadow blur', 'px', 0, 128), property('shadow-offset-x', 'Shadow offset X', 'px', -512, 512),
  property('shadow-offset-y', 'Shadow offset Y', 'px', -512, 512),
])
type PropertyUnavailable = { readonly status: 'unavailable'; readonly reason: 'unsupported-property-version' | 'unknown-property' | 'ineligible-element-kind' }
export type TitleAnimationPropertySpecResult =
  | { readonly status: 'available'; readonly spec: PropertySpec & { readonly propertyVersion: 1; readonly minExclusive: boolean }; readonly fallback: number }
  | PropertyUnavailable

function staticValue(element: TitleElement, property: TitleAnimationProperty): number | null {
  switch (property) {
    case 'position-x': return element.transform.x
    case 'position-y': return element.transform.y
    case 'scale-x': return element.transform.scaleX
    case 'scale-y': return element.transform.scaleY
    case 'rotation': return element.transform.rotation
    case 'opacity': return element.opacity
    case 'box-width': return element.kind === 'text' ? element.text.boxWidthPx : element.shape.boxWidthPx
    case 'box-height': return element.kind === 'text' ? element.text.boxHeightPx : element.shape.boxHeightPx
    case 'outline-width': return element.kind === 'text' ? element.text.outlineWidthPx : element.shape.outlineWidthPx
    case 'font-size': return element.kind === 'text' ? element.text.fontSizePx : null
    case 'shadow-blur': return element.kind === 'text' ? element.text.shadowBlurPx : null
    case 'shadow-offset-x': return element.kind === 'text' ? element.text.shadowOffsetXPx : null
    case 'shadow-offset-y': return element.kind === 'text' ? element.text.shadowOffsetYPx : null
    default: { const exhaustive: never = property; return exhaustive }
  }
}
/** Consume supported boundary-parsed data. No interpolation or render-value quantization. */
export function titleAnimationPropertySpec(element: TitleElement, propertyVersion: number, propertyName: string): TitleAnimationPropertySpecResult {
  if (propertyVersion !== TITLE_PROPERTY_VERSION) return { status: 'unavailable', reason: 'unsupported-property-version' }
  const spec = PROPERTY_SPECS.find((candidate) => candidate.property === propertyName)
  if (!spec) return { status: 'unavailable', reason: 'unknown-property' }
  const fallback = staticValue(element, spec.property)
  if (fallback === null) return { status: 'unavailable', reason: 'ineligible-element-kind' }
  const paddingMinimum = element.kind === 'text' && (spec.property === 'box-width' || spec.property === 'box-height')
    ? element.text.paddingPx * 2 : -Infinity
  return { status: 'available', fallback, spec: {
    ...spec, propertyVersion: TITLE_PROPERTY_VERSION,
    min: Math.max(spec.min, paddingMinimum), minExclusive: paddingMinimum >= spec.min,
  } }
}
export function readTitleAnimationProperty(element: TitleElement, propertyVersion: number, propertyName: string):
  { readonly status: 'available'; readonly value: number } | PropertyUnavailable {
  const result = titleAnimationPropertySpec(element, propertyVersion, propertyName)
  return result.status === 'available' ? { status: 'available', value: result.fallback } : result
}
export interface TitleAnimationValue {
  readonly propertyVersion: number
  readonly property: string
  readonly value: number
}
export type TitleAnimationApplyResult =
  | { readonly status: 'applied'; readonly element: TitleElement }
  | { readonly status: 'rejected'; readonly reason: string }

function applyValue(element: TitleElement, property: TitleAnimationProperty, value: number): TitleElement {
  switch (property) {
    case 'position-x': return { ...element, transform: { ...element.transform, x: value } }
    case 'position-y': return { ...element, transform: { ...element.transform, y: value } }
    case 'scale-x': return { ...element, transform: { ...element.transform, scaleX: value } }
    case 'scale-y': return { ...element, transform: { ...element.transform, scaleY: value } }
    case 'rotation': return { ...element, transform: { ...element.transform, rotation: value } }
    case 'opacity': return { ...element, opacity: value }
    case 'box-width': return element.kind === 'text' ? { ...element, text: { ...element.text, boxWidthPx: value } } : { ...element, shape: { ...element.shape, boxWidthPx: value } }
    case 'box-height': return element.kind === 'text' ? { ...element, text: { ...element.text, boxHeightPx: value } } : { ...element, shape: { ...element.shape, boxHeightPx: value } }
    case 'outline-width': return element.kind === 'text' ? { ...element, text: { ...element.text, outlineWidthPx: value } } : { ...element, shape: { ...element.shape, outlineWidthPx: value } }
    case 'font-size': return element.kind === 'text' ? { ...element, text: { ...element.text, fontSizePx: value } } : element
    case 'shadow-blur': return element.kind === 'text' ? { ...element, text: { ...element.text, shadowBlurPx: value } } : element
    case 'shadow-offset-x': return element.kind === 'text' ? { ...element, text: { ...element.text, shadowOffsetXPx: value } } : element
    case 'shadow-offset-y': return element.kind === 'text' ? { ...element, text: { ...element.text, shadowOffsetYPx: value } } : element
    default: { const exhaustive: never = property; return exhaustive }
  }
}
/** One atomic resolved-value batch. Retains static fallback fields in the caller's original. */
export function applyTitleAnimationValues(element: TitleElement, values: readonly TitleAnimationValue[]): TitleAnimationApplyResult {
  if (values.length > TITLE_ANIMATION_PROPERTIES.length) return { status: 'rejected', reason: 'Too many title scalar values.' }
  const properties = new Set<string>()
  for (const value of values) {
    if (properties.has(value.property)) return { status: 'rejected', reason: 'Duplicate semantic title property, regardless of version.' }
    properties.add(value.property)
  }
  let candidate = element
  for (const value of values) {
    const result = titleAnimationPropertySpec(element, value.propertyVersion, value.property)
    if (result.status !== 'available') return { status: 'rejected', reason: result.reason }
    const { spec } = result
    if (!Number.isFinite(value.value) || value.value < spec.min || value.value > spec.max
      || (spec.minExclusive && value.value === spec.min)) return { status: 'rejected', reason: 'Title scalar exceeds its value or padding bounds.' }
    if (!Object.is(value.value, result.fallback)) candidate = applyValue(candidate, spec.property, value.value)
  }
  return { status: 'applied', element: candidate }
}
