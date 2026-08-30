import type { Effect, TimelineDoc } from '../schema';
import { masterAudioSettings, trackBalance, trackVolume } from '../audioMixer';
import { compareTimelineMarkers } from '../timelineMarkers';
import { clipAnimation, cloneClipAnimation } from '../clipAnimation';
import { clipAudioSettings, clipVisualSettings } from '../clipInspector';
import { cloneMediaSourceBounds } from '../sourceBounds';
import { cloneMediaCollections, type MediaCollection } from '../mediaCollections';
import { clipBlendModeIntent } from '../blendModes';
import { animationWithSourceTimeIntent, cloneSourceTimeMap, defaultSourceTimeMap } from '../sourceTimeMap';
import { type LensCorrectionIntent } from '../lensCorrection';
import { CURRENT_PROJECT_FORMAT_VERSION, CURRENT_TIMELINE_SCHEMA_VERSION, PROJECT_FILE_FORMAT, PROJECT_FILE_LIMITS, type PortableAssetDescriptor, type ProjectFile } from './projectTypes';
import { fail, type JsonRecord } from './validationPrimitives';
import { validateProjectFile } from './documentValidation';
import { migrateProjectFile } from './migrations';
import { cloneAdjustmentAnimation } from '../adjustmentItems';

function cloneEffectParams(params: Effect['params']): Effect['params'] {
  const copy: Effect['params'] = {}
  for (const key of Object.keys(params)) copy[key] = params[key]
  return copy
}

function cloneLensIntentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneLensIntentValue)
  if (value !== null && typeof value === 'object') {
    const clone: JsonRecord = {}
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneLensIntentValue(entry),
        writable: true,
      })
    }
    return clone
  }
  return value
}

function cloneLensCorrectionIntent(
  value: LensCorrectionIntent | null | undefined,
): LensCorrectionIntent | null {
  return value === undefined || value === null
    ? null
    : cloneLensIntentValue(value) as LensCorrectionIntent
}

function portableProjectSnapshot(project: ProjectFile): ProjectFile {
  const document = project.document
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: {
      schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
      id: document.id,
      name: document.name,
      frameRate: { num: document.frameRate.num, den: document.frameRate.den },
      width: document.width,
      height: document.height,
      audioSampleRate: document.audioSampleRate,
      tracks: document.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          name: clip.name,
          sourceMode: clip.sourceMode,
          sourceRange: { ...clip.sourceRange },
          sourceTimeMap: cloneSourceTimeMap(
            clip.sourceTimeMap ?? defaultSourceTimeMap(
              clip.sourceRange.startFrame,
              clip.sourceRange.durationFrames,
            ),
          ),
          timelineRange: { ...clip.timelineRange },
          transform: { ...clip.transform },
          opacity: clip.opacity,
          blendMode: clipBlendModeIntent(clip),
          volume: clip.volume,
          lensCorrection: cloneLensCorrectionIntent(clip.lensCorrection),
          visual: {
            ...clipVisualSettings(clip),
            crop: { ...clipVisualSettings(clip).crop },
          },
          audio: { ...clipAudioSettings(clip) },
          animation: cloneClipAnimation(animationWithSourceTimeIntent(
            clipAnimation(clip),
            clip.sourceTimeMap ?? defaultSourceTimeMap(
              clip.sourceRange.startFrame,
              clip.sourceRange.durationFrames,
            ),
          )),
          effects: clip.effects.map((effect) => ({
            id: effect.id,
            type: effect.type,
            version: effect.version,
            enabled: effect.enabled,
            params: cloneEffectParams(effect.params),
          })),
          audioEffects: (clip.audioEffects ?? []).map((effect) => ({
            id: effect.id,
            type: effect.type,
            version: effect.version,
            enabled: effect.enabled,
            params: cloneEffectParams(effect.params),
          })),
          ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
          ...(clip.linkGroupId === undefined ? {} : { linkGroupId: clip.linkGroupId }),
        })),
        adjustments: (track.adjustments ?? []).map((adjustment) => ({
          kind: adjustment.kind,
          id: adjustment.id,
          name: adjustment.name,
          timelineRange: { ...adjustment.timelineRange },
          enabled: adjustment.enabled,
          opacity: adjustment.opacity,
          animation: cloneAdjustmentAnimation(adjustment.animation),
          effects: adjustment.effects.map((effect) => ({
            id: effect.id,
            type: effect.type,
            version: effect.version,
            enabled: effect.enabled,
            params: cloneEffectParams(effect.params),
          })),
        })),
        transitions: track.transitions.map((transition) => ({
          ...transition,
          audio: { ...transition.audio },
        })),
        hidden: track.hidden,
        muted: track.muted,
        solo: track.solo,
        locked: track.locked,
        volume: trackVolume(track),
        balance: trackBalance(track),
        audioEffects: (track.audioEffects ?? []).map((effect) => ({
          id: effect.id,
          type: effect.type,
          version: effect.version,
          enabled: effect.enabled,
          params: cloneEffectParams(effect.params),
        })),
      })),
      markers: [...(document.markers ?? [])]
        .sort(compareTimelineMarkers)
        .map((marker) => ({
          id: marker.id,
          frame: marker.frame,
          label: marker.label,
          color: marker.color,
          ...(marker.note === undefined ? {} : { note: marker.note }),
        })),
      captionTracks: (document.captionTracks ?? []).map((track) => ({
        id: track.id,
        name: track.name,
        language: track.language,
        role: track.role,
        stylePreset: track.stylePreset,
        hidden: track.hidden,
        items: track.items.map((item) => ({
          id: item.id,
          range: { ...item.range },
          text: item.text,
        })),
      })),
      masterAudio: (() => {
        const master = masterAudioSettings(document)
        return {
          volume: master.volume,
          balance: master.balance,
          muted: master.muted,
          audioEffects: (master.audioEffects ?? []).map((effect) => ({
            id: effect.id,
            type: effect.type,
            version: effect.version,
            enabled: effect.enabled,
            params: cloneEffectParams(effect.params),
          })),
        }
      })(),
    },
    assets: project.assets
      .map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
        lastModified: asset.lastModified,
        kind: asset.kind,
        ...(asset.partialTrackSelection === undefined
          ? {}
          : { partialTrackSelection: asset.partialTrackSelection }),
        durationMicroseconds: asset.durationMicroseconds,
        sourceBounds: cloneMediaSourceBounds(asset.sourceBounds),
        nativeFrameRate:
          asset.nativeFrameRate === null ? null : { ...asset.nativeFrameRate },
        width: asset.width,
        height: asset.height,
        hasAudio: asset.hasAudio,
        audioSampleRate: asset.audioSampleRate,
        audioChannels: asset.audioChannels,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    collections: cloneMediaCollections(project.collections),
  }
}

