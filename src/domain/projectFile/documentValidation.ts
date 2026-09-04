import type { AdjustmentAnimationKeyframe, AdjustmentItem, CaptionItem, CaptionTrack, Clip, MasterAudioSettings, MulticamDefinition, MulticamInstance, SequenceInstance, TimelineDoc, TimelineMarker, Track } from '../schema';
import { adjustmentAnimationValidationError, adjustmentItemValidationError } from '../adjustmentItems';
import { MAX_ANIMATED_FINITE_MAGNITUDE, MAX_KEYFRAME_FRAME, MAX_KEYFRAMES_PER_TRACK } from '../clipAnimation';
import { CAPTION_LIMITS, CAPTION_STYLE_PRESETS, CAPTION_TRACK_ROLES, captionDocumentValidationError, captionTrackValidationError, compareCaptionItems } from '../captions';
import { compareTimelineMarkers, MAX_TIMELINE_MARKER_FRAME, MAX_TIMELINE_MARKER_ID_CHARACTERS, MAX_TIMELINE_MARKER_LABEL_CHARACTERS, MAX_TIMELINE_MARKER_NOTE_CHARACTERS, TIMELINE_MARKER_COLORS } from '../timelineMarkers';
import { renderSurfaceBudget } from '../renderSurfaceBudget';
import { CURRENT_PROJECT_FORMAT_VERSION, CURRENT_TIMELINE_SCHEMA_VERSION, PROJECT_FILE_FORMAT, PROJECT_FILE_LIMITS, type PortableAssetDescriptor, type ProjectFile } from './projectTypes';
import { booleanValue, boundedArray, exactKeys, fail, finiteNumber, record, safeInteger, stringValue, validateFrameRate } from './validationPrimitives';
import { validateAsset, validateMediaCollections } from './assetValidation';
import { validateAnimationEasing, validateAudioEffectStack, validateClip, validateEffect, validateRange, type ValidationContext } from './clipValidation';

function validateAdjustmentKeyframes(
  value: unknown,
  path: string,
  context: ValidationContext,
): AdjustmentAnimationKeyframe[] {
  boundedArray(value, path, MAX_KEYFRAMES_PER_TRACK)
  if (value.length === 0) fail(path, 'must not be empty')
  context.keyframeCount += value.length
  if (context.keyframeCount > PROJECT_FILE_LIMITS.maxTotalKeyframes) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`)
  }
  let previousFrame: number | null = null
  for (let index = 0; index < value.length; index++) {
    const keyframePath = `${path}[${index}]`
    const keyframe = record(value[index], keyframePath)
    exactKeys(keyframe, ['frame', 'value', 'easing'], [], keyframePath)
    safeInteger(keyframe.frame, `${keyframePath}.frame`, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME)
    if (previousFrame !== null && keyframe.frame <= previousFrame) {
      fail(`${keyframePath}.frame`, 'must be strictly increasing and unique')
    }
    finiteNumber(
      keyframe.value,
      `${keyframePath}.value`,
      -MAX_ANIMATED_FINITE_MAGNITUDE,
      MAX_ANIMATED_FINITE_MAGNITUDE,
    )
    validateAnimationEasing(keyframe.easing, `${keyframePath}.easing`)
    previousFrame = Number(keyframe.frame)
  }
  return value as AdjustmentAnimationKeyframe[]
}

function validateAdjustment(
  value: unknown,
  path: string,
  trackKind: Track['kind'],
  context: ValidationContext,
): AdjustmentItem {
  const item = record(value, path)
  exactKeys(
    item,
    ['kind', 'id', 'name', 'timelineRange', 'enabled', 'opacity', 'animation', 'effects'],
    [],
    path,
  )
  if (item.kind !== 'adjustment') fail(`${path}.kind`, 'expected adjustment')
  if (trackKind !== 'video') fail(path, 'adjustments require a video track')
  stringValue(item.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.timelineItemIds.has(item.id)) fail(`${path}.id`, 'duplicate timeline item id')
  context.timelineItemIds.add(item.id)
  stringValue(item.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  validateRange(item.timelineRange, `${path}.timelineRange`, 1)
  booleanValue(item.enabled, `${path}.enabled`)
  finiteNumber(item.opacity, `${path}.opacity`, 0, 1)

  const animation = record(item.animation, `${path}.animation`)
  exactKeys(animation, ['tracks', 'effectTracks'], [], `${path}.animation`)
  boundedArray(animation.tracks, `${path}.animation.tracks`, 1)
  for (let index = 0; index < animation.tracks.length; index++) {
    const trackPath = `${path}.animation.tracks[${index}]`
    const track = record(animation.tracks[index], trackPath)
    exactKeys(track, ['property', 'keyframes'], [], trackPath)
    if (track.property !== 'opacity') fail(`${trackPath}.property`, 'expected opacity')
    validateAdjustmentKeyframes(track.keyframes, `${trackPath}.keyframes`, context)
  }
  boundedArray(animation.effectTracks, `${path}.animation.effectTracks`, 1_280)
  const targets = new Set<string>()
  for (let index = 0; index < animation.effectTracks.length; index++) {
    const trackPath = `${path}.animation.effectTracks[${index}]`
    const track = record(animation.effectTracks[index], trackPath)
    exactKeys(track, ['effectId', 'parameter', 'keyframes'], [], trackPath)
    stringValue(track.effectId, `${trackPath}.effectId`, PROJECT_FILE_LIMITS.maxIdCharacters)
    stringValue(track.parameter, `${trackPath}.parameter`, PROJECT_FILE_LIMITS.maxNameCharacters)
    const target = `${track.effectId}\u0000${track.parameter}`
    if (targets.has(target)) fail(trackPath, 'duplicate adjustment effect animation target')
    targets.add(target)
    validateAdjustmentKeyframes(track.keyframes, `${trackPath}.keyframes`, context)
  }

  boundedArray(item.effects, `${path}.effects`, PROJECT_FILE_LIMITS.maxEffectsPerClip)
  context.effectCount += item.effects.length
  if (context.effectCount > PROJECT_FILE_LIMITS.maxTotalEffects) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffects} effects in total`)
  }
  for (let index = 0; index < item.effects.length; index++) {
    validateEffect(item.effects[index], `${path}.effects[${index}]`, context)
  }
  const typed = item as unknown as AdjustmentItem
  const animationError = adjustmentAnimationValidationError(typed.animation)
  if (animationError) fail(`${path}.animation`, animationError)
  const error = adjustmentItemValidationError(typed)
  if (error) fail(path, error)
  return typed
}
import {
  SEQUENCE_PROJECT_LIMITS,
  sequenceSettingsEqual,
} from '../projectSequences';
import { analyzeNestedSequenceGraph } from '../nestedSequences';
import { multicamLinkedPairValidationError } from '../multicam';
import { multicamDefinitionValidationError } from '../multicam';
import { microsecondsDurationToFrames } from '../time';

