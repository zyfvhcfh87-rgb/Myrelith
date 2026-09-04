import type { ClipSourceMode, Effect, Transform } from '../schema';
import { ANIMATABLE_CLIP_PROPERTIES, defaultClipAnimation, MAX_KEYFRAME_FRAME, MAX_KEYFRAMES_PER_TRACK } from '../clipAnimation';
import { migrateLegacyClipInspectorSettings } from '../clipInspector';
import { defaultTextProps, migrateLegacyProceduralTextAssetId, proceduralTextAssetId } from '../textOverlay';
import { DEFAULT_BLEND_MODE } from '../blendModes';
import { LEGACY_UNVERSIONED_EFFECT_VERSION, migrateEffectDescriptor } from '../effectStack';
import { defaultSourceTimeMap, SOURCE_TIME_TICKS_PER_FRAME } from '../sourceTimeMap';
import { CURRENT_PROJECT_FORMAT_VERSION, CURRENT_TIMELINE_SCHEMA_VERSION, LEGACY_PROJECT_FILE_FORMAT, PROJECT_FILE_FORMAT, PROJECT_FILE_LIMITS } from './projectTypes';
import { boundedArray, fail, record, safeInteger, type JsonRecord } from './validationPrimitives';

/**
 * Upgrade one schema-1 timeline to the explicit schema-2 source contract.
 * Image media clips become canonical one-frame still sources while retaining
 * their authored timeline duration. Text clips remain timed even when their
 * historical backing asset is an image, because text renders its own payload
 * rather than the referenced media pixels.
 */
