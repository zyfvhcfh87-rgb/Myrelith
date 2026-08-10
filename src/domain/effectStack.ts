/** Pure effect descriptor registry, validation, migration, and evaluation. */

import type { EffectDescriptor, EffectParamValue } from './schema'
import type { ColorCorrectionParameters } from './colorCorrection'

export const COLOR_ADJUST_EFFECT_TYPE = 'builtin.color-adjust' as const
export const COLOR_ADJUST_EFFECT_VERSION = 1 as const
export const LEGACY_UNVERSIONED_EFFECT_VERSION = 0 as const
export const CANVAS_FILTER_EFFECT_CAPABILITY = 'canvas2d-filter' as const
export const CANVAS_PIXEL_EFFECT_CAPABILITY = 'canvas2d-pixel-access' as const

export interface ColorAdjustParams
  extends Record<string, EffectParamValue>, ColorCorrectionParameters {
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
}

export const DEFAULT_COLOR_ADJUST_PARAMS: Readonly<ColorAdjustParams> = Object.freeze({
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
})

export const COLOR_ADJUST_LIMITS = Object.freeze({
  exposure: Object.freeze({ min: -4, max: 4, step: 0.1 }),
  contrast: Object.freeze({ min: -1, max: 1, step: 0.01 }),
  saturation: Object.freeze({ min: -1, max: 1, step: 0.01 }),
  temperature: Object.freeze({ min: -1, max: 1, step: 0.01 }),
  tint: Object.freeze({ min: -1, max: 1, step: 0.01 }),
})

export type EffectCapability =
  | typeof CANVAS_FILTER_EFFECT_CAPABILITY
  | typeof CANVAS_PIXEL_EFFECT_CAPABILITY

/** Structural probe shared by the compositor and worker capability report. */
export function supportsCanvasEffectFilter(
  surface: { readonly filter?: unknown },
): boolean {
  return typeof surface.filter === 'string'
}

export function supportsCanvasEffectPixels(
  surface: { readonly getImageData?: unknown; readonly putImageData?: unknown },
): boolean {
  return typeof surface.getImageData === 'function'
    && typeof surface.putImageData === 'function'
}

export interface EffectRegistration {
  readonly type: string
  readonly version: number
  readonly label: string
  readonly capabilities: (effect: EffectDescriptor) => readonly EffectCapability[]
  readonly defaultParams: Readonly<Record<string, EffectParamValue>>
  readonly validateParams: (params: Readonly<Record<string, EffectParamValue>>) => string | null
  readonly migrateLegacy: (effect: EffectDescriptor) => EffectDescriptor | null
  readonly canvasFilter: (effect: EffectDescriptor) => string
}

const COLOR_ADJUST_REGISTRATION: EffectRegistration = Object.freeze({
  type: COLOR_ADJUST_EFFECT_TYPE,
  version: COLOR_ADJUST_EFFECT_VERSION,
  label: 'Color adjustment',
  capabilities: colorAdjustCapabilities,
  defaultParams: DEFAULT_COLOR_ADJUST_PARAMS,
  validateParams: validateColorAdjustParams,
  migrateLegacy: migrateLegacyColorAdjust,
  canvasFilter: colorAdjustFilter,
})

const EFFECT_REGISTRY = new Map<string, EffectRegistration>([
  [COLOR_ADJUST_EFFECT_TYPE, COLOR_ADJUST_REGISTRATION],
])

export function registeredEffects(): readonly EffectRegistration[] {
  return [...EFFECT_REGISTRY.values()]
}

export function effectRegistration(type: string): EffectRegistration | null {
  return EFFECT_REGISTRY.get(type) ?? null
}

export function cloneEffectDescriptor(effect: EffectDescriptor): EffectDescriptor {
  return { ...effect, params: { ...effect.params } }
}

export function createColorAdjustEffect(id: string): EffectDescriptor {
  return {
    id,
    type: COLOR_ADJUST_EFFECT_TYPE,
    version: COLOR_ADJUST_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_COLOR_ADJUST_PARAMS },
  }
}

