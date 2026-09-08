/** Immutable sequence lane/key index. No per-playhead project traversal. */
import type { TimelineDoc, ClipAnimationTrack, ClipAnimationKeyframe } from './schema'
import type { AnyAnimationTrack } from './animationCollections'
import { animationLaneKey, animationOwnerKey, animationSemanticLaneKey, type AnimationLaneAddress, type AnimationKeyAddress } from './animationAddresses'
import { animationLaneAddress, animationOwnerIndex, animationOwnerLanes, scalarLaneProperty, pathLaneAvailable, type AnimationEditContext, type AnimationOwner } from './animationOwners'
import { CLIP_SCALAR_PROPERTY_SPECS } from './clipAnimationProperties'
import { effectRegistration, MASK_EFFECT_TYPE } from './effectStack'
import { readTitleDefinition, TITLE_ANIMATION_PROPERTIES } from './titleElements'
import { keyframesValidationError, evaluateValidatedAnimationTrackAtBoundaryPosition } from './scalarAnimation'
import { scalarAnimationValueError, type ScalarAnimationPropertyResolution } from './animationPropertyCatalog'

export const ANIMATION_VIEW_LIMITS = Object.freeze({ rows: 40, glyphs: 512, curveSamples: 256, rowHeight: 32 })
export interface AnimationLaneRow {
  readonly id: string
  readonly address: AnimationLaneAddress
  readonly owner: AnimationOwner
  readonly group: string
  readonly label: string
  readonly search: string
  readonly track?: AnyAnimationTrack
  readonly scalar: ScalarAnimationPropertyResolution
  readonly status: 'scalar' | 'hold' | 'unavailable'
  readonly reason: string | null
  readonly frames: readonly number[]
  readonly globalFrames: readonly number[]
  readonly holdPrefix: readonly number[]
}
export interface AnimationLaneIndex {
  readonly document: TimelineDoc
  readonly lanes: readonly AnimationLaneRow[]
  readonly byId: ReadonlyMap<string, AnimationLaneRow>
  readonly owners: ReadonlyMap<string, AnimationOwner>
  readonly keyCount: number
}
export interface AnimationLaneFilter { readonly text: string; readonly animatedOnly: boolean; readonly kind: 'all' | AnimationLaneAddress['kind']; readonly ownerIds?: ReadonlySet<string> }