function migrateClipSourceModes(
  documentValue: unknown,
  assetsValue: unknown,
): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(
    assetsValue,
    '$.assets',
    PROJECT_FILE_LIMITS.maxAssets,
  )
  const assets = assetsValue
  const imageAssetIds = new Set<string>()
  for (let index = 0; index < assets.length; index++) {
    const asset = record(assets[index], `$.assets[${index}]`)
    if (typeof asset.id === 'string' && asset.kind === 'image') {
      imageAssetIds.add(asset.id)
    }
  }

  boundedArray(
    document.tracks,
    '$.document.tracks',
    PROJECT_FILE_LIMITS.maxTracks,
  )
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clip = record(
        clipValue,
        `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
      )
      const sourceMode: ClipSourceMode =
        clip.text === undefined
        && typeof clip.assetId === 'string'
        && imageAssetIds.has(clip.assetId)
          ? 'still'
          : 'timed'
      return {
        ...clip,
        sourceMode,
        ...(sourceMode === 'still'
          ? { sourceRange: { startFrame: 0, durationFrames: 1 } }
          : {}),
      }
    })
    return { ...track, clips }
  })
  return {
    ...document,
    schemaVersion: 2,
    tracks,
  }
}

/** Upgrade schema 2 transitions without claiming legacy audio behavior. */
function migrateTransitionAudio(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.transitions,
      `$.document.tracks[${trackIndex}].transitions`,
      PROJECT_FILE_LIMITS.maxTransitions,
    )
    return {
      ...track,
      transitions: track.transitions.map((transitionValue, transitionIndex) => ({
        ...record(
          transitionValue,
          `$.document.tracks[${trackIndex}].transitions[${transitionIndex}]`,
        ),
        audio: { enabled: false, curve: 'equal-power' },
      })),
    }
  })
  return { ...document, schemaVersion: 3, tracks }
}

/** Upgrade dormant schema-3 text payloads into bounded procedural overlays. */
function migrateTextOverlays(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const width = typeof document.width === 'number' && Number.isFinite(document.width)
    ? document.width
    : 1_920
  const height = typeof document.height === 'number' && Number.isFinite(document.height)
    ? document.height
    : 1_080
  const defaults = defaultTextProps(width, height)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clipPath = `$.document.tracks[${trackIndex}].clips[${clipIndex}]`
      const clip = record(clipValue, clipPath)
      if (clip.text === undefined) return clip
      const legacy = record(clip.text, `${clipPath}.text`)
      const timelineRange = record(clip.timelineRange, `${clipPath}.timelineRange`)
      return {
        ...clip,
        assetId: proceduralTextAssetId(String(clip.id)),
        sourceMode: 'timed',
        sourceRange: {
          startFrame: 0,
          durationFrames: timelineRange.durationFrames,
        },
        text: {
          ...defaults,
          content: legacy.content,
          fontFamily: legacy.fontFamily,
          fontSizePx: legacy.fontSizePx,
          color: legacy.color,
          align: legacy.align,
          bold: legacy.bold,
          italic: legacy.italic,
        },
      }
    })
    return { ...track, clips }
  })
  return { ...document, schemaVersion: 4, tracks }
}

/** Upgrade schema-4 clips to the complete static Inspector document model. */
function migrateClipInspector(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clipPath = `$.document.tracks[${trackIndex}].clips[${clipIndex}]`
      const clip = record(clipValue, clipPath)
      const transform = record(clip.transform, `${clipPath}.transform`)
      const migrated = migrateLegacyClipInspectorSettings(
        transform as unknown as Transform,
      )
      return {
        ...clip,
        transform: migrated.transform,
        visual: migrated.visual,
        audio: migrated.audio,
      }
    })
    return { ...track, clips }
  })
  return { ...document, schemaVersion: 5, tracks }
}

/** Upgrade schema-5 clips with a canonical empty animation container. */
function migrateClipAnimation(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => ({
        ...record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        ),
        animation: defaultClipAnimation(),
      })),
    }
  })
  return { ...document, schemaVersion: 6, tracks }
}

/** Upgrade schema-6 documents with an explicit empty sequence-marker list. */
function migrateTimelineMarkers(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  return { ...document, schemaVersion: 7, markers: [] }
}

/** Upgrade schema-7 documents with explicit semantic caption-track storage. */
function migrateCaptionTracks(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  return { ...document, schemaVersion: 8, captionTracks: [] }
}

/** Upgrade schema-8 clips with explicit normal/source-over compositing intent. */
function migrateClipBlendModes(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => ({
        ...record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        ),
        blendMode: DEFAULT_BLEND_MODE,
      })),
    }
  })
  return { ...document, schemaVersion: 9, tracks }
}

/** Upgrade schema-9 effect records to explicit per-effect registry versions. */
function migrateVersionedEffectDescriptors(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const trackPath = `$.document.tracks[${trackIndex}]`
    const track = record(trackValue, trackPath)
    boundedArray(track.clips, `${trackPath}.clips`, PROJECT_FILE_LIMITS.maxClips)
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clipPath = `${trackPath}.clips[${clipIndex}]`
        const clip = record(clipValue, clipPath)
        boundedArray(clip.effects, `${clipPath}.effects`, PROJECT_FILE_LIMITS.maxEffectsPerClip)
        return {
          ...clip,
          effects: clip.effects.map((effectValue, effectIndex) => {
            const effectPath = `${clipPath}.effects[${effectIndex}]`
            const effect = record(effectValue, effectPath)
            const params = record(effect.params, `${effectPath}.params`)
            return migrateEffectDescriptor({
              ...effect,
              version: LEGACY_UNVERSIONED_EFFECT_VERSION,
              params: { ...params },
            } as unknown as Effect)
          }),
        }
      }),
    }
  })
  return { ...document, schemaVersion: 10, tracks }
}

/** Upgrade schema-10 clips with the exact backward-compatible 1x map. */
function migrateClipSourceTimeMaps(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clip = record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        )
        const sourceRange = record(
          clip.sourceRange,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}].sourceRange`,
        )
        safeInteger(
          sourceRange.startFrame,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}].sourceRange.startFrame`,
          0,
        )
        safeInteger(
          sourceRange.durationFrames,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}].sourceRange.durationFrames`,
          1,
        )
        const sourceTimeMap = defaultSourceTimeMap(
          Number(sourceRange.startFrame),
          Number(sourceRange.durationFrames),
        )
        const animationValue = clip.animation
        let animation = animationValue
        if (animationValue !== undefined) {
          const animationRecord = record(
            animationValue,
            `$.document.tracks[${trackIndex}].clips[${clipIndex}].animation`,
          )
          boundedArray(
            animationRecord.tracks,
            `$.document.tracks[${trackIndex}].clips[${clipIndex}].animation.tracks`,
            ANIMATABLE_CLIP_PROPERTIES.length,
          )
          animation = {
            ...animationRecord,
            tracks: animationRecord.tracks.map((trackValue, animationTrackIndex) => {
              const trackPath = `$.document.tracks[${trackIndex}].clips[${clipIndex}].animation.tracks[${animationTrackIndex}]`
              const animationTrack = record(trackValue, trackPath)
              boundedArray(
                animationTrack.keyframes,
                `${trackPath}.keyframes`,
                MAX_KEYFRAMES_PER_TRACK,
              )
              return {
                ...animationTrack,
                keyframes: animationTrack.keyframes.map((keyframeValue, keyframeIndex) => {
                  const keyframePath = `${trackPath}.keyframes[${keyframeIndex}]`
                  const keyframe = record(keyframeValue, keyframePath)
                  safeInteger(
                    keyframe.frame,
                    `${keyframePath}.frame`,
                    -MAX_KEYFRAME_FRAME,
                    MAX_KEYFRAME_FRAME,
                  )
                  const sourceTimeTicks = sourceTimeMap.sourceStartTicks
                    + Number(keyframe.frame) * SOURCE_TIME_TICKS_PER_FRAME
                  safeInteger(
                    sourceTimeTicks,
                    `${keyframePath}.sourceTimeTicks`,
                    Number.MIN_SAFE_INTEGER,
                    Number.MAX_SAFE_INTEGER,
                  )
                  return { ...keyframe, sourceTimeTicks }
                }),
              }
            }),
          }
        }
        return {
          ...clip,
          sourceTimeMap,
          ...(animation === undefined ? {} : { animation }),
        }
      }),
    }
  })
  return { ...document, schemaVersion: 11, tracks }
}

