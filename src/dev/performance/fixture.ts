import { defaultClipAnimation } from '../../domain/clipAnimation'
import {
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from '../../domain/clipInspector'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TIMELINE_SCHEMA_VERSION,
  PROJECT_FILE_FORMAT,
  type PortableAssetDescriptor,
  type ProjectFile,
} from '../../domain/projectFile'
import type {
  Clip,
  FrameRate,
  TimelineDoc,
  Track,
  Transform,
  Transition,
} from '../../domain/schema'
import {
  defaultTextProps,
  proceduralTextAssetId,
  textOverlayName,
} from '../../domain/textOverlay'
import type { PerformanceFixtureSummary } from './contract'
import { defaultSourceTimeMap } from '../../domain/sourceTimeMap'
import { rootSequence } from '../../domain/projectSequences'

export const PERFORMANCE_FIXTURE_VERSION = 'stress-100x8-30m-v1' as const
export const PERFORMANCE_FIXTURE_RATE: Readonly<FrameRate> = Object.freeze({
  num: 30,
  den: 1,
})
export const PERFORMANCE_FIXTURE_DURATION_FRAMES = 54_000
export const PERFORMANCE_FIXTURE_CLIP_FRAMES = 1_350
export const PERFORMANCE_FIXTURE_CLIPS_PER_TRACK = 40
export const PERFORMANCE_FIXTURE_SOURCE_FRAMES = 1_410
export const PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS = 47_000_000
export const PERFORMANCE_FIXTURE_WIDTH = 3_840
export const PERFORMANCE_FIXTURE_HEIGHT = 2_160

const FIXED_LAST_MODIFIED = 1_700_000_000_000
export const PERFORMANCE_FIXTURE_SOURCE_IN_FRAME = 30
const TRANSITION_FRAMES = 30
const VIDEO_ASSET_COUNT = 45
const AUDIO_ASSET_COUNT = 25
const IMAGE_ASSET_COUNT = 30
const CONNECTED_IMAGE_INDEXES = Object.freeze([0, 2, 4, 6, 8, 9])
const SCRUB_CLIP_INDEXES = Object.freeze([0, 2, 4, 6, 8])
const CONNECTED_AUDIO_INDEXES = Object.freeze([0, 5, 10, 15])
const CONNECTED_VIDEO_INDEXES = Object.freeze([0])

export interface PerformanceFixture {
  readonly version: typeof PERFORMANCE_FIXTURE_VERSION
  readonly project: ProjectFile
  readonly summary: Omit<PerformanceFixtureSummary, 'fingerprint'>
  /** Frames whose V2 source is a connected 4K still and whose V3 text is active. */
  readonly scrubFrames: readonly number[]
  readonly connectedVideoAssetIds: readonly string[]
  readonly connectedImageAssetIds: readonly string[]
  readonly connectedAudioAssetIds: readonly string[]
}

export interface PerformanceFixtureMediaGenerationSettings {
  readonly version: string
  readonly video: {
    readonly width: number
    readonly height: number
    readonly codec: 'avc'
    readonly bitrate: number
    readonly keyFrameInterval: number
    readonly frameRate: FrameRate
    readonly samplePlan: readonly {
      readonly index: number
      readonly timestampSeconds: number
      readonly durationSeconds: number
    }[]
  }
  readonly png: {
    readonly width: number
    readonly height: number
    readonly mimeType: string
  }
  readonly wav: {
    readonly durationSeconds: number
    readonly sampleRate: number
    readonly channels: number
    readonly bytesPerSample: number
    readonly frequenciesHz: readonly [number, number]
    readonly amplitude: number
    readonly mimeType: string
  }
}

/** Generated media plus the stable settings that make the portable fixture runnable. */
export interface PerformanceFixtureRuntimeMedia {
  readonly video: Blob
  readonly png: Blob
  readonly wav: Blob
  readonly generation: PerformanceFixtureMediaGenerationSettings
}

