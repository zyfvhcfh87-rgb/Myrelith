import type { EffectDescriptor, EffectParamValue } from './schema'
import type { EffectRegistration } from './effectStack'

export type SpatialEffectKind = 'box-blur' | 'sharpen' | 'vignette' | 'drop-shadow' | 'outline'
export interface SpatialPixelEffect { readonly kind: SpatialEffectKind; readonly params: Readonly<Record<string, EffectParamValue>> }
interface Parameter { readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly default: number }
export const SPATIAL_EFFECT_PARAMETERS: Readonly<Record<SpatialEffectKind, Readonly<Record<string, Parameter>>>> = {
  'box-blur': { radius: { label: 'Radius (project px)', min: 0, max: 32, step: 1, default: 0 } },
  sharpen: { amount: { label: 'Amount', min: 0, max: 2, step: 0.05, default: 0 } },
  vignette: {
    strength: { label: 'Strength', min: 0, max: 1, step: 0.01, default: 0 },
    radius: { label: 'Clear center', min: 0, max: 0.99, step: 0.01, default: 0.5 },
    softness: { label: 'Softness', min: 0.01, max: 1, step: 0.01, default: 0.5 },
  },
  'drop-shadow': {
    radius: { label: 'Blur radius (project px)', min: 0, max: 32, step: 1, default: 8 },
    offsetX: { label: 'Offset X (project px)', min: -64, max: 64, step: 1, default: 8 },
    offsetY: { label: 'Offset Y (project px)', min: -64, max: 64, step: 1, default: 8 },
    opacity: { label: 'Shadow opacity', min: 0, max: 1, step: 0.01, default: 0 },
  },
  outline: {
    width: { label: 'Width (project px)', min: 0, max: 32, step: 1, default: 0 },
    opacity: { label: 'Outline opacity', min: 0, max: 1, step: 0.01, default: 1 },
  },
}
for (const parameters of Object.values(SPATIAL_EFFECT_PARAMETERS)) {
  Object.values(parameters).forEach(Object.freeze)
  Object.freeze(parameters)
}
Object.freeze(SPATIAL_EFFECT_PARAMETERS)
export const SPATIAL_EFFECT_LABELS: Readonly<Record<SpatialEffectKind, string>> = {
  'box-blur': 'Box blur', sharpen: 'Sharpen', vignette: 'Vignette', 'drop-shadow': 'Drop shadow', outline: 'Outline',
}
export function spatialEffectKind(type: string): SpatialEffectKind | null {
  const kind = type.slice('builtin.'.length)
  return type.startsWith('builtin.') && Object.hasOwn(SPATIAL_EFFECT_PARAMETERS, kind) ? kind as SpatialEffectKind : null
}
export function spatialEffectParams(kind: SpatialEffectKind, raw: Readonly<Record<string, EffectParamValue>>): Record<string, EffectParamValue> {
  const params: Record<string, EffectParamValue> = {}
  for (const [key, spec] of Object.entries(SPATIAL_EFFECT_PARAMETERS[kind])) params[key] = raw[key] ?? spec.default
  if (kind === 'drop-shadow' || kind === 'outline') params.color = raw.color ?? '#000000'
  return params
}
export function spatialEffectIsIdentity(kind: SpatialEffectKind, params: Readonly<Record<string, EffectParamValue>>): boolean {
  if (kind === 'box-blur') return params.radius === 0
  if (kind === 'sharpen') return params.amount === 0
  if (kind === 'vignette') return params.strength === 0
  return params.opacity === 0 || (kind === 'outline' && params.width === 0)
}
export function spatialEffectRegistrations(): EffectRegistration[] {
  return (Object.keys(SPATIAL_EFFECT_PARAMETERS) as SpatialEffectKind[]).map((kind): EffectRegistration => ({
    type: `builtin.${kind}`, version: 1, label: SPATIAL_EFFECT_LABELS[kind],
    surfaces: ['source-layer', 'post-composite'], preservesOpaqueInput: true,
    defaultParams: Object.freeze(spatialEffectParams(kind, {})),
    validateParams(raw) {
      for (const [key, spec] of Object.entries(SPATIAL_EFFECT_PARAMETERS[kind])) {
        const value = raw[key] ?? spec.default
        if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) return `${key} must be between ${spec.min} and ${spec.max}`
      }
      if ((kind === 'drop-shadow' || kind === 'outline') && raw.color !== undefined && (typeof raw.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(raw.color))) return 'color must be an RGB hex color'
      return null
    },
    capabilities: (effect: EffectDescriptor) => spatialEffectIsIdentity(kind, spatialEffectParams(kind, effect.params)) ? [] : ['canvas2d-pixel-access'],
    migrateLegacy: () => null, canvasFilter: () => '',
    pixelEffect: (effect: EffectDescriptor) => {
      const params = spatialEffectParams(kind, effect.params)
      return spatialEffectIsIdentity(kind, params) ? null : { kind, params }
    },
    animatableParams: SPATIAL_EFFECT_PARAMETERS[kind],
  })).map((registration) => Object.freeze(registration))
}
