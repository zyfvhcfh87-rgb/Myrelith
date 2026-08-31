/** Pure product contract for bounded, resource-free adjustment timeline items. */

import type {
  AdjustmentAnimation,
  AdjustmentAnimationKeyframe,
  AdjustmentItem,
  AdjustmentItemId,
  ClipAnimation,
  EffectDescriptor,
  EffectId,
  EffectParamValue,
  TimeRange,
  TimelineDoc,
  Track,
  TrackId,
} from './schema'
import {
  animationEasingValidationError,
  clipAnimationKeyframeCount,
  clipAnimationValidationError,
  cloneAnimationEasing,
  documentAnimationKeyframeGrowthAllowed,
  evaluateAnimationTrack,
  MAX_KEYFRAME_FRAME,
} from './clipAnimation'
import {
  cloneEffectDescriptor,
  effectAnimationParameterSpec,
  effectParamsValidationError,
  effectRegistration,
  effectSupportsSurface,
} from './effectStack'
import {
  effectAppendBudgetError,
  effectCollectionAppendBudgetError,
  effectDescriptorBoundsError,
  effectReplacementBudgetError,
} from './effectBounds'
import { MAX_PROJECT_NAME_CHARACTERS } from './projectLimits'
import { rangeEnd, rangeOverlap } from './time'
import type { TrimEdge } from './operations/operationTypes'

export const DEFAULT_ADJUSTMENT_NAME = 'Adjustment'

export interface AdjustmentLocation {
  readonly trackIndex: number
  readonly track: Track
  readonly adjustmentIndex: number
  readonly adjustment: AdjustmentItem
}

export interface AdjustmentEditDeltaBounds {
  readonly min: number
  readonly max: number
}

function reject(doc: TimelineDoc, operation: string, reason: string): TimelineDoc {
  console.warn(`[adjustment-items] ${operation} rejected: ${reason}`)
  return doc
}

function withTrack(doc: TimelineDoc, trackIndex: number, track: Track): TimelineDoc {
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = track
  return { ...doc, tracks }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function adjustmentItems(track: Track): readonly AdjustmentItem[] {
  return track.adjustments ?? []
}

export function defaultAdjustmentAnimation(): AdjustmentAnimation {
  return { tracks: [], effectTracks: [] }
}

export function cloneAdjustmentAnimation(
  animation: AdjustmentAnimation,
): AdjustmentAnimation {
  return {
    tracks: animation.tracks.map((track) => ({
      property: track.property,
      keyframes: track.keyframes.map(cloneAdjustmentKeyframe),
    })),
    effectTracks: animation.effectTracks.map((track) => ({
      effectId: track.effectId,
      parameter: track.parameter,
      keyframes: track.keyframes.map(cloneAdjustmentKeyframe),
    })),
  }
}

function cloneAdjustmentKeyframe(
  keyframe: AdjustmentAnimationKeyframe,
): AdjustmentAnimationKeyframe {
  return {
    frame: keyframe.frame,
    value: keyframe.value,
    easing: cloneAnimationEasing(keyframe.easing),
  }
}

export function adjustmentAnimationValidationError(
  animation: AdjustmentAnimation,
): string | null {
  const sharedError = clipAnimationValidationError(animation as ClipAnimation)
  if (sharedError) return sharedError
  if (animation.tracks.some((track) => track.property !== 'opacity')) {
    return 'adjustment animation supports opacity only'
  }
  for (const track of animation.tracks) {
    if (track.keyframes.some((keyframe) => 'sourceTimeTicks' in keyframe)) {
      return 'adjustment keyframes must not carry source time'
    }
  }
  for (const track of animation.effectTracks) {
    if (track.keyframes.some((keyframe) => 'sourceTimeTicks' in keyframe)) {
      return 'adjustment effect keyframes must not carry source time'
    }
  }
  return null
}

export function adjustmentItemValidationError(item: AdjustmentItem): string | null {
  if (item.kind !== 'adjustment') return 'adjustment kind must be adjustment'
  if (typeof item.id !== 'string' || item.id.trim().length === 0) {
    return 'adjustment id must not be empty'
  }
  if (
    typeof item.name !== 'string'
    || item.name.trim().length === 0
    || item.name.length > MAX_PROJECT_NAME_CHARACTERS
  ) return `adjustment name must be 1 through ${MAX_PROJECT_NAME_CHARACTERS} characters`
  if (
    !Number.isSafeInteger(item.timelineRange.startFrame)
    || item.timelineRange.startFrame < 0
    || !Number.isSafeInteger(item.timelineRange.durationFrames)
    || item.timelineRange.durationFrames < 1
    || !Number.isSafeInteger(rangeEnd(item.timelineRange))
  ) return 'adjustment range must be a positive safe integer range'
  if (typeof item.enabled !== 'boolean') return 'adjustment enabled must be boolean'
  if (!Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1) {
    return 'adjustment opacity must be from 0 through 1'
  }
  const animationError = adjustmentAnimationValidationError(item.animation)
  if (animationError) return animationError
  const effectIds = new Set<string>()
  for (const effect of item.effects) {
    const error = effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
    if (error) return error
    if (effectIds.has(effect.id)) return `duplicate adjustment effect id ${effect.id}`
    effectIds.add(effect.id)
  }
  return null
}

/** Default factory; owns serializable edit intent only. */
export function createAdjustmentItem(
  startFrame: number,
  durationFrames: number,
  name = DEFAULT_ADJUSTMENT_NAME,
): AdjustmentItem {
  const item: AdjustmentItem = {
    kind: 'adjustment',
    id: newId('adjustment'),
    name,
    timelineRange: { startFrame, durationFrames },
    enabled: true,
    opacity: 1,
    animation: defaultAdjustmentAnimation(),
    effects: [],
  }
  const error = adjustmentItemValidationError(item)
  if (error) throw new RangeError(error)
  return item
}

export function findAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
): AdjustmentItem | null {
  return locateAdjustment(doc, adjustmentId)?.adjustment ?? null
}

