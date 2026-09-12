/**
 * Bounded OpenTimelineIO JSON interchange. Pure domain: no DOM, no fetch,
 * no adapters, and no executable target URLs.
 *
 * Pinned family: official OTIO JSON 0.17.0 (Timeline.1, Track.1, Clip.1/2,
 * Gap.1, Transition.1, Marker.1/2, ExternalReference.1, MissingReference.1,
 * SerializableCollection.1). Timing uses integer frames + snapped rationals.
 */

import { addCrossfade } from './operations'
import { defaultMasterAudio } from './audioMixer'
import { DEFAULT_BLEND_MODE } from './blendModes'
import { defaultClipAnimation } from './clipAnimation'
import {
  defaultClipAudioSettings,
  defaultClipTransform,
  defaultClipVisualSettings,
} from './clipInspector'
import type { PortableAssetDescriptor } from './projectFile/projectTypes'
import { PROJECT_FILE_LIMITS } from './projectFile/projectTypes'
import { MAX_PROJECT_NAME_CHARACTERS } from './projectLimits'
import { createTimelineDoc, type ProjectSettings } from './projectSettings'
import type {
  AssetKind,
  Clip,
  FrameRate,
  MediaSourceBounds,
  TimelineDoc,
  TimelineMarker,
  TimelineMarkerColor,
  Track,
  TrackKind,
} from './schema'
import { defaultSourceTimeMap, isUnitySourceTimeRate, sourceTimeMapWholeClipSpeed } from './sourceTimeMap'
import {
  framesToMicroseconds,
  microsecondsToFrames,
  rangeEnd,
  rescaleFrames,
  secondsToMicroseconds,
  snapToStandardRate,
} from './time'
import { compareTimelineMarkers, MAX_TIMELINE_MARKER_FRAME } from './timelineMarkers'
import { isProceduralTitleClip } from './textOverlay'
import type { SequenceProject } from './projectSequences'

export const OTIO_COMPATIBILITY_LABEL = '0.17.0' as const
export const OTIO_FILE_EXTENSION = '.otio' as const
export const OTIO_JSON_MEDIA_TYPE = 'application/vnd.pixar.opentimelineio+json' as const
export const MAX_OTIO_JSON_CHARACTERS = 8_000_000
export const MAX_OTIO_NESTING_DEPTH = 16
export const MAX_OTIO_OBJECT_COUNT = 200_000
export const MAX_OTIO_LOSS_ENTRIES = 48

export type OtioErrorCode =
  | 'malformed'
  | 'oversized'
  | 'cyclic'
  | 'unsupported'
  | 'empty'

export class OtioInterchangeError extends Error {
  readonly code: OtioErrorCode

  constructor(code: OtioErrorCode, message: string) {
    super(message)
    this.name = 'OtioInterchangeError'
    this.code = code
  }
}

export type OtioIdKind =
  | 'sequence'
  | 'track'
  | 'clip'
  | 'transition'
  | 'marker'
  | 'asset'

export type OtioIdFactory = (kind: OtioIdKind) => string

export interface OtioLossEntry {
  readonly code: string
  readonly path: string
  readonly detail: string
}

export interface OtioSequenceSummary {
  readonly name: string
  readonly videoTracks: number
  readonly audioTracks: number
  readonly clips: number
  readonly gaps: number
  readonly transitions: number
  readonly markers: number
  readonly offlineMedia: number
}

export interface OtioMediaSummary {
  readonly id: string
  readonly fileName: string
  readonly kind: AssetKind
  readonly offline: boolean
  readonly targetUrl: string | null
}

export interface OtioImportPreview {
  readonly schemaLabel: typeof OTIO_COMPATIBILITY_LABEL
  readonly sequences: readonly OtioSequenceSummary[]
  readonly media: readonly OtioMediaSummary[]
  readonly losses: readonly OtioLossEntry[]
  readonly omittedLosses: number
}

export interface OtioImportPlan {
  readonly preview: OtioImportPreview
  readonly sequences: readonly TimelineDoc[]
  readonly descriptors: readonly PortableAssetDescriptor[]
}

export interface OtioExportResult {
  readonly fileName: string
  readonly mediaType: typeof OTIO_JSON_MEDIA_TYPE
  readonly content: string
  readonly preview: OtioImportPreview
}

interface JsonRecord {
  readonly [key: string]: unknown
}

interface LossLog {
  entries: OtioLossEntry[]
  omitted: number
}

interface SchemaName {
  name: string
  version: number
}

interface TimedValue {
  frames: number
  rate: FrameRate
}

interface AssetDraft {
  descriptor: PortableAssetDescriptor
  targetUrl: string | null
}

interface PlacedClip {
  start: number
  duration: number
  sourceStart: number
  name: string
  enabled: boolean
  asset: AssetDraft | null
  path: string
}

const FORBIDDEN_ROOT = new Set([
  'Adapter',
  'HookScript',
  'PluginManifest',
  'SchemaDef',
  'MediaLinker',
])

const CORE_VERSIONS: Readonly<Record<string, readonly number[]>> = {
  Timeline: [1],
  Stack: [1],
  Track: [1],
  Sequence: [1],
  Clip: [1, 2],
  Gap: [1],
  Transition: [1],
  Marker: [1, 2],
  RationalTime: [1],
  TimeRange: [1],
  ExternalReference: [1],
  MissingReference: [1],
  SerializableCollection: [1],
  LinearTimeWarp: [1],
  FreezeFrame: [1],
  Effect: [1],
  TimeEffect: [1],
  GeneratorReference: [1],
  ImageSequenceReference: [1],
}

