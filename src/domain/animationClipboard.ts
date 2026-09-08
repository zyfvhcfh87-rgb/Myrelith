/** Defensive internal clipboard. It owns frozen copies, never source project or browser objects. */
import type { FrameRate, TimelineDoc } from './schema'
import type { SequenceProject } from './projectSequences'
import type { AnyAnimationTrack } from './animationCollections'
import { animationParameterIdentityMatches } from './animationParameterIdentity'
import { ANIMATION_EDIT_LIMITS, animationLaneKey, animationOwnerKey, animationSelectionError, type AnimationKeyAddress, type AnimationLaneAddress } from './animationAddresses'
import { animationLaneAddress, animationOwnerIndex, animationTrackWithKeys, findAnimationLane, pathLaneAvailable, scalarLaneProperty, type AnimationEditContext, type AnimationOwner, trackAtAddress } from './animationOwners'
import { clipAnimationValidationError } from './clipAnimation'
import { maskPathAnimationSnapshotBudget } from './maskPathAnimation'
import { titlePayloadBudget } from './titleBudgets'
import { rateEquals } from './time'
import { planAnimationInsertions, type AnimationBatchResult, type AnimationLaneInsertion } from './animationBatch'
import type { ScalarAnimationPropertySpec } from './animationPropertyCatalog'