export function trackOfAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
): Track | null {
  return locateAdjustment(doc, adjustmentId)?.track ?? null
}

export function locateAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
): AdjustmentLocation | null {
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex]!
    const adjustmentIndex = adjustmentItems(track)
      .findIndex((item) => item.id === adjustmentId)
    if (adjustmentIndex >= 0) {
      return {
        trackIndex,
        track,
        adjustmentIndex,
        adjustment: adjustmentItems(track)[adjustmentIndex]!,
      }
    }
  }
  return null
}

function itemIdExists(doc: TimelineDoc, id: string): boolean {
  return doc.tracks.some((track) => (
    track.clips.some((clip) => clip.id === id)
    || adjustmentItems(track).some((adjustment) => adjustment.id === id)
  ))
}

function effectIdExists(doc: TimelineDoc, effectId: EffectId): boolean {
  return doc.tracks.some((track) => (
    track.clips.some((clip) => clip.effects.some((effect) => effect.id === effectId))
    || adjustmentItems(track).some((adjustment) => (
      adjustment.effects.some((effect) => effect.id === effectId)
    ))
  ))
}

function overlapsTrackItems(
  track: Track,
  range: TimeRange,
  excludedAdjustmentId?: AdjustmentItemId,
): boolean {
  return track.clips.some((clip) => rangeOverlap(clip.timelineRange, range))
    || adjustmentItems(track).some((adjustment) => (
      adjustment.id !== excludedAdjustmentId
      && rangeOverlap(adjustment.timelineRange, range)
    ))
}

function sortedAdjustments(items: readonly AdjustmentItem[]): AdjustmentItem[] {
  return items.toSorted((left, right) => (
    left.timelineRange.startFrame - right.timelineRange.startFrame
    || left.id.localeCompare(right.id)
  ))
}

function cloneAdjustment(item: AdjustmentItem): AdjustmentItem {
  return {
    ...item,
    timelineRange: { ...item.timelineRange },
    animation: cloneAdjustmentAnimation(item.animation),
    effects: item.effects.map(cloneEffectDescriptor),
  }
}

export function insertAdjustment(
  doc: TimelineDoc,
  trackId: TrackId,
  item: AdjustmentItem,
): TimelineDoc {
  const operation = 'insertAdjustment'
  const trackIndex = doc.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) return reject(doc, operation, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]!
  if (track.kind !== 'video') return reject(doc, operation, 'adjustments require a video track')
  if (track.locked) return reject(doc, operation, `track ${track.id} is locked`)
  const validationError = adjustmentItemValidationError(item)
  if (validationError) return reject(doc, operation, validationError)
  if (itemIdExists(doc, item.id)) {
    return reject(doc, operation, `document already has an item with id ${item.id}`)
  }
  for (const effect of item.effects) {
    if (effectIdExists(doc, effect.id)) {
      return reject(doc, operation, `document already has an effect with id ${effect.id}`)
    }
  }
  if (overlapsTrackItems(track, item.timelineRange)) {
    return reject(doc, operation, 'insert would overlap another timeline item')
  }
  const effectBudgetError = effectCollectionAppendBudgetError(doc, item.effects)
  if (effectBudgetError) return reject(doc, operation, effectBudgetError)
  if (!documentAnimationKeyframeGrowthAllowed(
    doc,
    clipAnimationKeyframeCount(item.animation as ClipAnimation),
  )) return reject(doc, operation, 'insert would exceed the document keyframe budget')
  return withTrack(doc, trackIndex, {
    ...track,
    adjustments: sortedAdjustments([...adjustmentItems(track), cloneAdjustment(item)]),
  })
}