const MARKER_COLORS: Readonly<Record<string, TimelineMarkerColor>> = {
  YELLOW: 'yellow',
  ORANGE: 'orange',
  RED: 'red',
  PINK: 'pink',
  PURPLE: 'purple',
  BLUE: 'blue',
  GREEN: 'green',
  CYAN: 'blue',
  MAGENTA: 'pink',
  WHITE: 'yellow',
  BLACK: 'purple',
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp'])
const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.ac3',
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lossLog(): LossLog {
  return { entries: [], omitted: 0 }
}

function addLoss(log: LossLog, code: string, path: string, detail: string): void {
  if (log.entries.length >= MAX_OTIO_LOSS_ENTRIES) {
    log.omitted += 1
    return
  }
  log.entries.push({ code, path, detail })
}

function boundedName(value: string, fallback: string): string {
  const trimmed = value.trim()
  const source = trimmed.length > 0 ? trimmed : fallback
  return source.length > MAX_PROJECT_NAME_CHARACTERS
    ? source.slice(0, MAX_PROJECT_NAME_CHARACTERS)
    : source
}

function readSchema(value: unknown): SchemaName | null {
  if (!isRecord(value) || typeof value.OTIO_SCHEMA !== 'string') return null
  const match = /^([A-Za-z][A-Za-z0-9]*)\.([0-9]+)$/u.exec(value.OTIO_SCHEMA)
  if (!match) return null
  return { name: match[1], version: Number(match[2]) }
}

function assertCoreVersion(schema: SchemaName, path: string): void {
  const allowed = CORE_VERSIONS[schema.name]
  if (!allowed) return
  if (!allowed.includes(schema.version)) {
    throw new OtioInterchangeError(
      'unsupported',
      `${path} uses ${schema.name}.${schema.version}, which is outside the pinned OTIO ${OTIO_COMPATIBILITY_LABEL} family`,
    )
  }
}

function isTrackSchema(schema: SchemaName): boolean {
  return schema.name === 'Track' || schema.name === 'Sequence'
}

function metadataPresent(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0
}

function countGraph(value: unknown, depth: number, seen: WeakSet<object>): number {
  if (value === null || typeof value !== 'object') return 0
  if (seen.has(value)) {
    throw new OtioInterchangeError('cyclic', 'The OTIO document contains a cyclic object graph')
  }
  if (depth > MAX_OTIO_NESTING_DEPTH) {
    throw new OtioInterchangeError('cyclic', 'The OTIO document nests compositions deeper than the supported limit')
  }
  seen.add(value)
  let count = 1
  if (Array.isArray(value)) {
    if (value.length > PROJECT_FILE_LIMITS.maxClips) {
      throw new OtioInterchangeError('oversized', 'An OTIO list exceeds the clip/item budget')
    }
    for (const entry of value) count += countGraph(entry, depth + 1, seen)
    return count
  }
  for (const entry of Object.values(value)) count += countGraph(entry, depth + 1, seen)
  return count
}

export function framesFromOtioRational(
  value: number,
  rate: number,
  dest: FrameRate,
): number {
  if (!Number.isFinite(value) || !Number.isFinite(rate) || rate <= 0) {
    throw new OtioInterchangeError(
      'malformed',
      'RationalTime must use a finite value and a positive rate',
    )
  }
  if (value < 0) {
    throw new OtioInterchangeError('malformed', 'RationalTime value must not be negative')
  }
  const sourceRate = snapToStandardRate(rate)
  const nearest = Math.round(value)
  const frames = Math.abs(value - nearest) <= 1e-6
    ? rescaleFrames(nearest, sourceRate, dest)
    : microsecondsToFrames(secondsToMicroseconds(value / rate), dest)
  if (!Number.isSafeInteger(frames) || frames < 0 || frames > MAX_TIMELINE_MARKER_FRAME) {
    throw new OtioInterchangeError('oversized', 'A converted time exceeds the integer frame budget')
  }
  return frames
}

export function otioRateNumber(rate: FrameRate): number {
  return rate.num / rate.den
}

function readRationalTime(value: unknown, path: string, dest: FrameRate): TimedValue {
  if (!isRecord(value)) {
    throw new OtioInterchangeError('malformed', `${path} must be a RationalTime object`)
  }
  const schema = readSchema(value)
  if (!schema || schema.name !== 'RationalTime') {
    throw new OtioInterchangeError('malformed', `${path} must declare OTIO_SCHEMA RationalTime.1`)
  }
  assertCoreVersion(schema, path)
  if (typeof value.value !== 'number' || typeof value.rate !== 'number') {
    throw new OtioInterchangeError('malformed', `${path} must contain numeric value and rate`)
  }
  return {
    frames: framesFromOtioRational(value.value, value.rate, dest),
    rate: snapToStandardRate(value.rate),
  }
}

function readTimeRange(
  value: unknown,
  path: string,
  dest: FrameRate,
): { start: number; duration: number } | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) {
    throw new OtioInterchangeError('malformed', `${path} must be a TimeRange object`)
  }
  const schema = readSchema(value)
  if (!schema || schema.name !== 'TimeRange') {
    throw new OtioInterchangeError('malformed', `${path} must declare OTIO_SCHEMA TimeRange.1`)
  }
  assertCoreVersion(schema, path)
  const start = readRationalTime(value.start_time, `${path}.start_time`, dest).frames
  const duration = readRationalTime(value.duration, `${path}.duration`, dest).frames
  return { start, duration }
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function otioRelinkBaseName(fileName: string): string {
  const trimmed = fileName.trim()
  const withoutQuery = trimmed.split(/[?#]/u)[0] ?? trimmed
  const parts = withoutQuery.replace(/\\/gu, '/').split('/').filter((part) => part.length > 0)
  const last = parts[parts.length - 1] ?? withoutQuery
  return last.length > 0 ? last : 'offline-media'
}

export function isOtioIncompleteMediaIdentity(descriptor: PortableAssetDescriptor): boolean {
  return descriptor.size === 0 && descriptor.lastModified === 0
}

function extensionOf(fileName: string): string {
  const base = otioRelinkBaseName(fileName).toLowerCase()
  const index = base.lastIndexOf('.')
  return index >= 0 ? base.slice(index) : ''
}

function mimeFromFileName(fileName: string, kind: AssetKind): string {
  const extension = extensionOf(fileName)
  if (extension === '.wav') return 'audio/wav'
  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.m4a' || extension === '.aac') return 'audio/mp4'
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.mxf') return 'application/mxf'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (kind === 'audio') return 'audio/octet-stream'
  if (kind === 'image') return 'image/octet-stream'
  return 'application/octet-stream'
}

function kindFromTrackAndName(trackKind: TrackKind, fileName: string): AssetKind {
  const extension = extensionOf(fileName)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (trackKind === 'audio' || AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'video'
}

function forbiddenTargetUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return (
    lower.startsWith('javascript:')
    || lower.startsWith('data:')
    || lower.startsWith('vbscript:')
  )
}

function sourceBoundsForKind(kind: AssetKind): MediaSourceBounds {
  if (kind === 'image') return { video: null, audio: null }
  if (kind === 'audio') {
    return {
      video: null,
      audio: { status: 'unknown' },
    }
  }
  return {
    video: { status: 'unknown' },
    audio: null,
  }
}

function emptyTrack(id: string, kind: TrackKind, name: string, hidden: boolean): Track {
  return {
    id,
    kind,
    name,
    clips: [],
    sequenceInstances: [],
    multicamInstances: [],
    adjustments: [],
    transitions: [],
    hidden,
    muted: false,
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
    videoEffects: [],
    audioEffects: [],
  }
}

function buildClip(
  id: string,
  assetId: string,
  name: string,
  start: number,
  duration: number,
  sourceStart: number,
  still: boolean,
): Clip {
  const sourceDuration = still ? 1 : duration
  const sourceStartFrame = still ? 0 : sourceStart
  return {
    id,
    assetId,
    name,
    sourceMode: still ? 'still' : 'timed',
    sourceRange: { startFrame: sourceStartFrame, durationFrames: sourceDuration },
    sourceTimeMap: defaultSourceTimeMap(sourceStartFrame, sourceDuration),
    timelineRange: { startFrame: start, durationFrames: duration },
    transform: defaultClipTransform(),
    opacity: 1,
    blendMode: DEFAULT_BLEND_MODE,
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    audioEffects: [],
  }
}

function maximumCrossfadeDuration(left: number, right: number): number {
  const leftFrames = Math.max(0, left)
  const rightFrames = Math.max(0, right)
  const even = 2 * Math.min(leftFrames, rightFrames)
  const odd = rightFrames >= 1 ? 2 * Math.min(leftFrames, rightFrames - 1) + 1 : 0
  return Math.max(even, odd)
}

function childrenOf(value: JsonRecord): unknown[] {
  return Array.isArray(value.children) ? value.children : []
}

function readItemDuration(
  item: JsonRecord,
  path: string,
  dest: FrameRate,
  log: LossLog,
): number | null {
  try {
    const sourceRange = readTimeRange(item.source_range, `${path}.source_range`, dest)
    if (sourceRange && sourceRange.duration >= 1) return sourceRange.duration
  } catch (cause) {
    addLoss(log, 'timing', `${path}.source_range`, cause instanceof Error ? cause.message : 'Invalid source range')
    return null
  }
  return null
}

function compositionDuration(
  children: readonly unknown[],
  path: string,
  dest: FrameRate,
  log: LossLog,
  depth: number,
): number {
  let duration = 0
  for (let index = 0; index < children.length; index++) {
    const childPath = `${path}.children[${index}]`
    const child = children[index]
    const schema = readSchema(child)
    if (!schema || !isRecord(child)) continue
    if (schema.name === 'Transition') {
      continue
    }
    if (schema.name === 'Gap' || schema.name === 'Clip') {
      const itemDuration = readItemDuration(child, childPath, dest, log)
        ?? mediaRangeDuration(child, childPath, dest, log)
      if (itemDuration !== null) duration += itemDuration
      continue
    }
    if (schema.name === 'Stack' || isTrackSchema(schema) || schema.name === 'Timeline') {
      duration += compositionDuration(childrenOf(child), childPath, dest, log, depth + 1)
    }
  }
  return duration
}

function mediaRange(
  clip: JsonRecord,
  path: string,
  dest: FrameRate,
  log: LossLog,
): { start: number; duration: number } | null {
  const reference = mediaReferenceOf(clip)
  if (!reference) return null
  try {
    const available = readTimeRange(
      reference.available_range,
      `${path}.media_reference.available_range`,
      dest,
    )
    return available && available.duration >= 1 ? available : null
  } catch (cause) {
    addLoss(
      log,
      'timing',
      `${path}.media_reference.available_range`,
      cause instanceof Error ? cause.message : 'Invalid available range',
    )
    return null
  }
}

function mediaRangeDuration(
  clip: JsonRecord,
  path: string,
  dest: FrameRate,
  log: LossLog,
): number | null {
  return mediaRange(clip, path, dest, log)?.duration ?? null
}

function mediaReferenceOf(clip: JsonRecord): JsonRecord | null {
  if (isRecord(clip.media_reference)) return clip.media_reference
  if (!isRecord(clip.media_references)) return null
  const key = typeof clip.active_media_reference_key === 'string'
    ? clip.active_media_reference_key
    : 'DEFAULT_MEDIA'
  const selected = clip.media_references[key]
  return isRecord(selected) ? selected : null
}

function noteDroppedEffects(
  item: JsonRecord,
  path: string,
  log: LossLog,
): void {
  if (Array.isArray(item.effects) && item.effects.length > 0) {
    addLoss(log, 'effects', `${path}.effects`, `${item.effects.length} effect(s) were omitted`)
  }
  if (metadataPresent(item.metadata)) {
    addLoss(log, 'metadata', `${path}.metadata`, 'OTIO metadata was omitted')
  }
}

function coverAssetFrames(draft: AssetDraft, frames: number, dest: FrameRate): void {
  if (draft.descriptor.kind === 'image') return
  const needed = framesToMicroseconds(Math.max(0, frames), dest)
  if (needed > draft.descriptor.durationMicroseconds) {
    draft.descriptor.durationMicroseconds = needed
  }
}

function resolveMedia(
  clip: JsonRecord,
  path: string,
  trackKind: TrackKind,
  dest: FrameRate,
  factory: OtioIdFactory,
  assets: Map<string, AssetDraft>,
  log: LossLog,
): AssetDraft | null {
  const reference = mediaReferenceOf(clip)
  if (!reference) {
    addLoss(log, 'media', path, 'Clip has no media reference')
    return null
  }
  const schema = readSchema(reference)
  if (!schema) {
    addLoss(log, 'media', `${path}.media_reference`, 'Media reference is missing OTIO_SCHEMA')
    return null
  }
  if (schema.name === 'GeneratorReference' || schema.name === 'ImageSequenceReference') {
    addLoss(log, 'media', `${path}.media_reference`, `${schema.name} is not imported`)
    return null
  }
  if (schema.name !== 'ExternalReference' && schema.name !== 'MissingReference') {
    addLoss(log, 'media', `${path}.media_reference`, `${schema.name} is not imported`)
    return null
  }
  assertCoreVersion(schema, `${path}.media_reference`)
  const targetUrl = typeof reference.target_url === 'string' ? reference.target_url : null
  if (targetUrl && forbiddenTargetUrl(targetUrl)) {
    throw new OtioInterchangeError(
      'unsupported',
      `${path} has an executable media URL, which OTIO import will not run or fetch`,
    )
  }
  if (targetUrl && /^(https?:|ftp:)/iu.test(targetUrl.trim())) {
    addLoss(log, 'media', `${path}.media_reference.target_url`, 'Remote URL was not fetched; relink a local file')
  }
  const rawName = targetUrl || readOptionalString(reference.name) || readOptionalString(clip.name)
  const fileName = otioRelinkBaseName(rawName.length > 0 ? rawName : 'offline-media')
  const kind = kindFromTrackAndName(trackKind, fileName)
  const available = (() => {
    try {
      return readTimeRange(reference.available_range, `${path}.media_reference.available_range`, dest)
    } catch (cause) {
      addLoss(
        log,
        'timing',
        `${path}.media_reference.available_range`,
        cause instanceof Error ? cause.message : 'Invalid available range',
      )
      return null
    }
  })()
  const identity = `${kind}:${schema.name === 'MissingReference' ? `missing:${fileName}` : (targetUrl ?? fileName)}`
  const existing = assets.get(identity)
  if (existing) {
    if (available) coverAssetFrames(existing, available.start + available.duration, dest)
    return existing
  }
  const still = kind === 'image'
  const descriptor: PortableAssetDescriptor = {
    id: factory('asset'),
    fileName,
    mimeType: mimeFromFileName(fileName, kind),
    size: 0,
    lastModified: 0,
    kind,
    durationMicroseconds: 0,
    sourceBounds: sourceBoundsForKind(kind),
    nativeFrameRate: kind === 'video' ? { num: dest.num, den: dest.den } : null,
    width: null,
    height: null,
    hasAudio: kind === 'audio',
    audioSampleRate: kind === 'audio' ? 48_000 : null,
    audioChannels: kind === 'audio' ? 2 : null,
  }
  if (kind === 'image') {
    descriptor.width = 1
    descriptor.height = 1
    addLoss(log, 'media', path, `Image "${fileName}" entered offline without proven dimensions; relink the original file`)
  }
  const draft: AssetDraft = { descriptor, targetUrl }
  if (!still && available) {
    coverAssetFrames(draft, available.start + available.duration, dest)
  }
  assets.set(identity, draft)
  return draft
}

function collectMarkers(
  value: JsonRecord,
  path: string,
  dest: FrameRate,
  offset: number,
  factory: OtioIdFactory,
  log: LossLog,
): TimelineMarker[] {
  if (!Array.isArray(value.markers) || value.markers.length === 0) return []
  const markers: TimelineMarker[] = []
  for (let index = 0; index < value.markers.length; index++) {
    const markerPath = `${path}.markers[${index}]`
    const marker = value.markers[index]
    const schema = readSchema(marker)
    if (!schema || !isRecord(marker) || schema.name !== 'Marker') {
      addLoss(log, 'marker', markerPath, 'Unsupported marker was omitted')
      continue
    }
    try {
      assertCoreVersion(schema, markerPath)
      let frame = offset
      if (schema.version === 1 && marker.time !== undefined) {
        frame = offset + readRationalTime(marker.time, `${markerPath}.time`, dest).frames
      } else {
        const range = readTimeRange(marker.marked_range, `${markerPath}.marked_range`, dest)
        frame = offset + (range?.start ?? 0)
      }
      const label = boundedName(readOptionalString(marker.name), 'Marker')
      const colorName = readOptionalString(marker.color).toUpperCase()
      const color = MARKER_COLORS[colorName] ?? 'yellow'
      if (!MARKER_COLORS[colorName] && colorName.length > 0) {
        addLoss(log, 'marker', markerPath, `Marker color ${colorName} was mapped to ${color}`)
      }
      const note = typeof marker.comment === 'string'
        ? marker.comment
        : typeof marker.note === 'string' ? marker.note : undefined
      markers.push({
        id: factory('marker'),
        frame,
        label,
        color,
        ...(note && note.trim().length > 0 ? { note: note.slice(0, 4_000) } : {}),
      })
      if (path.includes('.children[')) {
        addLoss(log, 'marker', markerPath, 'Clip/track marker was promoted to a sequence marker')
      }
    } catch (cause) {
      addLoss(log, 'marker', markerPath, cause instanceof Error ? cause.message : 'Marker was omitted')
    }
  }
  return markers
}

function importTrackChildren(
  children: readonly unknown[],
  path: string,
  trackKind: TrackKind,
  dest: FrameRate,
  factory: OtioIdFactory,
  assets: Map<string, AssetDraft>,
  log: LossLog,
  depth: number,
): { clips: PlacedClip[]; transitions: Array<{ from: number; to: number; duration: number; path: string }>; gaps: number; markers: TimelineMarker[] } {
  const clips: PlacedClip[] = []
  const transitions: Array<{ from: number; to: number; duration: number; path: string }> = []
  const markers: TimelineMarker[] = []
  let cursor = 0
  let gaps = 0
  let pending: { duration: number; path: string } | null = null

  const takePending = (nextClipIndex: number | null): void => {
    if (!pending) return
    if (
      nextClipIndex !== null
      && clips.length > 0
      && trackKind === 'video'
    ) {
      const from = clips.length - 1
      const previous = clips[from]
      if (previous && rangeEnd({ startFrame: previous.start, durationFrames: previous.duration }) === cursor) {
        transitions.push({ from, to: nextClipIndex, duration: pending.duration, path: pending.path })
        pending = null
        return
      }
    }
    addLoss(log, 'transition', pending.path, 'Transition was omitted because it does not sit on two touching video clips')
    pending = null
  }

  for (let index = 0; index < children.length; index++) {
    const childPath = `${path}.children[${index}]`
    const child = children[index]
    const schema = readSchema(child)
    if (!schema || !isRecord(child)) {
      addLoss(log, 'unsupported', childPath, 'Child is missing a supported OTIO schema')
      continue
    }
    if (schema.name === 'Transition') {
      assertCoreVersion(schema, childPath)
      noteDroppedEffects(child, childPath, log)
      const inOffset = child.in_offset === undefined
        ? 0
        : readRationalTime(child.in_offset, `${childPath}.in_offset`, dest).frames
      const outOffset = child.out_offset === undefined
        ? 0
        : readRationalTime(child.out_offset, `${childPath}.out_offset`, dest).frames
      const duration = inOffset + outOffset
      const type = readOptionalString(child.transition_type)
      if (duration < 1) {
        addLoss(log, 'transition', childPath, 'Transition duration is empty')
        continue
      }
      if (type.length > 0 && type !== 'SMPTE_Dissolve' && !/dissolv|crossfade/iu.test(type + readOptionalString(child.name))) {
        addLoss(log, 'transition', childPath, `Transition type ${type} is not imported`)
        continue
      }
      pending = { duration, path: childPath }
      continue
    }
    if (schema.name === 'Gap') {
      assertCoreVersion(schema, childPath)
      noteDroppedEffects(child, childPath, log)
      const duration = readItemDuration(child, childPath, dest, log)
      takePending(null)
      if (duration && duration > 0) {
        cursor += duration
        gaps += 1
      }
      continue
    }
    if (schema.name === 'Clip') {
      assertCoreVersion(schema, childPath)
      noteDroppedEffects(child, childPath, log)
      if (Array.isArray(child.effects) && child.effects.some((effect) => {
        const effectSchema = readSchema(effect)
        return effectSchema?.name === 'LinearTimeWarp' || effectSchema?.name === 'FreezeFrame'
      })) {
        addLoss(log, 'speed', childPath, 'Speed/freeze effects were omitted; the clip imported at 1×')
      }
      const sourceRange = (() => {
        try {
          return readTimeRange(child.source_range, `${childPath}.source_range`, dest)
        } catch (cause) {
          addLoss(log, 'timing', `${childPath}.source_range`, cause instanceof Error ? cause.message : 'Invalid source range')
          return null
        }
      })()
      const available = mediaRange(child, childPath, dest, log)
      const duration = sourceRange?.duration ?? available?.duration
      const sourceStart = sourceRange?.start ?? available?.start ?? 0
      if (!duration || duration < 1) {
        addLoss(log, 'clip', childPath, 'Clip has no positive duration')
        takePending(null)
        continue
      }
      const enabled = child.enabled !== false
      const asset = enabled
        ? resolveMedia(child, childPath, trackKind, dest, factory, assets, log)
        : null
      if (!enabled) {
        addLoss(log, 'clip', childPath, 'Disabled clip was replaced with a gap')
        takePending(null)
        cursor += duration
        gaps += 1
        continue
      }
      if (!asset) {
        addLoss(log, 'clip', childPath, 'Clip without supported media was replaced with a gap')
        takePending(null)
        cursor += duration
        gaps += 1
        continue
      }
      const nextIndex = clips.length
      takePending(nextIndex)
      markers.push(...collectMarkers(child, childPath, dest, cursor, factory, log))
      clips.push({
        start: cursor,
        duration,
        sourceStart,
        name: boundedName(readOptionalString(child.name), asset.descriptor.fileName),
        enabled: true,
        asset,
        path: childPath,
      })
      coverAssetFrames(asset, sourceStart + duration, dest)
      cursor += duration
      continue
    }
    if (schema.name === 'Stack' || isTrackSchema(schema) || schema.name === 'Timeline') {
      const nestedDuration = compositionDuration(childrenOf(child), childPath, dest, log, depth + 1)
      addLoss(log, 'nested', childPath, `${schema.name} nested composition was replaced with a ${nestedDuration}-frame gap`)
      takePending(null)
      if (nestedDuration > 0) {
        cursor += nestedDuration
        gaps += 1
      }
      continue
    }
    addLoss(log, 'unsupported', childPath, `${schema.name} is not imported`)
    takePending(null)
  }
  takePending(null)
  return { clips, transitions, gaps, markers }
}

function applyTrackTrim(
  placed: ReturnType<typeof importTrackChildren>,
  trim: { start: number; duration: number } | null,
): ReturnType<typeof importTrackChildren> {
  if (!trim) return placed
  const end = trim.start + trim.duration
  const remap = new Map<number, number>()
  const clips: PlacedClip[] = []
  placed.clips.forEach((clip, index) => {
    const clipEnd = clip.start + clip.duration
    const start = Math.max(clip.start, trim.start)
    const stop = Math.min(clipEnd, end)
    if (stop - start < 1) return
    const delta = start - clip.start
    remap.set(index, clips.length)
    clips.push({
      ...clip,
      start: start - trim.start,
      duration: stop - start,
      sourceStart: clip.sourceStart + delta,
    })
  })
  return {
    ...placed,
    clips,
    transitions: placed.transitions.flatMap((transition) => {
      const from = remap.get(transition.from)
      const to = remap.get(transition.to)
      return from === undefined || to === undefined ? [] : [{ ...transition, from, to }]
    }),
  }
}

function importOneTimeline(
  timeline: JsonRecord,
  path: string,
  settings: ProjectSettings,
  factory: OtioIdFactory,
  assets: Map<string, AssetDraft>,
  log: LossLog,
): { document: TimelineDoc; summary: OtioSequenceSummary } {
  const schema = readSchema(timeline)
  if (!schema || schema.name !== 'Timeline') {
    throw new OtioInterchangeError('unsupported', `${path} is not an OTIO Timeline`)
  }
  assertCoreVersion(schema, path)
  noteDroppedEffects(timeline, path, log)
  const tracksValue = timeline.tracks
  const tracksSchema = readSchema(tracksValue)
  if (!tracksSchema || !isRecord(tracksValue) || tracksSchema.name !== 'Stack') {
    throw new OtioInterchangeError('malformed', `${path}.tracks must be a Stack.1`)
  }
  assertCoreVersion(tracksSchema, `${path}.tracks`)
  let offset = 0
  if (timeline.global_start_time !== undefined && timeline.global_start_time !== null) {
    offset = readRationalTime(
      timeline.global_start_time,
      `${path}.global_start_time`,
      settings.frameRate,
    ).frames
    if (offset > 0) {
      addLoss(log, 'timing', `${path}.global_start_time`, `Global start of ${offset} frames was applied as a timeline offset`)
    }
  }
  const sequenceId = factory('sequence')
  const name = boundedName(readOptionalString(timeline.name), 'Imported timeline')
  const document = {
    ...createTimelineDoc(name, settings, sequenceId),
    markers: [] as TimelineMarker[],
    captionTracks: [] as NonNullable<TimelineDoc['captionTracks']>,
    masterAudio: defaultMasterAudio(),
    masterVideoEffects: [] as NonNullable<TimelineDoc['masterVideoEffects']>,
  }
  const markers = [
    ...collectMarkers(timeline, path, settings.frameRate, offset, factory, log),
    ...collectMarkers(tracksValue, `${path}.tracks`, settings.frameRate, offset, factory, log),
  ]
  const importedTracks: Track[] = []
  let totalClips = 0
  let totalGaps = 0
  let totalTransitions = 0
  const stackChildren = childrenOf(tracksValue)
  for (let index = 0; index < stackChildren.length; index++) {
    const trackPath = `${path}.tracks.children[${index}]`
    const trackValue = stackChildren[index]
    const trackSchema = readSchema(trackValue)
    if (!trackSchema || !isRecord(trackValue) || !isTrackSchema(trackSchema)) {
      if (trackSchema?.name === 'Stack' || trackSchema?.name === 'Timeline') {
        addLoss(log, 'nested', trackPath, `${trackSchema.name} beside tracks was omitted`)
      } else {
        addLoss(log, 'unsupported', trackPath, 'Stack child is not a video or audio track')
      }
      continue
    }
    assertCoreVersion(trackSchema, trackPath)
    noteDroppedEffects(trackValue, trackPath, log)
    const kindName = readOptionalString(trackValue.kind).toLowerCase()
    const kind: TrackKind | null = kindName === 'audio' ? 'audio' : kindName === 'video' || kindName.length === 0 ? 'video' : null
    if (!kind) {
      addLoss(log, 'track', trackPath, `Track kind ${readOptionalString(trackValue.kind)} is not imported`)
      continue
    }
    const hidden = trackValue.enabled === false
    if (hidden) addLoss(log, 'track', trackPath, 'Disabled track imported hidden')
    const trim = (() => {
      try {
        return readTimeRange(trackValue.source_range, `${trackPath}.source_range`, settings.frameRate)
      } catch (cause) {
        addLoss(log, 'timing', `${trackPath}.source_range`, cause instanceof Error ? cause.message : 'Invalid track source range')
        return null
      }
    })()
    let placed = importTrackChildren(
      childrenOf(trackValue),
      trackPath,
      kind,
      settings.frameRate,
      factory,
      assets,
      log,
      1,
    )
    placed = applyTrackTrim(placed, trim)
    if (offset > 0) {
      placed = {
        ...placed,
        clips: placed.clips.map((clip) => ({ ...clip, start: clip.start + offset })),
      }
    }
    const track = emptyTrack(
      factory('track'),
      kind,
      boundedName(readOptionalString(trackValue.name), kind === 'video' ? 'V' : 'A'),
      hidden,
    )
    for (const clip of placed.clips) {
      if (!clip.asset) continue
      const still = clip.asset.descriptor.kind === 'image'
      track.clips.push(buildClip(
        factory('clip'),
        clip.asset.descriptor.id,
        clip.name,
        clip.start,
        clip.duration,
        clip.sourceStart,
        still,
      ))
    }
    importedTracks.push(track)
    totalClips += track.clips.length
    totalGaps += placed.gaps
    markers.push(...placed.markers)
    markers.push(...collectMarkers(trackValue, trackPath, settings.frameRate, offset, factory, log))
    let trackDoc: TimelineDoc = { ...document, tracks: [track] }
    for (const transition of placed.transitions) {
      const from = track.clips[transition.from]
      const to = track.clips[transition.to]
      if (!from || !to) continue
      let duration = transition.duration
      const maximum = maximumCrossfadeDuration(from.timelineRange.durationFrames, to.timelineRange.durationFrames)
      if (duration > maximum) {
        addLoss(log, 'transition', transition.path, `Dissolve shortened from ${duration} to ${maximum} frames so it fits both clips`)
        duration = maximum
      }
      if (duration < 1) {
        addLoss(log, 'transition', transition.path, 'Dissolve does not fit the adjacent clips')
        continue
      }
      const next = addCrossfade(trackDoc, from.id, to.id, duration)
      if (next === trackDoc) {
        addLoss(log, 'transition', transition.path, 'Dissolve was omitted because it is not a valid Myrelith crossfade')
        continue
      }
      trackDoc = next
      totalTransitions += 1
    }
    const committed = trackDoc.tracks[0]
    if (committed) importedTracks[importedTracks.length - 1] = committed
  }

  const videos = importedTracks.filter((track) => track.kind === 'video')
  const audios = importedTracks.filter((track) => track.kind === 'audio')
  const ordered = [...videos, ...audios]
  if (ordered.length > 0) document.tracks = ordered
  else {
    addLoss(log, 'track', `${path}.tracks`, 'No supported tracks; an empty sequence was created')
  }
  document.markers = [...markers].sort(compareTimelineMarkers)
  const summary: OtioSequenceSummary = {
    name: document.name,
    videoTracks: videos.length,
    audioTracks: audios.length,
    clips: totalClips,
    gaps: totalGaps,
    transitions: totalTransitions,
    markers: document.markers.length,
    offlineMedia: [...assets.values()].length,
  }
  return { document, summary }
}

function collectTimelines(root: unknown, log: LossLog): JsonRecord[] {
  const schema = readSchema(root)
  if (!schema || !isRecord(root)) {
    throw new OtioInterchangeError('malformed', 'The file is not an OTIO JSON object')
  }
  if (FORBIDDEN_ROOT.has(schema.name)) {
    throw new OtioInterchangeError(
      'unsupported',
      `${schema.name} documents are not imported; Myrelith never runs OTIO adapters or scripts`,
    )
  }
  if (schema.name === 'Timeline') {
    assertCoreVersion(schema, '$')
    return [root]
  }
  if (schema.name === 'SerializableCollection') {
    assertCoreVersion(schema, '$')
    const children = childrenOf(root)
    const timelines: JsonRecord[] = []
    for (let index = 0; index < children.length; index++) {
      const child = children[index]
      const childSchema = readSchema(child)
      if (childSchema?.name === 'Timeline' && isRecord(child)) {
        timelines.push(child)
        continue
      }
      addLoss(log, 'unsupported', `$.children[${index}]`, `${childSchema?.name ?? 'Item'} in the collection was omitted`)
    }
    if (timelines.length === 0) {
      throw new OtioInterchangeError('unsupported', 'The SerializableCollection contains no Timeline objects')
    }
    return timelines
  }
  throw new OtioInterchangeError(
    'unsupported',
    `Root schema ${schema.name}.${schema.version} is not a Timeline or SerializableCollection`,
  )
}

export function parseOtioJson(text: string): unknown {
  if (text.length > MAX_OTIO_JSON_CHARACTERS) {
    throw new OtioInterchangeError(
      'oversized',
      `OTIO JSON exceeds ${MAX_OTIO_JSON_CHARACTERS} characters`,
    )
  }
  const trimmed = text.replace(/^\uFEFF/u, '').trim()
  if (trimmed.length === 0) {
    throw new OtioInterchangeError('malformed', 'The OTIO file is empty')
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    throw new OtioInterchangeError('malformed', 'The OTIO file is not valid JSON')
  }
}

export function planOtioImport(
  text: string,
  settings: ProjectSettings,
  factory: OtioIdFactory,
): OtioImportPlan {
  const parsed = parseOtioJson(text)
  const objectCount = countGraph(parsed, 0, new WeakSet())
  if (objectCount > MAX_OTIO_OBJECT_COUNT) {
    throw new OtioInterchangeError('oversized', 'The OTIO document exceeds the object-count budget')
  }
  const log = lossLog()
  const timelines = collectTimelines(parsed, log)
  const assets = new Map<string, AssetDraft>()
  const sequences: TimelineDoc[] = []
  const summaries: OtioSequenceSummary[] = []
  for (let index = 0; index < timelines.length; index++) {
    const imported = importOneTimeline(
      timelines[index],
      timelines.length === 1 ? '$' : `$.children[${index}]`,
      settings,
      factory,
      assets,
      log,
    )
    sequences.push(imported.document)
    summaries.push(imported.summary)
  }
  if (sequences.length === 0) {
    throw new OtioInterchangeError('empty', 'The OTIO file did not contain an importable timeline')
  }
  const descriptors = [...assets.values()].map((draft) => draft.descriptor)
  const preview: OtioImportPreview = {
    schemaLabel: OTIO_COMPATIBILITY_LABEL,
    sequences: summaries,
    media: descriptors.map((descriptor) => ({
      id: descriptor.id,
      fileName: descriptor.fileName,
      kind: descriptor.kind,
      offline: true,
      targetUrl: [...assets.values()].find((draft) => draft.descriptor.id === descriptor.id)?.targetUrl ?? null,
    })),
    losses: log.entries,
    omittedLosses: log.omitted,
  }
  return { preview, sequences, descriptors }
}

function rational(frames: number, rate: FrameRate): JsonRecord {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    rate: otioRateNumber(rate),
    value: frames,
  }
}

function timeRange(start: number, duration: number, rate: FrameRate): JsonRecord {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rational(start, rate),
    duration: rational(duration, rate),
  }
}

