import type { AssetKind, FrameRate, MediaSourceBounds, MulticamDefinition, PartialTrackImportSelection } from '../schema';
import { MAX_TIMELINE_MARKERS } from '../timelineMarkers';
import { TEXT_OVERLAY_LIMITS } from '../textOverlay';
import { MAX_DOCUMENT_ID_CHARACTERS, MAX_PROJECT_NAME_CHARACTERS } from '../projectLimits';
import { MEDIA_COLLECTION_LIMITS, type MediaCollection } from '../mediaCollections';
import { EFFECT_STACK_LIMITS } from '../effectBounds'
import { AUDIO_EFFECT_STACK_LIMITS } from '../audioEffectBounds';
import { MAX_SOURCE_TIME_SPEED_POINTS } from '../sourceTimeMap';
import type { SequenceProject } from '../projectSequences';
import { SEQUENCE_PROJECT_LIMITS } from '../sequenceProjectLimits';

export const PROJECT_FILE_FORMAT = 'myrelith-project' as const
/** Serialized format marker used by releases published before the rebrand. */
export const LEGACY_PROJECT_FILE_FORMAT = 'webcut-project' as const
export const PROJECT_FILE_EXTENSION = '.myrelith' as const
/** Portable project extension used before the Myrelith rebrand. */
export const LEGACY_PROJECT_FILE_EXTENSION = '.webcut' as const
export const SUPPORTED_PROJECT_FILE_EXTENSIONS = Object.freeze([
  PROJECT_FILE_EXTENSION,
  LEGACY_PROJECT_FILE_EXTENSION,
] as const)
export const CURRENT_PROJECT_FORMAT_VERSION = 7 as const
export const CURRENT_TIMELINE_SCHEMA_VERSION = 21 as const

/** Public bounds applied before or while walking untrusted project data. */
export const PROJECT_FILE_LIMITS = {
  maxSerializedCharacters: 10_000_000,
  maxAssets: 50_000,
  maxSequences: SEQUENCE_PROJECT_LIMITS.maxSequences,
  maxMulticamDefinitions: SEQUENCE_PROJECT_LIMITS.maxMulticamDefinitions,
  maxTotalMulticamAngles: SEQUENCE_PROJECT_LIMITS.maxTotalMulticamAngles,
  maxTotalMulticamSwitches: SEQUENCE_PROJECT_LIMITS.maxTotalMulticamSwitches,
  maxTotalTracks: SEQUENCE_PROJECT_LIMITS.maxTotalTracks,
  maxTotalMarkers: SEQUENCE_PROJECT_LIMITS.maxTotalMarkers,
  maxTotalCaptionTracks: SEQUENCE_PROJECT_LIMITS.maxTotalCaptionTracks,
  maxTotalCaptionItems: SEQUENCE_PROJECT_LIMITS.maxTotalCaptionItems,
  maxCollections: MEDIA_COLLECTION_LIMITS.maxCollections,
  maxCollectionMemberships: MEDIA_COLLECTION_LIMITS.maxMembershipsPerCollection,
  maxTotalCollectionMemberships: MEDIA_COLLECTION_LIMITS.maxTotalMemberships,
  maxCollectionNameCharacters: MEDIA_COLLECTION_LIMITS.maxNameCharacters,
  maxTracks: 256,
  maxClips: 100_000,
  maxSequenceInstances: SEQUENCE_PROJECT_LIMITS.maxTotalSequenceInstances,
  maxMulticamInstances: SEQUENCE_PROJECT_LIMITS.maxTotalMulticamInstances,
  maxAdjustments: SEQUENCE_PROJECT_LIMITS.maxTotalAdjustments,
  maxEffectsPerClip: EFFECT_STACK_LIMITS.maxEffectsPerClip,
  maxEffectParams: EFFECT_STACK_LIMITS.maxEffectParams,
  maxTotalEffects: SEQUENCE_PROJECT_LIMITS.maxTotalEffects,
  maxTotalEffectParams: SEQUENCE_PROJECT_LIMITS.maxTotalEffectParams,
  maxTotalEffectStringCharacters:
    SEQUENCE_PROJECT_LIMITS.maxTotalEffectStringCharacters,
  maxAudioEffectsPerStack: AUDIO_EFFECT_STACK_LIMITS.maxEffectsPerStack,
  maxTotalAudioEffects: AUDIO_EFFECT_STACK_LIMITS.maxTotalEffects,
  maxTotalAudioEffectParams: AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectParams,
  maxTotalAudioEffectStringCharacters: AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters,
  maxTransitions: 100_000,
  maxMarkers: MAX_TIMELINE_MARKERS,
  maxTotalKeyframes: SEQUENCE_PROJECT_LIMITS.maxTotalKeyframes,
  maxSpeedPointsPerClip: MAX_SOURCE_TIME_SPEED_POINTS,
  maxTotalSpeedPoints: SEQUENCE_PROJECT_LIMITS.maxTotalSpeedPoints,
  maxTotalTextCharacters: SEQUENCE_PROJECT_LIMITS.maxTotalTextCharacters,
  maxLensIntentDepth: 8,
  maxLensIntentEntries: 256,
  maxLensIntentKeyCharacters: 128,
  maxLensIntentStringCharacters: 8_192,
  maxIdCharacters: MAX_DOCUMENT_ID_CHARACTERS,
  maxNameCharacters: MAX_PROJECT_NAME_CHARACTERS,
  maxFileNameCharacters: 4_096,
  maxMimeTypeCharacters: 256,
  maxTextCharacters: TEXT_OVERLAY_LIMITS.maxCharacters,
  maxEffectStringCharacters: EFFECT_STACK_LIMITS.maxEffectStringCharacters,
  maxDimension: 65_535,
  maxAudioSampleRate: 768_000,
  maxAudioChannels: 64,
  maxRatePart: 1_000_000,
  maxFramesPerSecond: 1_000,
  maxFiniteMagnitude: EFFECT_STACK_LIMITS.maxFiniteMagnitude,
} as const

/** Durable effective-import metadata plus original-file relink identity. */
export interface PortableAssetDescriptor {
  id: string
  fileName: string
  mimeType: string
  size: number
  lastModified: number
  kind: AssetKind
  partialTrackSelection?: PartialTrackImportSelection
  durationMicroseconds: number
  sourceBounds: MediaSourceBounds
  nativeFrameRate: FrameRate | null
  width: number | null
  height: number | null
  hasAudio: boolean
  audioSampleRate: number | null
  audioChannels: number | null
}

export interface ProjectFileV7 extends SequenceProject {
  format: typeof PROJECT_FILE_FORMAT
  formatVersion: typeof CURRENT_PROJECT_FORMAT_VERSION
  multicams: MulticamDefinition[]
  assets: PortableAssetDescriptor[]
  collections: MediaCollection[]
}

export type ProjectFile = ProjectFileV7

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
  }
}

export function hasSupportedProjectFileExtension(fileName: string): boolean {
  const normalized = fileName.toLowerCase()
  return SUPPORTED_PROJECT_FILE_EXTENSIONS.some((extension) => (
    normalized.endsWith(extension)
  ))
}
