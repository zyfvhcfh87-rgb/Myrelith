/** Pure effect descriptor registry, validation, migration, and evaluation. */

import type { EffectDescriptor, EffectParamValue } from './schema'
import { spatialEffectRegistrations, type SpatialPixelEffect } from './spatialEffectDefinitions'
import type { ColorCorrectionParameters } from './colorCorrection'
import { maskBezierPathValidationError } from './maskPath'

export const COLOR_ADJUST_EFFECT_TYPE = 'builtin.color-adjust' as const
export const COLOR_ADJUST_EFFECT_VERSION = 1 as const
export const MASK_EFFECT_TYPE = 'builtin.mask' as const
export const MASK_EFFECT_VERSION = 1 as const
export const CHROMA_KEY_EFFECT_TYPE = 'builtin.chroma-key' as const
export const CHROMA_KEY_EFFECT_VERSION = 1 as const
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

export type MaskShape = 'rectangle' | 'ellipse' | 'bezier'

export interface MaskParams extends Record<string, EffectParamValue> {
  shape: MaskShape
  /** Left edge in normalized project-space coordinates. */
  x: number
  /** Top edge in normalized project-space coordinates. */
  y: number
  /** Bounding-box width as a fraction of project width. */
  width: number
  /** Bounding-box height as a fraction of project height. */
  height: number
  /** Feather distance as a fraction of the shorter project dimension. */
  feather: number
  invert: boolean
  /** Bounded normalized M/C/Z path, used only by the bezier shape. */
  path: string
}

export interface ChromaKeyParams extends Record<string, EffectParamValue> {
  color: string
  tolerance: number
  softness: number
  spill: number
}

export const MASK_LIMITS = Object.freeze({
  x: Object.freeze({ min: -4, max: 4, step: 0.01, label: 'Left (%)' }),
  y: Object.freeze({ min: -4, max: 4, step: 0.01, label: 'Top (%)' }),
  width: Object.freeze({ min: 0.001, max: 8, step: 0.01, label: 'Width (%)' }),
  height: Object.freeze({ min: 0.001, max: 8, step: 0.01, label: 'Height (%)' }),
  feather: Object.freeze({ min: 0, max: 1, step: 0.005, label: 'Feather (%)' }),
})

export const CHROMA_KEY_LIMITS = Object.freeze({
  tolerance: Object.freeze({ min: 0, max: 1, step: 0.01, label: 'Tolerance (%)' }),
  softness: Object.freeze({ min: 0, max: 1, step: 0.01, label: 'Softness (%)' }),
  spill: Object.freeze({ min: 0, max: 1, step: 0.01, label: 'Spill suppression (%)' }),
})

export const DEFAULT_MASK_BEZIER_PATH = [
  'M 0.5 0',
  'C 0.776142 0 1 0.223858 1 0.5',
  'C 1 0.776142 0.776142 1 0.5 1',
  'C 0.223858 1 0 0.776142 0 0.5',
  'C 0 0.223858 0.223858 0 0.5 0',
  'Z',
].join(' ')

export const DEFAULT_MASK_PARAMS: Readonly<MaskParams> = Object.freeze({
  shape: 'rectangle',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  feather: 0,
  invert: false,
  path: DEFAULT_MASK_BEZIER_PATH,
})

export const DEFAULT_CHROMA_KEY_PARAMS: Readonly<ChromaKeyParams> = Object.freeze({
  color: '#00ff00',
  tolerance: 0.08,
  softness: 0.12,
  spill: 0.5,
})

export interface EffectAnimationParameterSpec {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
}

export type CanvasPixelEffect =
  | SpatialPixelEffect
  | { readonly kind: 'color-adjust'; readonly params: ColorCorrectionParameters }
  | { readonly kind: 'mask'; readonly params: MaskParams }
  | { readonly kind: 'chroma-key'; readonly params: ChromaKeyParams }

export type EffectCapability =
  | typeof CANVAS_FILTER_EFFECT_CAPABILITY
  | typeof CANVAS_PIXEL_EFFECT_CAPABILITY

/** The authored surface on which an effect is semantically valid. */
export type EffectSurface = 'source-layer' | 'post-composite'

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
  readonly surfaces: readonly EffectSurface[]
  /** Explicit prerequisite for sharing an opaque nested composite with video buses. */
  readonly preservesOpaqueInput?: true
  readonly capabilities: (effect: EffectDescriptor) => readonly EffectCapability[]
  readonly defaultParams: Readonly<Record<string, EffectParamValue>>
  readonly validateParams: (params: Readonly<Record<string, EffectParamValue>>) => string | null
  readonly migrateLegacy: (effect: EffectDescriptor) => EffectDescriptor | null
  readonly canvasFilter: (effect: EffectDescriptor) => string
  readonly pixelEffect: (effect: EffectDescriptor) => CanvasPixelEffect | null
  readonly animatableParams: Readonly<Record<string, EffectAnimationParameterSpec>>
}

