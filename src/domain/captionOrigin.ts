/** Historical generation provenance. It makes no claim about edited text accuracy. */
import { captionIntentEqual, inspectCaptionIntent, type CaptionIntentDescriptor, type CaptionIntentValue } from './captionIntent'

export type CaptionOriginDescriptor = CaptionIntentDescriptor
export interface CaptionCueOriginV1 {
  runId: string
  sourceStartSample: number
  sourceSampleCount: number
}
export interface CaptionTrackOriginV1 extends CaptionCueOriginV1 {
  modelId: string
  /** An upstream immutable revision, or composite:<manifest SHA-256>. */
  modelRevision: string
  manifestDigest: string
  runtimeVersion: string
  language: string
  sourceAssetId: string
  sourceFingerprintAlgorithm: 'sha256-sampled-v1' | 'sha256-full-v1'
  sourceFingerprintDigest: string
  sourceSampleRate: number
  targetFrameOffset: number
}
type Inspection<T> =
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly descriptor: CaptionOriginDescriptor; readonly serializedUtf8Bytes: number }
  | { readonly kind: 'supported'; readonly params: Readonly<T>; readonly descriptor: CaptionOriginDescriptor; readonly serializedUtf8Bytes: number }

const portableId = (v: CaptionIntentValue): boolean => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)
const digest = (v: CaptionIntentValue): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v)
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => (v: CaptionIntentValue): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const CUE = { runId: portableId, sourceStartSample: integer(0), sourceSampleCount: integer(1) }
const TRACK = {
  ...CUE,
  modelId: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(v),
  modelRevision: (v) => typeof v === 'string' && /^(?:[0-9a-f]{40}|composite:[0-9a-f]{64})$/u.test(v),
  manifestDigest: digest,
  runtimeVersion: (v) => typeof v === 'string' && /^[0-9][A-Za-z0-9.+_-]*$/u.test(v),
  language: (v) => typeof v === 'string' && /^(?:und|[A-Za-z]{2,8})(?:-[A-Za-z0-9]{1,8})*$/u.test(v),
  sourceAssetId: portableId,
  sourceFingerprintAlgorithm: (v) => v === 'sha256-sampled-v1' || v === 'sha256-full-v1',
  sourceFingerprintDigest: digest,
  sourceSampleRate: integer(1, 768_000),
  targetFrameOffset: integer(0, 1_000_000_000),
} satisfies Record<keyof CaptionTrackOriginV1, (value: CaptionIntentValue) => boolean>

function inspect<T>(value: unknown, validators: Record<string, (value: CaptionIntentValue) => boolean>): Inspection<T> {
  const result = inspectCaptionIntent(value)
  if (result.kind === 'invalid') return result
  const { descriptor, serializedUtf8Bytes } = result
  const bounded = { descriptor, serializedUtf8Bytes }
  if (descriptor.version !== 1 || Object.keys(descriptor.params).some((key) => !Object.hasOwn(validators, key))) {
    return { kind: 'unavailable', reason: 'This caption origin version or fields are unavailable', ...bounded }
  }
  for (const [key, validate] of Object.entries(validators)) {
    if (!Object.hasOwn(descriptor.params, key) || !validate(descriptor.params[key]!)) {
      return { kind: 'invalid', reason: `Caption origin ${key} is missing or invalid` }
    }
  }
  const params = descriptor.params
  if (!Number.isSafeInteger(Number(params.sourceStartSample) + Number(params.sourceSampleCount))) {
    return { kind: 'invalid', reason: 'Caption origin source sample endpoint exceeds safe integer precision' }
  }
  if (typeof params.modelRevision === 'string' && params.modelRevision.startsWith('composite:')
    && params.modelRevision !== `composite:${String(params.manifestDigest)}`) {
    return { kind: 'invalid', reason: 'Caption composite revision must bind the complete manifest digest' }
  }
  // Required own primitives passed their complete closed vocabulary above.
  return { kind: 'supported', params: params as Readonly<T>, ...bounded }
}

export const inspectCaptionTrackOrigin = (value: unknown): Inspection<CaptionTrackOriginV1> => inspect(value, TRACK)
export const inspectCaptionCueOrigin = (value: unknown): Inspection<CaptionCueOriginV1> => inspect(value, CUE)

/** Source identity is historical: removing an asset does not erase its origin. */
export function captionOriginRelationshipError(track: CaptionOriginDescriptor | undefined, cue: CaptionOriginDescriptor | undefined): string | null {
  if (!cue) return null
  const child = inspectCaptionCueOrigin(cue)
  if (child.kind === 'invalid') return child.reason
  if (child.kind === 'unavailable') return null
  if (!track) return 'A known caption cue origin requires its track run origin'
  const parent = inspectCaptionTrackOrigin(track)
  if (parent.kind === 'invalid') return parent.reason
  if (parent.kind === 'unavailable') return null
  return parent.params.runId !== child.params.runId
    || child.params.sourceStartSample < parent.params.sourceStartSample
    || child.params.sourceStartSample + child.params.sourceSampleCount > parent.params.sourceStartSample + parent.params.sourceSampleCount
    ? 'Caption cue origin must belong to the track run and source sample range' : null
}

/** Merge one known run's historical sample coverage; opaque origins must match whole. */
export function mergeCaptionOrigins(a: CaptionOriginDescriptor | undefined, b: CaptionOriginDescriptor | undefined): CaptionOriginDescriptor | undefined {
  if (captionIntentEqual(a, b)) return a
  if (!a || !b) throw new RangeError('Merged captions must have compatible provenance')
  const one = inspectCaptionCueOrigin(a), two = inspectCaptionCueOrigin(b)
  if (one.kind !== 'supported' || two.kind !== 'supported' || one.params.runId !== two.params.runId) {
    throw new RangeError('Merged captions must have compatible provenance')
  }
  const start = Math.min(one.params.sourceStartSample, two.params.sourceStartSample)
  const end = Math.max(one.params.sourceStartSample + one.params.sourceSampleCount, two.params.sourceStartSample + two.params.sourceSampleCount)
  return Object.freeze({ version: 1, params: Object.freeze({ runId: one.params.runId, sourceStartSample: start, sourceSampleCount: end - start }) })
}
