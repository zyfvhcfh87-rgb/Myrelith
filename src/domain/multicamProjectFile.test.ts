import { describe, expect, test } from 'vitest'
import type {
  MulticamDefinition,
  MulticamInstance,
  TimelineDoc,
} from './schema'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TIMELINE_SCHEMA_VERSION,
  createProjectFileSnapshot,
  parseProjectFile,
  serializeProjectFile,
  type PortableAssetDescriptor,
} from './projectFile'
import { sequenceProjectFromTimeline } from './projectSequences'

function sequence(): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'root',
    name: 'Root',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [],
      sequenceInstances: [],
      multicamInstances: [],
      adjustments: [],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      balance: 0,
      audioEffects: [],
    }],
    markers: [],
    captionTracks: [],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  }
}

function asset(id: string): PortableAssetDescriptor {
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1_000,
    lastModified: 1,
    kind: 'video',
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    },
    nativeFrameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

function definition(): MulticamDefinition {
  return {
    id: 'multicam-1',
    name: 'Two cameras',
    durationFrames: 120,
    angles: [
      {
        id: 'wide',
        name: 'Wide',
        assetId: 'asset-wide',
        coverage: { startFrame: 0, durationFrames: 120 },
        sourceStartFrame: 0,
      },
      {
        id: 'close',
        name: 'Close',
        assetId: 'asset-close',
        coverage: { startFrame: 10, durationFrames: 110 },
        sourceStartFrame: 0,
      },
    ],
    switches: [
      { frame: 0, videoAngleId: 'wide' },
      { frame: 60, videoAngleId: 'close' },
    ],
    audioPolicy: { kind: 'fixed', angleId: 'wide' },
  }
}

describe('multicam project-file seam', () => {
  test('format 6 and schema 19 migrate to explicit empty multicam collections', () => {
    const historical = createProjectFileSnapshot(
      sequenceProjectFromTimeline(sequence()),
      [],
    ) as unknown as Record<string, unknown>
    historical.formatVersion = 6
    delete historical.multicams
    const sequences = historical.sequences as Array<Record<string, unknown>>
    sequences[0].schemaVersion = 19
    const tracks = sequences[0].tracks as Array<Record<string, unknown>>
    delete tracks[0].multicamInstances

    const parsed = parseProjectFile(JSON.stringify(historical))

    expect(CURRENT_PROJECT_FORMAT_VERSION).toBe(7)
    expect(CURRENT_TIMELINE_SCHEMA_VERSION).toBe(20)
    expect(parsed.multicams).toEqual([])
    expect(parsed.sequences[0].tracks[0].multicamInstances).toEqual([])
  })

  test('round-trips one project-owned definition and linked timeline pair', () => {
    const video: MulticamInstance = {
      kind: 'multicam',
      id: 'multicam-video',
      name: 'Two cameras',
      multicamId: 'multicam-1',
      sourceStartFrame: 0,
      timelineRange: { startFrame: 20, durationFrames: 100 },
      linkGroupId: 'multicam-pair',
    }
    const audio = { ...video, id: 'multicam-audio' }
    const document = sequence()
    document.tracks[0].multicamInstances = [video]
    document.tracks.push({
      ...document.tracks[0],
      id: 'A1',
      kind: 'audio',
      name: 'A1',
      multicamInstances: [audio],
    })
    const project = {
      ...sequenceProjectFromTimeline(document),
      multicams: [definition()],
    }

    const snapshot = createProjectFileSnapshot(
      project,
      [asset('asset-wide'), asset('asset-close')],
    )
    const parsed = parseProjectFile(serializeProjectFile(snapshot))

    expect(parsed.multicams).toEqual([definition()])
    expect(parsed.sequences[0].tracks.map((track) => track.multicamInstances)).toEqual([
      [video],
      [audio],
    ])
  })

  test('rejects unknown angle assets and stale timeline references', () => {
    const document = sequence()
    document.tracks[0].multicamInstances = [{
      kind: 'multicam',
      id: 'multicam-video',
      name: 'Two cameras',
      multicamId: 'multicam-1',
      sourceStartFrame: 0,
      timelineRange: { startFrame: 0, durationFrames: 120 },
    }]
    const snapshot = createProjectFileSnapshot({
      ...sequenceProjectFromTimeline(document),
      multicams: [definition()],
    }, [asset('asset-wide'), asset('asset-close')])

    const unknownAsset = structuredClone(snapshot)
    unknownAsset.multicams[0].angles[1].assetId = 'missing-asset'
    expect(() => parseProjectFile(JSON.stringify(unknownAsset)))
      .toThrow(/references an unknown asset/)

    const staleReference = structuredClone(snapshot)
    staleReference.sequences[0].tracks[0].multicamInstances![0].multicamId = 'missing-definition'
    expect(() => parseProjectFile(JSON.stringify(staleReference)))
      .toThrow(/missing multicam definition/)
  })

  test('rejects a linked multicam pair when its A/V geometry drifts', () => {
    const video: MulticamInstance = {
      kind: 'multicam',
      id: 'multicam-video',
      name: 'Two cameras',
      multicamId: 'multicam-1',
      sourceStartFrame: 0,
      timelineRange: { startFrame: 20, durationFrames: 100 },
      linkGroupId: 'multicam-pair',
    }
    const document = sequence()
    document.tracks[0].multicamInstances = [video]
    document.tracks.push({
      ...document.tracks[0],
      id: 'A1',
      kind: 'audio',
      name: 'A1',
      multicamInstances: [{
        ...video,
        id: 'multicam-audio',
        timelineRange: { startFrame: 21, durationFrames: 99 },
      }],
    })
    const project = {
      ...sequenceProjectFromTimeline(document),
      multicams: [definition()],
    }

    expect(() => createProjectFileSnapshot(
      project,
      [asset('asset-wide'), asset('asset-close')],
    )).toThrow(/share exact geometry/)
  })
})