function validateSequenceInstance(
  value: unknown,
  path: string,
  context: ValidationContext,
): SequenceInstance {
  const instance = record(value, path)
  exactKeys(
    instance,
    ['kind', 'id', 'name', 'sequenceId', 'sourceStartFrame', 'timelineRange'],
    ['linkGroupId'],
    path,
  )
  if (instance.kind !== 'sequence') fail(`${path}.kind`, 'expected sequence')
  stringValue(instance.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.timelineItemIds.has(instance.id)) {
    fail(`${path}.id`, 'duplicate timeline item id')
  }
  context.timelineItemIds.add(instance.id)
  stringValue(instance.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  stringValue(
    instance.sequenceId,
    `${path}.sequenceId`,
    PROJECT_FILE_LIMITS.maxIdCharacters,
  )
  safeInteger(instance.sourceStartFrame, `${path}.sourceStartFrame`, 0)
  validateRange(instance.timelineRange, `${path}.timelineRange`, 1)
  const typed = instance as unknown as SequenceInstance
  const sourceEnd = typed.sourceStartFrame + typed.timelineRange.durationFrames
  if (!Number.isSafeInteger(sourceEnd)) fail(path, 'source range must end at a safe integer')
  if (instance.linkGroupId !== undefined) {
    stringValue(
      instance.linkGroupId,
      `${path}.linkGroupId`,
      PROJECT_FILE_LIMITS.maxIdCharacters,
    )
    context.linkGroupCounts.set(
      instance.linkGroupId,
      (context.linkGroupCounts.get(instance.linkGroupId) ?? 0) + 1,
    )
  }
  return typed
}

function validateMulticamInstance(
  value: unknown,
  path: string,
  context: ValidationContext,
): MulticamInstance {
  const instance = record(value, path)
  exactKeys(
    instance,
    ['kind', 'id', 'name', 'multicamId', 'sourceStartFrame', 'timelineRange'],
    ['linkGroupId'],
    path,
  )
  if (instance.kind !== 'multicam') fail(`${path}.kind`, 'expected multicam')
  stringValue(instance.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.timelineItemIds.has(instance.id)) fail(`${path}.id`, 'duplicate timeline item id')
  context.timelineItemIds.add(instance.id)
  stringValue(instance.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  stringValue(instance.multicamId, `${path}.multicamId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  safeInteger(instance.sourceStartFrame, `${path}.sourceStartFrame`, 0)
  validateRange(instance.timelineRange, `${path}.timelineRange`, 1)
  const typed = instance as unknown as MulticamInstance
  if (!Number.isSafeInteger(typed.sourceStartFrame + typed.timelineRange.durationFrames)) {
    fail(path, 'source range must end at a safe integer')
  }
  if (instance.linkGroupId !== undefined) {
    stringValue(instance.linkGroupId, `${path}.linkGroupId`, PROJECT_FILE_LIMITS.maxIdCharacters)
    context.linkGroupCounts.set(
      instance.linkGroupId,
      (context.linkGroupCounts.get(instance.linkGroupId) ?? 0) + 1,
    )
  }
  return typed
}

function validateMulticamDefinition(
  value: unknown,
  path: string,
  assetIds: ReadonlySet<string>,
  assetsById: ReadonlyMap<string, PortableAssetDescriptor>,
  frameRate: TimelineDoc['frameRate'],
  ids: ProjectWideTimelineIds,
): MulticamDefinition {
  const definition = record(value, path)
  exactKeys(
    definition,
    ['id', 'name', 'durationFrames', 'angles', 'switches', 'audioPolicy'],
    [],
    path,
  )
  stringValue(definition.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (ids.multicamDefinitionIds.has(definition.id)) {
    fail(`${path}.id`, 'duplicate multicam definition id')
  }
  ids.multicamDefinitionIds.add(definition.id)
  stringValue(definition.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  safeInteger(definition.durationFrames, `${path}.durationFrames`, 1)
  boundedArray(definition.angles, `${path}.angles`, 8)
  if (definition.angles.length < 2) fail(`${path}.angles`, 'requires at least two angles')
  for (let index = 0; index < definition.angles.length; index++) {
    const anglePath = `${path}.angles[${index}]`
    const angle = record(definition.angles[index], anglePath)
    exactKeys(
      angle,
      ['id', 'name', 'assetId', 'coverage', 'sourceStartFrame'],
      [],
      anglePath,
    )
    stringValue(angle.id, `${anglePath}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
    if (ids.multicamAngleIds.has(angle.id)) fail(`${anglePath}.id`, 'duplicate multicam angle id')
    ids.multicamAngleIds.add(angle.id)
    stringValue(angle.name, `${anglePath}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
    stringValue(angle.assetId, `${anglePath}.assetId`, PROJECT_FILE_LIMITS.maxIdCharacters)
    if (!assetIds.has(angle.assetId)) fail(`${anglePath}.assetId`, 'references an unknown asset')
    const asset = assetsById.get(angle.assetId)
    if (asset?.kind !== 'video') fail(`${anglePath}.assetId`, 'multicam angles require video assets')
    validateRange(angle.coverage, `${anglePath}.coverage`, 1)
    safeInteger(angle.sourceStartFrame, `${anglePath}.sourceStartFrame`, 0)
    const coverage = angle.coverage as { startFrame: number; durationFrames: number }
    if (coverage.startFrame + coverage.durationFrames > Number(definition.durationFrames)) {
      fail(`${anglePath}.coverage`, 'exceeds the multicam definition duration')
    }
    const sourceEnd = Number(angle.sourceStartFrame) + coverage.durationFrames
    if (!Number.isSafeInteger(sourceEnd)) fail(anglePath, 'source range must end at a safe integer')
    if (
      asset
      && sourceEnd > microsecondsDurationToFrames(asset.durationMicroseconds, frameRate)
    ) fail(anglePath, 'source range extends beyond the referenced asset duration')
  }
  boundedArray(
    definition.switches,
    `${path}.switches`,
    PROJECT_FILE_LIMITS.maxTotalMulticamSwitches,
  )
  for (let index = 0; index < definition.switches.length; index++) {
    const switchPath = `${path}.switches[${index}]`
    const item = record(definition.switches[index], switchPath)
    exactKeys(item, ['frame', 'videoAngleId'], [], switchPath)
    safeInteger(item.frame, `${switchPath}.frame`, 0)
    stringValue(item.videoAngleId, `${switchPath}.videoAngleId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  }
  const audioPolicy = record(definition.audioPolicy, `${path}.audioPolicy`)
  if (audioPolicy.kind === 'fixed') {
    exactKeys(audioPolicy, ['kind', 'angleId'], [], `${path}.audioPolicy`)
    stringValue(audioPolicy.angleId, `${path}.audioPolicy.angleId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  } else if (audioPolicy.kind === 'follow-video') {
    exactKeys(audioPolicy, ['kind'], [], `${path}.audioPolicy`)
  } else fail(`${path}.audioPolicy.kind`, 'expected fixed or follow-video')
  const typed = definition as unknown as MulticamDefinition
  const error = multicamDefinitionValidationError(typed)
  if (error) fail(path, error)
  return typed
}

function validateTimelineMarker(
  value: unknown,
  path: string,
  markerIds: Set<string>,
  previous: TimelineMarker | null,
): TimelineMarker {
  const marker = record(value, path)
  exactKeys(marker, ['id', 'frame', 'label', 'color'], ['note'], path)
  stringValue(marker.id, `${path}.id`, MAX_TIMELINE_MARKER_ID_CHARACTERS)
  if (markerIds.has(marker.id)) fail(`${path}.id`, 'duplicate marker id')
  markerIds.add(marker.id)
  safeInteger(marker.frame, `${path}.frame`, 0, MAX_TIMELINE_MARKER_FRAME)
  stringValue(marker.label, `${path}.label`, MAX_TIMELINE_MARKER_LABEL_CHARACTERS)
  if (!TIMELINE_MARKER_COLORS.includes(marker.color as never)) {
    fail(`${path}.color`, 'unsupported marker color')
  }
  if (marker.note !== undefined) {
    stringValue(marker.note, `${path}.note`, MAX_TIMELINE_MARKER_NOTE_CHARACTERS)
  }
  const typed = marker as unknown as TimelineMarker
  if (previous && compareTimelineMarkers(previous, typed) >= 0) {
    fail(path, 'markers must be uniquely sorted by frame then id')
  }
  return typed
}

function validateCaptionItem(
  value: unknown,
  path: string,
  itemIds: Set<string>,
  previous: CaptionItem | null,
): CaptionItem {
  const item = record(value, path)
  exactKeys(item, ['id', 'range', 'text'], [], path)
  stringValue(item.id, `${path}.id`, CAPTION_LIMITS.maxIdCharacters)
  if (itemIds.has(item.id)) fail(`${path}.id`, 'duplicate caption item id')
  itemIds.add(item.id)
  const range = record(item.range, `${path}.range`)
  exactKeys(range, ['startFrame', 'durationFrames'], [], `${path}.range`)
  safeInteger(range.startFrame, `${path}.range.startFrame`, 0, CAPTION_LIMITS.maxFrame)
  safeInteger(range.durationFrames, `${path}.range.durationFrames`, 1, CAPTION_LIMITS.maxFrame)
  stringValue(item.text, `${path}.text`, CAPTION_LIMITS.maxItemCharacters)
  const typed = item as unknown as CaptionItem
  if (previous && compareCaptionItems(previous, typed) > 0) {
    fail(path, 'caption items must be sorted by timing and id')
  }
  return typed
}

function validateCaptionTrack(
  value: unknown,
  path: string,
  trackIds: Set<string>,
  itemIds: Set<string>,
): void {
  const track = record(value, path)
  exactKeys(
    track,
    ['id', 'name', 'language', 'role', 'stylePreset', 'hidden', 'items'],
    [],
    path,
  )
  stringValue(track.id, `${path}.id`, CAPTION_LIMITS.maxIdCharacters)
  if (trackIds.has(track.id)) fail(`${path}.id`, 'duplicate caption track id')
  trackIds.add(track.id)
  stringValue(track.name, `${path}.name`, CAPTION_LIMITS.maxTrackNameCharacters)
  stringValue(track.language, `${path}.language`, CAPTION_LIMITS.maxLanguageCharacters)
  if (!CAPTION_TRACK_ROLES.includes(track.role as never)) {
    fail(`${path}.role`, 'unsupported caption role')
  }
  if (!CAPTION_STYLE_PRESETS.includes(track.stylePreset as never)) {
    fail(`${path}.stylePreset`, 'unsupported caption style preset')
  }
  booleanValue(track.hidden, `${path}.hidden`)
  boundedArray(track.items, `${path}.items`, CAPTION_LIMITS.maxItemsPerTrack)
  let previous: CaptionItem | null = null
  for (let index = 0; index < track.items.length; index++) {
    previous = validateCaptionItem(
      track.items[index],
      `${path}.items[${index}]`,
      itemIds,
      previous,
    )
  }
  const error = captionTrackValidationError(track as unknown as CaptionTrack)
  if (error) fail(path, error)
}

interface ResolvedTransitionWindow {
  startFrame: number
  endFrame: number
}

function validateTransition(
  value: unknown,
  path: string,
  track: Track,
  clipIndexById: ReadonlyMap<string, number>,
  context: ValidationContext,
): ResolvedTransitionWindow {
  const transition = record(value, path)
  exactKeys(
    transition,
    ['id', 'type', 'fromClipId', 'toClipId', 'durationFrames', 'audio'],
    [],
    path,
  )
  stringValue(transition.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.transitionIds.has(transition.id)) fail(`${path}.id`, 'duplicate transition id')
  context.transitionIds.add(transition.id)
  if (transition.type !== 'crossfade') fail(`${path}.type`, 'expected crossfade')
  stringValue(transition.fromClipId, `${path}.fromClipId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  stringValue(transition.toClipId, `${path}.toClipId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  safeInteger(transition.durationFrames, `${path}.durationFrames`, 1)
  const audio = record(transition.audio, `${path}.audio`)
  exactKeys(audio, ['enabled', 'curve'], [], `${path}.audio`)
  booleanValue(audio.enabled, `${path}.audio.enabled`)
  if (audio.curve !== 'linear' && audio.curve !== 'equal-power') {
    fail(`${path}.audio.curve`, 'expected linear or equal-power')
  }
  if (track.kind !== 'video') fail(path, 'transitions require a video track')

  const fromIndex = clipIndexById.get(transition.fromClipId)
  if (fromIndex === undefined || fromIndex + 1 >= track.clips.length) {
    fail(path, 'transition endpoints must be adjacent clips on the owning track')
  }
  const from = track.clips[fromIndex]
  const to = track.clips[fromIndex + 1]
  if (to.id !== transition.toClipId || from.id === to.id) {
    fail(path, 'transition endpoints must be ordered adjacent clips')
  }
  if (from.text !== undefined || to.text !== undefined) {
    fail(path, 'text clips cannot be transition endpoints')
  }
  const cutFrame = from.timelineRange.startFrame + from.timelineRange.durationFrames
  if (cutFrame !== to.timelineRange.startFrame) {
    fail(path, 'transition endpoints must touch')
  }
  const startFrame = cutFrame - Math.floor(transition.durationFrames / 2)
  const endFrame = startFrame + transition.durationFrames
  const toEnd = to.timelineRange.startFrame + to.timelineRange.durationFrames
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < from.timelineRange.startFrame ||
    endFrame > toEnd
  ) {
    fail(path, 'transition window does not fit its clips')
  }
  return { startFrame, endFrame }
}

function validateMasterAudio(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is MasterAudioSettings {
  const master = record(value, path)
  exactKeys(master, ['volume', 'balance', 'muted', 'audioEffects'], [], path)
  finiteNumber(master.volume, `${path}.volume`, 0, 2)
  finiteNumber(master.balance, `${path}.balance`, -1, 1)
  booleanValue(master.muted, `${path}.muted`)
  validateAudioEffectStack(master.audioEffects, `${path}.audioEffects`, context)
}

function validateTrack(value: unknown, path: string, trackIds: Set<string>, context: ValidationContext): asserts value is Track {
  const track = record(value, path)
  exactKeys(
    track,
    ['id', 'kind', 'name', 'clips', 'sequenceInstances', 'multicamInstances', 'adjustments', 'transitions', 'hidden', 'muted', 'solo', 'locked', 'volume', 'balance', 'audioEffects'],
    [],
    path,
  )
  stringValue(track.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (trackIds.has(track.id)) fail(`${path}.id`, 'duplicate track id')
  trackIds.add(track.id)
  if (track.kind !== 'video' && track.kind !== 'audio') {
    fail(`${path}.kind`, 'expected video or audio')
  }
  stringValue(track.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  boundedArray(track.clips, `${path}.clips`, PROJECT_FILE_LIMITS.maxClips)
  context.clipCount += track.clips.length
  if (context.clipCount > PROJECT_FILE_LIMITS.maxClips) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxClips} clips in total`)
  }
  let previousEnd = -1
  const clipIndexById = new Map<string, number>()
  for (let index = 0; index < track.clips.length; index++) {
    const clipPath = `${path}.clips[${index}]`
    const clip = track.clips[index]
    validateClip(clip, clipPath, track.kind, context)
    if (clip.timelineRange.startFrame < previousEnd) {
      fail(clipPath, 'clips must be sorted and non-overlapping')
    }
    previousEnd = clip.timelineRange.startFrame + clip.timelineRange.durationFrames
    clipIndexById.set(clip.id, index)
  }
  boundedArray(
    track.sequenceInstances,
    `${path}.sequenceInstances`,
    PROJECT_FILE_LIMITS.maxSequenceInstances,
  )
  context.sequenceInstanceCount += track.sequenceInstances.length
  if (context.sequenceInstanceCount > PROJECT_FILE_LIMITS.maxSequenceInstances) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxSequenceInstances} sequence instances in total`,
    )
  }
  const allItemRanges = (track.clips as Clip[]).map((clip) => clip.timelineRange)
  let previousInstanceEnd = -1
  for (let index = 0; index < track.sequenceInstances.length; index++) {
    const itemPath = `${path}.sequenceInstances[${index}]`
    const item = validateSequenceInstance(
      track.sequenceInstances[index],
      itemPath,
      context,
    )
    if (item.timelineRange.startFrame < previousInstanceEnd) {
      fail(itemPath, 'sequence instances must be sorted and non-overlapping')
    }
    if (allItemRanges.some((range) => (
      item.timelineRange.startFrame < range.startFrame + range.durationFrames
      && range.startFrame < item.timelineRange.startFrame + item.timelineRange.durationFrames
    ))) fail(itemPath, 'sequence instance overlaps another item on the owning track')
    previousInstanceEnd = item.timelineRange.startFrame
      + item.timelineRange.durationFrames
    allItemRanges.push(item.timelineRange)
  }
  boundedArray(
    track.multicamInstances,
    `${path}.multicamInstances`,
    PROJECT_FILE_LIMITS.maxMulticamInstances,
  )
  context.multicamInstanceCount += track.multicamInstances.length
  if (context.multicamInstanceCount > PROJECT_FILE_LIMITS.maxMulticamInstances) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxMulticamInstances} multicam instances in total`)
  }
  let previousMulticamEnd = -1
  for (let index = 0; index < track.multicamInstances.length; index++) {
    const itemPath = `${path}.multicamInstances[${index}]`
    const item = validateMulticamInstance(
      track.multicamInstances[index],
      itemPath,
      context,
    )
    if (item.timelineRange.startFrame < previousMulticamEnd) {
      fail(itemPath, 'multicam instances must be sorted and non-overlapping')
    }
    if (allItemRanges.some((range) => (
      item.timelineRange.startFrame < range.startFrame + range.durationFrames
      && range.startFrame < item.timelineRange.startFrame + item.timelineRange.durationFrames
    ))) fail(itemPath, 'multicam instance overlaps another item on the owning track')
    previousMulticamEnd = item.timelineRange.startFrame + item.timelineRange.durationFrames
    allItemRanges.push(item.timelineRange)
  }
  boundedArray(track.adjustments, `${path}.adjustments`, PROJECT_FILE_LIMITS.maxAdjustments)
  context.adjustmentCount += track.adjustments.length
  if (context.adjustmentCount > PROJECT_FILE_LIMITS.maxAdjustments) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxAdjustments} adjustments in total`)
  }
  let previousAdjustmentEnd = -1
  for (let index = 0; index < track.adjustments.length; index++) {
    const itemPath = `${path}.adjustments[${index}]`
    const item = validateAdjustment(track.adjustments[index], itemPath, track.kind, context)
    if (item.timelineRange.startFrame < previousAdjustmentEnd) {
      fail(itemPath, 'adjustments must be sorted and non-overlapping')
    }
    if (allItemRanges.some((range) => (
      item.timelineRange.startFrame < range.startFrame + range.durationFrames
      && range.startFrame < item.timelineRange.startFrame + item.timelineRange.durationFrames
    ))) fail(itemPath, 'adjustment overlaps a clip on the owning track')
    previousAdjustmentEnd = item.timelineRange.startFrame + item.timelineRange.durationFrames
    allItemRanges.push(item.timelineRange)
  }
  boundedArray(track.transitions, `${path}.transitions`, PROJECT_FILE_LIMITS.maxTransitions)
  context.transitionCount += track.transitions.length
  if (context.transitionCount > PROJECT_FILE_LIMITS.maxTransitions) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxTransitions} transitions in total`)
  }
  const windows: ResolvedTransitionWindow[] = []
  for (let index = 0; index < track.transitions.length; index++) {
    const window = validateTransition(
      track.transitions[index],
      `${path}.transitions[${index}]`,
      track as unknown as Track,
      clipIndexById,
      context,
    )
    windows.push(window)
  }
  windows.sort((left, right) => left.startFrame - right.startFrame)
  for (let index = 1; index < windows.length; index++) {
    if (windows[index].startFrame < windows[index - 1].endFrame) {
      fail(path, 'transition windows overlap')
    }
  }
  booleanValue(track.hidden, `${path}.hidden`)
  booleanValue(track.muted, `${path}.muted`)
  booleanValue(track.solo, `${path}.solo`)
  booleanValue(track.locked, `${path}.locked`)
  finiteNumber(track.volume, `${path}.volume`, 0, 2)
  finiteNumber(track.balance, `${path}.balance`, -1, 1)
  validateAudioEffectStack(track.audioEffects, `${path}.audioEffects`, context)
}