function numberedId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`
}

function exactBounds(): { status: 'exact'; firstTimestampUs: number; endTimestampUs: number } {
  return {
    status: 'exact',
    firstTimestampUs: 0,
    endTimestampUs: PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS,
  }
}

function videoDescriptor(index: number): PortableAssetDescriptor {
  const hasAudio = index < 30
  const is4k = index < 15
  return {
    id: numberedId('video', index),
    fileName: `camera-${String(index + 1).padStart(2, '0')}-${is4k ? '2160p' : '1080p'}.mp4`,
    mimeType: 'video/mp4',
    size: is4k ? 1_250_000_000 : 420_000_000,
    lastModified: FIXED_LAST_MODIFIED + index,
    kind: 'video',
    durationMicroseconds: PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS,
    sourceBounds: {
      video: exactBounds(),
      audio: hasAudio ? exactBounds() : null,
    },
    nativeFrameRate: index % 3 === 0 ? { num: 60, den: 1 } : { num: 30_000, den: 1_001 },
    width: is4k ? 3_840 : 1_920,
    height: is4k ? 2_160 : 1_080,
    hasAudio,
    audioSampleRate: hasAudio ? 48_000 : null,
    audioChannels: hasAudio ? 2 : null,
  }
}

function audioDescriptor(index: number): PortableAssetDescriptor {
  return {
    id: numberedId('audio', index),
    fileName: `field-audio-${String(index + 1).padStart(2, '0')}.wav`,
    mimeType: 'audio/wav',
    size: 9_024_044,
    lastModified: FIXED_LAST_MODIFIED + 1_000 + index,
    kind: 'audio',
    durationMicroseconds: PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS,
    sourceBounds: { video: null, audio: exactBounds() },
    nativeFrameRate: null,
    width: null,
    height: null,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

function imageDescriptor(index: number): PortableAssetDescriptor {
  const is4k = index < 10
  return {
    id: numberedId('image', index),
    fileName: `production-still-${String(index + 1).padStart(2, '0')}-${is4k ? '2160p' : '1440p'}.png`,
    mimeType: 'image/png',
    size: is4k ? 12_500_000 : 6_500_000,
    lastModified: FIXED_LAST_MODIFIED + 2_000 + index,
    kind: 'image',
    durationMicroseconds: 5_000_000,
    sourceBounds: { video: null, audio: null },
    nativeFrameRate: null,
    width: is4k ? 3_840 : 2_560,
    height: is4k ? 2_160 : 1_440,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
  }
}

function clipTransform(index: number): Transform {
  return {
    x: index % 5 === 0 ? 48 : 0,
    y: index % 7 === 0 ? -32 : 0,
    scaleX: index % 9 === 0 ? 0.92 : 1,
    scaleY: index % 9 === 0 ? 0.92 : 1,
    rotation: index % 11 === 0 ? 1.5 : 0,
    anchorX: 0.5,
    anchorY: 0.5,
  }
}

function mediaClip(
  id: string,
  asset: PortableAssetDescriptor,
  clipIndex: number,
): Clip {
  const still = asset.kind === 'image'
  return {
    id,
    assetId: asset.id,
    name: asset.fileName,
    sourceMode: still ? 'still' : 'timed',
    sourceRange: still
      ? { startFrame: 0, durationFrames: 1 }
      : {
          startFrame: PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
          durationFrames: PERFORMANCE_FIXTURE_CLIP_FRAMES,
        },
    sourceTimeMap: defaultSourceTimeMap(
      still ? 0 : PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
      still ? 1 : PERFORMANCE_FIXTURE_CLIP_FRAMES,
    ),
    timelineRange: {
      startFrame: clipIndex * PERFORMANCE_FIXTURE_CLIP_FRAMES,
      durationFrames: PERFORMANCE_FIXTURE_CLIP_FRAMES,
    },
    transform: clipTransform(clipIndex),
    opacity: clipIndex % 8 === 0 ? 0.88 : 1,
    blendMode: 'normal',
    volume: clipIndex % 6 === 0 ? 0.82 : 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: {
      ...defaultClipAudioSettings(),
      fadeInFrames: clipIndex % 10 === 0 ? 15 : 0,
      fadeOutFrames: clipIndex % 10 === 0 ? 15 : 0,
    },
    animation: defaultClipAnimation(),
    effects: clipIndex % 10 === 0
      ? [{
          id: `effect-${id}`,
          type: 'brightness',
          version: 1,
          enabled: true,
          params: { amount: 1.05 },
        }]
      : [],
    audioEffects: [],
  }
}

function textClip(clipIndex: number): Clip {
  const id = `text-clip-${String(clipIndex + 1).padStart(3, '0')}`
  const content = `Stress fixture title ${clipIndex + 1}`
  const text = defaultTextProps(
    PERFORMANCE_FIXTURE_WIDTH,
    PERFORMANCE_FIXTURE_HEIGHT,
    content,
  )
  return {
    id,
    assetId: proceduralTextAssetId(id),
    name: textOverlayName(content),
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: PERFORMANCE_FIXTURE_CLIP_FRAMES },
    sourceTimeMap: defaultSourceTimeMap(0, PERFORMANCE_FIXTURE_CLIP_FRAMES),
    timelineRange: {
      startFrame: clipIndex * PERFORMANCE_FIXTURE_CLIP_FRAMES,
      durationFrames: PERFORMANCE_FIXTURE_CLIP_FRAMES,
    },
    transform: {
      ...clipTransform(clipIndex),
      y: PERFORMANCE_FIXTURE_HEIGHT * 0.28,
    },
    opacity: 0.96,
    blendMode: 'normal',
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    audioEffects: [],
    text,
  }
}

function track(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  transitions: Transition[] = [],
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    sequenceInstances: [],
    multicamInstances: [],
    adjustments: [],
    transitions,
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
    audioEffects: [],
  }
}

function transition(from: Clip, to: Clip, index: number): Transition {
  return {
    id: `transition-v4-${String(index + 1).padStart(3, '0')}`,
    type: 'crossfade',
    fromClipId: from.id,
    toClipId: to.id,
    durationFrames: TRANSITION_FRAMES,
    audio: { enabled: false, curve: 'equal-power' },
  }
}

function fixtureDocument(
  videoAssets: readonly PortableAssetDescriptor[],
  audioAssets: readonly PortableAssetDescriptor[],
  imageAssets: readonly PortableAssetDescriptor[],
): TimelineDoc {
  const v1Clips = Array.from({ length: PERFORMANCE_FIXTURE_CLIPS_PER_TRACK }, (_, index) => (
    mediaClip(`clip-v1-${index + 1}`, videoAssets[index % videoAssets.length], index)
  ))
  const v2Clips = Array.from({ length: PERFORMANCE_FIXTURE_CLIPS_PER_TRACK }, (_, index) => (
    mediaClip(`clip-v2-${index + 1}`, imageAssets[index % imageAssets.length], index)
  ))
  const v3Clips = Array.from({ length: PERFORMANCE_FIXTURE_CLIPS_PER_TRACK }, (_, index) => (
    index % 2 === 0
      ? textClip(index)
      : mediaClip(`clip-v3-${index + 1}`, imageAssets[(index + 7) % imageAssets.length], index)
  ))
  const v4Clips = Array.from({ length: PERFORMANCE_FIXTURE_CLIPS_PER_TRACK }, (_, index) => (
    mediaClip(`clip-v4-${index + 1}`, videoAssets[(index + 20) % videoAssets.length], index)
  ))
  const v4Transitions = v4Clips.slice(0, -1).map((clip, index) => (
    transition(clip, v4Clips[index + 1], index)
  ))
  const audioTracks = Array.from({ length: 4 }, (_, trackIndex) => {
    const clips = Array.from({ length: PERFORMANCE_FIXTURE_CLIPS_PER_TRACK }, (_, index) => (
      mediaClip(
        `clip-a${trackIndex + 1}-${index + 1}`,
        audioAssets[(index + trackIndex * 5) % audioAssets.length],
        index,
      )
    ))
    return track(`A${trackIndex + 1}`, 'audio', clips)
  })

  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'performance-stress-document-v1',
    name: 'Performance stress fixture v1',
    frameRate: { ...PERFORMANCE_FIXTURE_RATE },
    width: PERFORMANCE_FIXTURE_WIDTH,
    height: PERFORMANCE_FIXTURE_HEIGHT,
    audioSampleRate: 48_000,
    tracks: [
      track('V1', 'video', v1Clips),
      track('V2', 'video', v2Clips),
      track('V3', 'video', v3Clips),
      track('V4', 'video', v4Clips, v4Transitions),
      ...audioTracks,
    ],
    markers: [],
    captionTracks: [],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  }
}

function fixtureSummary(
  project: ProjectFile,
): Omit<PerformanceFixtureSummary, 'fingerprint'> {
  const document = rootSequence(project)
  let clipCount = 0
  let transitionCount = 0
  let textClipCount = 0
  for (const track of document.tracks) {
    clipCount += track.clips.length
    transitionCount += track.transitions.length
    textClipCount += track.clips.filter((clip) => clip.text !== undefined).length
  }
  const assetKinds = {
    video: project.assets.filter((asset) => asset.kind === 'video').length,
    audio: project.assets.filter((asset) => asset.kind === 'audio').length,
    image: project.assets.filter((asset) => asset.kind === 'image').length,
  }
  return {
    version: PERFORMANCE_FIXTURE_VERSION,
    assetCount: project.assets.length,
    assetKinds,
    representative4kAssetCount: project.assets.filter(
      (asset) => asset.width === 3_840 && asset.height === 2_160,
    ).length,
    trackCount: document.tracks.length,
    videoTrackCount: document.tracks.filter((item) => item.kind === 'video').length,
    audioTrackCount: document.tracks.filter((item) => item.kind === 'audio').length,
    clipCount,
    transitionCount,
    textClipCount,
    durationFrames: PERFORMANCE_FIXTURE_DURATION_FRAMES,
    durationSeconds: PERFORMANCE_FIXTURE_DURATION_FRAMES / PERFORMANCE_FIXTURE_RATE.num,
    width: document.width,
    height: document.height,
    frameRate: `${PERFORMANCE_FIXTURE_RATE.num}/${PERFORMANCE_FIXTURE_RATE.den}`,
  }
}

/** Hash stable fixture contracts only; browser-produced Blob bytes are intentionally excluded. */
export async function fingerprintPerformanceFixture(
  fixture: PerformanceFixture,
  runtimeMedia: PerformanceFixtureRuntimeMedia,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    version: fixture.version,
    project: fixture.project,
    logicalMediaPlan: {
      generation: runtimeMedia.generation,
      scrubFrames: fixture.scrubFrames,
      connectedVideoAssetIds: fixture.connectedVideoAssetIds,
      connectedImageAssetIds: fixture.connectedImageAssetIds,
      connectedAudioAssetIds: fixture.connectedAudioAssetIds,
    },
  }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => (
    value.toString(16).padStart(2, '0')
  )).join('')
  return `sha256:${hex}`
}

/** Connected visual and procedural contributors that must paint at one fixture frame. */
export function expectedFixtureDrawnClipIds(
  fixture: PerformanceFixture,
  frame: number,
): readonly string[] {
  if (!Number.isSafeInteger(frame) || frame < 0) return []
  const connectedVisualAssetIds = new Set([
    ...fixture.connectedVideoAssetIds,
    ...fixture.connectedImageAssetIds,
  ])
  return rootSequence(fixture.project).tracks.flatMap((track) => {
    if (track.kind !== 'video' || track.hidden) return []
    return track.clips.flatMap((clip) => {
      const { startFrame, durationFrames } = clip.timelineRange
      const active = frame >= startFrame && frame < startFrame + durationFrames
      const expected = clip.text !== undefined || connectedVisualAssetIds.has(clip.assetId)
      return active && expected && clip.opacity > 0 ? [clip.id] : []
    })
  })
}

export function createPerformanceFixture(): PerformanceFixture {
  const videoAssets = Array.from({ length: VIDEO_ASSET_COUNT }, (_, index) => (
    videoDescriptor(index)
  ))
  const audioAssets = Array.from({ length: AUDIO_ASSET_COUNT }, (_, index) => (
    audioDescriptor(index)
  ))
  const imageAssets = Array.from({ length: IMAGE_ASSET_COUNT }, (_, index) => (
    imageDescriptor(index)
  ))
  const document = fixtureDocument(videoAssets, audioAssets, imageAssets)
  const project: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    id: document.id,
    name: document.name,
    rootSequenceId: document.id,
    sequences: [document],
    multicams: [],
    assets: [...videoAssets, ...audioAssets, ...imageAssets],
    collections: [],
  }
  return {
    version: PERFORMANCE_FIXTURE_VERSION,
    project,
    summary: fixtureSummary(project),
    scrubFrames: SCRUB_CLIP_INDEXES.map(
      (index) => index * PERFORMANCE_FIXTURE_CLIP_FRAMES + Math.floor(PERFORMANCE_FIXTURE_CLIP_FRAMES / 2),
    ),
    connectedVideoAssetIds: CONNECTED_VIDEO_INDEXES.map(
      (index) => videoAssets[index].id,
    ),
    connectedImageAssetIds: CONNECTED_IMAGE_INDEXES.map((index) => imageAssets[index].id),
    connectedAudioAssetIds: CONNECTED_AUDIO_INDEXES.map((index) => audioAssets[index].id),
  }
}