function finiteInRange(value: EffectParamValue | undefined, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function optionalFiniteInRange(
  value: EffectParamValue | undefined,
  min: number,
  max: number,
): boolean {
  return value === undefined || finiteInRange(value, min, max)
}

export function colorAdjustParams(effect: EffectDescriptor): ColorAdjustParams {
  return {
    exposure: effect.params.exposure as number,
    contrast: effect.params.contrast as number,
    saturation: effect.params.saturation as number,
    temperature: (effect.params.temperature as number | undefined) ?? 0,
    tint: (effect.params.tint as number | undefined) ?? 0,
  }
}

function colorAdjustIsIdentity(effect: EffectDescriptor): boolean {
  const params = colorAdjustParams(effect)
  return params.exposure === 0
    && params.contrast === 0
    && params.saturation === 0
    && params.temperature === 0
    && params.tint === 0
}

function colorAdjustCapabilities(effect: EffectDescriptor): readonly EffectCapability[] {
  if (colorAdjustIsIdentity(effect)) return []
  const params = colorAdjustParams(effect)
  return params.temperature === 0 && params.tint === 0
    ? [CANVAS_FILTER_EFFECT_CAPABILITY]
    : [CANVAS_PIXEL_EFFECT_CAPABILITY]
}

/** Validate registered semantics without rejecting opaque unknown descriptors. */
function validateColorAdjustParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  if (!finiteInRange(
    params.exposure,
    COLOR_ADJUST_LIMITS.exposure.min,
    COLOR_ADJUST_LIMITS.exposure.max,
  )) {
    return `exposure must be between ${COLOR_ADJUST_LIMITS.exposure.min} and ${COLOR_ADJUST_LIMITS.exposure.max}`
  }
  if (!finiteInRange(
    params.contrast,
    COLOR_ADJUST_LIMITS.contrast.min,
    COLOR_ADJUST_LIMITS.contrast.max,
  )) {
    return `contrast must be between ${COLOR_ADJUST_LIMITS.contrast.min} and ${COLOR_ADJUST_LIMITS.contrast.max}`
  }
  if (!finiteInRange(
    params.saturation,
    COLOR_ADJUST_LIMITS.saturation.min,
    COLOR_ADJUST_LIMITS.saturation.max,
  )) {
    return `saturation must be between ${COLOR_ADJUST_LIMITS.saturation.min} and ${COLOR_ADJUST_LIMITS.saturation.max}`
  }
  if (!optionalFiniteInRange(
    params.temperature,
    COLOR_ADJUST_LIMITS.temperature.min,
    COLOR_ADJUST_LIMITS.temperature.max,
  )) {
    return `temperature must be between ${COLOR_ADJUST_LIMITS.temperature.min} and ${COLOR_ADJUST_LIMITS.temperature.max}`
  }
  if (!optionalFiniteInRange(
    params.tint,
    COLOR_ADJUST_LIMITS.tint.min,
    COLOR_ADJUST_LIMITS.tint.max,
  )) {
    return `tint must be between ${COLOR_ADJUST_LIMITS.tint.min} and ${COLOR_ADJUST_LIMITS.tint.max}`
  }
  return null
}

export function effectParamsValidationError(effect: EffectDescriptor): string | null {
  const registration = effectRegistration(effect.type)
  if (!registration) return null
  if (effect.version !== registration.version) {
    return `unsupported ${effect.type} version ${effect.version}; expected ${registration.version}`
  }
  return registration.validateParams(effect.params)
}

function migrateLegacyColorAdjust(effect: EffectDescriptor): EffectDescriptor | null {
  if (effect.version !== LEGACY_UNVERSIONED_EFFECT_VERSION) return null
  return {
    ...effect,
    version: COLOR_ADJUST_EFFECT_VERSION,
    params: { ...DEFAULT_COLOR_ADJUST_PARAMS, ...effect.params },
  }
}

/**
 * Upgrade descriptors owned by this registry. Unknown types and future
 * versions are cloned byte-for-byte at the JSON value level and remain opaque.
 */
export function migrateEffectDescriptor(effect: EffectDescriptor): EffectDescriptor {
  const registration = effectRegistration(effect.type)
  return registration?.migrateLegacy(effect) ?? cloneEffectDescriptor(effect)
}

export type EffectResolutionStatus = 'ready' | 'disabled' | 'invalid' | 'unsupported'

export interface EffectResolution {
  readonly effect: EffectDescriptor
  readonly label: string
  readonly status: EffectResolutionStatus
  readonly detail: string
  readonly canvasFilter: string | null
}

