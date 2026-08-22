import type { CaptionItem, CaptionTrack, TimelineDoc, TimelineMarker, Track } from '../schema';
import { CAPTION_LIMITS, CAPTION_STYLE_PRESETS, CAPTION_TRACK_ROLES, captionDocumentValidationError, captionTrackValidationError, compareCaptionItems } from '../captions';
import { compareTimelineMarkers, MAX_TIMELINE_MARKER_FRAME, MAX_TIMELINE_MARKER_ID_CHARACTERS, MAX_TIMELINE_MARKER_LABEL_CHARACTERS, MAX_TIMELINE_MARKER_NOTE_CHARACTERS, TIMELINE_MARKER_COLORS } from '../timelineMarkers';
import { renderSurfaceBudget } from '../renderSurfaceBudget';
import { CURRENT_PROJECT_FORMAT_VERSION, CURRENT_TIMELINE_SCHEMA_VERSION, PROJECT_FILE_FORMAT, PROJECT_FILE_LIMITS, type PortableAssetDescriptor, type ProjectFile } from './projectTypes';
import { booleanValue, boundedArray, exactKeys, fail, record, safeInteger, stringValue, validateFrameRate } from './validationPrimitives';
import { validateAsset, validateMediaCollections } from './assetValidation';
import { validateClip, type ValidationContext } from './clipValidation';

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

function validateTrack(value: unknown, path: string, trackIds: Set<string>, context: ValidationContext): asserts value is Track {
  const track = record(value, path)
  exactKeys(
    track,
    ['id', 'kind', 'name', 'clips', 'transitions', 'hidden', 'muted', 'solo', 'locked'],
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
    fail('$.document.tracks', `exceeds ${PROJECT_FILE_LIMITS.maxClips} clips in total`)
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
  boundedArray(track.transitions, `${path}.transitions`, PROJECT_FILE_LIMITS.maxTransitions)
  context.transitionCount += track.transitions.length
  if (context.transitionCount > PROJECT_FILE_LIMITS.maxTransitions) {
    fail('$.document.tracks', `exceeds ${PROJECT_FILE_LIMITS.maxTransitions} transitions in total`)
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
}

function validateDocument(value: unknown, context: ValidationContext): asserts value is TimelineDoc {
  const document = record(value, '$.document')
  exactKeys(
    document,
    ['schemaVersion', 'id', 'name', 'frameRate', 'width', 'height', 'audioSampleRate', 'tracks', 'markers', 'captionTracks'],
    [],
    '$.document',
  )
  safeInteger(document.schemaVersion, '$.document.schemaVersion', 1)
  if (document.schemaVersion > CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail('$.document.schemaVersion', `unsupported future timeline schema ${document.schemaVersion}`)
  }
  if (document.schemaVersion !== CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail('$.document.schemaVersion', `unsupported timeline schema ${document.schemaVersion}`)
  }
  stringValue(document.id, '$.document.id', PROJECT_FILE_LIMITS.maxIdCharacters)
  stringValue(document.name, '$.document.name', PROJECT_FILE_LIMITS.maxNameCharacters)
  validateFrameRate(document.frameRate, '$.document.frameRate')
  context.documentFrameRate = document.frameRate
  safeInteger(document.width, '$.document.width', 1, PROJECT_FILE_LIMITS.maxDimension)
  safeInteger(document.height, '$.document.height', 1, PROJECT_FILE_LIMITS.maxDimension)
  const renderBudget = renderSurfaceBudget(document.width, document.height)
  if (!renderBudget.allowed) {
    fail('$.document', renderBudget.reason ?? 'unsafe render surface')
  }
  safeInteger(
    document.audioSampleRate,
    '$.document.audioSampleRate',
    1,
    PROJECT_FILE_LIMITS.maxAudioSampleRate,
  )
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const trackIds = new Set<string>()
  for (let index = 0; index < document.tracks.length; index++) {
    validateTrack(document.tracks[index], `$.document.tracks[${index}]`, trackIds, context)
  }
  boundedArray(document.markers, '$.document.markers', PROJECT_FILE_LIMITS.maxMarkers)
  const markerIds = new Set<string>()
  let previousMarker: TimelineMarker | null = null
  for (let index = 0; index < document.markers.length; index++) {
    previousMarker = validateTimelineMarker(
      document.markers[index],
      `$.document.markers[${index}]`,
      markerIds,
      previousMarker,
    )
  }
  boundedArray(document.captionTracks, '$.document.captionTracks', CAPTION_LIMITS.maxTracks)
  const captionTrackIds = new Set<string>()
  const captionItemIds = new Set<string>()
  for (let index = 0; index < document.captionTracks.length; index++) {
    validateCaptionTrack(
      document.captionTracks[index],
      `$.document.captionTracks[${index}]`,
      captionTrackIds,
      captionItemIds,
    )
  }
  const captionError = captionDocumentValidationError(document as unknown as TimelineDoc)
  if (captionError) fail('$.document.captionTracks', captionError)
}

/**
 * Validate an already-current project value. The returned object is the same
 * reference; callers that need an isolated snapshot can parse serialized JSON.
 */
export function validateProjectFile(value: unknown): ProjectFile {
  const project = record(value, '$')
  exactKeys(
    project,
    ['format', 'formatVersion', 'document', 'assets', 'collections'],
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
    effectIds: new Set(),
    transitionIds: new Set(),
    linkGroupCounts: new Map(),
    clipCount: 0,
    effectCount: 0,
    effectParamCount: 0,
    effectStringCharacterCount: 0,
    textCharacterCount: 0,
    transitionCount: 0,
    keyframeCount: 0,
    speedPointCount: 0,
  }
  validateDocument(project.document, context)
  for (const [linkGroupId, count] of context.linkGroupCounts) {
    if (count < 2) fail('$.document', `link group ${linkGroupId} has no partner clip`)
  }
  return project as unknown as ProjectFile
}