function offeredAddresses(owner: AnimationOwner, context: AnimationEditContext): AnimationLaneAddress[] {
  const addresses: AnimationLaneAddress[] = Object.keys(CLIP_SCALAR_PROPERTY_SPECS).map((property) => ({ owner: owner.address, kind: 'scalar', property, propertyVersion: 1 }))
  for (const effect of owner.item.effects) {
    const registration = effectRegistration(effect.type)
    for (const parameter of Object.keys(registration?.animatableParams ?? {})) addresses.push({ owner: owner.address, kind: 'effect', effectId: effect.id, parameter })
    const declaration = context.plugins?.declarations.find((entry) => entry.effectType === effect.type)
    if (declaration) for (const parameter of declaration.parameters) if (parameter.kind === 'number' && parameter.animatable) addresses.push({
      owner: owner.address, kind: 'effect', effectId: effect.id, parameter: parameter.key,
      parameterIdentity: { version: 1, effectType: declaration.effectType, descriptorVersion: declaration.descriptorVersion,
        contributionId: declaration.contributionId, contributionVersion: declaration.contributionVersion, packageDigest: declaration.packageDigest },
    })
    // Held path creation stays with the mask geometry authoring surface.
    if (effect.type === MASK_EFFECT_TYPE && effect.params.shape === 'bezier') addresses.push({ owner: owner.address, kind: 'path', effectId: effect.id, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1 })
  }
  if (owner.clip?.title) {
    const definition = readTitleDefinition(owner.clip.title)
    if (definition.status === 'supported') for (const element of definition.title.elements) {
      for (const property of TITLE_ANIMATION_PROPERTIES) addresses.push({ owner: owner.address, kind: 'title', elementId: element.id, property, propertyVersion: 1 })
    }
  }
  return addresses
}
export function buildAnimationLaneIndex(document: TimelineDoc, context: AnimationEditContext): AnimationLaneIndex {
  const lanes: AnimationLaneRow[] = [], byId = new Map<string, AnimationLaneRow>()
  let keyCount = 0
  const owners = animationOwnerIndex(document)
  for (const owner of owners.values()) {
    const elements = new Map<string, ReturnType<NonNullable<AnimationEditContext['titles']>['readElement']>>()
    const localContext: AnimationEditContext = context.titles ? { ...context, titles: { isTitleClip: context.titles.isTitleClip, readElement: (clip, id) => {
      if (!elements.has(id)) elements.set(id, context.titles!.readElement(clip, id))
      return elements.get(id)
    } } } : context
    const stored = new Map(animationOwnerLanes(owner).map((track) => [animationSemanticLaneKey(animationLaneAddress(owner.address, track)), track]))
    const addresses = new Map<string, AnimationLaneAddress>()
    for (const track of stored.values()) { const address = animationLaneAddress(owner.address, track); addresses.set(animationSemanticLaneKey(address), address) }
    for (const address of offeredAddresses(owner, localContext)) if (!addresses.has(animationSemanticLaneKey(address))) addresses.set(animationSemanticLaneKey(address), address)
    for (const address of addresses.values()) {
      const track = stored.get(animationSemanticLaneKey(address)), scalar = scalarLaneProperty(owner, address, localContext)
      let status: AnimationLaneRow['status'] = scalar.status === 'available' ? 'scalar' : 'unavailable'
      let reason: string | null = scalar.status === 'available' ? null : scalar.reason
      if (address.kind === 'path' && track && pathLaneAvailable(owner, address, track, localContext)) { status = 'hold'; reason = 'Held path: edit geometry in the mask controls; timing edits are available here.' }
      if (!track && status === 'unavailable') continue
      if (scalar.status === 'available' && track) {
        const invalid = keyframesValidationError(track.keyframes as ClipAnimationKeyframe[], (value) => scalarAnimationValueError(scalar.spec, value))
        if (invalid) { status = 'unavailable'; reason = invalid }
      }
      const row = makeLaneRow(owner, address, track, scalar, status, reason, localContext)
      lanes.push(row); byId.set(row.id, row); keyCount += row.frames.length
    }
  }
  return { document, lanes, byId, owners, keyCount }
}
function makeLaneRow(owner: AnimationOwner, address: AnimationLaneAddress, track: AnyAnimationTrack | undefined, scalar: ScalarAnimationPropertyResolution, status: AnimationLaneRow['status'], reason: string | null, context: AnimationEditContext): AnimationLaneRow {
  const effectId = address.kind === 'effect' || address.kind === 'path' ? address.effectId : null
  const effect = owner.item.effects.find((effect) => effect.id === effectId)
  const element = address.kind === 'title' && owner.clip ? context.titles?.readElement(owner.clip, address.elementId) : undefined
  const property = address.kind === 'effect' || address.kind === 'path' ? address.parameter : address.property
  const label = scalar.status === 'available' ? scalar.spec.label : property
  const ownerLabel = owner.clip?.text?.content.slice(0, 40) || owner.item.name || owner.address.id
  const group = [owner.track.name, ownerLabel, element?.name ?? (address.kind === 'title' ? address.elementId : null), effect ? effectRegistration(effect.type)?.label ?? effect.type : effectId].filter(Boolean).join(' / ')
  const frames: number[] = [], globalFrames: number[] = [], holdPrefix = [0]
  for (const key of track?.keyframes ?? []) { frames.push(key.frame); globalFrames.push(owner.item.timelineRange.startFrame + key.frame); holdPrefix.push(holdPrefix.at(-1)! + Number(key.easing.type === 'hold')) }
  return { id: animationLaneKey(address), address, owner, group, label, search: `${group} ${label} ${property}`.toLocaleLowerCase(), track, scalar, status, reason, frames, globalFrames, holdPrefix }
}
/** Resolve an explicit entry even if it is unavailable and has no stored keys. */
export function resolveAnimationFocusedLane(index: AnimationLaneIndex, address: AnimationLaneAddress, context: AnimationEditContext): AnimationLaneRow | undefined {
  const existing = index.byId.get(animationLaneKey(address))
  if (existing) return existing
  const owner = index.owners.get(animationOwnerKey(address.owner))
  if (!owner) return undefined
  const stored = animationOwnerLanes(owner).find((track) => animationSemanticLaneKey(animationLaneAddress(owner.address, track)) === animationSemanticLaneKey(address))
  if (stored) return index.byId.get(animationLaneKey(animationLaneAddress(owner.address, stored)))
  const scalar = scalarLaneProperty(owner, address, context)
  return makeLaneRow(owner, address, undefined, scalar, scalar.status === 'available' ? 'scalar' : 'unavailable', scalar.status === 'available' ? null : scalar.reason, context)
}
export function filterAnimationLanes(index: AnimationLaneIndex, filter: AnimationLaneFilter): readonly AnimationLaneRow[] {
  const text = filter.text.trim().toLocaleLowerCase()
  return index.lanes.filter((lane) => (!filter.animatedOnly || lane.frames.length > 0)
    && (filter.kind === 'all' || lane.address.kind === filter.kind)
    && (!filter.ownerIds || filter.ownerIds.has(lane.address.owner.id)) && (!text || lane.search.includes(text)))
}
/** First value >= target; used for visible keys, dense buckets and exact navigation. */
export function animationLowerBound(frames: readonly number[], target: number): number {
  let low = 0, high = frames.length
  while (low < high) { const middle = (low + high) >>> 1; if (frames[middle] < target) low = middle + 1; else high = middle }
  return low
}
export function animationKeyAt(row: AnimationLaneRow, index: number): AnimationKeyAddress | null {
  return index < 0 || index >= row.frames.length ? null : { lane: row.address, frame: row.frames[index] }
}
export interface AnimationKeyGlyph { readonly first: number; readonly end: number; readonly globalFrame: number; readonly count: number }
/** Each mounted row gets a bounded budget. Binary ranges never walk dense keys. */
export function animationKeyGlyphs(row: AnimationLaneRow, start: number, end: number, budget: number): readonly AnimationKeyGlyph[] {
  const limit = Math.max(1, Math.floor(budget)), first = animationLowerBound(row.globalFrames, start), last = animationLowerBound(row.globalFrames, end + 1)
  const count = last - first
  if (count <= limit) return Array.from({ length: count }, (_, offset) => ({ first: first + offset, end: first + offset + 1, globalFrame: row.globalFrames[first + offset], count: 1 }))
  const glyphs: AnimationKeyGlyph[] = [], step = Math.max(1, (end - start + 1) / limit)
  for (let bucket = 0; bucket < limit; bucket++) {
    const left = animationLowerBound(row.globalFrames, start + bucket * step), right = Math.min(last, animationLowerBound(row.globalFrames, start + (bucket + 1) * step))
    if (right > left) glyphs.push({ first: left, end: right, globalFrame: row.globalFrames[left], count: right - left })
  }
  return glyphs
}
export function animationValueAt(row: AnimationLaneRow, globalFrame: number): number | null {
  if (row.status !== 'scalar' || row.scalar.status !== 'available') return null
  if (!row.track?.keyframes.length) return row.scalar.fallback
  return evaluateValidatedAnimationTrackAtBoundaryPosition(row.track as ClipAnimationTrack, globalFrame - row.owner.item.timelineRange.startFrame, row.scalar.fallback)
}
export interface AnimationCurvePoint { readonly frame: number; readonly value: number; readonly move: boolean }
/** Sample only through the canonical evaluator. Never connect across a skipped hold discontinuity. */
export function animationCurvePoints(row: AnimationLaneRow, start: number, end: number): { readonly points: readonly AnimationCurvePoint[]; readonly dense: boolean } {
  if (row.status !== 'scalar') return { points: [], dense: false }
  const first = animationLowerBound(row.globalFrames, start), last = animationLowerBound(row.globalFrames, end + 1)
  const dense = (last - first) * 2 > ANIMATION_VIEW_LIMITS.curveSamples / 2
  const frames = new Set<number>([start, end])
  if (!dense) for (let index = first; index < last; index++) frames.add(row.globalFrames[index])
  const slots = ANIMATION_VIEW_LIMITS.curveSamples - frames.size - (dense ? 0 : last - first)
  for (let index = 1; index < slots; index++) frames.add(start + (end - start) * index / slots)
  const ordered = [...frames].sort((a, b) => a - b), points: AnimationCurvePoint[] = []
  const upper = (frame: number) => { const found = animationLowerBound(row.globalFrames, frame); return found + Number(row.globalFrames[found] === frame) }
  for (const frame of ordered) {
    const value = animationValueAt(row, frame)
    if (value === null) continue
    const previous = points.at(-1), left = previous ? upper(previous.frame) : 0, right = upper(frame)
    const crossesHold = previous && row.holdPrefix[Math.max(0, right - 1)] > row.holdPrefix[Math.max(0, left - 1)]
    const index = animationLowerBound(row.globalFrames, frame), before = row.track?.keyframes[index - 1]
    if (!dense && previous && row.globalFrames[index] === frame && before?.easing.type === 'hold' && typeof before.value === 'number') points.push({ frame, value: before.value, move: false })
    points.push({ frame, value, move: !previous || !!crossesHold })
  }
  return { points, dense }
}