interface ProjectWideTimelineIds {
  sequenceIds: Set<string>
  trackIds: Set<string>
  markerIds: Set<string>
  captionTrackIds: Set<string>
  captionItemIds: Set<string>
  linkGroupIds: Set<string>
  multicamDefinitionIds: Set<string>
  multicamAngleIds: Set<string>
}

function validateDocument(
  value: unknown,
  path: string,
  context: ValidationContext,
  ids: ProjectWideTimelineIds,
): asserts value is TimelineDoc {
  const document = record(value, path)
  exactKeys(
    document,
    ['schemaVersion', 'id', 'name', 'frameRate', 'width', 'height', 'audioSampleRate', 'tracks', 'markers', 'captionTracks', 'masterAudio'],
    [],
    path,
  )
  safeInteger(document.schemaVersion, `${path}.schemaVersion`, 1)
  if (document.schemaVersion > CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `unsupported future timeline schema ${document.schemaVersion}`)
  }
  if (document.schemaVersion !== CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `unsupported timeline schema ${document.schemaVersion}`)
  }
  stringValue(document.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (ids.sequenceIds.has(document.id as string)) {
    fail(`${path}.id`, 'duplicate sequence id')
  }
  ids.sequenceIds.add(document.id as string)
  stringValue(document.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  validateFrameRate(document.frameRate, `${path}.frameRate`)
  context.documentFrameRate = document.frameRate
  safeInteger(document.width, `${path}.width`, 1, PROJECT_FILE_LIMITS.maxDimension)
  safeInteger(document.height, `${path}.height`, 1, PROJECT_FILE_LIMITS.maxDimension)
  const renderBudget = renderSurfaceBudget(document.width, document.height)
  if (!renderBudget.allowed) {
    fail(path, renderBudget.reason ?? 'unsafe render surface')
  }
  safeInteger(
    document.audioSampleRate,
    `${path}.audioSampleRate`,
    1,
    PROJECT_FILE_LIMITS.maxAudioSampleRate,
  )
  boundedArray(document.tracks, `${path}.tracks`, PROJECT_FILE_LIMITS.maxTracks)
  for (let index = 0; index < document.tracks.length; index++) {
    validateTrack(document.tracks[index], `${path}.tracks[${index}]`, ids.trackIds, context)
  }
  boundedArray(document.markers, `${path}.markers`, PROJECT_FILE_LIMITS.maxMarkers)
  let previousMarker: TimelineMarker | null = null
  for (let index = 0; index < document.markers.length; index++) {
    previousMarker = validateTimelineMarker(
      document.markers[index],
      `${path}.markers[${index}]`,
      ids.markerIds,
      previousMarker,
    )
  }
  boundedArray(document.captionTracks, `${path}.captionTracks`, CAPTION_LIMITS.maxTracks)
  for (let index = 0; index < document.captionTracks.length; index++) {
    validateCaptionTrack(
      document.captionTracks[index],
      `${path}.captionTracks[${index}]`,
      ids.captionTrackIds,
      ids.captionItemIds,
    )
  }
  const captionError = captionDocumentValidationError(document as unknown as TimelineDoc)
  if (captionError) fail(`${path}.captionTracks`, captionError)
  validateMasterAudio(document.masterAudio, `${path}.masterAudio`, context)
}

/**
 * Validate an already-current project value. The returned object is the same
 * reference; callers that need an isolated snapshot can parse serialized JSON.
 */
export function validateProjectFile(value: unknown): ProjectFile {
  const project = record(value, '$')
  exactKeys(
    project,
    [
      'format',
      'formatVersion',
      'id',
      'name',
      'rootSequenceId',
      'sequences',
      'multicams',
      'assets',
      'collections',
    ],
    [],
    '$',
  )
  if (project.format !== PROJECT_FILE_FORMAT) {
    fail('$.format', `expected ${PROJECT_FILE_FORMAT}`)
  }
  safeInteger(project.formatVersion, '$.formatVersion', 1)
  if (project.formatVersion > CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported future project format ${project.formatVersion}`)
  }
  if (project.formatVersion !== CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported project format ${project.formatVersion}`)
  }
  stringValue(project.id, '$.id', PROJECT_FILE_LIMITS.maxIdCharacters)
  stringValue(project.name, '$.name', PROJECT_FILE_LIMITS.maxNameCharacters)
  stringValue(
    project.rootSequenceId,
    '$.rootSequenceId',
    PROJECT_FILE_LIMITS.maxIdCharacters,
  )
  boundedArray(project.sequences, '$.sequences', PROJECT_FILE_LIMITS.maxSequences)
  if (project.sequences.length === 0) fail('$.sequences', 'requires at least one sequence')
  boundedArray(
    project.multicams,
    '$.multicams',
    PROJECT_FILE_LIMITS.maxMulticamDefinitions,
  )
  boundedArray(project.assets, '$.assets', PROJECT_FILE_LIMITS.maxAssets)

  const assetIds = new Set<string>()
  const assetsById = new Map<string, PortableAssetDescriptor>()
  for (let index = 0; index < project.assets.length; index++) {
    const path = `$.assets[${index}]`
    const asset = project.assets[index]
    validateAsset(asset, path)
    if (assetIds.has(asset.id)) fail(`${path}.id`, 'duplicate asset id')
    assetIds.add(asset.id)
    assetsById.set(asset.id, asset)
  }
  validateMediaCollections(project.collections, assetIds)

  const context: ValidationContext = {
    assetIds,
    assetsById,
    documentFrameRate: null,
    clipIds: new Set(),
    timelineItemIds: new Set(),
    effectIds: new Set(),
    audioEffectIds: new Set(),
    transitionIds: new Set(),
    linkGroupCounts: new Map(),
    clipCount: 0,
    sequenceInstanceCount: 0,
    multicamInstanceCount: 0,
    adjustmentCount: 0,
    effectCount: 0,
    effectParamCount: 0,
    effectStringCharacterCount: 0,
    audioEffectCount: 0,
    audioEffectParamCount: 0,
    audioEffectStringCharacterCount: 0,
    textCharacterCount: 0,
    transitionCount: 0,
    keyframeCount: 0,
    speedPointCount: 0,
  }
  const ids: ProjectWideTimelineIds = {
    sequenceIds: new Set(),
    trackIds: new Set(),
    markerIds: new Set(),
    captionTrackIds: new Set(),
    captionItemIds: new Set(),
    linkGroupIds: new Set(),
    multicamDefinitionIds: new Set(),
    multicamAngleIds: new Set(),
  }
  let totalTracks = 0
  let totalMarkers = 0
  let totalCaptionTracks = 0
  let totalCaptionItems = 0
  let settingsSource: TimelineDoc | null = null
  for (let index = 0; index < project.sequences.length; index++) {
    const path = `$.sequences[${index}]`
    const candidate = project.sequences[index]
    context.linkGroupCounts = new Map()
    validateDocument(candidate, path, context, ids)
    const sequence = candidate as unknown as TimelineDoc
    const multicamLinkError = multicamLinkedPairValidationError(sequence)
    if (multicamLinkError) fail(path, multicamLinkError)
    if (settingsSource && !sequenceSettingsEqual(settingsSource, sequence)) {
      fail(path, 'sequence settings must match the project root settings')
    }
    settingsSource ??= sequence
    totalTracks += sequence.tracks.length
    totalMarkers += sequence.markers?.length ?? 0
    totalCaptionTracks += sequence.captionTracks?.length ?? 0
    totalCaptionItems += (sequence.captionTracks ?? []).reduce(
      (sum, track) => sum + track.items.length,
      0,
    )
    for (const [linkGroupId, count] of context.linkGroupCounts) {
      if (count < 2) fail(path, `link group ${linkGroupId} has no partner clip`)
      if (ids.linkGroupIds.has(linkGroupId)) {
        fail(path, `duplicate link group id ${linkGroupId}`)
      }
      ids.linkGroupIds.add(linkGroupId)
    }
  }
  if (!ids.sequenceIds.has(project.rootSequenceId as string)) {
    fail('$.rootSequenceId', 'missing root sequence')
  }
  if (totalTracks > SEQUENCE_PROJECT_LIMITS.maxTotalTracks) {
    fail('$.sequences', `exceeds ${SEQUENCE_PROJECT_LIMITS.maxTotalTracks} tracks in total`)
  }
  if (totalMarkers > SEQUENCE_PROJECT_LIMITS.maxTotalMarkers) {
    fail('$.sequences', `exceeds ${SEQUENCE_PROJECT_LIMITS.maxTotalMarkers} markers in total`)
  }
  if (totalCaptionTracks > SEQUENCE_PROJECT_LIMITS.maxTotalCaptionTracks) {
    fail('$.sequences', `exceeds ${SEQUENCE_PROJECT_LIMITS.maxTotalCaptionTracks} caption tracks in total`)
  }
  if (totalCaptionItems > SEQUENCE_PROJECT_LIMITS.maxTotalCaptionItems) {
    fail('$.sequences', `exceeds ${SEQUENCE_PROJECT_LIMITS.maxTotalCaptionItems} caption items in total`)
  }
  let totalMulticamAngles = 0
  let totalMulticamSwitches = 0
  for (let index = 0; index < project.multicams.length; index++) {
    const definition = validateMulticamDefinition(
      project.multicams[index],
      `$.multicams[${index}]`,
      assetIds,
      assetsById,
      settingsSource!.frameRate,
      ids,
    )
    totalMulticamAngles += definition.angles.length
    totalMulticamSwitches += definition.switches.length
  }
  if (totalMulticamAngles > PROJECT_FILE_LIMITS.maxTotalMulticamAngles) {
    fail('$.multicams', `exceeds ${PROJECT_FILE_LIMITS.maxTotalMulticamAngles} angles in total`)
  }
  if (totalMulticamSwitches > PROJECT_FILE_LIMITS.maxTotalMulticamSwitches) {
    fail('$.multicams', `exceeds ${PROJECT_FILE_LIMITS.maxTotalMulticamSwitches} switches in total`)
  }
  for (let sequenceIndex = 0; sequenceIndex < project.sequences.length; sequenceIndex++) {
    const sequence = project.sequences[sequenceIndex] as TimelineDoc
    for (let trackIndex = 0; trackIndex < sequence.tracks.length; trackIndex++) {
      const track = sequence.tracks[trackIndex]
      for (let itemIndex = 0; itemIndex < (track.multicamInstances ?? []).length; itemIndex++) {
        const instance = track.multicamInstances![itemIndex]
        const definition = (project.multicams as MulticamDefinition[]).find(
          (candidate) => candidate.id === instance.multicamId,
        )
        const itemPath = `$.sequences[${sequenceIndex}].tracks[${trackIndex}].multicamInstances[${itemIndex}]`
        if (!definition) fail(`${itemPath}.multicamId`, 'references a missing multicam definition')
        if (
          instance.sourceStartFrame + instance.timelineRange.durationFrames
          > definition.durationFrames
        ) fail(itemPath, 'source range exceeds the multicam definition duration')
      }
    }
  }
  try {
    analyzeNestedSequenceGraph(project as unknown as ProjectFile)
  } catch (cause) {
    fail(
      '$.sequences',
      cause instanceof Error ? cause.message : 'invalid nested sequence graph',
    )
  }
  return project as unknown as ProjectFile
}
