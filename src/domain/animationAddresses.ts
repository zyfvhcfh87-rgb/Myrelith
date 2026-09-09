/** Structural editor addresses. Semantic identity never depends on labels or array positions. */
import { animationParameterIdentityError, type AnimationParameterIdentity } from './animationParameterIdentity'
import { MAX_ANIMATION_PROPERTY_CHARACTERS } from './animationCollections'
import { MAX_KEYFRAME_FRAME } from './scalarAnimation'

export const ANIMATION_EDIT_LIMITS = Object.freeze({ selectedKeys: 4096, lanes: 128 })
export type AnimationOwnerAddress =
  | { readonly kind: 'clip'; readonly id: string }
  | { readonly kind: 'adjustment'; readonly id: string }
export type AnimationLaneAddress = { readonly owner: AnimationOwnerAddress } & (
  | { readonly kind: 'scalar'; readonly property: string; readonly propertyVersion: number }
  | { readonly kind: 'effect'; readonly effectId: string; readonly parameter: string; readonly parameterIdentity?: AnimationParameterIdentity }
  | { readonly kind: 'title'; readonly elementId: string; readonly property: string; readonly propertyVersion: number }
  | { readonly kind: 'path'; readonly effectId: string; readonly parameter: string; readonly valueType: string; readonly valueVersion: number }
)
export interface AnimationKeyAddress { readonly lane: AnimationLaneAddress; readonly frame: number }

export function animationOwnerKey(owner: AnimationOwnerAddress): string { return JSON.stringify([owner.kind, owner.id]) }
/** Version/kind applicability is separate from semantic competition. JSON tuples escape separators. */
export function animationSemanticLaneKey(lane: AnimationLaneAddress): string {
  return JSON.stringify([lane.owner.kind, lane.owner.id, ...(lane.kind === 'scalar' ? ['scalar', lane.property]
    : lane.kind === 'title' ? ['title', lane.elementId, lane.property] : ['effect', lane.effectId, lane.parameter])])
}
export function animationLaneKey(lane: AnimationLaneAddress): string {
  const identity = lane.kind === 'effect' ? lane.parameterIdentity : undefined
  return JSON.stringify([animationSemanticLaneKey(lane), lane.kind,
    lane.kind === 'scalar' || lane.kind === 'title' ? lane.propertyVersion : null,
    lane.kind === 'path' ? [lane.valueType, lane.valueVersion] : null,
    identity ? [identity.version, identity.effectType, identity.descriptorVersion, identity.contributionId, identity.contributionVersion, identity.packageDigest] : null])
}
export function animationKeyKey(key: AnimationKeyAddress): string { return JSON.stringify([animationLaneKey(key.lane), key.frame]) }
export function animationLaneAddressError(lane: AnimationLaneAddress): string | null {
  const bounded = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ANIMATION_PROPERTY_CHARACTERS
  const version = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
  if (!lane || !lane.owner || !['clip', 'adjustment'].includes(lane.owner.kind) || !bounded(lane.owner.id)) return 'The animation owner address is invalid.'
  if (lane.kind === 'scalar') return bounded(lane.property) && version(lane.propertyVersion) ? null : 'The scalar property address is invalid.'
  if (lane.kind === 'title') return lane.owner.kind === 'clip' && bounded(lane.elementId) && bounded(lane.property) && version(lane.propertyVersion) ? null : 'The title property address is invalid.'
  if (lane.kind !== 'effect' && lane.kind !== 'path') return 'The animation lane kind is invalid.'
  if (!bounded(lane.effectId) || !bounded(lane.parameter)) return 'The effect parameter address is invalid.'
  if (lane.kind === 'path') return bounded(lane.valueType) && version(lane.valueVersion) ? null : 'The path value address is invalid.'
  return lane.parameterIdentity === undefined ? null : animationParameterIdentityError(lane.parameterIdentity)
}
export function animationSelectionError(keys: readonly AnimationKeyAddress[]): string | null {
  if (!Array.isArray(keys) || keys.length > ANIMATION_EDIT_LIMITS.selectedKeys) return 'Select at most 4,096 keys.'
  const seen = new Set<string>(), lanes = new Set<string>()
  for (const key of keys) {
    const error = animationLaneAddressError(key.lane)
    if (error) return error
    if (!Number.isSafeInteger(key.frame) || Math.abs(key.frame) > MAX_KEYFRAME_FRAME) return 'Key frames must be bounded integers.'
    const id = animationKeyKey(key)
    if (seen.has(id)) return 'The key selection contains duplicates.'
    seen.add(id); lanes.add(animationSemanticLaneKey(key.lane))
    if (lanes.size > ANIMATION_EDIT_LIMITS.lanes) return 'Select keys in at most 128 lanes.'
  }
  return null
}