/** Upgrade schema-11 affine maps with an empty behavior-identical speed curve. */
function migrateClipSpeedCurves(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const trackPath = `$.document.tracks[${trackIndex}]`
    const track = record(trackValue, trackPath)
    boundedArray(track.clips, `${trackPath}.clips`, PROJECT_FILE_LIMITS.maxClips)
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clipPath = `${trackPath}.clips[${clipIndex}]`
        const clip = record(clipValue, clipPath)
        const sourceTimeMap = record(clip.sourceTimeMap, `${clipPath}.sourceTimeMap`)
        return {
          ...clip,
          sourceTimeMap: {
            ...sourceTimeMap,
            speedCurve: { originFrame: 0, points: [] },
          },
        }
      }),
    }
  })
  return { ...document, schemaVersion: 12, tracks }
}

/** Upgrade schema-12 animations with bounded stable effect-parameter tracks. */
function migrateEffectAnimationTracks(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const trackPath = `$.document.tracks[${trackIndex}]`
    const track = record(trackValue, trackPath)
    boundedArray(track.clips, `${trackPath}.clips`, PROJECT_FILE_LIMITS.maxClips)
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clipPath = `${trackPath}.clips[${clipIndex}]`
        const clip = record(clipValue, clipPath)
        const animation = clip.animation === undefined
          ? { tracks: [] }
          : record(clip.animation, `${clipPath}.animation`)
        return { ...clip, animation: { ...animation, effectTracks: [] } }
      }),
    }
  })
  return { ...document, schemaVersion: 13, tracks }
}

/** Upgrade schema-13 clips with explicit absent manual source geometry. */
function migrateManualLensCorrection(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const trackPath = `$.document.tracks[${trackIndex}]`
    const track = record(trackValue, trackPath)
    boundedArray(track.clips, `${trackPath}.clips`, PROJECT_FILE_LIMITS.maxClips)
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => ({
        ...record(clipValue, `${trackPath}.clips[${clipIndex}]`),
        lensCorrection: null,
      })),
    }
  })
  return { ...document, schemaVersion: 14, tracks }
}

/** Upgrade schema-14 tracks with an explicit empty adjustment-item collection. */
function migrateAdjustmentItems(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => ({
    ...record(trackValue, `$.document.tracks[${trackIndex}]`),
    adjustments: [],
  }))
  return { ...document, schemaVersion: 15, tracks }
}

/** Upgrade schema-15 documents so volume/balance keys are legal animation properties. */
function migrateClipAudioAutomation(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  return { ...document, schemaVersion: 16 }
}

/** Upgrade schema-16 documents with track/master mixer defaults. */
function migrateAudioMixer(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    return {
      ...track,
      volume: typeof track.volume === 'number' ? track.volume : 1,
      balance: typeof track.balance === 'number' ? track.balance : 0,
    }
  })
  const authoredMaster = document.masterAudio === undefined
    ? null
    : record(document.masterAudio, '$.document.masterAudio')
  const masterAudio = {
    volume: typeof authoredMaster?.volume === 'number' ? authoredMaster.volume : 1,
    balance: typeof authoredMaster?.balance === 'number' ? authoredMaster.balance : 0,
    muted: typeof authoredMaster?.muted === 'boolean' ? authoredMaster.muted : false,
  }
  return { ...document, schemaVersion: 17, tracks, masterAudio }
}