export function moveAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  targetTrackId: TrackId,
  toFrame: number,
): TimelineDoc {
  const operation = 'moveAdjustment'
  if (!Number.isSafeInteger(toFrame) || toFrame < 0) {
    return reject(doc, operation, 'target frame must be a non-negative safe integer')
  }
  const source = locateAdjustment(doc, adjustmentId)
  if (!source) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const targetTrackIndex = doc.tracks.findIndex((track) => track.id === targetTrackId)
  if (targetTrackIndex < 0) return reject(doc, operation, `track ${targetTrackId} not found`)
  const targetTrack = doc.tracks[targetTrackIndex]!
  if (source.track.locked || targetTrack.locked) return reject(doc, operation, 'owning track is locked')
  if (targetTrack.kind !== 'video') return reject(doc, operation, 'adjustments require a video track')
  if (
    source.track.id === targetTrack.id
    && source.adjustment.timelineRange.startFrame === toFrame
  ) return doc
  const nextItem = {
    ...source.adjustment,
    timelineRange: { ...source.adjustment.timelineRange, startFrame: toFrame },
  }
  if (overlapsTrackItems(
    targetTrack,
    nextItem.timelineRange,
    source.track.id === targetTrack.id ? adjustmentId : undefined,
  )) return reject(doc, operation, 'move would overlap another timeline item')

  const tracks = doc.tracks.slice()
  const sourceRemaining = adjustmentItems(source.track)
    .filter((item) => item.id !== adjustmentId)
  tracks[source.trackIndex] = { ...source.track, adjustments: sourceRemaining }
  const currentTarget = tracks[targetTrackIndex]!
  tracks[targetTrackIndex] = {
    ...currentTarget,
    adjustments: sortedAdjustments([...adjustmentItems(currentTarget), nextItem]),
  }
  return { ...doc, tracks }
}

function shiftAnimation(
  animation: AdjustmentAnimation,
  deltaFrames: number,
): AdjustmentAnimation | null {
  const shift = (keyframe: AdjustmentAnimationKeyframe): AdjustmentAnimationKeyframe | null => {
    const frame = keyframe.frame + deltaFrames
    if (!Number.isSafeInteger(frame) || Math.abs(frame) > MAX_KEYFRAME_FRAME) return null
    return { ...cloneAdjustmentKeyframe(keyframe), frame }
  }
  const tracks = animation.tracks.map((track) => ({
    ...track,
    keyframes: track.keyframes.map(shift),
  }))
  const effectTracks = animation.effectTracks.map((track) => ({
    ...track,
    keyframes: track.keyframes.map(shift),
  }))
  if (
    tracks.some((track) => track.keyframes.some((keyframe) => keyframe === null))
    || effectTracks.some((track) => track.keyframes.some((keyframe) => keyframe === null))
  ) return null
  return {
    tracks: tracks as AdjustmentAnimation['tracks'],
    effectTracks: effectTracks as AdjustmentAnimation['effectTracks'],
  }
}

export function trimAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  const operation = 'trimAdjustment'
  if (!Number.isSafeInteger(deltaFrames)) return reject(doc, operation, 'delta must be a safe integer')
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  if (location.track.locked) return reject(doc, operation, `track ${location.track.id} is locked`)
  const current = location.adjustment.timelineRange
  const nextRange = edge === 'start'
    ? {
        startFrame: current.startFrame + deltaFrames,
        durationFrames: current.durationFrames - deltaFrames,
      }
    : {
        startFrame: current.startFrame,
        durationFrames: current.durationFrames + deltaFrames,
      }
  if (
    nextRange.startFrame < 0
    || nextRange.durationFrames < 1
    || !Number.isSafeInteger(rangeEnd(nextRange))
  ) return reject(doc, operation, 'trim would create an invalid range')
  if (overlapsTrackItems(location.track, nextRange, adjustmentId)) {
    return reject(doc, operation, 'trim would overlap another timeline item')
  }
  const animation = edge === 'start'
    ? shiftAnimation(location.adjustment.animation, -deltaFrames)
    : cloneAdjustmentAnimation(location.adjustment.animation)
  if (!animation) return reject(doc, operation, 'trim would exceed animation frame bounds')
  const adjustments = adjustmentItems(location.track).slice()
  adjustments[location.adjustmentIndex] = {
    ...location.adjustment,
    timelineRange: nextRange,
    animation,
  }
  return withTrack(doc, location.trackIndex, {
    ...location.track,
    adjustments: sortedAdjustments(adjustments),
  })
}

