import type { Clip } from './schema'

/** The deliberately small serialized blend-mode vocabulary extended by issue #197. */
export const BLEND_MODE_NAMES = Object.freeze([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'difference',
  'exclusion',
] as const)

export type BlendModeName = (typeof BLEND_MODE_NAMES)[number]

export const DEFAULT_BLEND_MODE: BlendModeName = 'normal'
export const MAX_BLEND_MODE_INTENT_CHARACTERS = 128

export interface BlendModeResolution {
  /** Exact serialized author intent, including a future or otherwise unknown name. */
  intent: string
  /** Safe mode used by the current compositor. */
  effective: BlendModeName
  status: 'supported' | 'compatibility-fallback'
}

/**
 * A stored intent is intentionally more permissive than the current allow-list.
 * This lets newer/future mode names survive an older editor round trip while a
 * bounded compatibility path renders them as normal/source-over.
 */
export function blendModeIntentValidationError(value: unknown): string | null {
  if (typeof value !== 'string') return 'blend mode intent must be a string'
  if (value.length > MAX_BLEND_MODE_INTENT_CHARACTERS) {
    return `blend mode intent must not exceed ${MAX_BLEND_MODE_INTENT_CHARACTERS} characters`
  }
  return null
}

export function isBlendModeName(value: string): value is BlendModeName {
  return (BLEND_MODE_NAMES as readonly string[]).includes(value)
}

/** Historical in-memory fixtures without a field retain source-over behavior. */
export function clipBlendModeIntent(clip: Pick<Clip, 'blendMode'>): string {
  return typeof clip.blendMode === 'string' ? clip.blendMode : DEFAULT_BLEND_MODE
}

export function resolveBlendMode(intent: string | undefined): BlendModeResolution {
  const stored = intent ?? DEFAULT_BLEND_MODE
  if (isBlendModeName(stored)) {
    return { intent: stored, effective: stored, status: 'supported' }
  }
  return {
    intent: stored,
    effective: DEFAULT_BLEND_MODE,
    status: 'compatibility-fallback',
  }
}

/**
 * A crossfade is one isolated visual group. It may use a non-normal mode only
 * when both authored legs agree on the same supported name. Mixed or unknown
 * intent is preserved on the clips but the complete group safely source-overs.
 */
export function resolveTransitionGroupBlendMode(
  from: Pick<Clip, 'blendMode'>,
  to: Pick<Clip, 'blendMode'>,
): BlendModeResolution {
  const fromMode = resolveBlendMode(clipBlendModeIntent(from))
  const toMode = resolveBlendMode(clipBlendModeIntent(to))
  if (
    fromMode.status === 'supported'
    && toMode.status === 'supported'
    && fromMode.effective === toMode.effective
  ) return fromMode

  return {
    intent: DEFAULT_BLEND_MODE,
    effective: DEFAULT_BLEND_MODE,
    status: 'compatibility-fallback',
  }
}

export interface Rgba8 {
  r: number
  g: number
  b: number
  a: number
}

function channelBlend(backdrop: number, source: number, mode: BlendModeName): number {
  if (mode === 'darken') return Math.min(backdrop, source)
  if (mode === 'lighten') return Math.max(backdrop, source)
  if (mode === 'difference') return Math.abs(backdrop - source)
  if (mode === 'exclusion') return backdrop + source - 2 * backdrop * source
  if (mode === 'multiply') return backdrop * source
  if (mode === 'screen') return backdrop + source - backdrop * source
  if (mode === 'overlay') {
    return backdrop <= 0.5
      ? 2 * backdrop * source
      : 1 - 2 * (1 - backdrop) * (1 - source)
  }
  return source
}

function byte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
}

/**
 * Browser-free reference pixel for the normative sRGB, straight-input,
 * premultiplied-alpha source-over model. `sourceOpacity` is applied to source
 * alpha before blending, matching Canvas2D globalAlpha.
 */
export function compositeReferencePixel(
  backdrop: Rgba8,
  source: Rgba8,
  mode: BlendModeName,
  sourceOpacity = 1,
): Rgba8 {
  const alphaBackdrop = backdrop.a / 255
  const alphaSource = (source.a / 255) * Math.min(1, Math.max(0, sourceOpacity))
  const alphaOut = alphaSource + alphaBackdrop * (1 - alphaSource)
  if (alphaOut === 0) return { r: 0, g: 0, b: 0, a: 0 }

  const backdropChannels = [backdrop.r, backdrop.g, backdrop.b].map((value) => value / 255)
  const sourceChannels = [source.r, source.g, source.b].map((value) => value / 255)
  const output = sourceChannels.map((sourceChannel, index) => {
    const backdropChannel = backdropChannels[index]
    const blendedSource = (1 - alphaBackdrop) * sourceChannel
      + alphaBackdrop * channelBlend(backdropChannel, sourceChannel, mode)
    const premultiplied = alphaSource * blendedSource
      + alphaBackdrop * (1 - alphaSource) * backdropChannel
    return byte(premultiplied / alphaOut)
  })

  return { r: output[0], g: output[1], b: output[2], a: byte(alphaOut) }
}