function markerColor(color: TimelineMarkerColor): string {
  return color.toUpperCase()
}

function exportMarkers(markers: readonly TimelineMarker[], rate: FrameRate): JsonRecord[] {
  return markers.map((marker) => ({
    OTIO_SCHEMA: 'Marker.2',
    name: marker.label,
    color: markerColor(marker.color),
    marked_range: timeRange(marker.frame, 0, rate),
    metadata: {},
    ...(marker.note ? { comment: marker.note } : {}),
  }))
}

function exportClip(
  clip: Clip,
  descriptor: PortableAssetDescriptor | undefined,
  rate: FrameRate,
  log: LossLog,
  path: string,
): JsonRecord {
  if (clip.effects.length > 0) {
    addLoss(log, 'effects', path, 'Clip effects were omitted from OTIO')
  }
  if ((clip.audioEffects?.length ?? 0) > 0) {
    addLoss(log, 'effects', path, 'Clip audio effects were omitted from OTIO')
  }
  const speed = sourceTimeMapWholeClipSpeed(clip.sourceTimeMap ?? defaultSourceTimeMap())
  if (speed.kind !== 'constant' || speed.percent !== 100) {
    addLoss(log, 'speed', path, 'Speed ramps/retiming were omitted; OTIO plays the clip at 1× using its source range')
  } else if (clip.sourceTimeMap && !isUnitySourceTimeRate(clip.sourceTimeMap.rate)) {
    addLoss(log, 'speed', path, 'Non-1× speed was omitted from OTIO')
  }
  const fileName = descriptor?.fileName ?? clip.name
  const reference: JsonRecord = {
    OTIO_SCHEMA: 'ExternalReference.1',
    name: fileName,
    target_url: `file://${encodeURI(fileName)}`,
    available_range: timeRange(
      0,
      descriptor
        ? Math.max(1, microsecondsToFrames(descriptor.durationMicroseconds, rate))
        : Math.max(clip.sourceRange.startFrame + clip.sourceRange.durationFrames, clip.timelineRange.durationFrames),
      rate,
    ),
    metadata: {},
  }
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: clip.name,
    source_range: timeRange(clip.sourceRange.startFrame, clip.timelineRange.durationFrames, rate),
    effects: [],
    markers: [],
    metadata: {},
    enabled: true,
    media_references: { DEFAULT_MEDIA: reference },
    active_media_reference_key: 'DEFAULT_MEDIA',
  }
}

