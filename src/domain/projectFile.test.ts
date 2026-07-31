import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TIMELINE_SCHEMA_VERSION,
  createProjectFileSnapshot,
  parseProjectFile,
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_LIMITS,
  ProjectFileError,
  serializeProjectFile,
  type PortableAssetDescriptor,
  type ProjectFile,
  validateProjectFile,
} from './projectFile'

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
    volume: 1.25,
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
      enabled: true,
      params: { amount: 0.5, mode: 'soft', preserveHighlights: true },
    },
  ]
  const second = mediaClip('clip-b', 'video-z', 10, 15, 10)
  const title = mediaClip('clip-title', 'image-a', 24, 0, 20)
  title.text = {
    content: 'A portable title',
    fontFamily: 'Inter',
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
  }
}

function makeProject(): ProjectFile {
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: makeDocument(),
    assets: makeAssets(),
  }
}

describe('portable project file', () => {
  test('uses the shared durable document name and id limits', () => {
    expect(PROJECT_FILE_LIMITS.maxIdCharacters).toBe(MAX_DOCUMENT_ID_CHARACTERS)
    expect(PROJECT_FILE_LIMITS.maxNameCharacters).toBe(MAX_PROJECT_NAME_CHARACTERS)
  })

  test('round-trips every durable edit field and portable asset metadata', () => {
    const original = makeProject()
    const parsed = parseProjectFile(serializeProjectFile(original))

    expect(parsed.format).toBe('webcut-project')
    expect(parsed.formatVersion).toBe(CURRENT_PROJECT_FORMAT_VERSION)
    expect(parsed.document).toEqual(original.document)
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['image-a', 'video-z'])
    expect(parsed.assets.find((asset) => asset.id === 'video-z')).toEqual(original.assets[0])
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
  })

  test('migrates v1 projects to the current format without inventing a partial-track choice', () => {
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      assets: Array<Record<string, unknown>>
      document: TimelineDoc
    }
    legacy.formatVersion = 1
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
      assetId: 'image-a',
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 20 },
      text: { content: 'A portable title' },
    })
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

  test('migrates a v2 image clip to one still source frame without changing its timeline', () => {
    const legacy = clone(makeProject()) as unknown as {
      formatVersion: number
      document: TimelineDoc
    }
    legacy.formatVersion = 2
    legacy.document.schemaVersion = 1
    const title = legacy.document.tracks[0].clips[2]
    delete title.text
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
      assetId: 'image-a',
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
    removeSourceMode(imageBackedText)

    const parsed = parseProjectFile(JSON.stringify(legacy))

    expect(parsed.document.tracks[0].clips[2]).toMatchObject({
      assetId: 'image-a',
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
    title.sourceMode = 'still'
    title.sourceRange = { startFrame: 0, durationFrames: 1 }

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
      const clip = mediaClip(`bulk-text-${index}`, 'image-a', index, 0, 1)
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
    project.document.tracks[0].clips[2].sourceMode = 'still'
    project.document.tracks[0].clips[2].sourceRange = {
      startFrame: 0,
      durationFrames: 1,
    }
    const textClipCount = Math.floor(
      PROJECT_FILE_LIMITS.maxTotalTextCharacters / PROJECT_FILE_LIMITS.maxTextCharacters,
    )
    const textClips = Array.from({ length: textClipCount }, (_value, index) => {
      const clip = mediaClip(`budget-text-${index}`, 'image-a', index, 0, 1)
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
    expect(() => validateProjectFile(timedImage)).toThrow(
      /image clips must use still source mode/,
    )

    const malformedStill = makeProject()
    const still = malformedStill.document.tracks[0].clips[2]
    delete still.text
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

  test('allows procedural text beyond its backing asset while preserving timed equality', () => {
    const project = makeProject()
    const imageDescriptor = project.assets.find((asset) => asset.id === 'image-a')
    if (!imageDescriptor) throw new Error('missing image fixture')
    imageDescriptor.durationMicroseconds = 100_000

    expect(() => validateProjectFile(project)).not.toThrow()

    project.document.tracks[0].clips[2].sourceRange.durationFrames = 19
    expect(() => validateProjectFile(project)).toThrow(/durations must match/)
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
        clip.timelineRange.durationFrames = 1
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