function compactNumber(value: number): string {
  return Number(value.toFixed(6)).toString()
}

function colorAdjustFilter(effect: EffectDescriptor): string {
  const exposure = effect.params.exposure as number
  const contrast = effect.params.contrast as number
  const saturation = effect.params.saturation as number
  return [
    `brightness(${compactNumber(2 ** exposure)})`,
    `contrast(${compactNumber(1 + contrast)})`,
    `saturate(${compactNumber(1 + saturation)})`,
  ].join(' ')
}

/** Resolve an ordered stack deterministically. Bad entries are reported and bypassed. */
export function resolveEffectStack(
  effects: readonly EffectDescriptor[],
  capabilities: ReadonlySet<EffectCapability>,
): readonly EffectResolution[] {
  return effects.map((effect) => {
    const registration = effectRegistration(effect.type)
    if (!registration) {
      return {
        effect,
        label: effect.type || 'Unknown effect',
        status: 'unsupported',
        detail: `Effect type “${effect.type || '(empty)'}” is not installed; its data is preserved.`,
        canvasFilter: null,
      }
    }
    if (effect.version !== registration.version) {
      return {
        effect,
        label: registration.label,
        status: 'unsupported',
        detail: `Version ${effect.version} is not supported; expected ${registration.version}. Its data is preserved.`,
        canvasFilter: null,
      }
    }
    const validationError = effectParamsValidationError(effect)
    if (validationError) {
      return {
        effect,
        label: registration.label,
        status: 'invalid',
        detail: `${validationError}; the effect is bypassed.`,
        canvasFilter: null,
      }
    }
    const missingCapability = registration.capabilities(effect).find((capability) =>
      !capabilities.has(capability),
    )
    if (missingCapability) {
      return {
        effect,
        label: registration.label,
        status: 'unsupported',
        detail: `This renderer does not provide ${missingCapability}; the effect is bypassed.`,
        canvasFilter: null,
      }
    }
    if (!effect.enabled) {
      return {
        effect,
        label: registration.label,
        status: 'disabled',
        detail: 'Bypassed by the effect toggle.',
        canvasFilter: null,
      }
    }
    return {
      effect,
      label: registration.label,
      status: 'ready',
      detail: 'Applied in stack order.',
      canvasFilter: registration.canvasFilter(effect),
    }
  })
}

export interface CanvasEffectStackResolution {
  readonly filter: string | null
  readonly pixelCorrections: readonly ColorCorrectionParameters[]
  readonly effects: readonly EffectResolution[]
}

/** Concatenate Canvas2D filters in authored order; null is an exact no-op path. */
export function resolveCanvasEffectStack(
  effects: readonly EffectDescriptor[],
  supportsCanvasFilter: boolean,
  supportsPixelAccess = false,
): CanvasEffectStackResolution {
  const capabilities = new Set<EffectCapability>()
  if (supportsCanvasFilter) capabilities.add(CANVAS_FILTER_EFFECT_CAPABILITY)
  if (supportsPixelAccess) capabilities.add(CANVAS_PIXEL_EFFECT_CAPABILITY)
  const resolutions = resolveEffectStack(effects, capabilities)
  const usePixelPath = resolutions.some((resolution) => (
    resolution.status === 'ready'
    && resolution.effect.type === COLOR_ADJUST_EFFECT_TYPE
    && colorAdjustCapabilities(resolution.effect).includes(CANVAS_PIXEL_EFFECT_CAPABILITY)
  ))
  const pixelCorrections = usePixelPath
    ? resolutions.flatMap((resolution) => (
        resolution.status === 'ready'
        && resolution.effect.type === COLOR_ADJUST_EFFECT_TYPE
        && !colorAdjustIsIdentity(resolution.effect)
          ? [colorAdjustParams(resolution.effect)]
          : []
      ))
    : []
  const filters = resolutions.flatMap((resolution) =>
    usePixelPath
    || resolution.canvasFilter === null
    || (
      resolution.effect.type === COLOR_ADJUST_EFFECT_TYPE
      && colorAdjustIsIdentity(resolution.effect)
    )
      ? []
      : [resolution.canvasFilter],
  )
  return {
    filter: filters.length === 0 ? null : filters.join(' '),
    pixelCorrections,
    effects: resolutions,
  }
}
