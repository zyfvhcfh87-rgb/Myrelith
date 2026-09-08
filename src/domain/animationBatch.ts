/** One immutable planner for multi-key edits. Never delegates to destructive single-key moves. */
import type { AdjustmentAnimation, ClipAnimation, ClipAnimationTrack, EffectAnimationTrack, ClipAnimationEasing, TimelineDoc } from './schema'
import type { SequenceProject } from './projectSequences'
import { sequenceProjectWithinEditBudget } from './projectSequences'
import { projectCropAnimationError } from './projectCropAnimation'
import { projectTitleAnimationError } from './animationProjectBudget'
import { animationEasingValidationError, clipAnimationKindError, clipAnimationValidationError } from './clipAnimation'
import { adjustmentAnimationValidationError } from './adjustmentItems'
import { MAX_KEYFRAME_FRAME, keyframesValidationError } from './scalarAnimation'
import { scalarAnimationValueError } from './animationPropertyCatalog'
import type { AnyAnimationTrack } from './animationCollections'
import {
  ANIMATION_EDIT_LIMITS, animationLaneKey, animationOwnerKey, animationSemanticLaneKey,
  animationSelectionError, animationLaneAddressError, animationKeyKey, type AnimationKeyAddress, type AnimationLaneAddress,
} from './animationAddresses'
import {
  animationLaneAddress, animationOwnerIndex, animationOwnerLanes, animationTrackWithKeys,
  findAnimationLane, keyAtDestination, pathLaneAvailable, scalarLaneProperty, trackAtAddress,
  type AnimationEditContext, type AnimationOwner,
} from './animationOwners'

export type AnimationBatchCommand =
  | { readonly kind: 'move' | 'duplicate'; readonly deltaFrames: number }
  | { readonly kind: 'delete' }
  | { readonly kind: 'set-value'; readonly value: number }
  | { readonly kind: 'set-easing'; readonly easing: ClipAnimationEasing }
export type AnimationBatchFailureCode = 'invalid-selection' | 'missing-target' | 'locked' | 'collision' | 'unavailable' | 'bounds' | 'budget'
export type AnimationBatchResult =
  | { readonly ok: true; readonly project: SequenceProject; readonly changed: boolean; readonly selection: readonly AnimationKeyAddress[]; readonly focus: AnimationKeyAddress | null }
  | { readonly ok: false; readonly project: SequenceProject; readonly code: AnimationBatchFailureCode; readonly reason: string }
