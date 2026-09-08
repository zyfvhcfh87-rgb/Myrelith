/** Property adapters choose meaning; the scalar leaf remains the only interpolator. */
import { MAX_TITLE_ANIMATION_TRACKS } from './animationCollections'
import type { Clip, EffectDescriptor, TitleAnimationTrack, TrackKind } from './schema'
import { clipScalarPropertySpec, readClipScalarProperty } from './clipAnimationProperties'
import { effectAnimationParameterSpec } from './effectStack'
import { animationParameterIdentityMatches, type AnimationParameterIdentity } from './animationParameterIdentity'
import type { PluginVideoEffectContributionDeclaration } from './pluginVideoEffectStagePlan'
import { applyTitleAnimationValues, titleAnimationPropertySpec, type TitleElement } from './titleElements'
import { evaluateValidatedAnimationTrackAtBoundaryPosition, keyframesValidationError } from './scalarAnimation'

export interface ScalarAnimationPropertySpec {
  readonly property: string
  readonly propertyVersion: number
  readonly label: string
  readonly unit: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly minExclusive?: boolean
}
export type ScalarAnimationPropertyResolution =
  | { readonly status: 'available'; readonly spec: ScalarAnimationPropertySpec; readonly fallback: number }
  | { readonly status: 'unavailable'; readonly reason: string }

export type ScalarAnimationPropertyTarget =
  | { readonly kind: 'clip'; readonly clip: Clip; readonly trackKind: TrackKind; readonly property: string; readonly propertyVersion?: number }
  | { readonly kind: 'title-element'; readonly element: TitleElement; readonly property: string; readonly propertyVersion: number }
  | { readonly kind: 'effect'; readonly effect: EffectDescriptor; readonly parameter: string; readonly identity?: AnimationParameterIdentity; readonly declaration?: PluginVideoEffectContributionDeclaration }

export function resolveScalarAnimationProperty(target: ScalarAnimationPropertyTarget): ScalarAnimationPropertyResolution {
  if (target.kind === 'title-element') return titleAnimationPropertySpec(target.element, target.propertyVersion, target.property)
  if (target.kind === 'clip') {
    const spec = clipScalarPropertySpec(target.property, target.propertyVersion ?? 1)
    if (!spec) return { status: 'unavailable', reason: 'This clip property name or version is unavailable; its keys are preserved.' }
    if (target.clip.text !== undefined && spec.property !== 'opacity') return { status: 'unavailable', reason: 'Title clips expose only outer opacity; edit the title element geometry.' }
    if (target.trackKind === 'audio' && spec.property !== 'volume' && spec.property !== 'balance') return { status: 'unavailable', reason: 'Audio clips expose only volume and balance.' }
    return { status: 'available', spec, fallback: readClipScalarProperty(target.clip, spec.property) }
  }
  const { effect, parameter } = target
  const fallback = effect.params[parameter]
  if (effect.type.startsWith('plugin:')) {
    const declaration = target.declaration
    if (!declaration || declaration.effectType !== effect.type || declaration.descriptorVersion !== effect.version
      || declaration.availability !== 'ready') return { status: 'unavailable', reason: 'The exact plugin declaration is unavailable; keys are preserved.' }
    if (target.identity === undefined) return { status: 'unavailable', reason: 'Legacy plugin animation identity is unverified. Bind it explicitly to the current declaration.' }
    if (!animationParameterIdentityMatches(target.identity, declaration)) return { status: 'unavailable', reason: 'The plugin package or declaration identity changed; existing keys remain unavailable.' }
    const declared = declaration.parameters.find((item) => item.key === parameter)
    if (declared?.kind !== 'number' || !declared.animatable) return { status: 'unavailable', reason: 'The plugin does not declare this parameter as an animatable number.' }
    const authored = fallback === undefined ? declared.default : fallback
    if (typeof authored !== 'number' || !Number.isFinite(authored) || authored < declared.min || authored > declared.max) return { status: 'unavailable', reason: 'The authored scalar fallback is invalid.' }
    return { status: 'available', fallback: authored, spec: { property: parameter, propertyVersion: effect.version, label: declared.name, unit: 'number', min: declared.min, max: declared.max, step: declared.step } }
  }
  const spec = target.identity === undefined ? effectAnimationParameterSpec(effect, parameter) : null
  if (!spec || typeof fallback !== 'number' || !Number.isFinite(fallback)) return { status: 'unavailable', reason: 'This effect parameter or version is unavailable; keys are preserved.' }
  return { status: 'available', fallback, spec: { ...spec, property: parameter, propertyVersion: effect.version, unit: 'number' } }
}

export function scalarAnimationValueError(spec: ScalarAnimationPropertySpec, value: number): string | null {
  return !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.minExclusive === true && value === spec.min)
    ? 'The animated scalar is outside its declared bounds.' : null
}

/** #200 supplies supported parsed element data and consumes the resolved copy. */
export function resolveTitleElementAnimation(
  element: TitleElement,
  tracks: readonly TitleAnimationTrack[],
  localFrame: number,
): { readonly element: TitleElement; readonly unavailable: readonly string[] } {
  if (tracks.length > MAX_TITLE_ANIMATION_TRACKS) return { element, unavailable: ['Title animation exceeds the track limit.'] }
  if (!Number.isSafeInteger(localFrame)) return { element, unavailable: ['Title animation requires an integer local frame.'] }
  const values: { propertyVersion: number; property: string; value: number }[] = []
  const unavailable: string[] = []
  const targets = new Set<string>()
  for (const track of tracks) {
    if (track.elementId !== element.id) continue
    if (targets.has(track.property)) return { element, unavailable: ['Duplicate title property, regardless of version.'] }
    targets.add(track.property)
    const property = titleAnimationPropertySpec(element, track.propertyVersion, track.property)
    if (property.status !== 'available') { unavailable.push(property.reason); continue }
    const error = keyframesValidationError(track.keyframes, (value) => scalarAnimationValueError(property.spec, value))
    if (error) { unavailable.push(error); continue }
    const value = evaluateValidatedAnimationTrackAtBoundaryPosition(track, localFrame, property.fallback)
    if (scalarAnimationValueError(property.spec, value)) { unavailable.push('The interpolated title value is outside its declaration.'); continue }
    values.push({ propertyVersion: track.propertyVersion, property: track.property, value })
  }
  const result = applyTitleAnimationValues(element, values)
  return result.status === 'applied' ? { element: result.element, unavailable }
    : { element, unavailable: [...unavailable, result.reason] }
}
