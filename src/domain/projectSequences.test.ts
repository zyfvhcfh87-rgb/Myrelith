import { describe, expect, test } from 'vitest'
import { defaultClipAnimation } from './clipAnimation'
import { defaultClipAudioSettings, defaultClipVisualSettings } from './clipInspector'
import {
  chooseProjectRootSequence,
  createProjectSequence,
  deleteProjectSequence,
  duplicateProjectSequence,
  matchEmptyProjectFrameRate,
  projectMediaAssetIds,
  renameProjectSequence,
  replaceProjectSequence,
  rootSequence,
  sequenceProjectFromTimeline,
  sequenceProjectWithinEditBudget,
  type SequenceEntityKind,
  type SequenceIdFactory,
} from './projectSequences'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import type { Clip, TimelineDoc } from './schema'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { proceduralTextAssetId } from './textOverlay'

function factory(): SequenceIdFactory {
  let index = 0
  return (kind: SequenceEntityKind) => `${kind}_${++index}`
}

function clip(id: string, assetId = 'media-1'): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 10 },
    sourceTimeMap: defaultSourceTimeMap(0, 10),
    timelineRange: { startFrame: 0, durationFrames: 10 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: 'normal',
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function populatedDocument(): TimelineDoc {
  const document = JSON.parse(JSON.stringify(createTimelineDoc(
    'Main',
    DEFAULT_PROJECT_SETTINGS,
    'sequence-main',
  ))) as TimelineDoc
  const linkedVideo = clip('clip-video')
  linkedVideo.linkGroupId = 'link-av'
  linkedVideo.effects = [{
    id: 'effect-1',
    type: 'builtin.color-adjust',
    version: 1,
    enabled: true,
    params: { brightness: 0 },
  }]
  linkedVideo.audioEffects = [{
    id: 'audio-effect-clip',
    type: 'future.clip-audio',
    version: 1,
    enabled: true,
    params: { mix: 0.5 },
  }]
  linkedVideo.animation = {
    ...defaultClipAnimation(),
    effectTracks: [{
      effectId: 'effect-1',
      parameter: 'brightness',
      keyframes: [{
        frame: 0,
        sourceTimeTicks: 0,
        value: 0,
        easing: { type: 'hold' },
      }],
    }],
  }
  const linkedAudio = clip('clip-audio')
  linkedAudio.linkGroupId = 'link-av'
  const title = clip('clip-title', proceduralTextAssetId('clip-title'))
  title.timelineRange.startFrame = 20
  title.text = {
    content: 'Title',
    fontFamily: 'system-ui',
    fontSizePx: 40,
    color: '#ffffff',
    align: 'center',
    bold: false,
    italic: false,
    boxWidthPx: 400,
    boxHeightPx: 200,
    paddingPx: 8,
    backgroundEnabled: false,
    backgroundColor: '#000000',
    outlineEnabled: false,
    outlineColor: '#000000',
    outlineWidthPx: 0,
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowBlurPx: 0,
    shadowOffsetXPx: 0,
    shadowOffsetYPx: 0,
  }
  document.tracks[0].clips = [linkedVideo, title]
  document.tracks[0].adjustments = [{
    kind: 'adjustment',
    id: 'adjustment-1',
    name: 'Grade',
    timelineRange: { startFrame: 40, durationFrames: 10 },
    enabled: true,
    opacity: 1,
    animation: {
      tracks: [],
      effectTracks: [{
        effectId: 'effect-adjustment',
        parameter: 'brightness',
        keyframes: [{ frame: 0, value: 0, easing: { type: 'hold' } }],
      }],
    },
    effects: [{
      id: 'effect-adjustment',
      type: 'builtin.color-adjust',
      version: 1,
      enabled: true,
      params: { brightness: 0 },
    }],
  }]
  document.tracks[4].clips = [linkedAudio]
  document.tracks[4].audioEffects = [{
    id: 'audio-effect-track',
    type: 'future.track-audio',
    version: 1,
    enabled: true,
    params: {},
  }]
  document.masterAudio = {
    volume: 1,
    balance: 0,
    muted: false,
    audioEffects: [{
      id: 'audio-effect-master',
      type: 'future.master-audio',
      version: 1,
      enabled: true,
      params: {},
    }],
  }
  document.markers = [{ id: 'marker-1', frame: 2, label: 'Beat', color: 'blue' }]
  document.captionTracks = [{
    id: 'captions-1',
    name: 'English',
    language: 'en',
    role: 'subtitles',
    stylePreset: 'classic',
    hidden: false,
    items: [{
      id: 'caption-1',
      range: { startFrame: 0, durationFrames: 5 },
      text: 'Hello',
    }],
  }]
  return document
}

describe('project-level sequence authority', () => {
  test('wraps the historical document as the stable sole root', () => {
    const document = populatedDocument()
    const project = sequenceProjectFromTimeline(document)
    expect(project).toEqual({
      id: document.id,
      name: document.name,
      rootSequenceId: document.id,
      sequences: [document],
    })
    expect(rootSequence(project)).toBe(document)
  })

  test('creates an empty same-settings definition with globally fresh track ids', () => {
    const project = sequenceProjectFromTimeline(populatedDocument())
    const result = createProjectSequence(project, ' Scene two ', factory())
    expect(result.failure).toBeNull()
    expect(result.project.sequences).toHaveLength(2)
    const created = result.project.sequences[1]
    expect(created.name).toBe('Scene two')
    expect(created.tracks).toHaveLength(8)
    expect(created.tracks.every((track) => track.clips.length === 0)).toBe(true)
    expect(created).toMatchObject({
      frameRate: project.sequences[0].frameRate,
      width: project.sequences[0].width,
      height: project.sequences[0].height,
      audioSampleRate: project.sequences[0].audioSampleRate,
    })
    expect(new Set(result.project.sequences.flatMap(
      (sequence) => sequence.tracks.map((track) => track.id),
    )).size).toBe(16)
  })

  test('matches the frame rate across every empty sequence without changing ids', () => {
    const root = createTimelineDoc('Main', DEFAULT_PROJECT_SETTINGS, 'root')
    const created = createProjectSequence(
      sequenceProjectFromTimeline(root),
      'Scene two',
      factory(),
    )
    const sequenceIds = created.project.sequences.map((sequence) => sequence.id)
    const matched = matchEmptyProjectFrameRate(
      created.project,
      { num: 60, den: 1 },
    )
    expect(matched?.sequences.map((sequence) => sequence.frameRate)).toEqual([
      { num: 60, den: 1 },
      { num: 60, den: 1 },
    ])
    expect(matched?.sequences.map((sequence) => sequence.id)).toEqual(sequenceIds)
    const populated = {
      ...created.project,
      sequences: [populatedDocument(), created.project.sequences[1]],
      rootSequenceId: populatedDocument().id,
    }
    expect(matchEmptyProjectFrameRate(populated, { num: 24, den: 1 })).toBeNull()
    const marked = {
      ...created.project,
      sequences: created.project.sequences.map((sequence, index) => index === 1
        ? {
            ...sequence,
            markers: [{ id: 'timed-marker', frame: 30, label: 'Cue', color: 'blue' as const }],
          }
        : sequence),
    }
    expect(matchEmptyProjectFrameRate(marked, { num: 24, den: 1 })).toBeNull()
    const adjusted = {
      ...created.project,
      sequences: created.project.sequences.map((sequence, index) => index === 1
        ? {
            ...sequence,
            tracks: sequence.tracks.map((track, trackIndex) => trackIndex === 0
              ? {
                  ...track,
                  adjustments: [{
                    kind: 'adjustment' as const,
                    id: 'timed-adjustment',
                    name: 'Timed adjustment',
                    timelineRange: { startFrame: 0, durationFrames: 10 },
                    enabled: true,
                    opacity: 1,
                    animation: { tracks: [], effectTracks: [] },
                    effects: [],
                  }],
                }
              : track),
          }
        : sequence),
    }
    expect(matchEmptyProjectFrameRate(adjusted, { num: 24, den: 1 })).toBeNull()
  })

  test('duplicates complete edit intent while remapping every owned identity', () => {
    const source = populatedDocument()
    const result = duplicateProjectSequence(
      sequenceProjectFromTimeline(source),
      source.id,
      'Independent copy',
      factory(),
    )
    expect(result.failure).toBeNull()
    const duplicate = result.project.sequences[1]
    expect(duplicate.name).toBe('Independent copy')
    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate.tracks.map((track) => track.id)).not.toEqual(
      source.tracks.map((track) => track.id),
    )
    const sourceClips = source.tracks.flatMap((track) => track.clips)
    const copiedClips = duplicate.tracks.flatMap((track) => track.clips)
    expect(copiedClips.map((item) => item.id)).not.toEqual(
      sourceClips.map((item) => item.id),
    )
    const copiedVideo = copiedClips.find((item) => item.name === 'clip-video')!
    const copiedAudio = copiedClips.find((item) => item.name === 'clip-audio')!
    const copiedTitle = copiedClips.find((item) => item.text !== undefined)!
    expect(copiedVideo.linkGroupId).toBe(copiedAudio.linkGroupId)
    expect(copiedVideo.linkGroupId).not.toBe('link-av')
    expect(copiedVideo.effects[0].id).not.toBe('effect-1')
    expect(copiedVideo.audioEffects?.[0].id).not.toBe('audio-effect-clip')
    expect(copiedVideo.animation?.effectTracks?.[0].effectId)
      .toBe(copiedVideo.effects[0].id)
    expect(copiedTitle.assetId).toBe(proceduralTextAssetId(copiedTitle.id))
    const copiedAdjustment = duplicate.tracks[0].adjustments?.[0]
    expect(copiedAdjustment?.id).not.toBe('adjustment-1')
    expect(copiedAdjustment?.effects[0].id).not.toBe('effect-adjustment')
    expect(copiedAdjustment?.animation.effectTracks[0].effectId)
      .toBe(copiedAdjustment?.effects[0].id)
    expect(duplicate.tracks[4].audioEffects?.[0].id)
      .not.toBe('audio-effect-track')
    expect(duplicate.masterAudio?.audioEffects?.[0].id)
      .not.toBe('audio-effect-master')
    expect(duplicate.markers?.[0].id).not.toBe(source.markers?.[0].id)
    expect(duplicate.captionTracks?.[0].id).not.toBe(source.captionTracks?.[0].id)
    expect(duplicate.captionTracks?.[0].items[0].id)
      .not.toBe(source.captionTracks?.[0].items[0].id)
    expect(projectMediaAssetIds(result.project)).toEqual(new Set(['media-1']))
  })

  test('renames, chooses a root, and protects the root from deletion', () => {
    const start = sequenceProjectFromTimeline(populatedDocument())
    const created = createProjectSequence(start, 'Scene', factory())
    const sequenceId = created.sequenceId!
    const renamed = renameProjectSequence(created.project, sequenceId, 'Scene B')
    const rooted = chooseProjectRootSequence(renamed.project, sequenceId)
    expect(rooted.project.rootSequenceId).toBe(sequenceId)
    expect(rootSequence(rooted.project).name).toBe('Scene B')
    expect(deleteProjectSequence(rooted.project, sequenceId)).toMatchObject({
      project: rooted.project,
      failure: 'root-sequence-protected',
    })
    const deletedOldRoot = deleteProjectSequence(rooted.project, start.rootSequenceId)
    expect(deletedOldRoot.failure).toBeNull()
    expect(deletedOldRoot.project.sequences.map((sequence) => sequence.id))
      .toEqual([sequenceId])
  })

  test('replaces only a same-settings definition with its stable id', () => {
    const project = sequenceProjectFromTimeline(populatedDocument())
    const next = {
      ...project.sequences[0],
      tracks: project.sequences[0].tracks.slice(0, -1),
    }
    expect(replaceProjectSequence(project, next.id, next).sequences[0]).toBe(next)
    expect(replaceProjectSequence(project, next.id, {
      ...next,
      width: 1280,
    })).toBe(project)
    expect(replaceProjectSequence(project, 'missing', next)).toBe(project)
  })

  test('rejects an active edit that collides with another sequence identity', () => {
    const created = createProjectSequence(
      sequenceProjectFromTimeline(populatedDocument()),
      'Scene two',
      factory(),
    )
    const active = created.project.sequences[0]
    const colliding = {
      ...active,
      tracks: active.tracks.map((track, index) => index === 0
        ? { ...track, id: created.project.sequences[1].tracks[0].id }
        : track),
    }
    expect(sequenceProjectWithinEditBudget({
      ...created.project,
      sequences: [colliding, created.project.sequences[1]],
    })).toBe(false)
    expect(replaceProjectSequence(created.project, active.id, colliding))
      .toBe(created.project)
  })

  test('rejects duplication that would exceed an aggregate effect budget', () => {
    const source = JSON.parse(JSON.stringify(createTimelineDoc(
      'Effect-heavy',
      DEFAULT_PROJECT_SETTINGS,
      'sequence-effects',
    ))) as TimelineDoc
    source.tracks[0].clips = Array.from({ length: 5_001 }, (_, index) => {
      const item = clip(`clip-${index}`)
      item.timelineRange.startFrame = index * 10
      item.effects = [{
        id: `effect-${index}`,
        type: 'builtin.color-adjust',
        version: 1,
        enabled: true,
        params: {},
      }]
      return item
    })
    const project = sequenceProjectFromTimeline(source)
    expect(sequenceProjectWithinEditBudget(project)).toBe(true)
    expect(duplicateProjectSequence(
      project,
      source.id,
      'Too many effects',
      factory(),
    )).toMatchObject({
      project,
      failure: 'project-budget',
    })
  })
})
