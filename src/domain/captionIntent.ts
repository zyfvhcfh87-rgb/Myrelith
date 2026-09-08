/** Shared resource-free envelope and byte authority for caption style and origin. */
import { utf8ByteLength } from './documentMemory'

export const CAPTION_INTENT_LIMITS = Object.freeze({
  maxKeys: 24,
  maxKeyCharacters: 128,
  maxStringCharacters: 128,
  maxDescriptorBytes: 4_096,
  maxProjectIntentBytes: 2_097_152,
  maxRetainedIntentBytes: 33_554_432,
})

export type CaptionIntentValue = string | number | boolean
export interface CaptionIntentDescriptor {
  readonly version: number
  readonly params: Readonly<Record<string, CaptionIntentValue>>
}


export type CaptionIntentInspection =
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'bounded'; readonly descriptor: CaptionIntentDescriptor; readonly serializedUtf8Bytes: number }

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

export function inspectCaptionIntent(value: unknown): CaptionIntentInspection {
  const envelope = dataEntries(value, 2)
  if (!envelope || envelope.length !== 2 || envelope.some(([key]) => key !== 'version' && key !== 'params')) {
    return { kind: 'invalid', reason: 'Caption intent must contain only version and params data properties' }
  }
  const version = envelope.find(([key]) => key === 'version')?.[1]
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { kind: 'invalid', reason: 'Caption intent version must be a positive safe integer' }
  }
  const entries = dataEntries(envelope.find(([key]) => key === 'params')?.[1], CAPTION_INTENT_LIMITS.maxKeys)
  if (!entries) return { kind: 'invalid', reason: 'Caption intent params must be a bounded plain data record' }
  const checked: [string, CaptionIntentValue][] = []
  for (const [key, parameter] of entries) {
    if (key.length === 0 || key.length > CAPTION_INTENT_LIMITS.maxKeyCharacters) {
      return { kind: 'invalid', reason: 'Caption intent parameter key exceeds its character bound' }
    }
    if (!(typeof parameter === 'boolean'
      || (typeof parameter === 'number' && Number.isFinite(parameter))
      || (typeof parameter === 'string' && parameter.length <= CAPTION_INTENT_LIMITS.maxStringCharacters))) {
      return { kind: 'invalid', reason: `Caption intent parameter ${key} must be a bounded finite primitive` }
    }
    checked.push([key, parameter])
  }
  const params = Object.freeze(Object.fromEntries(checked))
  const descriptor = Object.freeze({ version, params })
  const serializedUtf8Bytes = utf8ByteLength(JSON.stringify(descriptor))
  if (serializedUtf8Bytes > CAPTION_INTENT_LIMITS.maxDescriptorBytes) {
    return { kind: 'invalid', reason: 'Caption intent exceeds its 4 KiB serialized UTF-8 bound' }
  }
  return { kind: 'bounded', descriptor, serializedUtf8Bytes }
}

/** Copy only checked own primitive data; never invoke a caller's toJSON. */
export function copyCaptionIntent(value: CaptionIntentDescriptor): CaptionIntentDescriptor {
  const result = inspectCaptionIntent(value)
  if (result.kind === 'invalid') throw new RangeError(result.reason)
  return result.descriptor
}

/** Structural equality of opaque envelopes does not interpret their fields. */
export function captionIntentEqual(a: CaptionIntentDescriptor | undefined, b: CaptionIntentDescriptor | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.version !== b.version) return false
  const keys = Object.keys(a.params)
  return keys.length === Object.keys(b.params).length
    && keys.every((key) => Object.hasOwn(b.params, key) && a.params[key] === b.params[key])
}