function exportTrack(
  track: Track,
  descriptors: ReadonlyMap<string, PortableAssetDescriptor>,
  rate: FrameRate,
  log: LossLog,
  path: string,
): JsonRecord {
  const children: JsonRecord[] = []
  const occupancy: Array<{ start: number; end: number; clip?: Clip; gapReason?: string }> = []
  for (const clip of track.clips) {
    occupancy.push({
      start: clip.timelineRange.startFrame,
      end: rangeEnd(clip.timelineRange),
      clip,
    })
  }
  for (const instance of track.sequenceInstances ?? []) {
    occupancy.push({
      start: instance.timelineRange.startFrame,
      end: rangeEnd(instance.timelineRange),
      gapReason: `Nested sequence "${instance.name}" exported as a gap`,
    })
  }
  for (const instance of track.multicamInstances ?? []) {
    occupancy.push({
      start: instance.timelineRange.startFrame,
      end: rangeEnd(instance.timelineRange),
      gapReason: `Multicam "${instance.name}" exported as a gap`,
    })
  }
  occupancy.sort((left, right) => left.start - right.start || left.end - right.end)
  let lastEnd = 0
  let previousClip: Clip | null = null
  for (let index = 0; index < occupancy.length; index++) {
    const item = occupancy[index]
    if (item.start > lastEnd) {
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        name: 'gap',
        source_range: timeRange(0, item.start - lastEnd, rate),
        effects: [],
        markers: [],
        metadata: {},
        enabled: true,
      })
      previousClip = null
    }
    if (item.clip && isProceduralTitleClip(item.clip)) {
      addLoss(log, 'generator', `${path}.clips[${item.clip.id}]`, 'Title/text clip exported as a gap')
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        name: item.clip.name,
        source_range: timeRange(0, item.clip.timelineRange.durationFrames, rate),
        effects: [],
        markers: [],
        metadata: {},
        enabled: true,
      })
      previousClip = null
      lastEnd = Math.max(lastEnd, item.end)
      continue
    }
    if (item.gapReason) {
      addLoss(log, 'nested', path, item.gapReason)
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        name: 'gap',
        source_range: timeRange(0, item.end - item.start, rate),
        effects: [],
        markers: [],
        metadata: {},
        enabled: true,
      })
      previousClip = null
      lastEnd = Math.max(lastEnd, item.end)
      continue
    }
    const clip = item.clip
    if (!clip) continue
    if (previousClip && previousClip.timelineRange.startFrame + previousClip.timelineRange.durationFrames === clip.timelineRange.startFrame) {
      const transition = track.transitions.find((candidate) => (
        candidate.fromClipId === previousClip?.id && candidate.toClipId === clip.id
      ))
      if (transition) {
        const half = Math.floor(transition.durationFrames / 2)
        children.push({
          OTIO_SCHEMA: 'Transition.1',
          name: 'Crossfade',
          transition_type: 'SMPTE_Dissolve',
          in_offset: rational(transition.durationFrames - half, rate),
          out_offset: rational(half, rate),
          metadata: {},
        })
      }
    }
    children.push(exportClip(clip, descriptors.get(clip.assetId), rate, log, `${path}.clip.${clip.id}`))
    previousClip = clip
    lastEnd = Math.max(lastEnd, item.end)
  }
  if ((track.adjustments?.length ?? 0) > 0) {
    addLoss(log, 'effects', path, 'Adjustment layers were omitted from OTIO')
  }
  if ((track.videoEffects?.length ?? 0) + (track.audioEffects?.length ?? 0) > 0) {
    addLoss(log, 'effects', path, 'Track effects were omitted from OTIO')
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name: track.name,
    kind: track.kind === 'audio' ? 'Audio' : 'Video',
    source_range: null,
    effects: [],
    markers: [],
    metadata: {},
    enabled: !track.hidden,
    children,
  }
}