const COLOR_ADJUST_REGISTRATION: EffectRegistration = Object.freeze({
  type: COLOR_ADJUST_EFFECT_TYPE,
  version: COLOR_ADJUST_EFFECT_VERSION,
  label: 'Color adjustment',
  surfaces: Object.freeze(['source-layer', 'post-composite'] as const),
  preservesOpaqueInput: true,
  capabilities: colorAdjustCapabilities,
  defaultParams: DEFAULT_COLOR_ADJUST_PARAMS,
  validateParams: validateColorAdjustParams,
  migrateLegacy: migrateLegacyColorAdjust,
  canvasFilter: colorAdjustFilter,
  pixelEffect: (effect: EffectDescriptor) => colorAdjustIsIdentity(effect)
    ? null
    : { kind: 'color-adjust' as const, params: colorAdjustParams(effect) },
  animatableParams: Object.freeze({
    exposure: Object.freeze({ ...COLOR_ADJUST_LIMITS.exposure, label: 'Exposure' }),
    contrast: Object.freeze({ ...COLOR_ADJUST_LIMITS.contrast, label: 'Contrast' }),
    saturation: Object.freeze({ ...COLOR_ADJUST_LIMITS.saturation, label: 'Saturation' }),
    temperature: Object.freeze({ ...COLOR_ADJUST_LIMITS.temperature, label: 'Temperature' }),
    tint: Object.freeze({ ...COLOR_ADJUST_LIMITS.tint, label: 'Tint' }),
  }),
})

const MASK_REGISTRATION: EffectRegistration = Object.freeze({
  type: MASK_EFFECT_TYPE,
  version: MASK_EFFECT_VERSION,
  label: 'Mask',
  surfaces: Object.freeze(['source-layer'] as const),
  capabilities: (effect: EffectDescriptor) => maskIsIdentity(effect)
    ? []
    : [CANVAS_PIXEL_EFFECT_CAPABILITY],
  defaultParams: DEFAULT_MASK_PARAMS,
  validateParams: validateMaskParams,
  migrateLegacy: () => null,
  canvasFilter: () => '',
  pixelEffect: (effect: EffectDescriptor) => maskIsIdentity(effect)
    ? null
    : { kind: 'mask' as const, params: maskParams(effect) },
  animatableParams: MASK_LIMITS,
})

const CHROMA_KEY_REGISTRATION: EffectRegistration = Object.freeze({
  type: CHROMA_KEY_EFFECT_TYPE,
  version: CHROMA_KEY_EFFECT_VERSION,
  label: 'Chroma key',
  surfaces: Object.freeze(['source-layer'] as const),
  capabilities: () => [CANVAS_PIXEL_EFFECT_CAPABILITY],
  defaultParams: DEFAULT_CHROMA_KEY_PARAMS,
  validateParams: validateChromaKeyParams,
  migrateLegacy: () => null,
  canvasFilter: () => '',
  pixelEffect: (effect: EffectDescriptor) => ({
    kind: 'chroma-key' as const,
    params: chromaKeyParams(effect),
  }),
  animatableParams: {},
})

const EFFECT_REGISTRY = new Map<string, EffectRegistration>([
  ...spatialEffectRegistrations().map((entry): [string, EffectRegistration] => [entry.type, entry]),
  [COLOR_ADJUST_EFFECT_TYPE, COLOR_ADJUST_REGISTRATION],
  [MASK_EFFECT_TYPE, MASK_REGISTRATION],
  [CHROMA_KEY_EFFECT_TYPE, CHROMA_KEY_REGISTRATION],
])

export function registeredEffects(): readonly EffectRegistration[] {
  return [...EFFECT_REGISTRY.values()]
}

export function effectRegistration(type: string): EffectRegistration | null {
  return EFFECT_REGISTRY.get(type) ?? null
}

export function effectSupportsSurface(
  effect: EffectDescriptor,
  surface: EffectSurface,
): boolean {
  const registration = effectRegistration(effect.type)
  return registration?.version === effect.version
    && registration.surfaces.includes(surface)
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

export function createMaskEffect(id: string, shape: MaskShape): EffectDescriptor {
  return {
    id,
    type: MASK_EFFECT_TYPE,
    version: MASK_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_MASK_PARAMS, shape },
  }
}

export function createChromaKeyEffect(id: string): EffectDescriptor {
  return {
    id,
    type: CHROMA_KEY_EFFECT_TYPE,
    version: CHROMA_KEY_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_CHROMA_KEY_PARAMS },
  }
}

