import { describe, expect, test } from 'vitest'
import type {
  Clip,
  EffectDescriptor,
  SourceTimeSpeedPoint,
  TimelineDoc,
  Track,
} from './schema'
import { PROJECT_ASPECT_RATIO_PRESETS } from './projectSettings'
import { defaultTextProps, proceduralTextAssetId } from './textOverlay'
import {
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from './clipInspector'
import { defaultClipAnimation } from './clipAnimation'
import { defaultSourceTimeMap } from './sourceTimeMap'
import {
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_EFFECT_VERSION,
} from './effectStack'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TIMELINE_SCHEMA_VERSION,
  createProjectFileSnapshot,
  hasSupportedProjectFileExtension,
  LEGACY_PROJECT_FILE_FORMAT,
  parseProjectFile,
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_LIMITS,
  ProjectFileError,
  serializeProjectFile,
  type PortableAssetDescriptor,
  type ProjectFile,
  validateProjectFile,
} from './projectFile'
import { EFFECT_STACK_LIMITS } from './effectBounds'
import { pluginEffectType } from './pluginManifest'
import { dynamicZoomRequestFromPreset } from './dynamicZoom'
import { addEffect, applyDynamicZoom, updateEffectParams } from './operations'
import {
  DEFAULT_MANUAL_LENS_CORRECTION,
  type LensCorrectionIntent,
} from './lensCorrection'
import {
  duplicateProjectSequence,
  type SequenceEntityKind,
} from './projectSequences'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function removeSourceMode(clip: Clip): void {
  Reflect.deleteProperty(clip, 'sourceMode')
}

function mediaClip(
  id: string,
  assetId: string,
  timelineStart: number,
  sourceStart: number,
  duration: number,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
    sourceTimeMap: defaultSourceTimeMap(sourceStart, duration),
    timelineRange: { startFrame: timelineStart, durationFrames: duration },
    transform: {
      x: 12.5,
      y: -8,
      scaleX: 1.25,
      scaleY: 0.75,
      rotation: 7.5,
      anchorX: 0.4,
      anchorY: 0.6,
    },
    opacity: 0.8,
    blendMode: 'normal',
    volume: 1.25,
    lensCorrection: null,
    visual: {
      ...defaultClipVisualSettings(),
      crop: { left: 0.1, right: 0.05, top: 0.02, bottom: 0.03 },
      flipHorizontal: true,
      scaleLocked: false,
    },
    audio: {
      ...defaultClipAudioSettings(),
      balance: -0.25,
      fadeInFrames: Math.min(2, duration),
      fadeOutFrames: Math.min(3, duration),
    },
    animation: defaultClipAnimation(),
    effects: [],
    audioEffects: [],
  }
}

function track(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
): Track {
  return {
    id,
    kind,
    name: `${id} lane`,
    clips,
    sequenceInstances: [],
    adjustments: [],
    transitions: [],
    hidden: kind === 'video',
    muted: kind === 'audio',
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
    audioEffects: [],
  }
}

function makeAssets(): PortableAssetDescriptor[] {
  return [
    {
      id: 'video-z',
      fileName: 'camera.mov',
      mimeType: 'video/quicktime',
      size: 12_345_678,
      lastModified: 1_725_000_000_000,
      kind: 'video',
      durationMicroseconds: 8_000_000,
      sourceBounds: {
        video: { status: 'exact', firstTimestampUs: -10_000, endTimestampUs: 8_000_000 },
        audio: { status: 'exact', firstTimestampUs: 20_000, endTimestampUs: 7_950_000 },
      },
      nativeFrameRate: { num: 60_000, den: 1_001 },
      width: 3_840,
      height: 2_160,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
    },
    {
      id: 'image-a',
      fileName: 'title.png',
      mimeType: 'image/png',
      size: 45_678,
      lastModified: 1_725_000_000_001,
      kind: 'image',
      durationMicroseconds: 10_000_000,
      sourceBounds: { video: null, audio: null },
      nativeFrameRate: null,
      width: 1_920,
      height: 1_080,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    },
  ]
}

function makeDocument(): TimelineDoc {
  const first = mediaClip('clip-a', 'video-z', 0, 5, 10)
  first.linkGroupId = 'linked-av'
  first.effects = [
    {
      id: 'effect-color',
      type: 'color-correction',
      version: 1,
      enabled: true,
      params: { amount: 0.5, mode: 'soft', preserveHighlights: true },
    },
  ]
  const second = mediaClip('clip-b', 'video-z', 10, 15, 10)
  const title = mediaClip(
    'clip-title',
    proceduralTextAssetId('clip-title'),
    24,
    0,
    20,
  )
  title.text = {
    ...defaultTextProps(1920, 1080),
    content: 'A portable title',
    fontFamily: 'system-ui',
    fontSizePx: 72,
    color: '#f5f5f5',
    align: 'center',
    bold: true,
    italic: false,
  }
  const video = track('V1', 'video', [first, second, title])
  video.transitions = [
    {
      id: 'transition-ab',
      type: 'crossfade',
      fromClipId: 'clip-a',
      toClipId: 'clip-b',
      durationFrames: 4,
      audio: { enabled: true, curve: 'equal-power' },
    },
  ]
  const audioClip = mediaClip('clip-audio', 'video-z', 0, 5, 10)
  audioClip.linkGroupId = 'linked-av'
  const audio = track('A1', 'audio', [audioClip])
  audio.solo = true
  audio.locked = true

  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'project-123',
    name: 'Portable edit',
    frameRate: { num: 30_000, den: 1_001 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [video, audio],
    markers: [],
    captionTracks: [],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  }
}

function makeProject(): ProjectFile {
  const document = makeDocument()
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    id: document.id,
    name: document.name,
    rootSequenceId: document.id,
    sequences: [document],
    assets: makeAssets(),
    collections: [],
  }
}

function makeMultiSequenceProject(): ProjectFile {
  const project = makeProject()
  let index = 0
  const duplicated = duplicateProjectSequence(
    project,
    project.rootSequenceId,
    'Alternate cut',
    (kind: SequenceEntityKind) => `alternate_${kind}_${++index}`,
  )
  if (duplicated.failure) throw new Error(duplicated.failure)
  return {
    ...project,
    ...duplicated.project,
  }
}

function makeOuterLegacyProject(formatVersion: 1 | 2 | 3 | 4 | 5): {
  format: string
  formatVersion: number
  document: TimelineDoc
  assets: Array<Record<string, unknown>>
  collections?: unknown
} {
  const current = clone(makeProject())
  return {
    format: current.format,
    formatVersion,
    document: current.sequences[0],
    assets: current.assets as unknown as Array<Record<string, unknown>>,
    ...(formatVersion >= 5 ? { collections: current.collections } : {}),
  }
}

