/** Bounded portable static caption overrides; no schema or painter wiring yet. */
import { utf8ByteLength } from './documentMemory'
import type { TextFontFamily } from './schema'
import { isSupportedTextFontFamily } from './textOverlay'

export const CAPTION_STYLE_LIMITS = Object.freeze({
  maxKeys: 24,
  maxKeyCharacters: 128,
  maxStringCharacters: 128,
  maxDescriptorBytes: 4_096,
  maxProjectIntentBytes: 2_097_152,
  maxRetainedIntentBytes: 33_554_432,
})

export type CaptionStyleValue = string | number | boolean
export interface CaptionStyleDescriptor {
  readonly version: number
  readonly params: Readonly<Record<string, CaptionStyleValue>>
}

export interface CaptionStyleV1 {
  fontFamily: TextFontFamily
  fontSizePermille: number
  color: string
  outlineColor: string
  backgroundColor: string
  bold: boolean
  italic: boolean
  backgroundEnabled: boolean
  outlineEnabled: boolean
  outlinePermille: number
  align: 'left' | 'center' | 'right'
  position: 'top' | 'middle' | 'bottom'
  marginXPermille: number
  marginYPermille: number
}

interface BoundedStyle {
  readonly descriptor: CaptionStyleDescriptor
  readonly serializedUtf8Bytes: number
}
export type CaptionStyleInspection =
  | { readonly kind: 'invalid'; readonly reason: string }
  | ({ readonly kind: 'unavailable'; readonly reason: string } & BoundedStyle)
  | ({ readonly kind: 'supported'; readonly params: Readonly<Partial<CaptionStyleV1>> } & BoundedStyle)

type DataEntry = readonly [string, unknown]
/** Read ordinary enumerable data properties only; never invoke accessors/toJSON. */
function dataEntries(value: unknown, maxKeys: number): readonly DataEntry[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length > maxKeys) return null
  const result: DataEntry[] = []
  for (const key of keys) {
    if (typeof key !== 'string') return null
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) return null
    result.push([key, property.value])
  }
  return result
}

const finiteRange = (minimum: number, maximum: number) => (value: CaptionStyleValue): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
const booleanValue = (value: CaptionStyleValue): boolean => typeof value === 'boolean'
const rgbaColor = (value: CaptionStyleValue): boolean => typeof value === 'string' && /^#[0-9a-f]{8}$/u.test(value)
const VALIDATORS = {
  fontFamily: isSupportedTextFontFamily,
  fontSizePermille: finiteRange(8, 150),
  color: rgbaColor,
  outlineColor: rgbaColor,
  backgroundColor: rgbaColor,
  bold: booleanValue,
  italic: booleanValue,
  backgroundEnabled: booleanValue,
  outlineEnabled: booleanValue,
  outlinePermille: finiteRange(0, 10),
  align: (value) => value === 'left' || value === 'center' || value === 'right',
  position: (value) => value === 'top' || value === 'middle' || value === 'bottom',
  marginXPermille: finiteRange(0, 250),
  marginYPermille: finiteRange(0, 250),
} satisfies Record<keyof CaptionStyleV1, (value: CaptionStyleValue) => boolean>

function knownKey(value: string): value is keyof CaptionStyleV1 {
  return Object.hasOwn(VALIDATORS, value)
}

/**
 * Unknown versions/keys survive within the primitive envelope. The entire
 * unknown override is unavailable; none of its apparently known fields apply.
 */
export function inspectCaptionStyle(value: unknown): CaptionStyleInspection {
  const envelope = dataEntries(value, 2)
  if (!envelope || envelope.length !== 2 || envelope.some(([key]) => key !== 'version' && key !== 'params')) {
    return { kind: 'invalid', reason: 'Caption style must contain only version and params data properties' }
  }
  const version = envelope.find(([key]) => key === 'version')?.[1]
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { kind: 'invalid', reason: 'Caption style version must be a positive safe integer' }
  }
  const entries = dataEntries(envelope.find(([key]) => key === 'params')?.[1], CAPTION_STYLE_LIMITS.maxKeys)
  if (!entries) return { kind: 'invalid', reason: 'Caption style params must be a bounded plain data record' }
  const checked: [string, CaptionStyleValue][] = []
  for (const [key, parameter] of entries) {
    if (key.length === 0 || key.length > CAPTION_STYLE_LIMITS.maxKeyCharacters) {
      return { kind: 'invalid', reason: 'Caption style parameter key exceeds its character bound' }
    }
    if (!(typeof parameter === 'boolean'
      || (typeof parameter === 'number' && Number.isFinite(parameter))
      || (typeof parameter === 'string' && parameter.length <= CAPTION_STYLE_LIMITS.maxStringCharacters))) {
      return { kind: 'invalid', reason: `Caption style parameter ${key} must be a bounded finite primitive` }
    }
    checked.push([key, parameter])
  }
  const params = Object.freeze(Object.fromEntries(checked))
  const descriptor = Object.freeze({ version, params })
  const serializedUtf8Bytes = utf8ByteLength(JSON.stringify(descriptor))
  if (serializedUtf8Bytes > CAPTION_STYLE_LIMITS.maxDescriptorBytes) {
    return { kind: 'invalid', reason: 'Caption style exceeds its 4 KiB serialized UTF-8 bound' }
  }
  const bounded = { descriptor, serializedUtf8Bytes }
  if (version !== 1) return { kind: 'unavailable', reason: `Caption style version ${version} is unavailable`, ...bounded }
  const unknown = checked.filter(([key]) => !knownKey(key)).map(([key]) => key).sort()
  if (unknown.length) return { kind: 'unavailable', reason: `Caption style fields are unavailable: ${unknown.join(', ')}`, ...bounded }
  for (const [key, parameter] of checked) {
    if (!knownKey(key) || !VALIDATORS[key](parameter)) {
      return { kind: 'invalid', reason: `Caption style ${key} has an unsupported value` }
    }
  }
  // Every own key and value passed its closed v1 validator above.
  return { kind: 'supported', params: params as Readonly<Partial<CaptionStyleV1>>, ...bounded }
}

export interface CombinedCaptionStyleOverrides {
  readonly params: Readonly<Partial<CaptionStyleV1>>
  readonly unavailable: readonly { readonly level: 'track' | 'cue'; readonly reason: string }[]
  readonly serializedUtf8Bytes: number
}

/** Merge supported track then cue values, preserving unavailable-level reports. */
export function combineCaptionStyleOverrides(
  track: CaptionStyleDescriptor | undefined,
  cue: CaptionStyleDescriptor | undefined,
): CombinedCaptionStyleOverrides {
  let params: Readonly<Partial<CaptionStyleV1>> = {}
  const unavailable: { level: 'track' | 'cue'; reason: string }[] = []
  let serializedUtf8Bytes = 0
  for (const [level, value] of [['track', track], ['cue', cue]] as const) {
    if (value === undefined) continue
    const inspected = inspectCaptionStyle(value)
    if (inspected.kind === 'invalid') throw new RangeError(inspected.reason)
    serializedUtf8Bytes += inspected.serializedUtf8Bytes
    if (inspected.kind === 'unavailable') unavailable.push({ level, reason: inspected.reason })
    else params = { ...params, ...inspected.params }
  }
  return { params: Object.freeze(params), unavailable: Object.freeze(unavailable), serializedUtf8Bytes }
}