/** Upgrade schema-17 documents with empty clip/track/master audio-effect stacks. */
function migrateAudioEffectStacks(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const trackPath = `$.document.tracks[${trackIndex}]`
    const track = record(trackValue, trackPath)
    boundedArray(track.clips, `${trackPath}.clips`, PROJECT_FILE_LIMITS.maxClips)
    return {
      ...track,
      audioEffects: Array.isArray(track.audioEffects) ? track.audioEffects : [],
      clips: track.clips.map((clipValue, clipIndex) => {
        const clip = record(clipValue, `${trackPath}.clips[${clipIndex}]`)
        return {
          ...clip,
          audioEffects: Array.isArray(clip.audioEffects) ? clip.audioEffects : [],
        }
      }),
    }
  })
  const authoredMaster = document.masterAudio === undefined
    ? null
    : record(document.masterAudio, '$.document.masterAudio')
  const masterAudio = {
    volume: typeof authoredMaster?.volume === 'number' ? authoredMaster.volume : 1,
    balance: typeof authoredMaster?.balance === 'number' ? authoredMaster.balance : 0,
    muted: typeof authoredMaster?.muted === 'boolean' ? authoredMaster.muted : false,
    audioEffects: Array.isArray(authoredMaster?.audioEffects)
      ? authoredMaster.audioEffects
      : [],
  }
  return { ...document, schemaVersion: 18, tracks, masterAudio }
}

function migrateSequenceInstances(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    return { ...track, sequenceInstances: [] }
  })
  return { ...document, schemaVersion: 19, tracks }
}

/** Upgrade schema-19 tracks with explicit empty multicam-item collections. */
function migrateMulticamInstances(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    return { ...track, multicamInstances: [] }
  })
  return { ...document, schemaVersion: 20, tracks }
}

/**
 * Upgrade a parsed historical timeline to the current nested schema. The
 * outer project format and nested timeline schema are independent version
 * boundaries: previously shipped project files can still contain a schema-1
 * document and must therefore pass through this migration too.
 */
function migrateTimelineDocument(
  documentValue: unknown,
  assetsValue: unknown,
): JsonRecord {
  const document = record(documentValue, '$.document')
  safeInteger(document.schemaVersion, '$.document.schemaVersion', 1)
  if (document.schemaVersion > CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail(
      '$.document.schemaVersion',
      `unsupported future timeline schema ${document.schemaVersion}`,
    )
  }
  let migrated = document
  if (migrated.schemaVersion === 1) {
    migrated = migrateClipSourceModes(migrated, assetsValue)
  }
  if (migrated.schemaVersion === 2) {
    migrated = migrateTransitionAudio(migrated)
  }
  if (migrated.schemaVersion === 3) {
    migrated = migrateTextOverlays(migrated)
  }
  if (migrated.schemaVersion === 4) {
    migrated = migrateClipInspector(migrated)
  }
  if (migrated.schemaVersion === 5) {
    migrated = migrateClipAnimation(migrated)
  }
  if (migrated.schemaVersion === 6) {
    migrated = migrateTimelineMarkers(migrated)
  }
  if (migrated.schemaVersion === 7) {
    migrated = migrateCaptionTracks(migrated)
  }
  if (migrated.schemaVersion === 8) {
    migrated = migrateClipBlendModes(migrated)
  }
  if (migrated.schemaVersion === 9) {
    migrated = migrateVersionedEffectDescriptors(migrated)
  }
  if (migrated.schemaVersion === 10) {
    migrated = migrateClipSourceTimeMaps(migrated)
  }
  if (migrated.schemaVersion === 11) {
    migrated = migrateClipSpeedCurves(migrated)
  }
  if (migrated.schemaVersion === 12) {
    migrated = migrateEffectAnimationTracks(migrated)
  }
  if (migrated.schemaVersion === 13) {
    migrated = migrateManualLensCorrection(migrated)
  }
  if (migrated.schemaVersion === 14) {
    migrated = migrateAdjustmentItems(migrated)
  }
  if (migrated.schemaVersion === 15) {
    migrated = migrateClipAudioAutomation(migrated)
  }
  if (migrated.schemaVersion === 16) {
    migrated = migrateAudioMixer(migrated)
  }
  if (migrated.schemaVersion === 17) {
    migrated = migrateAudioEffectStacks(migrated)
  }
  if (migrated.schemaVersion === 18) {
    migrated = migrateSequenceInstances(migrated)
  }
  if (migrated.schemaVersion === 19) {
    migrated = migrateMulticamInstances(migrated)
  }
  boundedArray(migrated.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = migrated.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clip = record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        )
        return typeof clip.assetId === 'string'
          ? {
              ...clip,
              assetId: migrateLegacyProceduralTextAssetId(clip.assetId),
            }
          : clip
      }),
    }
  })
  return { ...migrated, tracks }
}