describe('portable project file', () => {
  test('uses the shared durable document name and id limits', () => {
    expect(PROJECT_FILE_LIMITS.maxIdCharacters).toBe(MAX_DOCUMENT_ID_CHARACTERS)
    expect(PROJECT_FILE_LIMITS.maxNameCharacters).toBe(MAX_PROJECT_NAME_CHARACTERS)
  })

  test('round-trips every durable edit field and portable asset metadata', () => {
    const original = makeProject()
    original.collections = [
      { id: 'collection-selects', name: 'Selects', assetIds: ['video-z', 'image-a'] },
      { id: 'collection-broll', name: 'B-roll', assetIds: ['video-z'] },
    ]
    original.sequences[0].markers = [
      { id: 'marker-intro', frame: 0, label: 'Intro', color: 'blue' },
      {
        id: 'marker-beat',
        frame: 240,
        label: 'Beat drop',
        color: 'purple',
        note: 'Cut on the kick',
      },
    ]
    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.format).toBe('myrelith-project')
    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0]).toEqual(original.sequences[0])
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['image-a', 'video-z'])
    expect(parsed.assets.find((asset) => asset.id === 'video-z')).toEqual(original.assets[0])
    expect(parsed.collections).toEqual(original.collections)
    expect(parsed.sequences[0].tracks[0].clips[0]).toMatchObject({
      effects: original.sequences[0].tracks[0].clips[0].effects,
      linkGroupId: 'linked-av',
      transform: original.sequences[0].tracks[0].clips[0].transform,
    })
    expect(parsed.sequences[0].tracks[0].clips[2].text).toEqual(
      original.sequences[0].tracks[0].clips[2].text,
    )
    expect(parsed.sequences[0].tracks[0].transitions).toEqual(
      original.sequences[0].tracks[0].transitions,
    )
    expect(parsed.sequences[0].markers).toEqual(original.sequences[0].markers)
  })

  test('migrates the last single-document format into its byte-equivalent sole root', () => {
    const legacy = makeOuterLegacyProject(5)
    const originalDocument = clone(legacy.document)
    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed).toMatchObject({
      formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
      id: originalDocument.id,
      name: originalDocument.name,
      rootSequenceId: originalDocument.id,
    })
    expect(parsed.sequences).toHaveLength(1)
    expect(parsed.sequences[0]).toEqual(originalDocument)
  })

  test('round-trips multiple definitions in deterministic order with one asset catalog', () => {
    const original = makeMultiSequenceProject()
    original.sequences[1].markers = [{
      id: 'alternate-marker',
      frame: 12,
      label: 'Alt beat',
      color: 'orange',
    }]
    original.rootSequenceId = original.sequences[1].id

    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.sequences.map((sequence) => sequence.id)).toEqual(
      original.sequences.map((sequence) => sequence.id),
    )
    expect(parsed.sequences).toEqual(original.sequences)
    expect(parsed.rootSequenceId).toBe(original.sequences[1].id)
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['image-a', 'video-z'])
    expect(new Set(parsed.assets.map((asset) => asset.id))).toEqual(
      new Set(original.assets.map((asset) => asset.id)),
    )
  })

  test('rejects hostile dormant definitions and project-wide id collisions', () => {
    const missingRoot = makeMultiSequenceProject()
    missingRoot.rootSequenceId = 'missing-sequence'
    expect(() => validateProjectFile(missingRoot)).toThrow(/missing root sequence/i)

    const mixedSettings = makeMultiSequenceProject()
    mixedSettings.sequences[1].width = 1280
    expect(() => validateProjectFile(mixedSettings)).toThrow(/settings must match/i)

    const duplicateTrack = makeMultiSequenceProject()
    duplicateTrack.sequences[1].tracks[0].id = duplicateTrack.sequences[0].tracks[0].id
    expect(() => validateProjectFile(duplicateTrack)).toThrow(/duplicate track id/i)

    const duplicateLinkGroup = makeMultiSequenceProject()
    duplicateLinkGroup.sequences[1].tracks[0].clips[0].linkGroupId = 'linked-av'
    duplicateLinkGroup.sequences[1].tracks[1].clips[0].linkGroupId = 'linked-av'
    expect(() => validateProjectFile(duplicateLinkGroup)).toThrow(/duplicate link group id/i)

    const danglingDormantAsset = makeMultiSequenceProject()
    danglingDormantAsset.sequences[1].tracks[0].clips[0].assetId = 'missing-asset'
    expect(() => validateProjectFile(danglingDormantAsset)).toThrow(/unknown asset/i)

    const tooManySequences = makeProject()
    tooManySequences.sequences = Array.from(
      { length: PROJECT_FILE_LIMITS.maxSequences + 1 },
      (_, index) => ({ ...tooManySequences.sequences[0], id: `sequence-${index}` }),
    )
    expect(() => validateProjectFile(tooManySequences)).toThrow(/exceeds 256 entries/i)
  })

  test('migrates schema-9 through versioned effects and exact 1x maps without changing intent', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 9
    legacy.sequences[0].tracks[0].clips[0].animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 2, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const originalRanges = legacy.sequences[0].tracks.flatMap((item) => item.clips).map(
      (clip) => ({ sourceRange: clip.sourceRange, timelineRange: clip.timelineRange }),
    )
    for (const legacyTrack of legacy.sequences[0].tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'sourceTimeMap')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const clips = parsed.sequences[0].tracks.flatMap((item) => item.clips)

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(clips.map((clip) => ({
      sourceRange: clip.sourceRange,
      timelineRange: clip.timelineRange,
    }))).toEqual(originalRanges)
    expect(clips.map((clip) => clip.sourceTimeMap)).toEqual(
      clips.map((clip) => defaultSourceTimeMap(
        clip.sourceRange.startFrame,
        clip.sourceRange.durationFrames,
      )),
    )
    expect(clips[0].animation?.tracks[0].keyframes[0]).toMatchObject({
      frame: 2,
      sourceTimeTicks: 7_000_000,
    })
  })

  test('migrates schema-10 effect documents through schema-12 speed-curve intent', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 10
    legacy.sequences[0].tracks[0].clips[0].animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 2, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const effects = clone(legacy.sequences[0].tracks[0].clips[0].effects)
    for (const legacyTrack of legacy.sequences[0].tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'sourceTimeMap')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks[0].clips[0].effects).toEqual(effects)
    expect(parsed.sequences[0].tracks[0].clips[0].sourceTimeMap).toEqual(
      defaultSourceTimeMap(5, 10),
    )
    expect(parsed.sequences[0].tracks[0].clips[0].animation?.tracks[0].keyframes[0])
      .toMatchObject({ frame: 2, sourceTimeTicks: 7_000_000 })
  })

  test('round-trips a non-unity rational source-time map exactly', () => {
    const project = makeProject()
    const retimed = project.sequences[0].tracks[0].clips[1]
    retimed.timelineRange = { startFrame: 10, durationFrames: 5 }
    retimed.sourceTimeMap = {
      sourceStartTicks: 15_000_000,
      sourceDurationTicks: 10_000_000,
      rate: { numerator: 2, denominator: 1 },
      speedCurve: { originFrame: 0, points: [] },
    }

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.sequences[0].tracks[0].clips[1]).toMatchObject({
      sourceRange: { startFrame: 15, durationFrames: 10 },
      timelineRange: { startFrame: 10, durationFrames: 5 },
      sourceTimeMap: {
        sourceStartTicks: 15_000_000,
        sourceDurationTicks: 10_000_000,
        rate: { numerator: 2, denominator: 1 },
        speedCurve: { originFrame: 0, points: [] },
      },
    })
  })

  test('migrates schema-11 constant retiming to an explicit empty speed curve', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 11
    for (const legacyTrack of legacy.sequences[0].tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip.sourceTimeMap ?? {}, 'speedCurve')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    for (const parsedClip of parsed.sequences[0].tracks.flatMap((item) => item.clips)) {
      expect(parsedClip.sourceTimeMap?.speedCurve).toEqual({ originFrame: 0, points: [] })
    }
  })

  test('migrates schema-12 clips with omitted animation to canonical effect tracks', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 12
    for (const clip of legacy.sequences[0].tracks.flatMap((track) => track.clips)) {
      Reflect.deleteProperty(clip, 'animation')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks.flatMap((track) => track.clips).map((clip) => clip.animation))
      .toEqual(parsed.sequences[0].tracks.flatMap((track) => track.clips).map(() => ({
        tracks: [],
        effectTracks: [],
      })))
  })

  test('migrates schema-13 clips to explicit absent manual lens correction', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 13
    for (const clip of legacy.sequences[0].tracks.flatMap((track) => track.clips)) {
      Reflect.deleteProperty(clip, 'lensCorrection')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks.flatMap((track) => track.clips).map(
      (clip) => clip.lensCorrection,
    )).toEqual(parsed.sequences[0].tracks.flatMap((track) => track.clips).map(() => null))
  })

  test('migrates schema-14 documents to schema 15 without rewriting clips', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 14
    const before = JSON.stringify(
      legacy.sequences[0].tracks.flatMap((item) => item.clips),
    )

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(JSON.stringify(parsed.sequences[0].tracks.flatMap((item) => item.clips)))
      .toBe(before)
  })

  test('migrates schema-15 documents through schema 18 with mixer defaults', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 15
    for (const item of legacy.sequences[0].tracks) {
      Reflect.deleteProperty(item, 'volume')
      Reflect.deleteProperty(item, 'balance')
    }
    Reflect.deleteProperty(legacy.sequences[0], 'masterAudio')

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].masterAudio).toEqual({
      volume: 1,
      balance: 0,
      muted: false,
      audioEffects: [],
    })
    expect(parsed.sequences[0].tracks.map((item) => ({
      id: item.id,
      volume: item.volume,
      balance: item.balance,
    }))).toEqual([
      { id: 'V1', volume: 1, balance: 0 },
      { id: 'A1', volume: 1, balance: 0 },
    ])
  })

  test('migrates schema-16 documents through schema 18 with empty audio-effect stacks', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 16
    for (const item of legacy.sequences[0].tracks) {
      Reflect.deleteProperty(item, 'audioEffects')
      for (const clip of item.clips) {
        Reflect.deleteProperty(clip, 'audioEffects')
      }
    }
    if (legacy.sequences[0].masterAudio) {
      Reflect.deleteProperty(legacy.sequences[0].masterAudio, 'audioEffects')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].masterAudio?.audioEffects).toEqual([])
    expect(parsed.sequences[0].tracks.every((item) => item.audioEffects?.length === 0)).toBe(true)
    expect(
      parsed.sequences[0].tracks.every((item) =>
        item.clips.every((clip) => clip.audioEffects?.length === 0),
      ),
    ).toBe(true)
  })

  test('migrates schema-17 mixer documents to schema 18 audio-effect stacks', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 17
    for (const item of legacy.sequences[0].tracks) {
      Reflect.deleteProperty(item, 'audioEffects')
      for (const clip of item.clips) Reflect.deleteProperty(clip, 'audioEffects')
    }
    if (legacy.sequences[0].masterAudio) {
      Reflect.deleteProperty(legacy.sequences[0].masterAudio, 'audioEffects')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].masterAudio?.audioEffects).toEqual([])
    expect(parsed.sequences[0].tracks.every((item) => item.audioEffects?.length === 0)).toBe(true)
    expect(parsed.sequences[0].tracks.every((item) => (
      item.clips.every((clip) => clip.audioEffects?.length === 0)
    ))).toBe(true)
  })

  test('round-trips authored clip, track, and master audio-effect stacks including unknown types', () => {
    const project = makeProject()
    const unknown = {
      id: 'afx-future',
      type: 'future.exciter',
      version: 9,
      enabled: false,
      params: { sparkle: 0.4, keep: true },
    }
    project.sequences[0].tracks[1].clips[0].audioEffects = [{
      id: 'afx-clip-eq',
      type: 'builtin.eq',
      version: 1,
      enabled: true,
      params: {
        band1Type: 'lowshelf',
        band1Freq: 80,
        band1Q: 0.7,
        band1Gain: -1.5,
        band2Type: 'peak',
        band2Freq: 400,
        band2Q: 1,
        band2Gain: 0,
        band3Type: 'peak',
        band3Freq: 2500,
        band3Q: 1,
        band3Gain: 2,
        band4Type: 'highshelf',
        band4Freq: 8000,
        band4Q: 0.7,
        band4Gain: 0,
      },
    }]
    project.sequences[0].tracks[1].audioEffects = [unknown]
    project.sequences[0].masterAudio = {
      volume: 1,
      balance: 0,
      muted: false,
      audioEffects: [{
        id: 'afx-master-lim',
        type: 'builtin.limiter',
        version: 1,
        enabled: true,
        params: { ceilingDb: -1, releaseMs: 80 },
      }],
    }

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.sequences[0].tracks[1].clips[0].audioEffects).toEqual(
      project.sequences[0].tracks[1].clips[0].audioEffects,
    )
    expect(parsed.sequences[0].tracks[1].audioEffects).toEqual([unknown])
    expect(parsed.sequences[0].masterAudio?.audioEffects).toEqual(
      project.sequences[0].masterAudio?.audioEffects,
    )
  })

  test('round-trips authored track and master mixer fields', () => {
    const project = makeProject()
    project.sequences[0].tracks[1].volume = 0.4
    project.sequences[0].tracks[1].balance = -0.5
    project.sequences[0].masterAudio = {
      volume: 1.25,
      balance: 0.25,
      muted: true,
      audioEffects: [],
    }

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.sequences[0].tracks[1].volume).toBe(0.4)
    expect(parsed.sequences[0].tracks[1].balance).toBe(-0.5)
    expect(parsed.sequences[0].masterAudio).toEqual({
      volume: 1.25,
      balance: 0.25,
      muted: true,
      audioEffects: [],
    })
  })

  test('round-trips volume and balance animation tracks on audio clips', () => {
    const project = makeProject()
    project.sequences[0].tracks[1].clips[0].animation = {
      tracks: [{
        property: 'volume',
        keyframes: [
          {
            frame: 0,
            sourceTimeTicks: 0,
            value: 0,
            easing: { type: 'linear' },
          },
          {
            frame: 4,
            sourceTimeTicks: 4_000_000,
            value: 1,
            easing: { type: 'linear' },
          },
        ],
      }],
      effectTracks: [],
    }

    const parsed = parseProjectFile(serializeProjectFile(project))
    expect(parsed.sequences[0].tracks[1].clips[0].animation).toEqual(
      project.sequences[0].tracks[1].clips[0].animation,
    )
  })

  test('round-trips supported and bounded future lens intent without substitution', () => {
    const supported = makeProject()
    supported.sequences[0].tracks[0].clips[0].lensCorrection = {
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      k1: 0.16,
      k2: 0.025,
      outputScale: 1.24,
    }
    expect(parseProjectFile(serializeProjectFile(supported)).sequences[0].tracks[0]
      .clips[0].lensCorrection).toEqual(supported.sequences[0].tracks[0].clips[0].lensCorrection)

    const future = makeProject()
    const futureIntent = {
      version: 2,
      solver: 'future-grid',
      calibration: { points: [[0.1, 0.2], [0.8, 0.7]], exact: true },
    }
    future.sequences[0].tracks[0].clips[0].lensCorrection = futureIntent
    const parsed = parseProjectFile(serializeProjectFile(future))
    expect(parsed.sequences[0].tracks[0].clips[0].lensCorrection).toEqual(futureIntent)
    expect(parsed.sequences[0].tracks[0].clips[0].lensCorrection)
      .not.toBe(future.sequences[0].tracks[0].clips[0].lensCorrection)
  })

  test('preserves magic keys in bounded future lens intent', () => {
    const future = makeProject()
    const futureIntent = JSON.parse(
      '{"version":2,"__proto__":{"calibration":"future"}}',
    ) as LensCorrectionIntent
    future.sequences[0].tracks[0].clips[0].lensCorrection = futureIntent

    const parsed = parseProjectFile(serializeProjectFile(future))
    const parsedIntent = parsed.sequences[0].tracks[0].clips[0].lensCorrection as
      Record<string, unknown>

    expect(Object.prototype.hasOwnProperty.call(parsedIntent, '__proto__')).toBe(true)
    expect(parsedIntent.__proto__).toEqual({ calibration: 'future' })
  })

  test('rejects invalid v1 and unbounded future lens intent', () => {
    const invalidV1 = makeProject()
    invalidV1.sequences[0].tracks[0].clips[0].lensCorrection = {
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      outputScale: 0.5,
    }
    expect(() => validateProjectFile(invalidV1)).toThrow(/output scale/i)

    const tooDeep = makeProject()
    let nested: Record<string, unknown> = { terminal: true }
    for (let depth = 0; depth <= PROJECT_FILE_LIMITS.maxLensIntentDepth; depth++) {
      nested = { nested }
    }
    tooDeep.sequences[0].tracks[0].clips[0].lensCorrection = {
      version: 2,
      nested,
    }
    expect(() => validateProjectFile(tooDeep)).toThrow(/nested levels/i)
  })

  test('requires bounded effect tracks in current saves while retaining dangling intent', () => {
    const current = makeProject()
    current.sequences[0].tracks[0].clips[0].animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'future-effect',
        parameter: 'future-scalar',
        keyframes: [{
          frame: 0,
          sourceTimeTicks: 5_000_000,
          value: 42,
          easing: { type: 'linear' },
        }],
      }],
    }
    const parsed = parseProjectFile(serializeProjectFile(current))
    expect(parsed.sequences[0].tracks[0].clips[0].animation?.effectTracks)
      .toEqual(current.sequences[0].tracks[0].clips[0].animation.effectTracks)

    const missing = clone(current)
    Reflect.deleteProperty(missing.sequences[0].tracks[0].clips[0].animation!, 'effectTracks')
    expect(() => validateProjectFile(missing)).toThrow(/missing field effectTracks/)

    const overlong = clone(current)
    overlong.sequences[0].tracks[0].clips[0].animation!.effectTracks![0].parameter = 'x'.repeat(
      PROJECT_FILE_LIMITS.maxNameCharacters + 1,
    )
    expect(() => validateProjectFile(overlong)).toThrow(/exceeds/)
  })

  test('counts effect keyframes against the global portable-project budget', () => {
    const current = makeProject()
    const fullTrackCount = Math.floor(PROJECT_FILE_LIMITS.maxTotalKeyframes / 1_024)
    const remainingKeyframes = PROJECT_FILE_LIMITS.maxTotalKeyframes
      - (fullTrackCount * 1_024)
      + 1
    current.sequences[0].tracks[0].clips[0].animation = {
      tracks: [],
      effectTracks: Array.from(
        { length: fullTrackCount + 1 },
        (_unused, trackIndex) => ({
          effectId: 'future-effect',
          parameter: `future-scalar-${trackIndex}`,
          keyframes: Array.from(
            { length: trackIndex === fullTrackCount ? remainingKeyframes : 1_024 },
            (_keyframe, frame) => ({
              frame,
              sourceTimeTicks: frame * 1_000_000,
              value: frame,
              easing: { type: 'linear' as const },
            }),
          ),
        }),
      ),
    }

    expect(() => validateProjectFile(current))
      .toThrow(`exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`)
  })

  test('round-trips a deterministic piecewise speed curve exactly', () => {
    const project = makeProject()
    const retimed = project.sequences[0].tracks[0].clips[1]
    retimed.sourceTimeMap = {
      ...retimed.sourceTimeMap!,
      speedCurve: {
        originFrame: -2,
        points: [
          { frame: -2, rate: { numerator: 1, denominator: 1 }, easing: 'linear' },
          { frame: 0, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 2, rate: { numerator: 2, denominator: 1 }, easing: 'smooth' },
          { frame: 4, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    }

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.sequences[0].tracks[0].clips[1].sourceTimeMap).toEqual(
      retimed.sourceTimeMap,
    )
  })

  test.each([
    {
      label: 'duplicate point frames',
      points: [
        { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        { frame: 0, rate: { numerator: 2, denominator: 1 }, easing: 'linear' },
      ] satisfies SourceTimeSpeedPoint[],
      message: /strictly increasing|duplicate/i,
    },
    {
      label: 'an unbounded terminal freeze',
      points: [
        { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        { frame: 2, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
      ] satisfies SourceTimeSpeedPoint[],
      message: /final.*positive|finite/i,
    },
    {
      label: 'an out-of-bounds point frame',
      points: [
        { frame: 1_000_000_001, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
      ] satisfies SourceTimeSpeedPoint[],
      message: /bounded|range|frame/i,
    },
  ])('rejects $label without mutating the input', ({ points, message }) => {
    const project = makeProject()
    project.sequences[0].tracks[0].clips[1].sourceTimeMap!.speedCurve = {
      originFrame: 0,
      points,
    }
    const before = clone(project)

    expect(() => validateProjectFile(project)).toThrow(message)
    expect(project).toEqual(before)
  })

  test('migrates schema-6 projects to explicit empty marker defaults', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 6
    Reflect.deleteProperty(legacy.sequences[0], 'markers')

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].markers).toEqual([])
  })

  test('migrates schema-7 projects through caption and blend defaults', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 7
    Reflect.deleteProperty(legacy.sequences[0], 'captionTracks')
    for (const legacyTrack of legacy.sequences[0].tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'blendMode')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].captionTracks).toEqual([])
    expect(parsed.sequences[0].tracks.flatMap((item) => item.clips).map((item) => item.blendMode))
      .toEqual(['normal', 'normal', 'normal', 'normal'])
  })

  test('migrates schema-8 captions intact while adding normal blend intent', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 8
    legacy.sequences[0].captionTracks = [{
      id: 'captions-en',
      name: 'English CC',
      language: 'en-US',
      role: 'captions',
      stylePreset: 'boxed',
      hidden: false,
      items: [
        { id: 'caption-a', range: { startFrame: 3, durationFrames: 20 }, text: 'Hello' },
      ],
    }]
    for (const legacyTrack of legacy.sequences[0].tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'blendMode')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].captionTracks).toEqual(legacy.sequences[0].captionTracks)
    expect(parsed.sequences[0].tracks.flatMap((item) => item.clips).map((item) => item.blendMode))
      .toEqual(['normal', 'normal', 'normal', 'normal'])
  })

  test('migrates schema-9 effect descriptors and preserves opaque legacy payloads', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 9
    legacy.sequences[0].tracks[0].clips[0].effects = [
      {
        id: 'effect-owned',
        type: COLOR_ADJUST_EFFECT_TYPE,
        version: 0,
        enabled: true,
        params: { exposure: 1, futureKnob: 'keep-owned-extra' },
      },
      {
        id: 'effect-future',
        type: 'future.sparkle',
        version: 0,
        enabled: false,
        params: { seed: 42, mode: 'prismatic', preserveAlpha: true },
      },
    ]
    for (const effect of legacy.sequences[0].tracks[0].clips[0].effects) {
      Reflect.deleteProperty(effect, 'version')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks[0].clips[0].effects).toEqual([
      {
        id: 'effect-owned',
        type: COLOR_ADJUST_EFFECT_TYPE,
        version: COLOR_ADJUST_EFFECT_VERSION,
        enabled: true,
        params: {
          exposure: 1,
          contrast: 0,
          saturation: 0,
          temperature: 0,
          tint: 0,
          futureKnob: 'keep-owned-extra',
        },
      },
      {
        id: 'effect-future',
        type: 'future.sparkle',
        version: 0,
        enabled: false,
        params: { seed: 42, mode: 'prismatic', preserveAlpha: true },
      },
    ])
  })

  test('round-trips unknown effect type, version, order, and payload without substitution', () => {
    const original = makeProject()
    const effects: EffectDescriptor[] = [
      {
        id: 'effect-future-a',
        type: 'future.sparkle',
        version: 17,
        enabled: true,
        params: { seed: 42, mode: 'prismatic', preserveAlpha: true },
      },
      {
        id: 'effect-future-b',
        type: 'future.glow',
        version: 3,
        enabled: false,
        params: { radius: 12.5, colorSpace: 'oklab' },
      },
    ]
    original.sequences[0].tracks[0].clips[0].effects = effects

    const parsed = parseProjectFile(serializeProjectFile(original))
    expect(parsed.sequences[0].tracks[0].clips[0].effects).toEqual(effects)
  })

  test('preserves a disabled plugin descriptor without installing or executing it', () => {
    const original = makeProject()
    const descriptor: EffectDescriptor = {
      id: 'plugin-effect-sparkle',
      type: pluginEffectType('com.example.sparkle', 'sparkle'),
      version: 7,
      enabled: false,
      params: { strength: 0.5, mode: 'soft', preserveAlpha: true },
    }
    original.sequences[0].tracks[0].clips[0].effects = [descriptor]

    const serialized = serializeProjectFile(original)
    const parsed = parseProjectFile(serialized)
    expect(parsed.sequences[0].tracks[0].clips[0].effects).toEqual([descriptor])
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('.wasm')
  })

  test('keeps existing version-1 color descriptors valid without inventing new fields', () => {
    const original = makeProject()
    const existing: EffectDescriptor = {
      id: 'effect-existing-color',
      type: COLOR_ADJUST_EFFECT_TYPE,
      version: COLOR_ADJUST_EFFECT_VERSION,
      enabled: true,
      params: { exposure: 0.5, contrast: -0.2, saturation: 0.1 },
    }
    original.sequences[0].tracks[0].clips[0].effects = [existing]

    const parsed = parseProjectFile(serializeProjectFile(original))
    expect(parsed.sequences[0].tracks[0].clips[0].effects).toEqual([existing])
  })

  test('every accepted exact-limit live effect edit remains serializable', () => {
    const project = makeProject()
    const clip = project.sequences[0].tracks[0].clips[0]
    clip.effects = []
    const params: EffectDescriptor['params'] = Object.fromEntries(Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectParams },
      (_value, index) => [`parameter-${index}`, index],
    ))
    params['parameter-0'] = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    const edited = addEffect(project.sequences[0], clip.id, {
      id: 'i'.repeat(EFFECT_STACK_LIMITS.maxIdCharacters),
      type: 't'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters),
      version: Number.MAX_SAFE_INTEGER,
      enabled: true,
      params,
    })
    expect(edited).not.toBe(project.sequences[0])
    const acceptedProject = { ...project, sequences: [edited] }
    const serialized = serializeProjectFile(acceptedProject)
    expect(parseProjectFile(serialized).sequences[0]).toEqual(edited)

    const effectId = edited.tracks[0].clips[0].effects[0].id
    const rejected = updateEffectParams(edited, clip.id, effectId, { overflow: true })
    expect(rejected).toBe(edited)
    expect(() => serializeProjectFile({ ...project, sequences: [rejected] })).not.toThrow()
  })

  test('round-trips semantic captions and rejects malformed persisted cues', () => {
    const project = makeProject()
    project.sequences[0].captionTracks = [{
      id: 'captions-en',
      name: 'English CC',
      language: 'en-US',
      role: 'captions',
      stylePreset: 'boxed',
      hidden: false,
      items: [
        { id: 'caption-a', range: { startFrame: 3, durationFrames: 20 }, text: 'Hello' },
        { id: 'caption-b', range: { startFrame: 23, durationFrames: 10 }, text: 'World' },
      ],
    }]

    expect(parseProjectFile(serializeProjectFile(project)).sequences[0].captionTracks)
      .toEqual(project.sequences[0].captionTracks)

    const malformed = clone(project)
    malformed.sequences[0].captionTracks![0]!.items[0]!.text = '<b>Hello</b>'
    expect(() => validateProjectFile(malformed)).toThrow(/markup/u)
  })

  test('round-trips supported and unsupported blend intent without substitution', () => {
    const original = makeProject()
    original.sequences[0].tracks[0].clips[0].blendMode = 'multiply'
    original.sequences[0].tracks[0].clips[1].blendMode = 'future-soft-light'

    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.sequences[0].tracks[0].clips[0].blendMode).toBe('multiply')
    expect(parsed.sequences[0].tracks[0].clips[1].blendMode).toBe('future-soft-light')
  })

  test('rejects invalid, duplicate, and unsorted marker records', () => {
    const invalid = makeProject()
    invalid.sequences[0].markers = [
      { id: 'late', frame: 20, label: 'Late', color: 'yellow' },
      { id: 'early', frame: 10, label: 'Early', color: 'yellow' },
    ]
    expect(() => validateProjectFile(invalid)).toThrow(/sorted by frame then id/)

    const duplicate = makeProject()
    duplicate.sequences[0].markers = [
      { id: 'same', frame: 10, label: 'One', color: 'yellow' },
      { id: 'same', frame: 20, label: 'Two', color: 'red' },
    ]
    expect(() => validateProjectFile(duplicate)).toThrow(/duplicate marker id/)

    const badFrame = makeProject()
    badFrame.sequences[0].markers = [
      { id: 'bad', frame: 1.5, label: 'Bad', color: 'yellow' },
    ]
    expect(() => validateProjectFile(badFrame)).toThrow(/safe integer/)
  })

  test('migrates a legacy branded project and procedural text id', () => {
    const legacy = clone(makeProject()) as unknown as {
      format: string
      sequences: TimelineDoc[]
    }
    legacy.format = LEGACY_PROJECT_FILE_FORMAT
    legacy.sequences[0].tracks[0].clips[2].assetId = '__webcut_text__:clip-title'

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.format).toBe(PROJECT_FILE_FORMAT)
    expect(parsed.sequences[0].tracks[0].clips[2].assetId).toBe(
      '__myrelith_text__:clip-title',
    )
    expect(serializeProjectFile(parsed)).not.toContain('webcut')
  })

  test('recognizes current and legacy project filename extensions', () => {
    expect(hasSupportedProjectFileExtension('edit.myrelith')).toBe(true)
    expect(hasSupportedProjectFileExtension('EDIT.WEBCUT')).toBe(true)
    expect(hasSupportedProjectFileExtension('edit.json')).toBe(false)
  })

  test('round-trips keyframes and custom easing without changing order or precision', () => {
    const original = makeProject()
    original.sequences[0].tracks[0].clips[0].animation = {
      effectTracks: [],
      tracks: [
        {
          property: 'position-x',
          keyframes: [
            {
              frame: -5,
              sourceTimeTicks: 0,
              value: -125.25,
              easing: { type: 'hold' },
            },
            {
              frame: 12,
              sourceTimeTicks: 17_000_000,
              value: 240.75,
              easing: {
                type: 'cubic-bezier',
                x1: 0.42,
                y1: 0,
                x2: 0.58,
                y2: 1,
              },
            },
          ],
        },
        {
          property: 'opacity',
          keyframes: [{
            frame: 0,
            sourceTimeTicks: 5_000_000,
            value: 0.625,
            easing: { type: 'linear' },
          }],
        },
      ],
    }

    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.sequences[0].tracks[0].clips[0].animation)
      .toEqual(original.sequences[0].tracks[0].clips[0].animation)
  })

  test('round-trips dynamic zoom output as ordinary transform keyframes', () => {
    const original = makeProject()
    original.sequences[0] = applyDynamicZoom(
      original.sequences[0],
      'clip-a',
      { width: 3_840, height: 2_160 },
      dynamicZoomRequestFromPreset('reframe-left-right', 90),
    )
    const authored = original.sequences[0].tracks[0].clips[0].animation

    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(authored?.tracks.map(({ property }) => property)).toEqual([
      'position-x',
      'position-y',
      'scale-x',
      'scale-y',
    ])
    expect(parsed.sequences[0].tracks[0].clips[0].animation).toEqual(authored)
  })

  test('migrates schema-5 clips to canonical empty animation tracks', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 5
    for (const item of legacy.sequences[0].tracks.flatMap((track) => track.clips)) {
      Reflect.deleteProperty(item, 'animation')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks.flatMap((track) => track.clips)
      .every((item) => JSON.stringify(item.animation) === '{"tracks":[],"effectTracks":[]}'))
      .toBe(true)
  })

  test('rejects non-canonical duplicate times and invalid easing control points', () => {
    const duplicate = makeProject()
    duplicate.sequences[0].tracks[0].clips[0].animation = {
      effectTracks: [],
      tracks: [{
        property: 'position-x',
        keyframes: [
          { frame: 3, sourceTimeTicks: 8_000_000, value: 10, easing: { type: 'linear' } },
          { frame: 3, sourceTimeTicks: 8_000_000, value: 20, easing: { type: 'linear' } },
        ],
      }],
    }
    const badEasing = makeProject()
    badEasing.sequences[0].tracks[0].clips[0].animation = {
      effectTracks: [],
      tracks: [{
        property: 'position-x',
        keyframes: [{
          frame: 0,
          sourceTimeTicks: 5_000_000,
          value: 0,
          easing: { type: 'cubic-bezier', x1: -0.1, y1: 0, x2: 1, y2: 1 },
        }],
      }],
    }

    expect(() => validateProjectFile(duplicate)).toThrow(/strictly increasing/)
    expect(() => validateProjectFile(badEasing)).toThrow(/from 0 to 1/)
  })

  test('requires bounded durable source-time intent on current keyframes', () => {
    const missing = makeProject()
    missing.sequences[0].tracks[0].clips[0].animation = {
      effectTracks: [],
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 0, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const unsafe = clone(missing)
    unsafe.sequences[0].tracks[0].clips[0].animation!.tracks[0].keyframes[0]
      .sourceTimeTicks = Number.MAX_SAFE_INTEGER + 1
    const unknown = clone(missing)
    const unknownKeyframe = unknown.sequences[0].tracks[0].clips[0]
      .animation!.tracks[0].keyframes[0] as unknown as Record<string, unknown>
    unknownKeyframe.sourceTimeTicks = 5_000_000
    unknownKeyframe.futureTiming = true

    expect(() => validateProjectFile(missing)).toThrow(/sourceTimeTicks/)
    expect(() => validateProjectFile(unsafe)).toThrow(/sourceTimeTicks/)
    expect(() => validateProjectFile(unknown)).toThrow(/unknown field/)
  })

  test.each(
    PROJECT_ASPECT_RATIO_PRESETS
      .filter((aspectRatio) => aspectRatio.id !== 'horizontal-16-9')
      .flatMap((aspectRatio) => aspectRatio.resolutions.map((resolution) => ({
        aspectRatio: aspectRatio.ratioLabel,
        width: resolution.width,
        height: resolution.height,
      }))),
  )('round-trips a $aspectRatio $width × $height canvas without migration', ({
    width,
    height,
  }) => {
    const project = makeProject()
    project.sequences[0].width = width
    project.sequences[0].height = height

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].width).toBe(width)
    expect(parsed.sequences[0].height).toBe(height)
  })

  test('migrates v1 projects to the current format without inventing a partial-track choice', () => {
    const legacy = makeOuterLegacyProject(1)
    legacy.document.schemaVersion = 1
    for (const asset of legacy.assets) delete asset.partialTrackSelection
    for (const track of legacy.document.tracks) {
      for (const clip of track.clips) removeSourceMode(clip)
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.assets).toHaveLength(2)
    expect(
      parsed.assets.every((asset) => asset.partialTrackSelection === undefined),
    ).toBe(true)
    expect(
      parsed.sequences[0].tracks.flatMap((track) => track.clips)
        .every((clip) => clip.sourceMode === 'timed'),
    ).toBe(true)
    expect(parsed.sequences[0].tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('migrates v4 projects to an empty portable collection catalog', () => {
    const legacy = makeOuterLegacyProject(4)

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.collections).toEqual([])
  })

  test('migrates schema-4 clip Inspector defaults and preserves legacy scale signs as flips', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 4
    const first = legacy.sequences[0].tracks[0].clips[0]
    first.transform.scaleX = -1.5
    first.transform.scaleY = 0.75
    for (const track of legacy.sequences[0].tracks) {
      for (const clip of track.clips) {
        delete clip.visual
        delete clip.audio
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const migrated = parsed.sequences[0].tracks[0].clips[0]

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(migrated.transform).toMatchObject({ scaleX: 1.5, scaleY: 0.75 })
    expect(migrated.visual).toEqual({
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      flipHorizontal: true,
      flipVertical: false,
      scaleLocked: false,
    })
    expect(migrated.audio).toEqual(defaultClipAudioSettings())
    expect(parsed.sequences[0].tracks.flatMap((track) => track.clips).every(
      (clip) => clip.visual !== undefined && clip.audio !== undefined,
    )).toBe(true)
  })

  test('migrates v3 bounds and transition audio conservatively', () => {
    const legacy = makeOuterLegacyProject(3)
    legacy.document.schemaVersion = 2
    for (const asset of legacy.assets) delete asset.sourceBounds
    for (const track of legacy.document.tracks) {
      for (const transition of track.transitions) Reflect.deleteProperty(transition, 'audio')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.assets.find((asset) => asset.id === 'video-z')?.sourceBounds)
      .toEqual({
        video: { status: 'unknown' },
        audio: { status: 'unknown' },
      })
    expect(parsed.assets.find((asset) => asset.id === 'image-a')?.sourceBounds)
      .toEqual({ video: null, audio: null })
    expect(parsed.sequences[0].tracks[0].transitions[0].audio).toEqual({
      enabled: false,
      curve: 'equal-power',
    })
  })

  test('migrates dormant schema-3 text into a procedural bounded overlay', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 3
    const title = legacy.sequences[0].tracks[0].clips[2]
    title.assetId = 'image-a'
    title.text = {
      content: 'Legacy title',
      fontFamily: 'system-ui',
      fontSizePx: 72,
      color: '#f5f5f5',
      align: 'center',
      bold: true,
      italic: false,
    } as typeof title.text

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const migrated = parsed.sequences[0].tracks[0].clips[2]
    expect(migrated).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: {
        content: 'Legacy title',
        fontFamily: 'system-ui',
        boxWidthPx: 1248,
        boxHeightPx: 238,
        outlineEnabled: true,
        shadowEnabled: true,
      },
    })
  })

  test('rejects an unsupported legacy text font instead of substituting it', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 3
    const title = legacy.sequences[0].tracks[0].clips[2]
    title.assetId = 'image-a'
    title.text = {
      content: 'Legacy title',
      fontFamily: 'Inter' as 'sans-serif',
      fontSizePx: 72,
      color: '#f5f5f5',
      align: 'center',
      bold: true,
      italic: false,
    } as typeof title.text

    expect(() => parseProjectFile(JSON.stringify(legacy))).toThrow(
      /supported generic font family/,
    )
  })

  test('migrates a v2 image clip to one still source frame without changing its timeline', () => {
    const legacy = makeOuterLegacyProject(2)
    legacy.document.schemaVersion = 1
    const title = legacy.document.tracks[0].clips[2]
    delete title.text
    title.assetId = 'image-a'
    for (const track of legacy.document.tracks) {
      for (const clip of track.clips) removeSourceMode(clip)
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const migrated = parsed.sequences[0].tracks[0].clips[2]

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(migrated.sourceMode).toBe('still')
    expect(migrated.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(migrated.timelineRange).toEqual({
      startFrame: 24,
      durationFrames: 20,
    })
    expect(parsed.sequences[0].tracks[0].clips[0].sourceMode).toBe('timed')
  })

  test('migrates shipped v3 schema-1 documents by asset kind, including image-backed text', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 1
    const video = legacy.sequences[0].tracks[0].clips[0]
    const imageBackedText = legacy.sequences[0].tracks[0].clips[2]
    imageBackedText.assetId = 'image-a'
    video.sourceMode = 'still'
    imageBackedText.sourceMode = 'still'

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.sequences[0].tracks[0].clips[0]).toMatchObject({
      assetId: 'video-z',
      sourceMode: 'timed',
      sourceRange: { startFrame: 5, durationFrames: 10 },
    })
    expect(parsed.sequences[0].tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('migrates image-backed text beyond the nominal image duration', () => {
    const legacy = clone(makeProject())
    legacy.sequences[0].schemaVersion = 1
    const imageDescriptor = legacy.assets.find((asset) => asset.id === 'image-a')
    if (!imageDescriptor) throw new Error('missing image fixture')
    imageDescriptor.durationMicroseconds = 100_000
    const imageBackedText = legacy.sequences[0].tracks[0].clips[2]
    imageBackedText.assetId = 'image-a'
    removeSourceMode(imageBackedText)

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.sequences[0].tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      timelineRange: { startFrame: 24, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('round-trips explicit still source semantics in the current format', () => {
    const project = makeProject()
    const title = project.sequences[0].tracks[0].clips[2]
    delete title.text
    title.assetId = 'image-a'
    title.sourceMode = 'still'
    title.sourceRange = { startFrame: 0, durationFrames: 1 }
    title.sourceTimeMap = defaultSourceTimeMap(0)

    const parsed = parseProjectFile(serializeProjectFile(project))
    expect(parsed.sequences[0].tracks[0].clips[2]).toMatchObject({
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
      timelineRange: { startFrame: 24, durationFrames: 20 },
    })
  })

  test('round-trips durable video-only and audio-only descriptor choices', () => {
    const project = makeProject()
    project.assets.push(
      {
        id: 'partial-video',
        fileName: 'picture-only.mov',
        mimeType: 'video/quicktime',
        size: 4_000_000,
        lastModified: 1_725_000_000_010,
        kind: 'video',
        partialTrackSelection: 'video-only',
        durationMicroseconds: 6_000_000,
        sourceBounds: {
          video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 6_000_000 },
          audio: null,
        },
        nativeFrameRate: { num: 24, den: 1 },
        width: 1_920,
        height: 1_080,
        hasAudio: false,
        audioSampleRate: null,
        audioChannels: null,
      },
      {
        id: 'partial-audio',
        fileName: 'sound-only.mp4',
        mimeType: 'video/mp4',
        size: 2_000_000,
        lastModified: 1_725_000_000_011,
        kind: 'audio',
        partialTrackSelection: 'audio-only',
        durationMicroseconds: 5_000_000,
        sourceBounds: {
          video: null,
          audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 5_000_000 },
        },
        nativeFrameRate: null,
        width: null,
        height: null,
        hasAudio: true,
        audioSampleRate: 48_000,
        audioChannels: 2,
      },
    )

    const serialized = serializeProjectFile(project)
    const parsed = parseProjectFile(serialized)

    expect(parsed.assets.find((asset) => asset.id === 'partial-video')).toEqual(
      project.assets[2],
    )
    expect(parsed.assets.find((asset) => asset.id === 'partial-audio')).toEqual(
      project.assets[3],
    )
    expect(serialized).toContain('partialTrackSelection')
  })

  test('rejects invalid partial-track descriptor combinations', () => {
    const invalidSelection = makeProject()
    Object.assign(invalidSelection.assets[1], {
      partialTrackSelection: 'captions-only',
    })
    expect(() => validateProjectFile(invalidSelection)).toThrow(
      /partialTrackSelection.*video-only or audio-only/,
    )

    const videoOnlyWithAudio = makeProject()
    Object.assign(videoOnlyWithAudio.assets[0], {
      partialTrackSelection: 'video-only',
    })
    expect(() => validateProjectFile(videoOnlyWithAudio)).toThrow(
      /video-only imports must be video assets without audio/,
    )

    const videoOnlyImage = makeProject()
    Object.assign(videoOnlyImage.assets[1], {
      partialTrackSelection: 'video-only',
    })
    expect(() => validateProjectFile(videoOnlyImage)).toThrow(
      /video-only imports must be video assets without audio/,
    )

    const audioOnlyVideo = makeProject()
    Object.assign(audioOnlyVideo.assets[0], {
      partialTrackSelection: 'audio-only',
    })
    expect(() => validateProjectFile(audioOnlyVideo)).toThrow(
      /audio-only imports must be audio assets/,
    )

    const audioOnlyWithoutAudio = makeProject()
    Object.assign(audioOnlyWithoutAudio.assets[1], {
      kind: 'audio',
      partialTrackSelection: 'audio-only',
      width: null,
      height: null,
    })
    expect(() => validateProjectFile(audioOnlyWithoutAudio)).toThrow(
      /audio assets must contain audio/,
    )
  })

  test('rejects hostile or contradictory source timestamp bounds', () => {
    const reversed = makeProject()
    reversed.assets[0].sourceBounds.video = {
      status: 'exact',
      firstTimestampUs: 10,
      endTimestampUs: 10,
    }
    expect(() => validateProjectFile(reversed)).toThrow(
      /endTimestampUs must be greater/,
    )

    const missingVideo = makeProject()
    missingVideo.assets[0].sourceBounds.video = null
    expect(() => validateProjectFile(missingVideo)).toThrow(
      /video assets require video source bounds/,
    )

    const inventedImageTiming = makeProject()
    inventedImageTiming.assets[1].sourceBounds.video = { status: 'unknown' }
    expect(() => validateProjectFile(inventedImageTiming)).toThrow(
      /image assets cannot have timed source bounds/,
    )

    const beyondAssetEnd = makeProject()
    beyondAssetEnd.assets[0].sourceBounds.audio = {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: beyondAssetEnd.assets[0].durationMicroseconds + 1,
    }
    expect(() => validateProjectFile(beyondAssetEnd)).toThrow(
      /cannot exceed the asset duration endpoint/,
    )
  })

  test('builds an isolated active-session snapshot without session-only media fields', () => {
    const document = makeDocument()
    const assets = makeAssets()

    const snapshot = createProjectFileSnapshot(document, assets)
    document.name = 'Mutated after capture'
    assets[0].fileName = 'mutated.mov'

    expect(snapshot.sequences[0].name).toBe('Portable edit')
    expect(snapshot.assets.map((asset) => asset.id)).toEqual(['image-a', 'video-z'])
    expect(snapshot.assets.find((asset) => asset.id === 'video-z')).toMatchObject({
      fileName: 'camera.mov',
      nativeFrameRate: { num: 60_000, den: 1_001 },
    })
    const serialized = serializeProjectFile(snapshot)
    expect(serialized).not.toContain('objectUrl')
    expect(serialized).not.toContain('decoderConfigB64')
    expect(serialized).not.toContain('decoderCapabilityCache')
    expect(serialized).not.toContain('capabilityRevision')
    expect(serialized).not.toContain('revalidate')
    expect(serialized).not.toContain('blob:')
  })

  test('serialization is deterministic across asset and effect-param insertion order', () => {
    const left = makeProject()
    const right = clone(left)
    right.assets.reverse()
    right.sequences[0].tracks[0].clips[0].effects[0].params = {
      preserveHighlights: true,
      mode: 'soft',
      amount: 0.5,
    }
    expect(serializeProjectFile(right)).toBe(serializeProjectFile(left))
  })

  test('rejects forbidden session fields before serialization', () => {
    const withSessionState = makeProject()
    Object.assign(withSessionState.assets[0], {
      objectUrl: 'blob:https://example.invalid/session',
      decoderConfigB64: 'session-decoder-data',
      visuals: { thumbnails: ['blob:thumbnail'] },
      decoderCapabilityCache: { render: true },
      capabilityRevision: 4,
      absolutePath: 'C:\\private\\camera.mov',
      handle: { kind: 'file' },
    })
    expect(() => serializeProjectFile(withSessionState)).toThrow(/unknown field/)

    const serialized = serializeProjectFile(makeProject())
    for (const forbidden of [
      'objectUrl',
      'decoderConfigB64',
      'decoderCapabilityCache',
      'capabilityRevision',
      'visuals',
      'absolutePath',
      'history',
      'session-decoder-data',
      'blob:',
      'C:\\\\private',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(parseProjectFile(serialized).sequences[0]).toEqual(makeDocument())
  })

  test('rejects unsafe effect parameter keys before cloning for serialization', () => {
    const project = makeProject()
    project.sequences[0].tracks[0].clips[0].effects[0].params = JSON.parse(
      '{"__proto__":true}',
    ) as Record<string, string | number | boolean>
    expect(() => serializeProjectFile(project)).toThrow(/unsafe parameter key/)
  })

  test('rejects invalid JSON and unknown untrusted fields', () => {
    expect(() => parseProjectFile('{not json')).toThrow(ProjectFileError)
    const project = makeProject() as ProjectFile & { objectUrl: string }
    project.objectUrl = 'blob:forbidden'
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow(/unknown field/)
  })

  test('rejects oversized files, strings, and collection counts before use', () => {
    expect(() =>
      parseProjectFile(' '.repeat(PROJECT_FILE_LIMITS.maxSerializedCharacters + 1)),
    ).toThrow(/exceeds/)

    const longName = makeProject()
    longName.sequences[0].name = 'x'.repeat(PROJECT_FILE_LIMITS.maxNameCharacters + 1)
    expect(() => serializeProjectFile(longName)).toThrow(/characters/)

    const whitespaceName = makeProject()
    whitespaceName.sequences[0].name = ' '.repeat(PROJECT_FILE_LIMITS.maxNameCharacters + 1)
    expect(() => serializeProjectFile(whitespaceName)).toThrow(/exceeds/)

    const tooManyTracks = makeProject()
    tooManyTracks.sequences[0].tracks = Array.from(
      { length: PROJECT_FILE_LIMITS.maxTracks + 1 },
      (_value, index) => track(`V${index}`, 'video', []),
    )
    expect(() => validateProjectFile(tooManyTracks)).toThrow(/tracks.*exceeds|exceeds.*entries/)
  })

  test('rejects a canvas allocation that exceeds the render memory budget', () => {
    const unsafe = makeProject()
    unsafe.sequences[0].width = PROJECT_FILE_LIMITS.maxDimension
    unsafe.sequences[0].height = PROJECT_FILE_LIMITS.maxDimension

    expect(() => parseProjectFile(JSON.stringify(unsafe))).toThrow(
      /render surface|render memory|pixel limit/i,
    )
  })

  test('bounds aggregate effect, parameter, parameter-string, and text validation work', () => {
    const tooManyEffects = makeProject()
    const effectClipCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalEffects / PROJECT_FILE_LIMITS.maxEffectsPerClip,
    ) + 1
    const effectClips = Array.from({ length: effectClipCount }, (_value, clipIndex) => {
      const clip = mediaClip(`bulk-effect-clip-${clipIndex}`, 'video-z', clipIndex, 0, 1)
      clip.effects = Array.from(
        { length: PROJECT_FILE_LIMITS.maxEffectsPerClip },
        (_effect, effectIndex) => ({
          id: `bulk-effect-${clipIndex}-${effectIndex}`,
          type: 'test',
          version: 1,
          enabled: true,
          params: {},
        }),
      )
      return clip
    })
    tooManyEffects.sequences[0].tracks.push(track('V2', 'video', effectClips))
    expect(() => validateProjectFile(tooManyEffects)).toThrow(/effects in total/)

    const tooManyParams = makeProject()
    const fullParams = Object.fromEntries(
      Array.from(
        { length: PROJECT_FILE_LIMITS.maxEffectParams },
        (_value, index) => [`parameter-${index}`, index],
      ),
    )
    const parameterEffectCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalEffectParams / PROJECT_FILE_LIMITS.maxEffectParams,
    ) + 1
    tooManyParams.sequences[0].tracks[0].clips[0].effects = Array.from(
      { length: parameterEffectCount },
      (_value, index) => ({
        id: `parameter-effect-${index}`,
        type: 'test',
        version: 1,
        enabled: true,
        params: fullParams,
      }),
    )
    expect(() => validateProjectFile(tooManyParams)).toThrow(/effect parameters in total/)

    const tooManyEffectStringCharacters = makeProject()
    const largeEffectString = 'x'.repeat(PROJECT_FILE_LIMITS.maxEffectStringCharacters)
    tooManyEffectStringCharacters.sequences[0].tracks[0].clips[0].effects = [
      {
        id: 'large-string-effect',
        type: 'test',
        version: 1,
        enabled: true,
        params: Object.fromEntries(
          Array.from(
            { length: PROJECT_FILE_LIMITS.maxEffectParams },
            (_value, index) => [
              `string-parameter-${index}`,
              largeEffectString,
            ],
          ),
        ),
      },
    ]
    expect(() => validateProjectFile(tooManyEffectStringCharacters)).toThrow(
      /effect-string characters in total/,
    )

    const tooMuchText = makeProject()
    const title = tooMuchText.sequences[0].tracks[0].clips[2].text
    if (!title) throw new Error('title fixture missing')
    const sharedText = {
      ...title,
      content: 'x'.repeat(PROJECT_FILE_LIMITS.maxTextCharacters),
    }
    const textClipCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalTextCharacters / PROJECT_FILE_LIMITS.maxTextCharacters,
    ) + 1
    const textClips = Array.from({ length: textClipCount }, (_value, index) => {
      const id = `bulk-text-${index}`
      const clip = mediaClip(id, proceduralTextAssetId(id), index, 0, 1)
      clip.text = sharedText
      return clip
    })
    tooMuchText.sequences[0].tracks.push(track('V2', 'video', textClips))
    expect(() => validateProjectFile(tooMuchText)).toThrow(/text characters in total/)
  })

  test('aborts deterministic serialization at the project-file character budget', () => {
    const project = makeProject()
    const title = project.sequences[0].tracks[0].clips[2].text
    if (!title) throw new Error('title fixture missing')
    const sharedText = {
      ...title,
      content: 'x'.repeat(PROJECT_FILE_LIMITS.maxTextCharacters),
    }
    delete project.sequences[0].tracks[0].clips[2].text
    project.sequences[0].tracks[0].clips[2].assetId = 'image-a'
    project.sequences[0].tracks[0].clips[2].sourceMode = 'still'
    project.sequences[0].tracks[0].clips[2].sourceRange = {
      startFrame: 0,
      durationFrames: 1,
    }
    project.sequences[0].tracks[0].clips[2].sourceTimeMap = defaultSourceTimeMap(0)
    const textClipCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalTextCharacters / PROJECT_FILE_LIMITS.maxTextCharacters,
    )
    const textClips = Array.from({ length: textClipCount }, (_value, index) => {
      const id = `budget-text-${index}`
      const clip = mediaClip(id, proceduralTextAssetId(id), index, 0, 1)
      clip.text = sharedText
      return clip
    })
    project.sequences[0].tracks.push(track('V2', 'video', textClips))

    expect(() => serializeProjectFile(project)).toThrow(/serialized project exceeds/)
  })

  test('rejects duplicate stable ids at every durable entity level', () => {
    const duplicateAsset = makeProject()
    duplicateAsset.assets.push(clone(duplicateAsset.assets[0]))
    expect(() => validateProjectFile(duplicateAsset)).toThrow(/duplicate asset id/)

    const duplicateTrack = makeProject()
    duplicateTrack.sequences[0].tracks[1].id = 'V1'
    expect(() => validateProjectFile(duplicateTrack)).toThrow(/duplicate track id/)

    const duplicateClip = makeProject()
    duplicateClip.sequences[0].tracks[1].clips[0].id = 'clip-a'
    expect(() => validateProjectFile(duplicateClip)).toThrow(/duplicate clip id/)

    const duplicateEffect = makeProject()
    duplicateEffect.sequences[0].tracks[0].clips[1].effects = [
      clone(duplicateEffect.sequences[0].tracks[0].clips[0].effects[0]),
    ]
    expect(() => validateProjectFile(duplicateEffect)).toThrow(/duplicate effect id/)

    const duplicateTransition = makeProject()
    const secondVideo = track('V2', 'video', [
      mediaClip('clip-v2a', 'video-z', 0, 0, 10),
      mediaClip('clip-v2b', 'video-z', 10, 10, 10),
    ])
    secondVideo.transitions = [
      {
        ...duplicateTransition.sequences[0].tracks[0].transitions[0],
        fromClipId: 'clip-v2a',
        toClipId: 'clip-v2b',
      },
    ]
    duplicateTransition.sequences[0].tracks.push(secondVideo)
    expect(() => validateProjectFile(duplicateTransition)).toThrow(/duplicate transition id/)
  })

  test('rejects dangling asset references and orphaned link groups', () => {
    const dangling = makeProject()
    dangling.sequences[0].tracks[0].clips[0].assetId = 'missing-asset'
    expect(() => validateProjectFile(dangling)).toThrow(/unknown asset/)

    const orphaned = makeProject()
    delete orphaned.sequences[0].tracks[1].clips[0].linkGroupId
    expect(() => validateProjectFile(orphaned)).toThrow(/has no partner/)
  })

  test('rejects duplicate collection names and dangling or duplicate membership', () => {
    const duplicateNames = makeProject()
    duplicateNames.collections = [
      { id: 'one', name: 'Selects', assetIds: ['video-z'] },
      { id: 'two', name: 'SELECTS', assetIds: ['image-a'] },
    ]
    const dangling = makeProject()
    dangling.collections = [
      { id: 'one', name: 'Selects', assetIds: ['missing'] },
    ]
    const duplicateMembership = makeProject()
    duplicateMembership.collections = [
      { id: 'one', name: 'Selects', assetIds: ['video-z', 'video-z'] },
    ]
    const emptyName = makeProject()
    emptyName.collections = [{ id: 'one', name: '', assetIds: [] }]
    const emptyId = makeProject()
    emptyId.collections = [{ id: ' ', name: 'Selects', assetIds: [] }]

    expect(() => validateProjectFile(duplicateNames)).toThrow(/duplicate collection name/i)
    expect(() => validateProjectFile(dangling)).toThrow(/unknown media asset/i)
    expect(() => validateProjectFile(duplicateMembership)).toThrow(/duplicate media asset/i)
    expect(() => validateProjectFile(emptyName)).toThrow(/must not be empty/i)
    expect(() => validateProjectFile(emptyId)).toThrow(/must not be empty/i)
  })

  test('rejects unsafe integers and non-canonical exact frame rates', () => {
    const unsafe = makeProject()
    unsafe.assets[0].size = Number.MAX_SAFE_INTEGER + 1
    expect(() => validateProjectFile(unsafe)).toThrow(/safe integer/)

    const unreduced = makeProject()
    unreduced.sequences[0].frameRate = { num: 60_000, den: 2_002 }
    expect(() => validateProjectFile(unreduced)).toThrow(/exact rational/)
  })

  test('rejects malformed clip and transition geometry', () => {
    const overlap = makeProject()
    overlap.sequences[0].tracks[0].clips[1].timelineRange.startFrame = 9
    expect(() => validateProjectFile(overlap)).toThrow(/sorted and non-overlapping/)

    const mismatchedDurations = makeProject()
    mismatchedDurations.sequences[0].tracks[0].clips[0].sourceRange.durationFrames = 9
    expect(() => validateProjectFile(mismatchedDurations)).toThrow(/durations must match/)

    const badTransition = makeProject()
    badTransition.sequences[0].tracks[0].transitions[0].durationFrames = 100
    expect(() => validateProjectFile(badTransition)).toThrow(/does not fit/)

    const missingEndpoint = makeProject()
    missingEndpoint.sequences[0].tracks[0].transitions[0].toClipId = 'not-a-clip'
    expect(() => validateProjectFile(missingEndpoint)).toThrow(/adjacent clips/)

    const badAudioCurve = makeProject()
    Object.assign(badAudioCurve.sequences[0].tracks[0].transitions[0].audio, {
      curve: 'logarithmic',
    })
    expect(() => validateProjectFile(badAudioCurve)).toThrow(
      /linear or equal-power/,
    )
  })

  test('requires valid explicit timed/still source semantics in current files', () => {
    const legacyNestedSchema = makeProject()
    legacyNestedSchema.sequences[0].schemaVersion = 1
    expect(() => validateProjectFile(legacyNestedSchema)).toThrow(
      /unsupported timeline schema 1/,
    )

    const missingMode = makeProject()
    removeSourceMode(missingMode.sequences[0].tracks[0].clips[0])
    expect(() => validateProjectFile(missingMode)).toThrow(/missing field sourceMode/)

    const timedImage = makeProject()
    const imageClip = timedImage.sequences[0].tracks[0].clips[2]
    delete imageClip.text
    imageClip.assetId = 'image-a'
    expect(() => validateProjectFile(timedImage)).toThrow(
      /image clips must use still source mode/,
    )

    const malformedStill = makeProject()
    const still = malformedStill.sequences[0].tracks[0].clips[2]
    delete still.text
    still.assetId = 'image-a'
    still.sourceMode = 'still'
    still.sourceRange = { startFrame: 0, durationFrames: 2 }
    expect(() => validateProjectFile(malformedStill)).toThrow(
      /source frame 0 with duration 1/,
    )
  })

  test('rejects source ranges beyond the portable asset duration', () => {
    const project = makeProject()
    project.assets[0].durationMicroseconds = 100_000
    project.assets[0].sourceBounds = {
      video: { status: 'exact', firstTimestampUs: -10_000, endTimestampUs: 100_000 },
      audio: { status: 'exact', firstTimestampUs: 20_000, endTimestampUs: 100_000 },
    }
    expect(() => validateProjectFile(project)).toThrow(/beyond the referenced asset duration/)
  })

  test('allows media-free procedural text while preserving timed equality', () => {
    const project = makeProject()
    expect(() => validateProjectFile(project)).not.toThrow()

    project.sequences[0].tracks[0].clips[2].sourceRange.durationFrames = 19
    expect(() => validateProjectFile(project)).toThrow(/durations must match/)
  })

  test('rejects text clips that reuse a real media asset id', () => {
    const project = makeProject()
    project.sequences[0].tracks[0].clips[2].assetId = 'image-a'
    expect(() => validateProjectFile(project)).toThrow(/reserved procedural asset id/)
  })

  test('accepts one-frame clips for positive sub-frame media', () => {
    const project = makeProject()
    project.assets[0].durationMicroseconds = 1
    project.assets[0].sourceBounds = {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1 },
    }
    for (const track of project.sequences[0].tracks) {
      track.transitions = []
      for (const clip of track.clips) {
        if (clip.assetId !== 'video-z') continue
        clip.sourceRange = { startFrame: 0, durationFrames: 1 }
        clip.sourceTimeMap = defaultSourceTimeMap(0)
        clip.timelineRange.durationFrames = 1
        if (clip.audio) {
          clip.audio.fadeInFrames = Math.min(clip.audio.fadeInFrames, 1)
          clip.audio.fadeOutFrames = Math.min(clip.audio.fadeOutFrames, 1)
        }
      }
    }

    expect(() => validateProjectFile(project)).not.toThrow()
  })

  test('rejects future project-format and timeline-schema versions', () => {
    const futureFile = makeProject()
    ;(futureFile as unknown as { formatVersion: number }).formatVersion =
      CURRENT_PROJECT_FORMAT_VERSION + 1
    expect(() => parseProjectFile(JSON.stringify(futureFile))).toThrow(
      /unsupported future project format/,
    )

    const futureDocument = makeProject()
    futureDocument.sequences[0].schemaVersion = CURRENT_TIMELINE_SCHEMA_VERSION + 1
    expect(() => parseProjectFile(JSON.stringify(futureDocument))).toThrow(
      /unsupported future timeline schema/,
    )
  })
})
