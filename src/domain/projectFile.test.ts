import { describe, expect, test } from 'vitest'
import type { Clip, EffectDescriptor, TimelineDoc, Track } from './schema'
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
import { addEffect, updateEffectParams } from './operations'

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
    transitions: [],
    hidden: kind === 'video',
    muted: kind === 'audio',
    solo: false,
    locked: false,
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
  }
}

function makeProject(): ProjectFile {
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: makeDocument(),
    assets: makeAssets(),
    collections: [],
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
    original.document.markers = [
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
    expect(parsed.document).toEqual(original.document)
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['image-a', 'video-z'])
    expect(parsed.assets.find((asset) => asset.id === 'video-z')).toEqual(original.assets[0])
    expect(parsed.collections).toEqual(original.collections)
    expect(parsed.document.tracks[0].clips[0]).toMatchObject({
      effects: original.document.tracks[0].clips[0].effects,
      linkGroupId: 'linked-av',
      transform: original.document.tracks[0].clips[0].transform,
    })
    expect(parsed.document.tracks[0].clips[2].text).toEqual(
      original.document.tracks[0].clips[2].text,
    )
    expect(parsed.document.tracks[0].transitions).toEqual(
      original.document.tracks[0].transitions,
    )
    expect(parsed.document.markers).toEqual(original.document.markers)
  })

  test('migrates schema-9 through versioned effects and exact 1x maps without changing intent', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 9
    legacy.document.tracks[0].clips[0].animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 2, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const originalRanges = legacy.document.tracks.flatMap((item) => item.clips).map(
      (clip) => ({ sourceRange: clip.sourceRange, timelineRange: clip.timelineRange }),
    )
    for (const legacyTrack of legacy.document.tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'sourceTimeMap')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const clips = parsed.document.tracks.flatMap((item) => item.clips)

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
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

  test('migrates schema-10 effect documents to schema-11 source-time intent', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 10
    legacy.document.tracks[0].clips[0].animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 2, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const effects = clone(legacy.document.tracks[0].clips[0].effects)
    for (const legacyTrack of legacy.document.tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'sourceTimeMap')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(11)
    expect(parsed.document.tracks[0].clips[0].effects).toEqual(effects)
    expect(parsed.document.tracks[0].clips[0].sourceTimeMap).toEqual(
      defaultSourceTimeMap(5, 10),
    )
    expect(parsed.document.tracks[0].clips[0].animation?.tracks[0].keyframes[0])
      .toMatchObject({ frame: 2, sourceTimeTicks: 7_000_000 })
  })

  test('round-trips a non-unity rational source-time map exactly', () => {
    const project = makeProject()
    const retimed = project.document.tracks[0].clips[1]
    retimed.timelineRange = { startFrame: 10, durationFrames: 5 }
    retimed.sourceTimeMap = {
      sourceStartTicks: 15_000_000,
      sourceDurationTicks: 10_000_000,
      rate: { numerator: 2, denominator: 1 },
    }

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.document.tracks[0].clips[1]).toMatchObject({
      sourceRange: { startFrame: 15, durationFrames: 10 },
      timelineRange: { startFrame: 10, durationFrames: 5 },
      sourceTimeMap: {
        sourceStartTicks: 15_000_000,
        sourceDurationTicks: 10_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    })
  })

  test('migrates schema-6 projects to explicit empty marker defaults', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 6
    Reflect.deleteProperty(legacy.document, 'markers')

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.markers).toEqual([])
  })

  test('migrates schema-7 projects through caption and blend defaults', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 7
    Reflect.deleteProperty(legacy.document, 'captionTracks')
    for (const legacyTrack of legacy.document.tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'blendMode')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.captionTracks).toEqual([])
    expect(parsed.document.tracks.flatMap((item) => item.clips).map((item) => item.blendMode))
      .toEqual(['normal', 'normal', 'normal', 'normal'])
  })

  test('migrates schema-8 captions intact while adding normal blend intent', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 8
    legacy.document.captionTracks = [{
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
    for (const legacyTrack of legacy.document.tracks) {
      for (const legacyClip of legacyTrack.clips) {
        Reflect.deleteProperty(legacyClip, 'blendMode')
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.captionTracks).toEqual(legacy.document.captionTracks)
    expect(parsed.document.tracks.flatMap((item) => item.clips).map((item) => item.blendMode))
      .toEqual(['normal', 'normal', 'normal', 'normal'])
  })

  test('migrates schema-9 effect descriptors and preserves opaque legacy payloads', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 9
    legacy.document.tracks[0].clips[0].effects = [
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
    for (const effect of legacy.document.tracks[0].clips[0].effects) {
      Reflect.deleteProperty(effect, 'version')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.tracks[0].clips[0].effects).toEqual([
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
    original.document.tracks[0].clips[0].effects = effects

    const parsed = parseProjectFile(serializeProjectFile(original))
    expect(parsed.document.tracks[0].clips[0].effects).toEqual(effects)
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
    original.document.tracks[0].clips[0].effects = [existing]

    const parsed = parseProjectFile(serializeProjectFile(original))
    expect(parsed.document.tracks[0].clips[0].effects).toEqual([existing])
  })

  test('every accepted exact-limit live effect edit remains serializable', () => {
    const project = makeProject()
    const clip = project.document.tracks[0].clips[0]
    clip.effects = []
    const params: EffectDescriptor['params'] = Object.fromEntries(Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectParams },
      (_value, index) => [`parameter-${index}`, index],
    ))
    params['parameter-0'] = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    const edited = addEffect(project.document, clip.id, {
      id: 'i'.repeat(EFFECT_STACK_LIMITS.maxIdCharacters),
      type: 't'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters),
      version: Number.MAX_SAFE_INTEGER,
      enabled: true,
      params,
    })
    expect(edited).not.toBe(project.document)
    const acceptedProject = { ...project, document: edited }
    const serialized = serializeProjectFile(acceptedProject)
    expect(parseProjectFile(serialized).document).toEqual(edited)

    const effectId = edited.tracks[0].clips[0].effects[0].id
    const rejected = updateEffectParams(edited, clip.id, effectId, { overflow: true })
    expect(rejected).toBe(edited)
    expect(() => serializeProjectFile({ ...project, document: rejected })).not.toThrow()
  })

  test('round-trips semantic captions and rejects malformed persisted cues', () => {
    const project = makeProject()
    project.document.captionTracks = [{
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

    expect(parseProjectFile(serializeProjectFile(project)).document.captionTracks)
      .toEqual(project.document.captionTracks)

    const malformed = clone(project)
    malformed.document.captionTracks![0]!.items[0]!.text = '<b>Hello</b>'
    expect(() => validateProjectFile(malformed)).toThrow(/markup/u)
  })

  test('round-trips supported and unsupported blend intent without substitution', () => {
    const original = makeProject()
    original.document.tracks[0].clips[0].blendMode = 'multiply'
    original.document.tracks[0].clips[1].blendMode = 'future-soft-light'

    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.document.tracks[0].clips[0].blendMode).toBe('multiply')
    expect(parsed.document.tracks[0].clips[1].blendMode).toBe('future-soft-light')
  })

  test('rejects invalid, duplicate, and unsorted marker records', () => {
    const invalid = makeProject()
    invalid.document.markers = [
      { id: 'late', frame: 20, label: 'Late', color: 'yellow' },
      { id: 'early', frame: 10, label: 'Early', color: 'yellow' },
    ]
    expect(() => validateProjectFile(invalid)).toThrow(/sorted by frame then id/)

    const duplicate = makeProject()
    duplicate.document.markers = [
      { id: 'same', frame: 10, label: 'One', color: 'yellow' },
      { id: 'same', frame: 20, label: 'Two', color: 'red' },
    ]
    expect(() => validateProjectFile(duplicate)).toThrow(/duplicate marker id/)

    const badFrame = makeProject()
    badFrame.document.markers = [
      { id: 'bad', frame: 1.5, label: 'Bad', color: 'yellow' },
    ]
    expect(() => validateProjectFile(badFrame)).toThrow(/safe integer/)
  })

  test('migrates a legacy branded project and procedural text id', () => {
    const legacy = clone(makeProject()) as unknown as {
      format: string
      document: TimelineDoc
    }
    legacy.format = LEGACY_PROJECT_FILE_FORMAT
    legacy.document.tracks[0].clips[2].assetId = '__webcut_text__:clip-title'

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.format).toBe(PROJECT_FILE_FORMAT)
    expect(parsed.document.tracks[0].clips[2].assetId).toBe(
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
    original.document.tracks[0].clips[0].animation = {
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

    expect(parsed.document.tracks[0].clips[0].animation)
      .toEqual(original.document.tracks[0].clips[0].animation)
  })

  test('migrates schema-5 clips to canonical empty animation tracks', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 5
    for (const item of legacy.document.tracks.flatMap((track) => track.clips)) {
      Reflect.deleteProperty(item, 'animation')
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.tracks.flatMap((track) => track.clips)
      .every((item) => JSON.stringify(item.animation) === '{"tracks":[]}'))
      .toBe(true)
  })

  test('rejects non-canonical duplicate times and invalid easing control points', () => {
    const duplicate = makeProject()
    duplicate.document.tracks[0].clips[0].animation = {
      tracks: [{
        property: 'position-x',
        keyframes: [
          { frame: 3, sourceTimeTicks: 8_000_000, value: 10, easing: { type: 'linear' } },
          { frame: 3, sourceTimeTicks: 8_000_000, value: 20, easing: { type: 'linear' } },
        ],
      }],
    }
    const badEasing = makeProject()
    badEasing.document.tracks[0].clips[0].animation = {
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
    missing.document.tracks[0].clips[0].animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [{ frame: 0, value: 0.5, easing: { type: 'linear' } }],
      }],
    }
    const unsafe = clone(missing)
    unsafe.document.tracks[0].clips[0].animation!.tracks[0].keyframes[0]
      .sourceTimeTicks = Number.MAX_SAFE_INTEGER + 1
    const unknown = clone(missing)
    const unknownKeyframe = unknown.document.tracks[0].clips[0]
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
    project.document.width = width
    project.document.height = height

    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.width).toBe(width)
    expect(parsed.document.height).toBe(height)
  })

  test('migrates v1 projects to the current format without inventing a partial-track choice', () => {
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      assets: Array<Record<string, unknown>>
      document: TimelineDoc
    }
    legacy.formatVersion = 1
    Reflect.deleteProperty(legacy, 'collections')
    legacy.document.schemaVersion = 1
    for (const asset of legacy.assets) delete asset.partialTrackSelection
    for (const track of legacy.document.tracks) {
      for (const clip of track.clips) removeSourceMode(clip)
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.assets).toHaveLength(2)
    expect(
      parsed.assets.every((asset) => asset.partialTrackSelection === undefined),
    ).toBe(true)
    expect(
      parsed.document.tracks.flatMap((track) => track.clips)
        .every((clip) => clip.sourceMode === 'timed'),
    ).toBe(true)
    expect(parsed.document.tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('migrates v4 projects to an empty portable collection catalog', () => {
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      collections?: unknown
    }
    legacy.formatVersion = 4
    delete legacy.collections

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.collections).toEqual([])
  })

  test('migrates schema-4 clip Inspector defaults and preserves legacy scale signs as flips', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 4
    const first = legacy.document.tracks[0].clips[0]
    first.transform.scaleX = -1.5
    first.transform.scaleY = 0.75
    for (const track of legacy.document.tracks) {
      for (const clip of track.clips) {
        delete clip.visual
        delete clip.audio
      }
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const migrated = parsed.document.tracks[0].clips[0]

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(migrated.transform).toMatchObject({ scaleX: 1.5, scaleY: 0.75 })
    expect(migrated.visual).toEqual({
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      flipHorizontal: true,
      flipVertical: false,
      scaleLocked: false,
    })
    expect(migrated.audio).toEqual(defaultClipAudioSettings())
    expect(parsed.document.tracks.flatMap((track) => track.clips).every(
      (clip) => clip.visual !== undefined && clip.audio !== undefined,
    )).toBe(true)
  })

  test('migrates v3 bounds and transition audio conservatively', () => {
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      assets: Array<Record<string, unknown>>
      document: {
        schemaVersion: number
        tracks: Array<{ transitions: Array<Record<string, unknown>> }>
      }
    }
    legacy.formatVersion = 3
    Reflect.deleteProperty(legacy, 'collections')
    legacy.document.schemaVersion = 2
    for (const asset of legacy.assets) delete asset.sourceBounds
    for (const track of legacy.document.tracks) {
      for (const transition of track.transitions) delete transition.audio
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.assets.find((asset) => asset.id === 'video-z')?.sourceBounds)
      .toEqual({
        video: { status: 'unknown' },
        audio: { status: 'unknown' },
      })
    expect(parsed.assets.find((asset) => asset.id === 'image-a')?.sourceBounds)
      .toEqual({ video: null, audio: null })
    expect(parsed.document.tracks[0].transitions[0].audio).toEqual({
      enabled: false,
      curve: 'equal-power',
    })
  })

  test('migrates dormant schema-3 text into a procedural bounded overlay', () => {
    const legacy = clone(makeProject()) as unknown as {
      document: TimelineDoc
    }
    legacy.document.schemaVersion = 3
    const title = legacy.document.tracks[0].clips[2]
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
    const migrated = parsed.document.tracks[0].clips[2]
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
    const legacy = clone(makeProject()) as unknown as {
      document: TimelineDoc
    }
    legacy.document.schemaVersion = 3
    const title = legacy.document.tracks[0].clips[2]
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
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      document: TimelineDoc
    }
    legacy.formatVersion = 2
    Reflect.deleteProperty(legacy, 'collections')
    legacy.document.schemaVersion = 1
    const title = legacy.document.tracks[0].clips[2]
    delete title.text
    title.assetId = 'image-a'
    for (const track of legacy.document.tracks) {
      for (const clip of track.clips) removeSourceMode(clip)
    }

    const parsed = parseProjectFile(JSON.stringify(legacy))
    const migrated = parsed.document.tracks[0].clips[2]

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(migrated.sourceMode).toBe('still')
    expect(migrated.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(migrated.timelineRange).toEqual({
      startFrame: 24,
      durationFrames: 20,
    })
    expect(parsed.document.tracks[0].clips[0].sourceMode).toBe('timed')
  })

  test('migrates shipped v3 schema-1 documents by asset kind, including image-backed text', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 1
    const video = legacy.document.tracks[0].clips[0]
    const imageBackedText = legacy.document.tracks[0].clips[2]
    imageBackedText.assetId = 'image-a'
    video.sourceMode = 'still'
    imageBackedText.sourceMode = 'still'

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document.schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
    expect(parsed.document.tracks[0].clips[0]).toMatchObject({
      assetId: 'video-z',
      sourceMode: 'timed',
      sourceRange: { startFrame: 5, durationFrames: 10 },
    })
    expect(parsed.document.tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('migrates image-backed text beyond the nominal image duration', () => {
    const legacy = clone(makeProject())
    legacy.document.schemaVersion = 1
    const imageDescriptor = legacy.assets.find((asset) => asset.id === 'image-a')
    if (!imageDescriptor) throw new Error('missing image fixture')
    imageDescriptor.durationMicroseconds = 100_000
    const imageBackedText = legacy.document.tracks[0].clips[2]
    imageBackedText.assetId = 'image-a'
    removeSourceMode(imageBackedText)

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.tracks[0].clips[2]).toMatchObject({
      assetId: expect.stringMatching(/^__myrelith_text__:/),
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      timelineRange: { startFrame: 24, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
  })

  test('round-trips explicit still source semantics in the current format', () => {
    const project = makeProject()
    const title = project.document.tracks[0].clips[2]
    delete title.text
    title.assetId = 'image-a'
    title.sourceMode = 'still'
    title.sourceRange = { startFrame: 0, durationFrames: 1 }
    title.sourceTimeMap = defaultSourceTimeMap(0)

    const parsed = parseProjectFile(serializeProjectFile(project))
    expect(parsed.document.tracks[0].clips[2]).toMatchObject({
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

    expect(snapshot.document.name).toBe('Portable edit')
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
    right.document.tracks[0].clips[0].effects[0].params = {
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
    expect(parseProjectFile(serialized).document).toEqual(makeDocument())
  })

  test('rejects unsafe effect parameter keys before cloning for serialization', () => {
    const project = makeProject()
    project.document.tracks[0].clips[0].effects[0].params = JSON.parse(
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
    longName.document.name = 'x'.repeat(PROJECT_FILE_LIMITS.maxNameCharacters + 1)
    expect(() => serializeProjectFile(longName)).toThrow(/characters/)

    const whitespaceName = makeProject()
    whitespaceName.document.name = ' '.repeat(PROJECT_FILE_LIMITS.maxNameCharacters + 1)
    expect(() => serializeProjectFile(whitespaceName)).toThrow(/exceeds/)

    const tooManyTracks = makeProject()
    tooManyTracks.document.tracks = Array.from(
      { length: PROJECT_FILE_LIMITS.maxTracks + 1 },
      (_value, index) => track(`V${index}`, 'video', []),
    )
    expect(() => validateProjectFile(tooManyTracks)).toThrow(/tracks.*exceeds|exceeds.*entries/)
  })

  test('rejects a canvas allocation that exceeds the render memory budget', () => {
    const unsafe = makeProject()
    unsafe.document.width = PROJECT_FILE_LIMITS.maxDimension
    unsafe.document.height = PROJECT_FILE_LIMITS.maxDimension

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
    tooManyEffects.document.tracks.push(track('V2', 'video', effectClips))
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
    tooManyParams.document.tracks[0].clips[0].effects = Array.from(
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
    tooManyEffectStringCharacters.document.tracks[0].clips[0].effects = [
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
    const title = tooMuchText.document.tracks[0].clips[2].text
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
    tooMuchText.document.tracks.push(track('V2', 'video', textClips))
    expect(() => validateProjectFile(tooMuchText)).toThrow(/text characters in total/)
  })

  test('aborts deterministic serialization at the project-file character budget', () => {
    const project = makeProject()
    const title = project.document.tracks[0].clips[2].text
    if (!title) throw new Error('title fixture missing')
    const sharedText = {
      ...title,
      content: 'x'.repeat(PROJECT_FILE_LIMITS.maxTextCharacters),
    }
    delete project.document.tracks[0].clips[2].text
    project.document.tracks[0].clips[2].assetId = 'image-a'
    project.document.tracks[0].clips[2].sourceMode = 'still'
    project.document.tracks[0].clips[2].sourceRange = {
      startFrame: 0,
      durationFrames: 1,
    }
    project.document.tracks[0].clips[2].sourceTimeMap = defaultSourceTimeMap(0)
    const textClipCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalTextCharacters / PROJECT_FILE_LIMITS.maxTextCharacters,
    )
    const textClips = Array.from({ length: textClipCount }, (_value, index) => {
      const id = `budget-text-${index}`
      const clip = mediaClip(id, proceduralTextAssetId(id), index, 0, 1)
      clip.text = sharedText
      return clip
    })
    project.document.tracks.push(track('V2', 'video', textClips))

    expect(() => serializeProjectFile(project)).toThrow(/serialized project exceeds/)
  })

  test('rejects duplicate stable ids at every durable entity level', () => {
    const duplicateAsset = makeProject()
    duplicateAsset.assets.push(clone(duplicateAsset.assets[0]))
    expect(() => validateProjectFile(duplicateAsset)).toThrow(/duplicate asset id/)

    const duplicateTrack = makeProject()
    duplicateTrack.document.tracks[1].id = 'V1'
    expect(() => validateProjectFile(duplicateTrack)).toThrow(/duplicate track id/)

    const duplicateClip = makeProject()
    duplicateClip.document.tracks[1].clips[0].id = 'clip-a'
    expect(() => validateProjectFile(duplicateClip)).toThrow(/duplicate clip id/)

    const duplicateEffect = makeProject()
    duplicateEffect.document.tracks[0].clips[1].effects = [
      clone(duplicateEffect.document.tracks[0].clips[0].effects[0]),
    ]
    expect(() => validateProjectFile(duplicateEffect)).toThrow(/duplicate effect id/)

    const duplicateTransition = makeProject()
    const secondVideo = track('V2', 'video', [
      mediaClip('clip-v2a', 'video-z', 0, 0, 10),
      mediaClip('clip-v2b', 'video-z', 10, 10, 10),
    ])
    secondVideo.transitions = [
      {
        ...duplicateTransition.document.tracks[0].transitions[0],
        fromClipId: 'clip-v2a',
        toClipId: 'clip-v2b',
      },
    ]
    duplicateTransition.document.tracks.push(secondVideo)
    expect(() => validateProjectFile(duplicateTransition)).toThrow(/duplicate transition id/)
  })

  test('rejects dangling asset references and orphaned link groups', () => {
    const dangling = makeProject()
    dangling.document.tracks[0].clips[0].assetId = 'missing-asset'
    expect(() => validateProjectFile(dangling)).toThrow(/unknown asset/)

    const orphaned = makeProject()
    delete orphaned.document.tracks[1].clips[0].linkGroupId
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
    unreduced.document.frameRate = { num: 60_000, den: 2_002 }
    expect(() => validateProjectFile(unreduced)).toThrow(/exact rational/)
  })

  test('rejects malformed clip and transition geometry', () => {
    const overlap = makeProject()
    overlap.document.tracks[0].clips[1].timelineRange.startFrame = 9
    expect(() => validateProjectFile(overlap)).toThrow(/sorted and non-overlapping/)

    const mismatchedDurations = makeProject()
    mismatchedDurations.document.tracks[0].clips[0].sourceRange.durationFrames = 9
    expect(() => validateProjectFile(mismatchedDurations)).toThrow(/durations must match/)

    const badTransition = makeProject()
    badTransition.document.tracks[0].transitions[0].durationFrames = 100
    expect(() => validateProjectFile(badTransition)).toThrow(/does not fit/)

    const missingEndpoint = makeProject()
    missingEndpoint.document.tracks[0].transitions[0].toClipId = 'not-a-clip'
    expect(() => validateProjectFile(missingEndpoint)).toThrow(/adjacent clips/)

    const badAudioCurve = makeProject()
    Object.assign(badAudioCurve.document.tracks[0].transitions[0].audio, {
      curve: 'logarithmic',
    })
    expect(() => validateProjectFile(badAudioCurve)).toThrow(
      /linear or equal-power/,
    )
  })

  test('requires valid explicit timed/still source semantics in current files', () => {
    const legacyNestedSchema = makeProject()
    legacyNestedSchema.document.schemaVersion = 1
    expect(() => validateProjectFile(legacyNestedSchema)).toThrow(
      /unsupported timeline schema 1/,
    )

    const missingMode = makeProject()
    removeSourceMode(missingMode.document.tracks[0].clips[0])
    expect(() => validateProjectFile(missingMode)).toThrow(/missing field sourceMode/)

    const timedImage = makeProject()
    const imageClip = timedImage.document.tracks[0].clips[2]
    delete imageClip.text
    imageClip.assetId = 'image-a'
    expect(() => validateProjectFile(timedImage)).toThrow(
      /image clips must use still source mode/,
    )

    const malformedStill = makeProject()
    const still = malformedStill.document.tracks[0].clips[2]
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

    project.document.tracks[0].clips[2].sourceRange.durationFrames = 19
    expect(() => validateProjectFile(project)).toThrow(/durations must match/)
  })

  test('rejects text clips that reuse a real media asset id', () => {
    const project = makeProject()
    project.document.tracks[0].clips[2].assetId = 'image-a'
    expect(() => validateProjectFile(project)).toThrow(/reserved procedural asset id/)
  })

  test('accepts one-frame clips for positive sub-frame media', () => {
    const project = makeProject()
    project.assets[0].durationMicroseconds = 1
    project.assets[0].sourceBounds = {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1 },
    }
    for (const track of project.document.tracks) {
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
    futureDocument.document.schemaVersion = CURRENT_TIMELINE_SCHEMA_VERSION + 1
    expect(() => parseProjectFile(JSON.stringify(futureDocument))).toThrow(
      /unsupported future timeline schema/,
    )
  })
})