function remapAnimationEffectIds(
  animation: AdjustmentAnimation,
  replacements: ReadonlyMap<EffectId, EffectId>,
): AdjustmentAnimation {
  const clone = cloneAdjustmentAnimation(animation)
  clone.effectTracks = clone.effectTracks.map((track) => ({
    ...track,
    effectId: replacements.get(track.effectId) ?? track.effectId,
  }))
  return clone
}

function duplicatePayload(item: AdjustmentItem): Omit<AdjustmentItem, 'timelineRange'> {
  const replacements = new Map<EffectId, EffectId>()
  const effects = item.effects.map((effect) => {
    const id = newId('fx')
    replacements.set(effect.id, id)
    return { ...cloneEffectDescriptor(effect), id }
  })
  return {
    ...item,
    id: newId('adjustment'),
    animation: remapAnimationEffectIds(item.animation, replacements),
    effects,
  }
}

export function splitAdjustmentAtFrame(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  frame: number,
): TimelineDoc {
  const operation = 'splitAdjustmentAtFrame'
  if (!Number.isSafeInteger(frame)) return reject(doc, operation, 'frame must be a safe integer')
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  if (location.track.locked) return reject(doc, operation, `track ${location.track.id} is locked`)
  const range = location.adjustment.timelineRange
  if (frame <= range.startFrame || frame >= rangeEnd(range)) {
    return reject(doc, operation, 'split frame must be strictly inside the adjustment')
  }
  const effectBudgetError = effectCollectionAppendBudgetError(doc, location.adjustment.effects)
  if (effectBudgetError) return reject(doc, operation, effectBudgetError)
  if (!documentAnimationKeyframeGrowthAllowed(
    doc,
    clipAnimationKeyframeCount(location.adjustment.animation as ClipAnimation),
  )) return reject(doc, operation, 'split would exceed the document keyframe budget')
  const offset = frame - range.startFrame
  const shifted = shiftAnimation(location.adjustment.animation, -offset)
  if (!shifted) return reject(doc, operation, 'split would exceed animation frame bounds')
  const rightPayload = duplicatePayload({ ...location.adjustment, animation: shifted })
  const left: AdjustmentItem = {
    ...location.adjustment,
    timelineRange: { startFrame: range.startFrame, durationFrames: offset },
  }
  const right: AdjustmentItem = {
    ...rightPayload,
    timelineRange: { startFrame: frame, durationFrames: range.durationFrames - offset },
  }
  const adjustments = adjustmentItems(location.track).slice()
  adjustments.splice(location.adjustmentIndex, 1, left, right)
  return withTrack(doc, location.trackIndex, { ...location.track, adjustments })
}

export function duplicateAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  toFrame?: number,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'duplicateAdjustment', `adjustment ${adjustmentId} not found`)
  const startFrame = toFrame ?? rangeEnd(location.adjustment.timelineRange)
  const copy: AdjustmentItem = {
    ...duplicatePayload(location.adjustment),
    name: `${location.adjustment.name} copy`,
    timelineRange: {
      startFrame,
      durationFrames: location.adjustment.timelineRange.durationFrames,
    },
  }
  return insertAdjustment(doc, location.track.id, copy)
}

export function removeAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'removeAdjustment', `adjustment ${adjustmentId} not found`)
  if (location.track.locked) {
    return reject(doc, 'removeAdjustment', `track ${location.track.id} is locked`)
  }
  return withTrack(doc, location.trackIndex, {
    ...location.track,
    adjustments: adjustmentItems(location.track).filter((item) => item.id !== adjustmentId),
  })
}

function updateAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  operation: string,
  update: (item: AdjustmentItem) => AdjustmentItem | null,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  if (location.track.locked) return reject(doc, operation, `track ${location.track.id} is locked`)
  const item = update(location.adjustment)
  if (!item) return doc
  const adjustments = adjustmentItems(location.track).slice()
  adjustments[location.adjustmentIndex] = item
  return withTrack(doc, location.trackIndex, { ...location.track, adjustments })
}

export function setAdjustmentEnabled(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  enabled: boolean,
): TimelineDoc {
  if (typeof enabled !== 'boolean') return reject(doc, 'setAdjustmentEnabled', 'enabled must be boolean')
  return updateAdjustment(doc, adjustmentId, 'setAdjustmentEnabled', (item) => (
    item.enabled === enabled ? null : { ...item, enabled }
  ))
}