function migrateLegacyAssetBounds(assetsValue: unknown): JsonRecord[] {
  boundedArray(assetsValue, '$.assets', PROJECT_FILE_LIMITS.maxAssets)
  return assetsValue.map((assetValue, index) => {
    const asset = record(assetValue, `$.assets[${index}]`)
    const hasVideo = asset.kind === 'video'
    const hasAudio = asset.hasAudio === true
    return {
      ...asset,
      sourceBounds: {
        video: hasVideo ? { status: 'unknown' } : null,
        audio: hasAudio ? { status: 'unknown' } : null,
      },
    }
  })
}

/**
 * Upgrade a parsed historical value into the current format. Outer version 4
 * added durable stream bounds, version 5 added Media Pool collections, and
 * version 6 wraps the unchanged historical document as the sole root sequence;
 * version 7 adds project-owned multicam definitions.
 * Nested migrations remain independently versioned on TimelineDoc.
 */
export function migrateProjectFile(value: unknown): unknown {
  const project = record(value, '$')
  if (
    project.format !== PROJECT_FILE_FORMAT
    && project.format !== LEGACY_PROJECT_FILE_FORMAT
  ) {
    fail(
      '$.format',
      `expected ${PROJECT_FILE_FORMAT} or legacy ${LEGACY_PROJECT_FILE_FORMAT}`,
    )
  }
  const brandedProject = project.format === LEGACY_PROJECT_FILE_FORMAT
    ? { ...project, format: PROJECT_FILE_FORMAT }
    : project
  safeInteger(brandedProject.formatVersion, '$.formatVersion', 1)
  if (brandedProject.formatVersion > CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported future project format ${brandedProject.formatVersion}`)
  }
  if (
    brandedProject.formatVersion < 5
    && Object.prototype.hasOwnProperty.call(brandedProject, 'collections')
  ) {
    fail('$.collections', 'unknown field for this project format')
  }
  if (
    brandedProject.formatVersion < 7
    && Object.prototype.hasOwnProperty.call(brandedProject, 'multicams')
  ) fail('$.multicams', 'unknown field for this project format')
  switch (brandedProject.formatVersion) {
    case 1:
    case 2:
    case 3: {
      const assets = migrateLegacyAssetBounds(brandedProject.assets)
      const document = migrateTimelineDocument(brandedProject.document, assets)
      const { document: _legacyDocument, ...outer } = brandedProject
      return {
        ...outer,
        formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
        id: document.id,
        name: document.name,
        rootSequenceId: document.id,
        sequences: [document],
        multicams: [],
        assets,
        collections: [],
      }
    }
    case 4: {
      const document = migrateTimelineDocument(
        brandedProject.document,
        brandedProject.assets,
      )
      const { document: _legacyDocument, ...outer } = brandedProject
      return {
        ...outer,
        formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
        id: document.id,
        name: document.name,
        rootSequenceId: document.id,
        sequences: [document],
        multicams: [],
        collections: [],
      }
    }
    case 5: {
      const document = migrateTimelineDocument(
        brandedProject.document,
        brandedProject.assets,
      )
      const { document: _legacyDocument, ...outer } = brandedProject
      return {
        ...outer,
        formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
        id: document.id,
        name: document.name,
        rootSequenceId: document.id,
        sequences: [document],
        multicams: [],
      }
    }
    case 6:
      boundedArray(
        brandedProject.sequences,
        '$.sequences',
        PROJECT_FILE_LIMITS.maxSequences,
      )
      return {
        ...brandedProject,
        formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
        multicams: [],
        sequences: brandedProject.sequences.map((sequence) => (
          migrateTimelineDocument(sequence, brandedProject.assets)
        )),
      }
    case CURRENT_PROJECT_FORMAT_VERSION:
      boundedArray(
        brandedProject.sequences,
        '$.sequences',
        PROJECT_FILE_LIMITS.maxSequences,
      )
      return {
        ...brandedProject,
        sequences: brandedProject.sequences.map((sequence) => (
          migrateTimelineDocument(sequence, brandedProject.assets)
        )),
      }
    default:
      return fail(
        '$.formatVersion',
        `unsupported project format ${brandedProject.formatVersion}`,
      )
  }
}