/**
 * Build one isolated portable snapshot from the active editor session's durable
 * descriptor catalog. Connected MediaAssets, session-only URLs, decoder state,
 * conformed frame counts, visuals, and undo history are intentionally absent.
 */
export function createProjectFileSnapshot(
  document: TimelineDoc,
  descriptors: Iterable<PortableAssetDescriptor>,
  collections: readonly MediaCollection[] = [],
): ProjectFile {
  const assets = Array.from(descriptors)
  const project: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: document.captionTracks === undefined
      ? { ...document, captionTracks: [] }
      : document,
    assets,
    collections: cloneMediaCollections(collections),
  }
  const snapshot = portableProjectSnapshot(project)
  validateProjectFile(snapshot)
  return snapshot
}

interface SerializationBudget {
  remaining: number
}

function consumeSerializationBudget(
  budget: SerializationBudget,
  characters: number,
): void {
  if (characters > budget.remaining) {
    fail(
      '$',
      `serialized project exceeds ${PROJECT_FILE_LIMITS.maxSerializedCharacters} characters`,
    )
  }
  budget.remaining -= characters
}

function stableJson(value: unknown, budget: SerializationBudget): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value)
    consumeSerializationBudget(budget, serialized.length)
    return serialized
  }
  if (Array.isArray(value)) {
    consumeSerializationBudget(budget, 2)
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (index > 0) consumeSerializationBudget(budget, 1)
      items.push(stableJson(value[index], budget))
    }
    return `[${items.join(',')}]`
  }
  const object = value as JsonRecord
  const keys = Object.keys(object).sort()
  consumeSerializationBudget(budget, 2)
  const entries: string[] = []
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const serializedKey = JSON.stringify(key)
    if (index > 0) consumeSerializationBudget(budget, 1)
    consumeSerializationBudget(budget, serializedKey.length + 1)
    entries.push(`${serializedKey}:${stableJson(object[key], budget)}`)
  }
  return `{${entries.join(',')}}`
}

/** Serialize an allowlisted, validated, deterministic portable snapshot. */
export function serializeProjectFile(project: ProjectFile): string {
  validateProjectFile(project)
  const snapshot = portableProjectSnapshot(project)
  validateProjectFile(snapshot)
  return stableJson(snapshot, {
    remaining: PROJECT_FILE_LIMITS.maxSerializedCharacters,
  })
}

/** Parse, migrate, and fully validate untrusted project-file JSON. */
export function parseProjectFile(serialized: string): ProjectFile {
  if (typeof serialized !== 'string') fail('$', 'project file must be text')
  if (serialized.length > PROJECT_FILE_LIMITS.maxSerializedCharacters) {
    fail('$', `project file exceeds ${PROJECT_FILE_LIMITS.maxSerializedCharacters} characters`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    fail('$', 'invalid JSON')
  }
  return validateProjectFile(migrateProjectFile(parsed))
}