export function renameAdjustment(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  name: string,
): TimelineDoc {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PROJECT_NAME_CHARACTERS) {
    return reject(doc, 'renameAdjustment', 'name is empty or exceeds its bound')
  }
  return updateAdjustment(doc, adjustmentId, 'renameAdjustment', (item) => (
    item.name === trimmed ? null : { ...item, name: trimmed }
  ))
}

function replaceAdjustmentAnimation(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  animation: AdjustmentAnimation,
  operation: string,
): TimelineDoc {
  const error = adjustmentAnimationValidationError(animation)
  if (error) return reject(doc, operation, error)
  return updateAdjustment(doc, adjustmentId, operation, (item) => ({
    ...item,
    animation: cloneAdjustmentAnimation(animation),
  }))
}

function upsertKeyframe(
  keyframes: readonly AdjustmentAnimationKeyframe[],
  keyframe: AdjustmentAnimationKeyframe,
): AdjustmentAnimationKeyframe[] | null {
  if (
    !Number.isSafeInteger(keyframe.frame)
    || Math.abs(keyframe.frame) > MAX_KEYFRAME_FRAME
    || !Number.isFinite(keyframe.value)
    || animationEasingValidationError(keyframe.easing)
  ) return null
  const next = keyframes.filter((candidate) => candidate.frame !== keyframe.frame)
  next.push(cloneAdjustmentKeyframe(keyframe))
  next.sort((left, right) => left.frame - right.frame)
  if (next.length > 1_024) return null
  return next
}

export function setAdjustmentOpacityAtFrame(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  timelineFrame: number,
  opacity: number,
): TimelineDoc {
  const operation = 'setAdjustmentOpacityAtFrame'
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    return reject(doc, operation, 'opacity must be from 0 through 1')
  }
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const track = location.adjustment.animation.tracks[0]
  if (!track) {
    return updateAdjustment(doc, adjustmentId, operation, (item) => (
      item.opacity === opacity ? null : { ...item, opacity }
    ))
  }
  const localFrame = timelineFrame - location.adjustment.timelineRange.startFrame
  if (localFrame < 0 || localFrame >= location.adjustment.timelineRange.durationFrames) {
    return reject(doc, operation, 'playhead must be inside the adjustment')
  }
  const exists = track.keyframes.some((keyframe) => keyframe.frame === localFrame)
  if (!exists && !documentAnimationKeyframeGrowthAllowed(doc, 1)) {
    return reject(doc, operation, 'opacity key would exceed the document keyframe budget')
  }
  const keyframes = upsertKeyframe(track.keyframes, {
    frame: localFrame,
    value: opacity,
    easing: track.keyframes.find((keyframe) => keyframe.frame === localFrame)?.easing
      ?? { type: 'linear' },
  })
  if (!keyframes) return reject(doc, operation, 'opacity key exceeds its bounds')
  return replaceAdjustmentAnimation(doc, adjustmentId, {
    ...location.adjustment.animation,
    tracks: [{ property: 'opacity', keyframes }],
  }, operation)
}

export function setAdjustmentOpacityKeyframe(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  keyframe: AdjustmentAnimationKeyframe,
): TimelineDoc {
  const operation = 'setAdjustmentOpacityKeyframe'
  if (keyframe.value < 0 || keyframe.value > 1) return reject(doc, operation, 'opacity key is outside 0 through 1')
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const current = location.adjustment.animation.tracks[0]?.keyframes ?? []
  const exists = current.some((candidate) => candidate.frame === keyframe.frame)
  if (!exists && !documentAnimationKeyframeGrowthAllowed(doc, 1)) {
    return reject(doc, operation, 'opacity key would exceed the document keyframe budget')
  }
  const keyframes = upsertKeyframe(current, keyframe)
  if (!keyframes) return reject(doc, operation, 'opacity key exceeds its bounds')
  return replaceAdjustmentAnimation(doc, adjustmentId, {
    ...location.adjustment.animation,
    tracks: [{ property: 'opacity', keyframes }],
  }, operation)
}

export function clearAdjustmentOpacityAnimation(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'clearAdjustmentOpacityAnimation', `adjustment ${adjustmentId} not found`)
  if (location.adjustment.animation.tracks.length === 0) return doc
  return replaceAdjustmentAnimation(doc, adjustmentId, {
    ...location.adjustment.animation,
    tracks: [],
  }, 'clearAdjustmentOpacityAnimation')
}

function effectValidationError(effect: EffectDescriptor): string | null {
  return effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
}