function exportTimeline(
  document: TimelineDoc,
  descriptors: ReadonlyMap<string, PortableAssetDescriptor>,
  log: LossLog,
): JsonRecord {
  if ((document.captionTracks?.length ?? 0) > 0) {
    addLoss(log, 'captions', document.name, 'Caption tracks were omitted from OTIO')
  }
  if ((document.masterVideoEffects?.length ?? 0) > 0 || (document.masterAudio?.audioEffects?.length ?? 0) > 0) {
    addLoss(log, 'effects', document.name, 'Master effects were omitted from OTIO')
  }
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: document.name,
    metadata: {},
    global_start_time: rational(0, document.frameRate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: exportMarkers(document.markers ?? [], document.frameRate),
      metadata: {},
      enabled: true,
      children: document.tracks.map((track, index) => (
        exportTrack(track, descriptors, document.frameRate, log, `${document.name}.tracks[${index}]`)
      )),
    },
  }
}

function safeFileStem(value: string): string {
  const stem = value.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return stem.length > 0 ? stem.slice(0, 120) : 'timeline'
}

export function serializeOtioExport(
  project: SequenceProject,
  descriptors: Iterable<PortableAssetDescriptor>,
): OtioExportResult {
  const log = lossLog()
  const catalog = new Map(
    [...descriptors].map((descriptor) => [descriptor.id, descriptor]),
  )
  const timelines = project.sequences.map((sequence) => exportTimeline(sequence, catalog, log))
  const root = timelines.length === 1
    ? timelines[0]
    : {
        OTIO_SCHEMA: 'SerializableCollection.1',
        name: project.name,
        metadata: {},
        children: timelines,
      }
  const content = `${JSON.stringify(root, null, 2)}\n`
  if (content.length > MAX_OTIO_JSON_CHARACTERS) {
    throw new OtioInterchangeError('oversized', 'Exported OTIO JSON exceeds the interchange size limit')
  }
  const preview: OtioImportPreview = {
    schemaLabel: OTIO_COMPATIBILITY_LABEL,
    sequences: project.sequences.map((sequence) => ({
      name: sequence.name,
      videoTracks: sequence.tracks.filter((track) => track.kind === 'video').length,
      audioTracks: sequence.tracks.filter((track) => track.kind === 'audio').length,
      clips: sequence.tracks.reduce((sum, track) => sum + track.clips.length, 0),
      gaps: 0,
      transitions: sequence.tracks.reduce((sum, track) => sum + track.transitions.length, 0),
      markers: sequence.markers?.length ?? 0,
      offlineMedia: 0,
    })),
    media: [...catalog.values()].map((descriptor) => ({
      id: descriptor.id,
      fileName: descriptor.fileName,
      kind: descriptor.kind,
      offline: false,
      targetUrl: `file://${encodeURI(descriptor.fileName)}`,
    })),
    losses: log.entries,
    omittedLosses: log.omitted,
  }
  return {
    fileName: `${safeFileStem(project.name)}${OTIO_FILE_EXTENSION}`,
    mediaType: OTIO_JSON_MEDIA_TYPE,
    content,
    preview,
  }
}