export interface AnimationLaneInsertion { readonly lane: AnimationLaneAddress; readonly track: AnyAnimationTrack }
class BatchError extends Error {
  readonly code: AnimationBatchFailureCode
  constructor(code: AnimationBatchFailureCode, message: string) { super(message); this.code = code }
}
function fail(code: AnimationBatchFailureCode, reason: string): never { throw new BatchError(code, reason) }
function boundedFrame(frame: number): void {
  if (!Number.isSafeInteger(frame) || Math.abs(frame) > MAX_KEYFRAME_FRAME) fail('bounds', 'Key frames must stay within the signed integer frame limit.')
}
function requireOwner(owners: ReadonlyMap<string, AnimationOwner>, lane: AnimationLaneAddress): AnimationOwner {
  const owner = owners.get(animationOwnerKey(lane.owner))
  if (!owner) fail('missing-target', 'An animation owner no longer exists.')
  if (owner.track.locked) fail('locked', 'An animation owner is on a locked track.')
  return owner
}
function withAnimation(owner: AnimationOwner, updates: ReadonlyMap<string, AnyAnimationTrack | null>): ClipAnimation {
  const existing = animationOwnerLanes(owner), seen = new Set<string>()
  const tracks: AnyAnimationTrack[] = []
  for (const track of existing) {
    const id = animationSemanticLaneKey(animationLaneAddress(owner.address, track))
    seen.add(id)
    const replacement = updates.has(id) ? updates.get(id)! : track
    if (replacement) tracks.push(replacement)
  }
  for (const [id, track] of updates) if (!seen.has(id) && track) tracks.push(track)
  return {
    ...owner.animation,
    tracks: tracks.filter((track): track is ClipAnimationTrack => !('effectId' in track) && !('elementId' in track)),
    ...(owner.animation.effectTracks === undefined && !tracks.some((track) => 'effectId' in track && !('valueType' in track)) ? {}
      : { effectTracks: tracks.filter((track): track is EffectAnimationTrack => 'effectId' in track && !('valueType' in track)) }),
    ...(owner.animation.titleTracks === undefined && !tracks.some((track) => 'elementId' in track) ? {} : { titleTracks: tracks.filter((track) => 'elementId' in track) }),
    ...(owner.animation.effectPathTracks === undefined && !tracks.some((track) => 'valueType' in track) ? {} : { effectPathTracks: tracks.filter((track) => 'valueType' in track) }),
  }
}
function applyUpdates(project: SequenceProject, sequence: TimelineDoc, owners: ReadonlyMap<string, AnimationOwner>, updates: ReadonlyMap<string, ReadonlyMap<string, AnyAnimationTrack | null>>): SequenceProject {
  if (!updates.size) return project
  const animations = new Map<string, ClipAnimation>()
  for (const [id, changes] of updates) {
    const owner = owners.get(id)!, animation = withAnimation(owner, changes)
    const error = owner.clip ? clipAnimationValidationError(animation)
      ?? clipAnimationKindError(owner.track.kind, owner.clip.text !== undefined, animation)
      : adjustmentAnimationValidationError(animation as AdjustmentAnimation)
    if (error) fail('bounds', error)
    animations.set(id, animation)
  }
  const tracks = sequence.tracks.map((track) => {
    let changed = false
    const clips = track.clips.map((clip) => {
      const animation = animations.get(animationOwnerKey({ kind: 'clip', id: clip.id }))
      if (!animation) return clip
      changed = true; return { ...clip, animation }
    })
    const adjustments = track.adjustments?.map((item) => {
      const animation = animations.get(animationOwnerKey({ kind: 'adjustment', id: item.id }))
      if (!animation) return item
      changed = true; return { ...item, animation: animation as AdjustmentAnimation }
    })
    return changed ? { ...track, clips, ...(adjustments === undefined ? {} : { adjustments }) } : track
  })
  const candidate = { ...project, sequences: project.sequences.map((item) => item === sequence ? { ...sequence, tracks } : item) }
  if (!sequenceProjectWithinEditBudget(candidate)) fail('budget', projectCropAnimationError(candidate) ?? projectTitleAnimationError(candidate) ?? 'The edit exceeds the project animation limits.')
  return candidate
}
function failure(project: SequenceProject, cause: unknown): AnimationBatchResult {
  return { ok: false, project, code: cause instanceof BatchError ? cause.code : 'bounds', reason: cause instanceof Error ? cause.message : 'The animation edit is invalid.' }
}
function recordUpdate(updates: Map<string, Map<string, AnyAnimationTrack | null>>, lane: AnimationLaneAddress, track: AnyAnimationTrack | null) {
  const id = animationOwnerKey(lane.owner), lanes = updates.get(id) ?? new Map<string, AnyAnimationTrack | null>()
  lanes.set(animationSemanticLaneKey(lane), track); updates.set(id, lanes)
}

export function nearestAnimationKey(sequence: TimelineDoc, focus: AnimationKeyAddress | null): AnimationKeyAddress | null {
  if (!focus) return null
  const owner = animationOwnerIndex(sequence).get(animationOwnerKey(focus.lane.owner))
  if (!owner) return null
  const lane = findAnimationLane(owner, focus.lane)
  if (lane?.keyframes.length) {
    const frame = lane.keyframes.reduce((best, key) => Math.abs(key.frame - focus.frame) < Math.abs(best - focus.frame) ? key.frame : best, lane.keyframes[0].frame)
    return { lane: animationLaneAddress(owner.address, lane), frame }
  }
  const next = animationOwnerLanes(owner).find((track) => track.keyframes.length > 0)
  return next ? { lane: animationLaneAddress(owner.address, next), frame: next.keyframes[0].frame } : null
}
export function reconcileAnimationKeys(sequence: TimelineDoc, selection: readonly AnimationKeyAddress[]): readonly AnimationKeyAddress[] {
  const owners = animationOwnerIndex(sequence), lanes = new Map<string, ReadonlySet<number>>()
  return selection.filter((key) => {
    const id = animationLaneKey(key.lane)
    let frames = lanes.get(id)
    if (!frames) {
      const owner = owners.get(animationOwnerKey(key.lane.owner))
      frames = new Set(owner ? findAnimationLane(owner, key.lane)?.keyframes.map((item) => item.frame) : [])
      lanes.set(id, frames)
    }
    return frames.has(key.frame)
  })
}