export function addAdjustmentEffect(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effect: EffectDescriptor,
): TimelineDoc {
  const operation = 'addAdjustmentEffect'
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const error = effectValidationError(effect)
  if (error) return reject(doc, operation, error)
  if (!effectSupportsSurface(effect, 'post-composite')) {
    return reject(doc, operation, 'effect is not declared safe for a post-composite surface')
  }
  const budgetError = effectAppendBudgetError(
    doc,
    location.adjustment,
    effect,
    'adjustment',
  )
  if (budgetError) return reject(doc, operation, budgetError)
  if (effectIdExists(doc, effect.id)) return reject(doc, operation, `effect id ${effect.id} already exists`)
  return updateAdjustment(doc, adjustmentId, operation, (item) => ({
    ...item,
    effects: [...item.effects, cloneEffectDescriptor(effect)],
  }))
}

function updateAdjustmentEffect(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  operation: string,
  update: (
    effect: EffectDescriptor,
    index: number,
    effects: readonly EffectDescriptor[],
  ) => EffectDescriptor[] | null,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const index = location.adjustment.effects.findIndex((effect) => effect.id === effectId)
  if (index < 0) return reject(doc, operation, `effect ${effectId} not found`)
  const effects = update(location.adjustment.effects[index]!, index, location.adjustment.effects)
  if (!effects) return doc
  return updateAdjustment(doc, adjustmentId, operation, (item) => ({ ...item, effects }))
}

export function setAdjustmentEffectEnabled(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  enabled: boolean,
): TimelineDoc {
  if (typeof enabled !== 'boolean') return reject(doc, 'setAdjustmentEffectEnabled', 'enabled must be boolean')
  return updateAdjustmentEffect(doc, adjustmentId, effectId, 'setAdjustmentEffectEnabled', (effect, index, current) => {
    if (effect.enabled === enabled) return null
    const effects = current.slice()
    effects[index] = { ...cloneEffectDescriptor(effect), enabled }
    return effects
  })
}

export function updateAdjustmentEffectParamsAtFrame(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  timelineFrame: number,
  patch: Readonly<Record<string, EffectParamValue>>,
): TimelineDoc {
  const operation = 'updateAdjustmentEffectParamsAtFrame'
  if (!Number.isSafeInteger(timelineFrame)) return reject(doc, operation, 'timeline frame must be a safe integer')
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, operation, `adjustment ${adjustmentId} not found`)
  const effect = location.adjustment.effects.find((candidate) => candidate.id === effectId)
  if (!effect) return reject(doc, operation, `effect ${effectId} not found`)
  const staticPatch: Record<string, EffectParamValue> = {}
  const animated = new Map<string, number>()
  for (const [parameter, value] of Object.entries(patch)) {
    const track = location.adjustment.animation.effectTracks.find((candidate) => (
      candidate.effectId === effectId && candidate.parameter === parameter
    ))
    if (!track) {
      staticPatch[parameter] = value
      continue
    }
    const spec = effectAnimationParameterSpec(effect, parameter)
    if (!spec || typeof value !== 'number' || value < spec.min || value > spec.max) {
      return reject(doc, operation, `${effect.type}.${parameter} keyframe value is invalid`)
    }
    animated.set(parameter, value)
  }
  let working = doc
  if (Object.keys(staticPatch).length > 0) {
    working = updateAdjustmentEffect(doc, adjustmentId, effectId, operation, (current, index, effects) => {
      const next = { ...current, params: { ...current.params, ...staticPatch } }
      const error = effectValidationError(next)
      if (error) {
        reject(doc, operation, error)
        return null
      }
      const budgetError = effectReplacementBudgetError(doc, current, next)
      if (budgetError) {
        reject(doc, operation, budgetError)
        return null
      }
      if (Object.entries(staticPatch).every(([key, value]) => current.params[key] === value)) return null
      const copy = effects.slice()
      copy[index] = next
      return copy
    })
  }
  if (animated.size === 0) return working
  const nextLocation = locateAdjustment(working, adjustmentId)
  if (!nextLocation) return doc
  const localFrame = timelineFrame - nextLocation.adjustment.timelineRange.startFrame
  if (localFrame < 0 || localFrame >= nextLocation.adjustment.timelineRange.durationFrames) {
    return reject(doc, operation, 'playhead must be inside the adjustment')
  }
  let animation = cloneAdjustmentAnimation(nextLocation.adjustment.animation)
  const newKeys = [...animated].filter(([parameter]) => !animation.effectTracks
    .find((track) => track.effectId === effectId && track.parameter === parameter)
    ?.keyframes.some((keyframe) => keyframe.frame === localFrame)).length
  if (!documentAnimationKeyframeGrowthAllowed(working, newKeys)) {
    return reject(doc, operation, 'effect key would exceed the document keyframe budget')
  }
  for (const [parameter, value] of animated) {
    const index = animation.effectTracks.findIndex((track) => (
      track.effectId === effectId && track.parameter === parameter
    ))
    const existing = index < 0 ? [] : animation.effectTracks[index]!.keyframes
    const keyframes = upsertKeyframe(existing, {
      frame: localFrame,
      value,
      easing: existing.find((keyframe) => keyframe.frame === localFrame)?.easing
        ?? { type: 'linear' },
    })
    if (!keyframes) return reject(doc, operation, 'effect key exceeds its bounds')
    const nextTrack = { effectId, parameter, keyframes }
    if (index < 0) animation.effectTracks.push(nextTrack)
    else animation.effectTracks[index] = nextTrack
  }
  animation.effectTracks.sort((left, right) => (
    left.effectId.localeCompare(right.effectId)
    || left.parameter.localeCompare(right.parameter)
  ))
  return replaceAdjustmentAnimation(working, adjustmentId, animation, operation)
}

