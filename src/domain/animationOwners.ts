/** Resolve stable owners once per batch; property meaning stays with the accepted adapters. */
import type { AdjustmentItem, Clip, ClipAnimation, ClipAnimationKeyframe, TimelineDoc, Track } from './schema'
import type { TitleElement } from './titleElements'
import type { PluginVideoEffectContributionSnapshot } from './pluginVideoEffectStagePlan'
import { clipScalarPropertySpec } from './clipAnimationProperties'
import { animationLaneKey, animationOwnerKey, type AnimationLaneAddress, type AnimationOwnerAddress } from './animationAddresses'
import { type AnyAnimationTrack, effectPathAnimationTracks, titleAnimationTracks } from './animationCollections'
import { clipAnimation, effectAnimationTracks } from './clipAnimation'
import { resolveScalarAnimationProperty, type ScalarAnimationPropertyResolution } from './animationPropertyCatalog'
import { prepareEffectPathAnimationTrack } from './maskPathAnimation'
import { effectSupportsSurface } from './effectStack'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset, SOURCE_TIME_TICKS_PER_FRAME } from './sourceTimeMap'

/** #200 implements this protocol with its schema 23 owner; no title parsing is duplicated here. */
export interface AnimationTitleOwnerAdapter {
  readonly isTitleClip: (clip: Clip) => boolean
  readonly readElement: (clip: Clip, elementId: string) => TitleElement | undefined
}
export const LEGACY_ANIMATION_TITLE_OWNERS: AnimationTitleOwnerAdapter = Object.freeze({
  isTitleClip: (clip: Clip) => clip.text !== undefined,
  readElement: () => undefined,
})
export interface AnimationEditContext {
  readonly plugins?: PluginVideoEffectContributionSnapshot
  readonly titles?: AnimationTitleOwnerAdapter
}
export interface AnimationOwner {
  readonly address: AnimationOwnerAddress
  readonly track: Track
  readonly item: Clip | AdjustmentItem
  readonly clip: Clip | undefined
  readonly animation: ClipAnimation
}
export function animationOwnerIndex(sequence: TimelineDoc): ReadonlyMap<string, AnimationOwner> {
  const owners = new Map<string, AnimationOwner>()
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      const address = { kind: 'clip' as const, id: clip.id }
      owners.set(animationOwnerKey(address), { address, track, item: clip, clip, animation: clipAnimation(clip) })
    }
    for (const item of track.adjustments ?? []) {
      const address = { kind: 'adjustment' as const, id: item.id }
      owners.set(animationOwnerKey(address), { address, track, item, clip: undefined, animation: item.animation })
    }
  }
  return owners
}
export function animationLaneAddress(owner: AnimationOwnerAddress, track: AnyAnimationTrack): AnimationLaneAddress {
  if ('valueType' in track) return { owner, kind: 'path', effectId: track.effectId, parameter: track.parameter, valueType: track.valueType, valueVersion: track.valueVersion }
  if ('elementId' in track) return { owner, kind: 'title', elementId: track.elementId, property: track.property, propertyVersion: track.propertyVersion }
  if ('effectId' in track) return { owner, kind: 'effect', effectId: track.effectId, parameter: track.parameter, ...(track.parameterIdentity === undefined ? {} : { parameterIdentity: track.parameterIdentity }) }
  return { owner, kind: 'scalar', property: track.property, propertyVersion: track.propertyVersion ?? 1 }
}
export function animationOwnerLanes(owner: AnimationOwner): readonly AnyAnimationTrack[] {
  return [...owner.animation.tracks, ...effectAnimationTracks(owner.animation), ...titleAnimationTracks(owner.animation), ...effectPathAnimationTracks(owner.animation)]
}
export function findAnimationLane(owner: AnimationOwner, address: AnimationLaneAddress): AnyAnimationTrack | undefined {
  const tracks = address.kind === 'scalar' ? owner.animation.tracks : address.kind === 'effect' ? effectAnimationTracks(owner.animation)
    : address.kind === 'title' ? titleAnimationTracks(owner.animation) : effectPathAnimationTracks(owner.animation)
  const id = animationLaneKey(address)
  return tracks.find((track) => animationLaneKey(animationLaneAddress(owner.address, track)) === id)
}
export function scalarLaneProperty(owner: AnimationOwner, lane: AnimationLaneAddress, context: AnimationEditContext): ScalarAnimationPropertyResolution {
  const unavailable = (reason: string): ScalarAnimationPropertyResolution => ({ status: 'unavailable', reason })
  if (lane.kind === 'path') return unavailable('Path lanes support held geometry, not scalar editing.')
  if (lane.kind === 'title') {
    const element = owner.clip && context.titles?.readElement(owner.clip, lane.elementId)
    return element && element.id === lane.elementId ? resolveScalarAnimationProperty({ kind: 'title-element', element, property: lane.property, propertyVersion: lane.propertyVersion })
      : unavailable('The title element is unavailable; its stored keys are preserved.')
  }
  if (lane.kind === 'scalar') {
    if (!owner.clip) return lane.property === 'opacity' && lane.propertyVersion === 1
      ? { status: 'available', fallback: owner.item.opacity, spec: clipScalarPropertySpec('opacity')! }
      : unavailable('Adjustments expose only supported opacity animation.')
    if ((context.titles ?? LEGACY_ANIMATION_TITLE_OWNERS).isTitleClip(owner.clip) && lane.property !== 'opacity') return unavailable('Title clips expose only outer opacity.')
    return resolveScalarAnimationProperty({ kind: 'clip', clip: owner.clip, trackKind: owner.track.kind, property: lane.property, propertyVersion: lane.propertyVersion })
  }
  const effect = owner.item.effects.find((effect) => effect.id === lane.effectId)
  if (!effect || (owner.clip ? owner.track.kind !== 'video' : !effectSupportsSurface(effect, 'post-composite'))) return unavailable('The effect owner or stage is unavailable.')
  if (owner.clip && (owner.clip.title !== undefined || (context.titles ?? LEGACY_ANIMATION_TITLE_OWNERS).isTitleClip(owner.clip))
    && !titleEffectAnimationParameterSpec(owner.clip, effect, lane.parameter)) return unavailable('This title effect does not support animation.')
  return resolveScalarAnimationProperty({ kind: 'effect', effect, parameter: lane.parameter, identity: lane.parameterIdentity,
    declaration: context.plugins?.declarations.find((item) => item.effectType === effect.type) })
}
export function pathLaneAvailable(owner: AnimationOwner, lane: AnimationLaneAddress, track: AnyAnimationTrack, context: AnimationEditContext): boolean {
  if (lane.kind !== 'path' || !('valueType' in track) || !owner.clip || owner.track.kind !== 'video'
    || (context.titles ?? LEGACY_ANIMATION_TITLE_OWNERS).isTitleClip(owner.clip)) return false
  return prepareEffectPathAnimationTrack(track, owner.item.effects.find((effect) => effect.id === lane.effectId)).ok
}
export function keyAtDestination(owner: AnimationOwner, key: AnyAnimationTrack['keyframes'][number], frame: number, context: AnimationEditContext): AnyAnimationTrack['keyframes'][number] {
  if (!Number.isSafeInteger(owner.item.timelineRange.startFrame + frame)) throw new RangeError('The destination global key frame exceeds safe integer bounds.')
  const result = typeof key.value === 'string'
    ? { frame, value: key.value, easing: { type: 'hold' as const } }
    : { frame, value: key.value, easing: { ...key.easing } }
  if (!owner.clip) return result
  const sourceTimeTicks = (context.titles ?? LEGACY_ANIMATION_TITLE_OWNERS).isTitleClip(owner.clip)
    ? frame * SOURCE_TIME_TICKS_PER_FRAME : sourceTicksAtTimelineOffset(clipSourceTimeMap(owner.clip), frame)
  if (!Number.isSafeInteger(sourceTimeTicks)) throw new RangeError('Key source intent exceeds safe integer bounds.')
  return { ...result, sourceTimeTicks }
}
/** Keys are already admitted typed payloads. Only this value-kind boundary needs a cast. */
export function animationTrackWithKeys(track: AnyAnimationTrack, keys: readonly AnyAnimationTrack['keyframes'][number][]): AnyAnimationTrack {
  if ('valueType' in track) {
    if (keys.some((key) => typeof key.value !== 'string' || key.easing.type !== 'hold')) throw new TypeError('A path lane requires string values and hold easing.')
    return { ...track, keyframes: keys.map((key) => ({ ...key, value: key.value as string, easing: { type: 'hold' as const } })) }
  }
  if (keys.some((key) => typeof key.value !== 'number')) throw new TypeError('A scalar lane requires numeric values.')
  return { ...track, keyframes: keys.map((key) => ({ ...key, easing: { ...key.easing } })) as ClipAnimationKeyframe[] }
}

/** Explicit destination metadata, preserving the scalar v1 compact encoding where possible. */
export function trackAtAddress(source: AnyAnimationTrack, address: AnimationLaneAddress): AnyAnimationTrack {
  const keyframes = source.keyframes
  if (address.kind === 'path') return animationTrackWithKeys({ effectId: address.effectId, parameter: address.parameter, valueType: address.valueType, valueVersion: address.valueVersion, keyframes: [] }, keyframes)
  if (address.kind === 'title') return animationTrackWithKeys({ elementId: address.elementId, property: address.property, propertyVersion: address.propertyVersion, keyframes: [] }, keyframes)
  if (address.kind === 'effect') return animationTrackWithKeys({ effectId: address.effectId, parameter: address.parameter, ...(address.parameterIdentity === undefined ? {} : { parameterIdentity: { ...address.parameterIdentity } }), keyframes: [] }, keyframes)
  return animationTrackWithKeys({ property: address.property, ...((address.propertyVersion !== 1 || ('propertyVersion' in source && source.propertyVersion !== undefined)) ? { propertyVersion: address.propertyVersion } : {}), keyframes: [] }, keyframes)
}