export function planAnimationBatch(project: SequenceProject, sequenceId: string, selection: readonly AnimationKeyAddress[], command: AnimationBatchCommand, context: AnimationEditContext = {}, focus: AnimationKeyAddress | null = selection[0] ?? null): AnimationBatchResult {
  try {
    if (!['move', 'duplicate', 'delete', 'set-value', 'set-easing'].includes(command.kind)) fail('bounds', 'The animation command is unsupported.')
    const error = animationSelectionError(selection)
    if (error || !selection.length) fail('invalid-selection', error ?? 'Select at least one animation key.')
    const sequence = project.sequences.find((item) => item.id === sequenceId)
    if (!sequence) fail('missing-target', 'The animation sequence no longer exists.')
    const owners = animationOwnerIndex(sequence), groups = new Map<string, { lane: AnimationLaneAddress; frames: Set<number> }>()
    for (const key of selection) {
      const id = animationLaneKey(key.lane), group = groups.get(id) ?? { lane: key.lane, frames: new Set<number>() }
      group.frames.add(key.frame); groups.set(id, group)
    }
    for (const { lane, frames } of groups.values()) {
      const owner = requireOwner(owners, lane), track = findAnimationLane(owner, lane)
      const existing = new Set(track?.keyframes.map((key) => key.frame))
      if (!track || [...frames].some((frame) => !existing.has(frame))) fail('missing-target', 'A selected key or lane version changed.')
    }
    if ((command.kind === 'move' || command.kind === 'duplicate') && !Number.isSafeInteger(command.deltaFrames)) fail('bounds', 'The key offset must be an integer.')
    if (command.kind === 'move' && command.deltaFrames === 0) return { ok: true, project, changed: false, selection, focus }
    const updates = new Map<string, Map<string, AnyAnimationTrack | null>>()
    for (const { lane, frames } of groups.values()) {
      const owner = requireOwner(owners, lane), track = findAnimationLane(owner, lane)!
      const selected = track.keyframes.filter((key) => frames.has(key.frame))
      const remaining = command.kind === 'duplicate' ? [...track.keyframes] : track.keyframes.filter((key) => !frames.has(key.frame))
      if (command.kind === 'set-value' || command.kind === 'set-easing') {
        const property = scalarLaneProperty(owner, lane, context)
        if (property.status !== 'available') fail('unavailable', property.reason)
        const invalid = command.kind === 'set-value' ? scalarAnimationValueError(property.spec, command.value) : animationEasingValidationError(command.easing)
        if (invalid) fail('bounds', invalid)
      }
      const occupied = new Set(remaining.map((key) => key.frame))
      if (command.kind !== 'delete') for (const key of selected) {
        let next = key
        if (command.kind === 'move' || command.kind === 'duplicate') {
          const frame = key.frame + command.deltaFrames; boundedFrame(frame)
          next = keyAtDestination(owner, key, frame, context)
        } else if (command.kind === 'set-value') next = { ...key, value: command.value }
        else if (command.kind === 'set-easing') {
          if (typeof key.value !== 'number') fail('unavailable', 'Path easing is hold-only.')
          next = { ...key, value: key.value, easing: { ...command.easing } }
        }
        if (occupied.has(next.frame)) fail('collision', 'A destination key already exists. The whole edit was rejected.')
        remaining.push(next); occupied.add(next.frame)
      }
      remaining.sort((a, b) => a.frame - b.frame)
      const next = remaining.length ? animationTrackWithKeys(track, remaining) : null
      if (JSON.stringify(next) !== JSON.stringify(track)) recordUpdate(updates, lane, next)
    }
    const candidate = applyUpdates(project, sequence, owners, updates)
    const resultSequence = candidate.sequences.find((item) => item.id === sequenceId)!
    const nextSelection = command.kind === 'delete' ? [] : selection.map((key) => ({ lane: key.lane, frame: key.frame + (command.kind === 'move' || command.kind === 'duplicate' ? command.deltaFrames : 0) }))
    const focusedIndex = focus ? selection.findIndex((key) => animationKeyKey(key) === animationKeyKey(focus)) : -1
    return { ok: true, project: candidate, changed: candidate !== project, selection: nextSelection,
      focus: nextSelection[focusedIndex] ?? nearestAnimationKey(resultSequence, focus) }
  } catch (cause) { return failure(project, cause) }
}