export function setAdjustmentEffectKeyframe(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  parameter: string,
  keyframe: AdjustmentAnimationKeyframe,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'setAdjustmentEffectKeyframe', `adjustment ${adjustmentId} not found`)
  const effect = location.adjustment.effects.find((candidate) => candidate.id === effectId)
  const spec = effect && effectAnimationParameterSpec(effect, parameter)
  if (!effect || !spec || keyframe.value < spec.min || keyframe.value > spec.max) {
    return reject(doc, 'setAdjustmentEffectKeyframe', 'effect keyframe target is unsupported or invalid')
  }
  const animation = cloneAdjustmentAnimation(location.adjustment.animation)
  const index = animation.effectTracks.findIndex((track) => (
    track.effectId === effectId && track.parameter === parameter
  ))
  const current = index < 0 ? [] : animation.effectTracks[index]!.keyframes
  const exists = current.some((candidate) => candidate.frame === keyframe.frame)
  if (!exists && !documentAnimationKeyframeGrowthAllowed(doc, 1)) {
    return reject(doc, 'setAdjustmentEffectKeyframe', 'effect key would exceed the document keyframe budget')
  }
  const keyframes = upsertKeyframe(current, keyframe)
  if (!keyframes) return reject(doc, 'setAdjustmentEffectKeyframe', 'effect key exceeds its bounds')
  const track = { effectId, parameter, keyframes }
  if (index < 0) animation.effectTracks.push(track)
  else animation.effectTracks[index] = track
  return replaceAdjustmentAnimation(doc, adjustmentId, animation, 'setAdjustmentEffectKeyframe')
}

export function clearAdjustmentEffectAnimation(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  parameter?: string,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'clearAdjustmentEffectAnimation', `adjustment ${adjustmentId} not found`)
  const effectTracks = location.adjustment.animation.effectTracks.filter((track) => (
    track.effectId !== effectId || (parameter !== undefined && track.parameter !== parameter)
  ))
  if (effectTracks.length === location.adjustment.animation.effectTracks.length) return doc
  return replaceAdjustmentAnimation(doc, adjustmentId, {
    ...location.adjustment.animation,
    effectTracks,
  }, 'clearAdjustmentEffectAnimation')
}

export function reorderAdjustmentEffect(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
  targetIndex: number,
): TimelineDoc {
  if (!Number.isSafeInteger(targetIndex)) return reject(doc, 'reorderAdjustmentEffect', 'target index must be a safe integer')
  return updateAdjustmentEffect(doc, adjustmentId, effectId, 'reorderAdjustmentEffect', (_effect, index, current) => {
    if (targetIndex < 0 || targetIndex >= current.length) {
      reject(doc, 'reorderAdjustmentEffect', 'target index is outside the stack')
      return null
    }
    if (targetIndex === index) return null
    const effects = current.slice()
    const [moved] = effects.splice(index, 1)
    effects.splice(targetIndex, 0, moved!)
    return effects
  })
}