export interface AnimationClipboardLane {
  readonly address: AnimationLaneAddress
  readonly track: AnyAnimationTrack
  readonly globalFrames: readonly number[]
  /** A value contract captured from the explicit property authority, never numeric JSON inference. */
  readonly effectType?: string
  readonly contract: ScalarAnimationPropertySpec | 'held-mask-path-v1' | null
}
export interface AnimationKeyClipboard {
  readonly version: 1
  readonly frameRate: FrameRate
  readonly anchorGlobalFrame: number
  readonly lanes: readonly AnimationClipboardLane[]
}
export interface AnimationPasteMapping { readonly from: AnimationLaneAddress; readonly to: AnimationLaneAddress }
export type AnimationClipboardResult = { readonly ok: true; readonly clipboard: AnimationKeyClipboard } | { readonly ok: false; readonly reason: string }
function frozenTrack(source: AnyAnimationTrack, keys: readonly AnyAnimationTrack['keyframes'][number][]): AnyAnimationTrack {
  const track = animationTrackWithKeys(source, keys)
  if ('parameterIdentity' in track && track.parameterIdentity) track.parameterIdentity = Object.freeze({ ...track.parameterIdentity })
  for (const key of track.keyframes) { Object.freeze(key.easing); Object.freeze(key) }
  Object.freeze(track.keyframes)
  return Object.freeze(track)
}
function contractFor(owner: AnimationOwner, address: AnimationLaneAddress, track: AnyAnimationTrack, context: AnimationEditContext): AnimationClipboardLane['contract'] {
  if (address.kind === 'path') return pathLaneAvailable(owner, address, track, context) ? 'held-mask-path-v1' : null
  const property = scalarLaneProperty(owner, address, context)
  return property.status === 'available' ? Object.freeze({ ...property.spec }) : null
}
function sameContract(left: AnimationClipboardLane['contract'], right: AnimationClipboardLane['contract']): boolean {
  if (left === null || right === null) return false
  if (typeof left === 'string' || typeof right === 'string') return left === right
  return left.propertyVersion === right.propertyVersion && left.unit === right.unit && left.min === right.min && left.max === right.max
    && (left.minExclusive ?? false) === (right.minExclusive ?? false)
}
export function animationClipboardError(clipboard: AnimationKeyClipboard): string | null {
  if (clipboard.version !== 1 || !Number.isSafeInteger(clipboard.anchorGlobalFrame)
    || !Number.isSafeInteger(clipboard.frameRate.num) || clipboard.frameRate.num < 1
    || !Number.isSafeInteger(clipboard.frameRate.den) || clipboard.frameRate.den < 1
    || !Array.isArray(clipboard.lanes) || clipboard.lanes.length < 1 || clipboard.lanes.length > ANIMATION_EDIT_LIMITS.lanes) return 'The key clipboard envelope is invalid.'
  let count = 0, earliest = Infinity
  const selection: AnimationKeyAddress[] = []
  for (const lane of clipboard.lanes) {
    count += lane.track.keyframes.length
    if (count > ANIMATION_EDIT_LIMITS.selectedKeys || lane.track.keyframes.length < 1 || lane.globalFrames.length !== lane.track.keyframes.length) return 'The key clipboard exceeds its key limit or has inconsistent timing.'
    if (animationLaneKey(animationLaneAddress(lane.address.owner, lane.track)) !== animationLaneKey(lane.address)) return 'Clipboard track metadata does not match its address.'
    const animation = { tracks: [], effectTracks: [], ...(lane.address.kind === 'scalar' ? { tracks: [lane.track] }
      : lane.address.kind === 'effect' ? { effectTracks: [lane.track] } : lane.address.kind === 'title' ? { titleTracks: [lane.track] } : { effectPathTracks: [lane.track] }) }
    // The existing typed field boundary performs value/easing/version validation.
    const error = clipAnimationValidationError(animation as Parameters<typeof clipAnimationValidationError>[0])
    if (error) return error
    for (let index = 0; index < lane.track.keyframes.length; index++) {
      const frame = lane.globalFrames[index]
      if (!Number.isSafeInteger(frame) || !Number.isSafeInteger(frame - lane.track.keyframes[index].frame)
        || frame - lane.track.keyframes[index].frame !== lane.globalFrames[0] - lane.track.keyframes[0].frame
        || (index > 0 && frame <= lane.globalFrames[index - 1])) return 'Clipboard global times must be ordered safe integers.'
      earliest = Math.min(earliest, frame)
      selection.push({ lane: lane.address, frame: lane.track.keyframes[index].frame })
    }
  }
  const error = animationSelectionError(selection)
  if (error) return error
  if (earliest !== clipboard.anchorGlobalFrame) return 'Clipboard anchor must be its earliest global key.'
  const paths = clipboard.lanes.flatMap(({ track }) => 'valueType' in track ? [track] : [])
  const pathBudget = maskPathAnimationSnapshotBudget({ tracks: paths })
  if (!pathBudget.ok) return pathBudget.reason
  const titles = new Map<string, Extract<AnyAnimationTrack, { elementId: string }>[]> ()
  for (const lane of clipboard.lanes) if ('elementId' in lane.track) {
    const id = animationOwnerKey(lane.address.owner), tracks = titles.get(id) ?? []
    tracks.push(lane.track); titles.set(id, tracks)
  }
  for (const tracks of titles.values()) {
    const budget = titlePayloadBudget({ titleTracks: tracks })
    if (!budget.ok) return budget.reason
  }
  return null
}
export function copyAnimationKeys(sequence: TimelineDoc, selection: readonly AnimationKeyAddress[], context: AnimationEditContext = {}): AnimationClipboardResult {
  try {
    const error = animationSelectionError(selection)
    if (error || !selection.length) return { ok: false, reason: error ?? 'Select at least one key to copy.' }
    const owners = animationOwnerIndex(sequence), groups = new Map<string, { address: AnimationLaneAddress; frames: Set<number> }>()
    for (const key of selection) {
      const group = groups.get(animationLaneKey(key.lane)) ?? { address: key.lane, frames: new Set<number>() }
      group.frames.add(key.frame); groups.set(animationLaneKey(key.lane), group)
    }
    const lanes: AnimationClipboardLane[] = []
    let anchor = Infinity
    for (const { address, frames } of groups.values()) {
      const owner = owners.get(animationOwnerKey(address.owner)), source = owner && findAnimationLane(owner, address)
      if (!owner || !source) return { ok: false, reason: 'A copied lane no longer exists.' }
      const keys = source.keyframes.filter((key) => frames.has(key.frame))
      if (keys.length !== frames.size) return { ok: false, reason: 'A copied key no longer exists.' }
      const track = frozenTrack(source, keys)
      const globalFrames = keys.map((key) => owner.item.timelineRange.startFrame + key.frame)
      anchor = Math.min(anchor, ...globalFrames)
      const laneAddress = animationLaneAddress(Object.freeze({ ...address.owner }), track)
      Object.freeze(laneAddress)
      lanes.push(Object.freeze({ address: laneAddress, track, globalFrames: Object.freeze(globalFrames), ...((address.kind === 'effect' || address.kind === 'path') ? { effectType: owner.item.effects.find((effect) => effect.id === address.effectId)?.type } : {}), contract: contractFor(owner, address, source, context) }))
    }
    const clipboard: AnimationKeyClipboard = Object.freeze({ version: 1, frameRate: Object.freeze({ ...sequence.frameRate }), anchorGlobalFrame: anchor, lanes: Object.freeze(lanes) })
    const invalid = animationClipboardError(clipboard)
    return invalid ? { ok: false, reason: invalid } : { ok: true, clipboard }
  } catch (cause) { return { ok: false, reason: cause instanceof Error ? cause.message : 'The selected keys cannot be copied.' } }
}
export function planAnimationPaste(project: SequenceProject, sequenceId: string, clipboard: AnimationKeyClipboard, playheadFrame: number, context: AnimationEditContext = {}, mapping?: readonly AnimationPasteMapping[], originalTime = false): AnimationBatchResult {
  const reject = (reason: string): AnimationBatchResult => ({ ok: false, project, code: 'unavailable', reason })
  try {
    const error = animationClipboardError(clipboard)
    if (error) return reject(error)
    const sequence = project.sequences.find((sequence) => sequence.id === sequenceId)
    if (!sequence || !rateEquals(sequence.frameRate, clipboard.frameRate)) return reject('The copied and destination frame rates do not match.')
    if (!Number.isSafeInteger(playheadFrame) || playheadFrame < 0) return reject('Paste requires an integer playhead at or after zero.')
    if (mapping && (mapping.length !== clipboard.lanes.length || new Set(mapping.map((item) => animationLaneKey(item.from))).size !== mapping.length)) return reject('Provide one explicit mapping for every copied lane.')
    const owners = animationOwnerIndex(sequence), insertions: AnimationLaneInsertion[] = []
    const delta = originalTime ? 0 : playheadFrame - clipboard.anchorGlobalFrame
    if (!Number.isSafeInteger(delta)) return reject('The paste offset exceeds safe integer bounds.')
    for (const lane of clipboard.lanes) {
      const destination = mapping ? mapping.find((item) => animationLaneKey(item.from) === animationLaneKey(lane.address))?.to : lane.address
      if (!destination) return reject('A copied lane has no destination mapping.')
      const owner = owners.get(animationOwnerKey(destination.owner))
      if (!owner) return reject('A destination animation owner no longer exists.')
      if (lane.address.kind !== destination.kind) return reject('Scalar and path lane kinds cannot be interchanged.')
      // An exact lane address does not bind the effect type behind its ID.
      // Two still-missing owners compare equal, preserving opaque orphan intent.
      if ((destination.kind === 'effect' || destination.kind === 'path')
        && lane.effectType !== owner.item.effects.find((effect) => effect.id === destination.effectId)?.type) return reject('The effect type must match the copied lane, even at its original address.')
      const existing = findAnimationLane(owner, destination)
      const exact = animationLaneKey(destination) === animationLaneKey(lane.address)
      const metadata = trackAtAddress(lane.track, destination)
      const destinationContract = contractFor(owner, destination, existing ?? metadata, context)
      if (!sameContract(lane.contract, destinationContract) && !(exact && existing && lane.contract === null && destinationContract === null)) return reject('The destination property kind, version, units or bounds do not match the copied lane.')
      if (lane.address.kind === 'effect' && destination.kind === 'effect') {
        if (lane.address.parameter !== destination.parameter) return reject('The effect parameter must match the copied lane.')
        const left = lane.address.parameterIdentity, right = destination.parameterIdentity
        if ((left === undefined) !== (right === undefined) || (left && right && !animationParameterIdentityMatches(left, right) && !exact)) return reject('Plugin declaration identities do not match.')
      }
      const keys = lane.track.keyframes.map((key, index) => {
        const globalFrame = lane.globalFrames[index] + delta
        if (!Number.isSafeInteger(globalFrame)) throw new RangeError('The pasted global key frame exceeds safe integer bounds.')
        return { ...key, frame: globalFrame - owner.item.timelineRange.startFrame }
      })
      insertions.push({ lane: destination, track: animationTrackWithKeys(metadata, keys) })
    }
    return planAnimationInsertions(project, sequenceId, insertions, context)
  } catch (cause) { return reject(cause instanceof Error ? cause.message : 'The copied keys cannot be pasted.') }
}
