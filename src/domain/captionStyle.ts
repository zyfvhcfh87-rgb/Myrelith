/** Bounded portable static caption overrides. */
import { CAPTION_INTENT_LIMITS, inspectCaptionIntent, type CaptionIntentDescriptor, type CaptionIntentValue } from './captionIntent'
import type { TextFontFamily } from './schema'
import { isSupportedTextFontFamily } from './textOverlay'

export const CAPTION_STYLE_LIMITS = CAPTION_INTENT_LIMITS
export type CaptionStyleValue = CaptionIntentValue
export type CaptionStyleDescriptor = CaptionIntentDescriptor

export interface CaptionStyleV1 {
  fontFamily: TextFontFamily
  fontSizePermille: number
  color: string
  outlineColor: string
  backgroundColor: string
  bold: boolean
  italic: boolean
  backgroundEnabled: boolean
  /** Omission inherits the preset; legacy shadow color/blur/offsets stay unchanged. */
  shadowEnabled: boolean
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
  shadowEnabled: booleanValue,
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
  const inspected = inspectCaptionIntent(value)
  if (inspected.kind === 'invalid') return { kind: 'invalid', reason: inspected.reason.replace('Caption intent', 'Caption style') }
  const { descriptor, serializedUtf8Bytes } = inspected
  const { version, params } = descriptor
  const checked = Object.entries(params)
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