export function effectAnimationParameterSpec(
  effect: EffectDescriptor,
  parameter: string,
): EffectAnimationParameterSpec | null {
  const registration = effectRegistration(effect.type)
  if (!registration || registration.version !== effect.version) return null
  return registration.animatableParams[parameter] ?? null
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

function requiredString(value: EffectParamValue | undefined): value is string {
  return typeof value === 'string'
}

function requiredBoolean(value: EffectParamValue | undefined): value is boolean {
  return typeof value === 'boolean'
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

export function maskParams(effect: EffectDescriptor): MaskParams {
  return {
    shape: effect.params.shape as MaskShape,
    x: effect.params.x as number,
    y: effect.params.y as number,
    width: effect.params.width as number,
    height: effect.params.height as number,
    feather: effect.params.feather as number,
    invert: effect.params.invert as boolean,
    path: effect.params.path as string,
  }
}

export function chromaKeyParams(effect: EffectDescriptor): ChromaKeyParams {
  return {
    color: effect.params.color as string,
    tolerance: effect.params.tolerance as number,
    softness: effect.params.softness as number,
    spill: effect.params.spill as number,
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

function maskIsIdentity(effect: EffectDescriptor): boolean {
  const params = maskParams(effect)
  return params.shape === 'rectangle'
    && params.x === 0
    && params.y === 0
    && params.width === 1
    && params.height === 1
    && params.feather === 0
    && !params.invert
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

function validateMaskParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  if (params.shape !== 'rectangle' && params.shape !== 'ellipse' && params.shape !== 'bezier') {
    return 'shape must be rectangle, ellipse, or bezier'
  }
  for (const parameter of ['x', 'y', 'width', 'height', 'feather'] as const) {
    const limit = MASK_LIMITS[parameter]
    if (!finiteInRange(params[parameter], limit.min, limit.max)) {
      return `${parameter} must be between ${limit.min} and ${limit.max}`
    }
  }
  if (!requiredBoolean(params.invert)) return 'invert must be a boolean'
  if (!requiredString(params.path)) return 'path must be a string'
  if (params.shape === 'bezier') return maskBezierPathValidationError(params.path)
  return null
}

function validateChromaKeyParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  if (!requiredString(params.color) || !/^#[0-9a-f]{6}$/i.test(params.color)) {
    return 'color must be a six-digit hex color'
  }
  for (const parameter of ['tolerance', 'softness', 'spill'] as const) {
    const limit = CHROMA_KEY_LIMITS[parameter]
    if (!finiteInRange(params[parameter], limit.min, limit.max)) {
      return `${parameter} must be between ${limit.min} and ${limit.max}`
    }
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
    const canvasFilter = registration.canvasFilter(effect)
    return {
      effect,
      label: registration.label,
      status: 'ready',
      detail: 'Applied in stack order.',
      canvasFilter: canvasFilter === '' ? null : canvasFilter,
    }
  })
}

export interface CanvasEffectStackResolution {
  readonly filter: string | null
  /** Complete executable stack whenever any ready effect needs pixel access. */
  readonly pixelEffects: readonly CanvasPixelEffect[]
  /** Backward-compatible color-only projection for existing callers/tests. */
  readonly pixelCorrections: readonly ColorCorrectionParameters[]
  readonly effects: readonly EffectResolution[]
}

/**
 * Resolve the bounded full-frame adjustment vocabulary. Unknown, future, and
 * source-layer-only descriptors stay ordered and portable but are explicitly
 * bypassed. Every executable post-composite contribution uses the existing
 * pixel evaluator, which makes opacity mixing and preview/export parity exact.
 */
export function resolvePostCompositeEffectStack(
  effects: readonly EffectDescriptor[],
  supportsPixelAccess: boolean,
): CanvasEffectStackResolution {
  const capabilities = new Set<EffectCapability>([
    CANVAS_FILTER_EFFECT_CAPABILITY,
    ...(supportsPixelAccess ? [CANVAS_PIXEL_EFFECT_CAPABILITY] : []),
  ])
  const effectsResolution = resolveEffectStack(effects, capabilities).map((resolution) => {
    if (effectSupportsSurface(resolution.effect, 'post-composite')) return resolution
    const registration = effectRegistration(resolution.effect.type)
    return {
      ...resolution,
      label: registration?.label ?? resolution.label,
      status: 'unsupported' as const,
      detail: registration
        ? 'This effect requires a source layer and is visibly bypassed on an adjustment item.'
        : resolution.detail,
      canvasFilter: null,
    }
  })
  const pixelEffects = supportsPixelAccess
    ? effectsResolution.flatMap((resolution) => (
        resolution.status === 'ready'
          ? effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect) ?? []
          : []
      ))
    : []
  return {
    filter: null,
    pixelEffects,
    pixelCorrections: pixelEffects.flatMap((effect) => (
      effect.kind === 'color-adjust' ? [effect.params] : []
    )),
    effects: effectsResolution,
  }
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
    && effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect) !== null
    && effectRegistration(resolution.effect.type)?.capabilities(resolution.effect)
      .includes(CANVAS_PIXEL_EFFECT_CAPABILITY)
  ))
  const pixelEffects = usePixelPath
    ? resolutions.flatMap((resolution) => (
        resolution.status === 'ready'
          ? effectRegistration(resolution.effect.type)?.pixelEffect(resolution.effect) ?? []
          : []
      ))
    : []
  const pixelCorrections = pixelEffects.flatMap((effect) =>
    effect.kind === 'color-adjust' ? [effect.params] : [],
  )
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
    pixelEffects,
    pixelCorrections,
    effects: resolutions,
  }
}
