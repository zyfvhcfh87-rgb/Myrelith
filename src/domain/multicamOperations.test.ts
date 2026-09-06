import { describe, expect, test } from 'vitest'
import type { TimelineDoc, Track, TrackKind } from './schema'
import { createMulticamPlanner } from './multicam'
import {
  applyMulticamDefinitionEdit,
  applyMulticamInstanceEdit,
  createMulticamFromAssets,
} from './multicamOperations'
import type { SequenceEntityKind, SequenceProject } from './projectSequences'

function track(id: string, kind: TrackKind): Track {
  return {
    id,
    kind,
    name: id,
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
  }
}

function sequence(): TimelineDoc {
  return {
    schemaVersion: 21,
    id: 'root',
    name: 'Root',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [track('V1', 'video'), track('A1', 'audio')],
    markers: [],
    captionTracks: [],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  }
}

function project(): SequenceProject {
  return {
    id: 'project',
    name: 'Project',
    rootSequenceId: 'root',
    sequences: [sequence()],
    multicams: [],
  }
}

function idFactory() {
  let index = 0
  return (kind: SequenceEntityKind) => `${kind}-${++index}`
}

describe('multicam project edit seam', () => {
  test('aligns integer clap marks and places one linked video/audio pair atomically', () => {
    const result = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 15 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 25 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())

    expect(result.failure).toBeNull()
    const definition = result.project.multicams?.[0]
    expect(definition).toMatchObject({
      name: 'Concert',
      durationFrames: 130,
      angles: [
        { assetId: 'wide', coverage: { startFrame: 10, durationFrames: 120 } },
        { assetId: 'close', coverage: { startFrame: 0, durationFrames: 120 } },
      ],
    })
    expect(createMulticamPlanner(definition!).select(25)).toMatchObject({
      video: { assetId: 'wide', sourceFrame: 15 },
      audio: { assetId: 'wide', sourceFrame: 15 },
    })
    const [video, audio] = result.project.sequences[0].tracks
    expect(video.multicamInstances).toHaveLength(1)
    expect(audio.multicamInstances).toHaveLength(1)
    expect(video.multicamInstances?.[0]).toMatchObject({
      timelineRange: { startFrame: 20, durationFrames: 130 },
      sourceStartFrame: 0,
    })
    expect(audio.multicamInstances?.[0].linkGroupId)
      .toBe(video.multicamInstances?.[0].linkGroupId)
  })

  test('moves a linked pair together and rejects the whole edit when one lane is locked', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'follow-video' },
    }, idFactory())
    const moved = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'move',
      instanceId: created.videoInstanceId!,
      startFrame: 200,
    }, idFactory())
    expect(moved.failure).toBeNull()
    expect(moved.project.sequences[0].tracks.map(
      (item) => item.multicamInstances?.[0].timelineRange.startFrame,
    )).toEqual([200, 200])

    const lockedProject = structuredClone(created.project)
    lockedProject.sequences[0].tracks[1].locked = true
    const rejected = applyMulticamInstanceEdit(lockedProject, 'root', {
      kind: 'move',
      instanceId: created.videoInstanceId!,
      startFrame: 200,
    }, idFactory())
    expect(rejected).toEqual({ project: lockedProject, failure: 'track-locked' })
  })

  test('trims linked items with one exact parent and definition-local range', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const trimmed = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'trim',
      instanceId: created.videoInstanceId!,
      timelineRange: { startFrame: 30, durationFrames: 90 },
      sourceStartFrame: 10,
    }, idFactory())

    expect(trimmed.failure).toBeNull()
    expect(trimmed.project.sequences[0].tracks.map(
      (item) => item.multicamInstances?.[0],
    )).toEqual([
      expect.objectContaining({
        timelineRange: { startFrame: 30, durationFrames: 90 },
        sourceStartFrame: 10,
      }),
      expect.objectContaining({
        timelineRange: { startFrame: 30, durationFrames: 90 },
        sourceStartFrame: 10,
      }),
    ])
  })

  test('splits every member of a linked pair at one exact frame', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'follow-video' },
    }, idFactory())

    const split = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'split',
      instanceId: created.videoInstanceId!,
      frame: 70,
    }, idFactory())

    expect(split.failure).toBeNull()
    const [video, audio] = split.project.sequences[0].tracks
    expect(video.multicamInstances).toHaveLength(2)
    expect(audio.multicamInstances).toHaveLength(2)
    for (const item of [video, audio]) {
      expect(item.multicamInstances).toEqual([
        expect.objectContaining({
          sourceStartFrame: 0,
          timelineRange: { startFrame: 20, durationFrames: 50 },
        }),
        expect.objectContaining({
          sourceStartFrame: 50,
          timelineRange: { startFrame: 70, durationFrames: 70 },
        }),
      ])
    }
    expect(video.multicamInstances?.[1].linkGroupId)
      .toBe(audio.multicamInstances?.[1].linkGroupId)
    expect(video.multicamInstances?.[1].linkGroupId)
      .not.toBe(video.multicamInstances?.[0].linkGroupId)
  })

  test('duplicates and deletes a linked pair without changing its definition', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const duplicated = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'duplicate',
      instanceId: created.videoInstanceId!,
      startFrame: 200,
    }, idFactory())

    expect(duplicated.failure).toBeNull()
    expect(duplicated.project.multicams).toEqual(created.project.multicams)
    const [video, audio] = duplicated.project.sequences[0].tracks
    expect(video.multicamInstances?.map((item) => item.timelineRange.startFrame))
      .toEqual([20, 200])
    expect(audio.multicamInstances?.map((item) => item.timelineRange.startFrame))
      .toEqual([20, 200])
    expect(video.multicamInstances?.[1].id).not.toBe(video.multicamInstances?.[0].id)
    expect(video.multicamInstances?.[1].linkGroupId)
      .toBe(audio.multicamInstances?.[1].linkGroupId)

    const deleted = applyMulticamInstanceEdit(duplicated.project, 'root', {
      kind: 'delete',
      instanceId: video.multicamInstances![1].id,
    }, idFactory())
    expect(deleted.failure).toBeNull()
    expect(deleted.project.sequences[0].tracks.map(
      (item) => item.multicamInstances?.map((instance) => instance.timelineRange.startFrame),
    )).toEqual([[20], [20]])
    expect(deleted.project.multicams).toEqual(created.project.multicams)
  })

  test('rejects duplicate overlap and omits link keys from unlinked copies', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: null,
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())

    const rejected = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'duplicate',
      instanceId: created.videoInstanceId!,
      startFrame: 20,
    }, idFactory())
    expect(rejected).toEqual({ project: created.project, failure: 'overlap' })

    const duplicated = applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'duplicate',
      instanceId: created.videoInstanceId!,
      startFrame: 200,
    }, idFactory())
    expect(duplicated.failure).toBeNull()
    const duplicate = duplicated.project.sequences[0].tracks[0]
      .multicamInstances?.find((instance) => instance.timelineRange.startFrame === 200)
    expect(duplicate).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(duplicate, 'linkGroupId')).toBe(false)

    const split = applyMulticamInstanceEdit(duplicated.project, 'root', {
      kind: 'split',
      instanceId: created.videoInstanceId!,
      frame: 70,
    }, idFactory())
    expect(split.failure).toBeNull()
    const right = split.project.sequences[0].tracks[0]
      .multicamInstances?.find((instance) => instance.timelineRange.startFrame === 70)
    expect(right).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(right, 'linkGroupId')).toBe(false)
  })

  test('authors, changes, and rolls cuts while keeping audio policy independent', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const definition = created.project.multicams![0]
    const closeId = definition.angles[1].id
    const wideId = definition.angles[0].id

    const cut = applyMulticamDefinitionEdit(created.project, {
      kind: 'cut',
      definitionId: definition.id,
      frame: 30,
      angleId: closeId,
    })
    const changed = applyMulticamDefinitionEdit(cut.project, {
      kind: 'cut',
      definitionId: definition.id,
      frame: 30,
      angleId: wideId,
    })
    const secondCut = applyMulticamDefinitionEdit(changed.project, {
      kind: 'cut',
      definitionId: definition.id,
      frame: 60,
      angleId: closeId,
    })
    const rolled = applyMulticamDefinitionEdit(secondCut.project, {
      kind: 'roll-cut',
      definitionId: definition.id,
      frame: 60,
      toFrame: 55,
    })
    const follow = applyMulticamDefinitionEdit(rolled.project, {
      kind: 'set-audio-policy',
      definitionId: definition.id,
      audioPolicy: { kind: 'follow-video' },
    })

    expect(follow.failure).toBeNull()
    expect(follow.project.multicams![0]).toMatchObject({
      switches: [
        { frame: 0, videoAngleId: wideId },
        { frame: 55, videoAngleId: closeId },
      ],
      audioPolicy: { kind: 'follow-video' },
    })
  })

  test('changes a manual angle offset only when its exact coverage stays bounded', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: null,
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 100, syncFrame: 10 },
        { assetId: 'close', name: 'Close', durationFrames: 80, syncFrame: 20 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const definition = created.project.multicams![0]
    const angleId = definition.angles[1].id
    const accepted = applyMulticamDefinitionEdit(created.project, {
      kind: 'set-angle',
      definitionId: definition.id,
      angleId,
      name: 'Close-up',
      coverageStartFrame: 15,
    })
    expect(accepted.failure).toBeNull()
    expect(accepted.project.multicams![0].angles[1]).toMatchObject({
      name: 'Close-up',
      coverage: { startFrame: 15, durationFrames: 80 },
    })

    const extended = applyMulticamDefinitionEdit(created.project, {
      kind: 'set-angle',
      definitionId: definition.id,
      angleId,
      name: 'Close-up',
      coverageStartFrame: 31,
    })
    expect(extended.failure).toBeNull()
    expect(extended.project.multicams![0]).toMatchObject({
      durationFrames: 111,
      angles: [
        expect.anything(),
        { coverage: { startFrame: 31, durationFrames: 80 } },
      ],
    })
  })

  test('protects every shared definition reference when any owning lane is locked', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const lockedProject = structuredClone(created.project)
    lockedProject.sequences[0].tracks[1].locked = true
    const definition = lockedProject.multicams![0]

    const rejected = applyMulticamDefinitionEdit(lockedProject, {
      kind: 'set-audio-policy',
      definitionId: definition.id,
      audioPolicy: { kind: 'follow-video' },
    })

    expect(rejected).toEqual({ project: lockedProject, failure: 'track-locked' })
  })

  test('preserves project identity for idempotent definition and instance edits', () => {
    const created = createMulticamFromAssets(project(), 'root', {
      name: 'Concert',
      startFrame: 20,
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      angles: [
        { assetId: 'wide', name: 'Wide', durationFrames: 120, syncFrame: 0 },
        { assetId: 'close', name: 'Close', durationFrames: 120, syncFrame: 0 },
      ],
      audioPolicy: { kind: 'fixed', angleIndex: 0 },
    }, idFactory())
    const definition = created.project.multicams![0]
    const angle = definition.angles[0]

    expect(applyMulticamDefinitionEdit(created.project, {
      kind: 'cut',
      definitionId: definition.id,
      frame: 0,
      angleId: angle.id,
    }).project).toBe(created.project)
    expect(applyMulticamDefinitionEdit(created.project, {
      kind: 'set-audio-policy',
      definitionId: definition.id,
      audioPolicy: definition.audioPolicy,
    }).project).toBe(created.project)
    expect(applyMulticamDefinitionEdit(created.project, {
      kind: 'set-angle',
      definitionId: definition.id,
      angleId: angle.id,
      name: angle.name,
      coverageStartFrame: angle.coverage.startFrame,
    }).project).toBe(created.project)
    expect(applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'move',
      instanceId: created.videoInstanceId!,
      startFrame: 20,
    }, idFactory()).project).toBe(created.project)
    expect(applyMulticamInstanceEdit(created.project, 'root', {
      kind: 'trim',
      instanceId: created.videoInstanceId!,
      timelineRange: { startFrame: 20, durationFrames: 120 },
      sourceStartFrame: 0,
    }, idFactory()).project).toBe(created.project)
  })
})