export function resetAdjustmentEffect(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
): TimelineDoc {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location) return reject(doc, 'resetAdjustmentEffect', `adjustment ${adjustmentId} not found`)
  const effect = location.adjustment.effects.find((candidate) => candidate.id === effectId)
  const registration = effect && effectRegistration(effect.type)
  if (!effect || !registration || registration.version !== effect.version) {
    return reject(doc, 'resetAdjustmentEffect', 'effect has no supported reset contract')
  }
  let working = updateAdjustmentEffect(doc, adjustmentId, effectId, 'resetAdjustmentEffect', (current, index, effects) => {
    const next = { ...current, params: { ...current.params, ...registration.defaultParams } }
    const budgetError = effectReplacementBudgetError(doc, current, next)
    if (budgetError) {
      reject(doc, 'resetAdjustmentEffect', budgetError)
      return null
    }
    if (Object.entries(registration.defaultParams).every(([key, value]) => current.params[key] === value)) return null
    const copy = effects.slice()
    copy[index] = next
    return copy
  })
  working = clearAdjustmentEffectAnimation(working, adjustmentId, effectId)
  return working
}

export function removeAdjustmentEffect(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  effectId: EffectId,
): TimelineDoc {
  let working = updateAdjustmentEffect(doc, adjustmentId, effectId, 'removeAdjustmentEffect', (_effect, index, effects) => {
    const copy = effects.slice()
    copy.splice(index, 1)
    return copy
  })
  if (working === doc) return doc
  working = clearAdjustmentEffectAnimation(working, adjustmentId, effectId)
  return working
}

/** Resolve opacity and safe scalar effect animation at one exact timeline frame. */
export function resolveAdjustmentAtFrame(
  item: AdjustmentItem,
  timelineFrame: number,
): AdjustmentItem {
  if (!Number.isSafeInteger(timelineFrame) || adjustmentAnimationValidationError(item.animation)) {
    return item
  }
  const localFrame = timelineFrame - item.timelineRange.startFrame
  const opacityTrack = item.animation.tracks[0]
  const opacity = opacityTrack
    ? evaluateAnimationTrack(opacityTrack, localFrame, item.opacity)
    : item.opacity
  let effects: EffectDescriptor[] | null = null
  for (let index = 0; index < item.effects.length; index++) {
    const effect = item.effects[index]!
    if (!effectSupportsSurface(effect, 'post-composite')) continue
    const tracks = item.animation.effectTracks.filter((track) => track.effectId === effect.id)
    if (tracks.length === 0) continue
    const params = { ...effect.params }
    let changed = false
    for (const track of tracks) {
      const spec = effectAnimationParameterSpec(effect, track.parameter)
      const fallback = params[track.parameter]
      if (!spec || typeof fallback !== 'number') continue
      const value = evaluateAnimationTrack(track, localFrame, fallback)
      if (value < spec.min || value > spec.max || value === fallback) continue
      params[track.parameter] = value
      changed = true
    }
    if (!changed) continue
    const next = { ...effect, params }
    if (effectParamsValidationError(next)) continue
    effects ??= item.effects.slice()
    effects[index] = next
  }
  if (opacity === item.opacity && effects === null) return item
  return { ...item, opacity, effects: effects ?? item.effects }
}

function neighboringRanges(
  track: Track,
  item: AdjustmentItem,
): { previousEnd: number; nextStart: number } {
  const ranges = [
    ...track.clips.map((clip) => ({ id: clip.id, range: clip.timelineRange })),
    ...adjustmentItems(track).map((adjustment) => ({
      id: adjustment.id,
      range: adjustment.timelineRange,
    })),
  ].toSorted((left, right) => left.range.startFrame - right.range.startFrame)
  const index = ranges.findIndex((candidate) => candidate.id === item.id)
  return {
    previousEnd: index <= 0 ? 0 : rangeEnd(ranges[index - 1]!.range),
    nextStart: index < 0 || index >= ranges.length - 1
      ? Number.MAX_SAFE_INTEGER
      : ranges[index + 1]!.range.startFrame,
  }
}

export function adjustmentEditDeltaBounds(
  doc: TimelineDoc,
  adjustmentId: AdjustmentItemId,
  kind: 'move' | 'trim-start' | 'trim-end',
): AdjustmentEditDeltaBounds | null {
  const location = locateAdjustment(doc, adjustmentId)
  if (!location || location.track.locked) return null
  const range = location.adjustment.timelineRange
  const neighbors = neighboringRanges(location.track, location.adjustment)
  if (kind === 'move') {
    return {
      min: neighbors.previousEnd - range.startFrame,
      max: neighbors.nextStart === Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER - rangeEnd(range)
        : neighbors.nextStart - rangeEnd(range),
    }
  }
  if (kind === 'trim-start') {
    return {
      min: neighbors.previousEnd - range.startFrame,
      max: range.durationFrames - 1,
    }
  }
  return {
    min: -(range.durationFrames - 1),
    max: neighbors.nextStart === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER - rangeEnd(range)
      : neighbors.nextStart - rangeEnd(range),
  }
}