/** A paste is one checked insertion set; targets are resolved before any write. */
export function planAnimationInsertions(project: SequenceProject, sequenceId: string, insertions: readonly AnimationLaneInsertion[], context: AnimationEditContext = {}, replaceAtSameFrame = false): AnimationBatchResult {
  try {
    if (insertions.length > ANIMATION_EDIT_LIMITS.lanes) fail('bounds', 'An insertion supports at most 128 lanes.')
    let count = 0
    for (const insertion of insertions) {
      count += insertion.track.keyframes.length
      if (count > ANIMATION_EDIT_LIMITS.selectedKeys) fail('bounds', 'An insertion supports at most 4,096 keys.')
    }
    if (replaceAtSameFrame && (insertions.length !== 1 || count !== 1)) fail('bounds', 'Replacement semantics apply only to one explicitly set key.')
    const selected = insertions.flatMap(({ lane, track }) => track.keyframes.map((key) => ({ lane, frame: key.frame })))
    const error = animationSelectionError(selected)
    if (error || !selected.length) fail('invalid-selection', error ?? 'No animation keys were supplied.')
    const sequence = project.sequences.find((item) => item.id === sequenceId)
    if (!sequence) fail('missing-target', 'The animation sequence no longer exists.')
    const owners = animationOwnerIndex(sequence), updates = new Map<string, Map<string, AnyAnimationTrack | null>>(), seen = new Set<string>()
    for (const { lane, track: inserted } of insertions) {
      const owner = requireOwner(owners, lane), existing = findAnimationLane(owner, lane)
      const semantic = animationSemanticLaneKey(lane)
      if (seen.has(semantic)) fail('collision', 'Two insertion lanes compete for the same destination.')
      seen.add(semantic)
      const competing = animationOwnerLanes(owner).find((item) => animationSemanticLaneKey(animationLaneAddress(owner.address, item)) === semantic)
      if (competing && competing !== existing) fail('collision', 'An unavailable version already owns the destination property.')
      if (animationLaneKey(animationLaneAddress(owner.address, inserted)) !== animationLaneKey(lane)) fail('bounds', 'Inserted track metadata does not match its destination address.')
      const property = scalarLaneProperty(owner, lane, context)
      if (property.status === 'available') {
        const invalid = keyframesValidationError(inserted.keyframes as ClipAnimationTrack['keyframes'], (value) => scalarAnimationValueError(property.spec, value))
        if (invalid) fail('bounds', invalid)
      }
      const keys = inserted.keyframes.map((key) => { boundedFrame(key.frame); return keyAtDestination(owner, key, key.frame, context) })
      const frames = new Set(keys.map((key) => key.frame))
      if (!replaceAtSameFrame && existing?.keyframes.some((key) => frames.has(key.frame))) fail('collision', 'Paste would overwrite a destination key.')
      const merged = [...(existing?.keyframes.filter((key) => !frames.has(key.frame)) ?? []), ...keys].sort((a, b) => a.frame - b.frame)
      const next = animationTrackWithKeys(existing ?? inserted, merged)
      if (!existing) {
        if (lane.kind === 'path' ? !pathLaneAvailable(owner, lane, next, context) : scalarLaneProperty(owner, lane, context).status !== 'available') fail('unavailable', 'The destination property is unavailable; missing targets cannot be created by paste.')
      }
      if (JSON.stringify(next) !== JSON.stringify(existing)) recordUpdate(updates, lane, next)
    }
    const candidate = applyUpdates(project, sequence, owners, updates)
    return { ok: true, project: candidate, changed: candidate !== project, selection: selected, focus: selected[0] ?? null }
  } catch (cause) { return failure(project, cause) }
}

/** Explicit Set replaces one exact-time key; multi-key commands never enable this policy. */
export function planSetAnimationKey(project: SequenceProject, sequenceId: string, lane: AnimationLaneAddress, frame: number, value: number | string, easing: ClipAnimationEasing | undefined, context: AnimationEditContext = {}): AnimationBatchResult {
  try {
    const error = animationLaneAddressError(lane)
    if (error) fail('bounds', error)
    boundedFrame(frame)
    const sequence = project.sequences.find((item) => item.id === sequenceId)
    if (!sequence) fail('missing-target', 'The animation sequence no longer exists.')
    const owner = requireOwner(animationOwnerIndex(sequence), lane), existing = findAnimationLane(owner, lane)
    const selectedEasing = easing ?? existing?.keyframes.find((key) => key.frame === frame)?.easing ?? { type: lane.kind === 'path' ? 'hold' as const : 'linear' as const }
    const easingError = animationEasingValidationError(selectedEasing)
    if (easingError) fail('bounds', easingError)
    const key = typeof value === 'string'
      ? { frame, value, easing: { type: 'hold' as const } }
      : { frame, value, easing: { ...selectedEasing } }
    const track = animationTrackWithKeys(trackAtAddress(existing ?? { property: '', keyframes: [] }, lane), [key])
    if (lane.kind === 'path') {
      if (selectedEasing.type !== 'hold' || !pathLaneAvailable(owner, lane, track, context)) fail('unavailable', 'This held-path target or value is unavailable.')
    } else {
      const property = scalarLaneProperty(owner, lane, context)
      if (property.status !== 'available') fail('unavailable', property.reason)
      if (typeof value !== 'number' || scalarAnimationValueError(property.spec, value)) fail('bounds', 'The key value exceeds its declared bounds.')
    }
    return planAnimationInsertions(project, sequenceId, [{ lane, track }], context, true)
  } catch (cause) { return failure(project, cause) }
}
