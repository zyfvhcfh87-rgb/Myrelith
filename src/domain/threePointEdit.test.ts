/**
 * Three-point duration rule, targeting, and sequence-edit apply.
 *
 * Inputs are deep-frozen. Rejected apply paths must return the same
 * document reference.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  addCaptionItem,
  addCaptionTrack,
  createCaptionTrack,
} from './captions'
import { createSourceBoundsCatalog, resolveCrossfadePlan } from './crossfadePlan'
import { createAdjustmentItem } from './adjustmentItems'
import { addCrossfade, createTextClip } from './operations'
import type { Clip, MediaAsset, MediaSourceBounds, TimelineDoc, Track } from './schema'
import type { SourceMonitorSession } from './sourceMonitor'
import { rangeEnd } from './time'
import {
  applySequenceEdit,
  defaultSourcePatch,
  defaultTrackTargets,
  mapSourceClockRangeToDocument,
  planSequenceEdit,
  reconcileTrackTargets,
  resolveThreePointDuration,
  sequenceEditRejectionMessage,
  type SequenceEditInput,
} from './threePointEdit'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function makeClip(
  id: string,
  tlStart: number,
  duration: number,
  srcStart = 0,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId: 'asset-existing',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function makeTrack(
  id: string,
  kind: Track['kind'],
  clips: Clip[] = [],
  locked = false,
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function makeDoc(tracks?: Track[]): TimelineDoc {
  return deepFreeze({
    schemaVersion: 21,
    id: 'doc-three-point',
    name: 'three-point fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: tracks ?? [
      makeTrack('V1', 'video', [makeClip('clipA', 0, 100), makeClip('clipB', 100, 50)]),
      makeTrack('V2', 'video'),
      makeTrack('A1', 'audio', [makeClip('clipD', 0, 80)]),
      makeTrack('VL', 'video', [makeClip('clipE', 0, 50)], true),
    ],
  })
}

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return deepFreeze({
    id: 'asset-1',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 2048,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  })
}

function exactBounds(endTimestampUs = 4_000_000): MediaSourceBounds {
  return {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs },
  }
}

function boundsCatalog(
  ids: readonly string[],
  bounds: MediaSourceBounds = exactBounds(),
) {
  return createSourceBoundsCatalog(ids.map((id) => ({ id, sourceBounds: bounds })))
}

function session(
  over: Omit<Partial<SourceMonitorSession>, 'source'> & {
    source?: Partial<SourceMonitorSession['source']>
  } = {},
): SourceMonitorSession {
  const { source: sourceOver, ...rest } = over
  return deepFreeze({
    source: {
      assetId: 'asset-1',
      kind: 'video' as const,
      fileName: 'source.mp4',
      rate: { num: 30, den: 1 },
      durationFrames: 120,
      hasAudio: true,
      ...sourceOver,
    },
    playheadFrame: 0,
    inFrame: null,
    outFrameExclusive: null,
    shuttleStep: 0,
    ...rest,
  })
}

function input(over: Partial<SequenceEditInput> = {}): SequenceEditInput {
  return {
    kind: 'insert',
    doc: makeDoc(),
    asset: asset(),
    sourceSession: session(),
    playheadFrame: 200,
    timelineInFrame: null,
    timelineOutExclusive: null,
    videoTargetTrackId: 'V2',
    audioTargetTrackId: 'A1',
    patchVideo: true,
    patchAudio: false,
    selectedClipId: null,
    ...over,
  }
}

function clipsOf(doc: TimelineDoc, trackId: string): Clip[] {
  return doc.tracks.find((track) => track.id === trackId)?.clips ?? []
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveThreePointDuration', () => {
  const base = {
    sourceInFrame: null as number | null,
    sourceOutExclusive: null as number | null,
    sourceDurationFrames: 120,
    sourceRate: { num: 30, den: 1 },
    documentRate: { num: 30, den: 1 },
    assetDurationFrames: 120,
    timelineInFrame: null as number | null,
    timelineOutExclusive: null as number | null,
    playheadFrame: 10,
  }

  test('no marks is source-driven: full source at the playhead', () => {
    const result = resolveThreePointDuration(base)
    expect(result).toEqual({
      status: 'ok',
      rule: 'source-driven',
      timelineRange: { startFrame: 10, durationFrames: 120 },
      sourceRange: { startFrame: 0, durationFrames: 120 },
    })
  })

  test('source In/Out set duration; playhead is timeline start', () => {
    const result = resolveThreePointDuration({
      ...base,
      sourceInFrame: 30,
      sourceOutExclusive: 90,
    })
    expect(result).toMatchObject({
      status: 'ok',
      rule: 'source-driven',
      timelineRange: { startFrame: 10, durationFrames: 60 },
      sourceRange: { startFrame: 30, durationFrames: 60 },
    })
  })

  test('source In/Out plus Timeline Out places the range so it ends at Out', () => {
    const result = resolveThreePointDuration({
      ...base,
      sourceInFrame: 0,
      sourceOutExclusive: 40,
      timelineOutExclusive: 100,
    })
    expect(result).toMatchObject({
      status: 'ok',
      rule: 'source-driven',
      timelineRange: { startFrame: 60, durationFrames: 40 },
    })
  })

  test('Timeline Out earlier than the source duration rejects instead of going negative', () => {
    expect(resolveThreePointDuration({
      ...base,
      sourceOutExclusive: 50,
      timelineOutExclusive: 20,
    })).toEqual({ status: 'reject', reason: 'timeline-start-negative' })
  })

  test('both timeline marks without both source marks are timeline-driven', () => {
    const result = resolveThreePointDuration({
      ...base,
      sourceInFrame: 20,
      timelineInFrame: 10,
      timelineOutExclusive: 40,
    })
    expect(result).toMatchObject({
      status: 'ok',
      rule: 'timeline-driven',
      timelineRange: { startFrame: 10, durationFrames: 30 },
      sourceRange: { startFrame: 20, durationFrames: 30 },
    })
  })

  test('four-point matching durations are accepted', () => {
    const result = resolveThreePointDuration({
      ...base,
      sourceInFrame: 10,
      sourceOutExclusive: 70,
      timelineInFrame: 100,
      timelineOutExclusive: 160,
    })
    expect(result).toMatchObject({
      status: 'ok',
      rule: 'four-point-match',
      timelineRange: { startFrame: 100, durationFrames: 60 },
      sourceRange: { startFrame: 10, durationFrames: 60 },
    })
  })

  test('four-point mismatched durations never retimes', () => {
    expect(resolveThreePointDuration({
      ...base,
      sourceInFrame: 0,
      sourceOutExclusive: 40,
      timelineInFrame: 0,
      timelineOutExclusive: 80,
    })).toEqual({ status: 'reject', reason: 'duration-mismatch' })
  })

  test('empty source marks reject', () => {
    expect(resolveThreePointDuration({
      ...base,
      sourceInFrame: 40,
      sourceOutExclusive: 40,
    })).toEqual({ status: 'reject', reason: 'empty-range' })
  })
})

describe('mapSourceClockRangeToDocument', () => {
  test('keeps a full 60 fps source 2.000s long in a 30 fps project', () => {
    expect(mapSourceClockRangeToDocument({
      startFrame: 0,
      exclusiveEndFrame: 120,
      sourceDurationFrames: 120,
      sourceRate: { num: 60, den: 1 },
      documentRate: { num: 30, den: 1 },
      assetDurationFrames: 60,
    })).toEqual({ startFrame: 0, durationFrames: 60 })
  })

  test('maps a 60 fps In/Out pair onto 30 fps document frames', () => {
    expect(mapSourceClockRangeToDocument({
      startFrame: 30,
      exclusiveEndFrame: 90,
      sourceDurationFrames: 120,
      sourceRate: { num: 60, den: 1 },
      documentRate: { num: 30, den: 1 },
      assetDurationFrames: 60,
    })).toEqual({ startFrame: 15, durationFrames: 30 })
  })

  test('NTSC identity does not rescale', () => {
    expect(mapSourceClockRangeToDocument({
      startFrame: 0,
      exclusiveEndFrame: 30000,
      sourceDurationFrames: 30000,
      sourceRate: { num: 30000, den: 1001 },
      documentRate: { num: 30000, den: 1001 },
      assetDurationFrames: 30000,
    })).toEqual({ startFrame: 0, durationFrames: 30000 })
  })
})

describe('track targeting', () => {
  test('defaults to the first unlocked video and audio lanes', () => {
    expect(defaultTrackTargets(makeDoc())).toEqual({
      videoTrackId: 'V1',
      audioTrackId: 'A1',
    })
  })

  test('drops a locked or missing target without inventing a replacement', () => {
    expect(reconcileTrackTargets(makeDoc(), {
      videoTrackId: 'VL',
      audioTrackId: 'missing',
    })).toEqual({ videoTrackId: null, audioTrackId: null })
  })

  test('an A/V asset patches both kinds', () => {
    expect(defaultSourcePatch(asset())).toEqual({ video: true, audio: true })
    expect(defaultSourcePatch(asset({ kind: 'audio', hasAudio: true, width: null, height: null })))
      .toEqual({ video: false, audio: true })
    expect(defaultSourcePatch(asset({ kind: 'image', hasAudio: false })))
      .toEqual({ video: true, audio: false })
  })
})

describe('planSequenceEdit rejections', () => {
  test('insert without a Source Monitor session names the missing source', () => {
    const plan = planSequenceEdit(input({ sourceSession: null }))
    expect(plan).toEqual({ status: 'reject', reason: 'missing-source' })
    expect(sequenceEditRejectionMessage('missing-source')).toMatch(/Source Monitor/)
  })

  test('insert onto a locked target rejects the whole edit', () => {
    expect(planSequenceEdit(input({
      videoTargetTrackId: 'VL',
      patchAudio: false,
    }))).toEqual({ status: 'reject', reason: 'locked-track' })
  })

  test('insert with both patches off rejects', () => {
    expect(planSequenceEdit(input({
      patchVideo: false,
      patchAudio: false,
    }))).toEqual({ status: 'reject', reason: 'no-patch' })
  })

  test('lift without both timeline marks rejects', () => {
    expect(planSequenceEdit(input({
      kind: 'lift',
      timelineInFrame: 10,
      timelineOutExclusive: null,
    }))).toEqual({ status: 'reject', reason: 'timeline-range-incomplete' })
  })

  test('four-point insert mismatch is duration-mismatch, not a guessed fit', () => {
    expect(planSequenceEdit(input({
      sourceSession: session({ inFrame: 0, outFrameExclusive: 30 }),
      timelineInFrame: 0,
      timelineOutExclusive: 90,
    }))).toEqual({ status: 'reject', reason: 'duration-mismatch' })
  })
})

describe('insert', () => {
  test('places the prepared source on the targeted empty lane at the playhead', () => {
    const start = input()
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(start.doc, plan, start.asset)
    expect(next).not.toBe(start.doc)
    const placed = clipsOf(next, 'V2')
    expect(placed).toHaveLength(1)
    expect(placed[0]!.timelineRange).toEqual({ startFrame: 200, durationFrames: 120 })
    expect(placed[0]!.sourceRange).toEqual({ startFrame: 0, durationFrames: 120 })
    expect(clipsOf(start.doc, 'V2')).toHaveLength(0)
  })

  test('ripples later clips on unlocked tracks and splits a spanning clip', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('span', 0, 200)]),
      makeTrack('V2', 'video', [makeClip('later', 80, 40)]),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc,
      playheadFrame: 50,
      videoTargetTrackId: 'A1',
      patchVideo: true,
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
      asset: asset(),
    })
    const plan = planSequenceEdit({ ...start, videoTargetTrackId: 'A1' })
    expect(plan.status).toBe('reject')

    const videoInsert = input({
      doc,
      playheadFrame: 50,
      videoTargetTrackId: 'V2',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const videoPlan = planSequenceEdit(videoInsert)
    expect(videoPlan.status).toBe('ok')
    if (videoPlan.status !== 'ok') return
    const next = applySequenceEdit(doc, videoPlan, videoInsert.asset)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 50 },
      { startFrame: 70, durationFrames: 150 },
    ])
    expect(clipsOf(next, 'V2').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 50, durationFrames: 20 },
      { startFrame: 100, durationFrames: 40 },
    ])
  })

  test('ripples later adjustments with later clips', () => {
    const v1 = makeTrack('V1', 'video')
    const doc = makeDoc([
      { ...v1, adjustments: [createAdjustmentItem(80, 20)] },
      makeTrack('V2', 'video', [makeClip('later', 80, 40)]),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc,
      playheadFrame: 50,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 50, durationFrames: 20 },
    ])
    expect(next.tracks.find((track) => track.id === 'V1')!.adjustments![0]!
      .timelineRange).toEqual({ startFrame: 100, durationFrames: 20 })
    expect(clipsOf(next, 'V2').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 100, durationFrames: 40 },
    ])
  })

  test('splits a covering adjustment so insert can occupy the playhead', () => {
    const v1 = makeTrack('V1', 'video')
    const doc = makeDoc([
      { ...v1, adjustments: [createAdjustmentItem(0, 100)] },
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc,
      playheadFrame: 50,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(next).not.toBe(doc)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 50, durationFrames: 20 },
    ])
    expect(next.tracks.find((track) => track.id === 'V1')!.adjustments!
      .map((item) => item.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 50 },
      { startFrame: 70, durationFrames: 50 },
    ])
  })

  test('linked A/V insert is one apply with a shared group id', () => {
    const emptyAudio = makeDoc([
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc: emptyAudio,
      playheadFrame: 10,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: 'A1',
      patchVideo: true,
      patchAudio: true,
      sourceSession: session({ inFrame: 10, outFrameExclusive: 40 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan).toMatchObject({ status: 'ok', kind: 'insert', linkPlacements: true })
    if (plan.status !== 'ok' || plan.kind !== 'insert') return
    const next = applySequenceEdit(emptyAudio, plan, start.asset)
    const video = clipsOf(next, 'V1')[0]!
    const audio = clipsOf(next, 'A1')[0]!
    expect(video.timelineRange).toEqual({ startFrame: 10, durationFrames: 30 })
    expect(audio.timelineRange).toEqual({ startFrame: 10, durationFrames: 30 })
    expect(video.linkGroupId).toBe(audio.linkGroupId)
    expect(video.linkGroupId).toBeDefined()
    expect(video.sourceRange.startFrame).toBe(10)
  })

  test('a locked later clip rejects insert and keeps the original doc', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video'),
      makeTrack('VL', 'video', [makeClip('locked-later', 80, 20)], true),
    ])
    const start = input({
      doc,
      playheadFrame: 0,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 10 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(next).toBe(doc)
  })
})

describe('overwrite', () => {
  test('punches the targeted range and leaves a gap-filling source clip', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 0, 200)]),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      kind: 'overwrite',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(next).not.toBe(doc)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 40 },
      { startFrame: 40, durationFrames: 20 },
      { startFrame: 60, durationFrames: 140 },
    ])
    expect(clipsOf(next, 'V1')[1]!.assetId).toBe('asset-1')
  })

  test('punches an adjustment in the targeted range', () => {
    const v1 = makeTrack('V1', 'video')
    const doc = makeDoc([{
      ...v1,
      adjustments: [createAdjustmentItem(40, 20)],
    }, makeTrack('A1', 'audio')])
    const start = input({
      kind: 'overwrite',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(next).not.toBe(doc)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 40, durationFrames: 20 },
    ])
    expect(next.tracks.find((track) => track.id === 'V1')!.adjustments).toEqual([])
  })
})

describe('lift and extract', () => {
  test('lift removes the timeline range and leaves a gap', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 0, 200)]),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      kind: 'lift',
      doc,
      timelineInFrame: 40,
      timelineOutExclusive: 60,
      videoTargetTrackId: 'V1',
      patchAudio: false,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, null)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 40 },
      { startFrame: 60, durationFrames: 140 },
    ])
  })

  test('lift of a linked A/V range keeps leftover pairs and does not warn', () => {
    const empty = makeDoc([
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc: empty,
      playheadFrame: 0,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: 'A1',
      patchVideo: true,
      patchAudio: true,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 80 }),
    })
    const insertedPlan = planSequenceEdit(start)
    expect(insertedPlan.status).toBe('ok')
    if (insertedPlan.status !== 'ok') return
    const inserted = applySequenceEdit(empty, insertedPlan, start.asset)
    const liftPlan = planSequenceEdit(input({
      kind: 'lift',
      doc: inserted,
      timelineInFrame: 20,
      timelineOutExclusive: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: 'A1',
    }))
    expect(liftPlan.status).toBe('ok')
    if (liftPlan.status !== 'ok') return
    const lifted = applySequenceEdit(inserted, liftPlan, null)
    expect(lifted).not.toBe(inserted)
    expect(console.warn).not.toHaveBeenCalled()
    const video = clipsOf(lifted, 'V1')
    const audio = clipsOf(lifted, 'A1')
    expect(video.map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 20 },
      { startFrame: 40, durationFrames: 40 },
    ])
    expect(audio.map((clip) => clip.timelineRange)).toEqual(video.map((clip) => clip.timelineRange))
    expect(video[0]!.linkGroupId).toBe(audio[0]!.linkGroupId)
    expect(video[1]!.linkGroupId).toBe(audio[1]!.linkGroupId)
    expect(video[0]!.linkGroupId).toBeDefined()
    expect(video[1]!.linkGroupId).toBeDefined()
    expect(video[0]!.linkGroupId).not.toBe(video[1]!.linkGroupId)
  })

  test('video-only lift keeps co-starting leftovers linked and unlinks the later orphan', () => {
    const empty = makeDoc([
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      doc: empty,
      playheadFrame: 0,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: 'A1',
      patchVideo: true,
      patchAudio: true,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 80 }),
    })
    const insertedPlan = planSequenceEdit(start)
    expect(insertedPlan.status).toBe('ok')
    if (insertedPlan.status !== 'ok') return
    const inserted = applySequenceEdit(empty, insertedPlan, start.asset)
    const liftPlan = planSequenceEdit(input({
      kind: 'lift',
      doc: inserted,
      timelineInFrame: 20,
      timelineOutExclusive: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
    }))
    expect(liftPlan.status).toBe('ok')
    if (liftPlan.status !== 'ok') return
    const lifted = applySequenceEdit(inserted, liftPlan, null)
    expect(lifted).not.toBe(inserted)
    expect(console.warn).not.toHaveBeenCalled()
    const video = clipsOf(lifted, 'V1')
    const audio = clipsOf(lifted, 'A1')
    expect(video.map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 20 },
      { startFrame: 40, durationFrames: 40 },
    ])
    expect(audio.map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 80 },
    ])
    expect(video[0]!.linkGroupId).toBe(audio[0]!.linkGroupId)
    expect(video[0]!.linkGroupId).toBeDefined()
    expect(video[1]!.linkGroupId).toBeUndefined()
    expect('linkGroupId' in video[1]!).toBe(false)
  })

  test('extract closes the gap on the targeted track only', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 0, 200)]),
      makeTrack('A1', 'audio', [makeClip('audio-later', 80, 40)]),
    ])
    const start = input({
      kind: 'extract',
      doc,
      timelineInFrame: 40,
      timelineOutExclusive: 60,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, null)
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 40 },
      { startFrame: 40, durationFrames: 140 },
    ])
    expect(clipsOf(next, 'A1')[0]!.timelineRange).toEqual({ startFrame: 80, durationFrames: 40 })
  })

  test('extract punches an in-range adjustment so later clips can close the gap', () => {
    const v1 = makeTrack('V1', 'video', [makeClip('later', 80, 40)])
    const doc = makeDoc([
      { ...v1, adjustments: [createAdjustmentItem(40, 30)] },
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      kind: 'extract',
      doc,
      timelineInFrame: 40,
      timelineOutExclusive: 60,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, null)
    expect(next).not.toBe(doc)
    expect(next.tracks.find((track) => track.id === 'V1')!.adjustments!
      .map((item) => item.timelineRange)).toEqual([
      { startFrame: 40, durationFrames: 10 },
    ])
    expect(clipsOf(next, 'V1').map((clip) => clip.timelineRange)).toEqual([
      { startFrame: 60, durationFrames: 40 },
    ])
  })
})

describe('replace', () => {
  test('keeps the clip duration and uses the source In as the new start', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 10, 40)]),
      makeTrack('A1', 'audio'),
    ])
    const start = input({
      kind: 'replace',
      doc,
      selectedClipId: 'host',
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 20, outFrameExclusive: null }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    const replaced = clipsOf(next, 'V1')[0]!
    expect(replaced.id).toBe('host')
    expect(replaced.assetId).toBe('asset-1')
    expect(replaced.timelineRange).toEqual({ startFrame: 10, durationFrames: 40 })
    expect(replaced.sourceRange).toEqual({ startFrame: 20, durationFrames: 40 })
  })

  test('an explicit source range of a different length is duration-mismatch', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 0, 40)]),
    ])
    expect(planSequenceEdit(input({
      kind: 'replace',
      doc,
      selectedClipId: 'host',
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 10 }),
    }))).toEqual({ status: 'reject', reason: 'duration-mismatch' })
  })
})

describe('roll', () => {
  test('moves a touching seam and preserves total duration', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 40, 0), makeClip('right', 40, 40, 40)]),
    ])
    const catalog = boundsCatalog(['asset-existing'])
    const start = input({
      kind: 'roll',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 10,
      sourceBoundsCatalog: catalog,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, null, catalog)
    expect(next).not.toBe(doc)
    const [left, right] = clipsOf(next, 'V1')
    expect(left!.timelineRange).toEqual({ startFrame: 0, durationFrames: 50 })
    expect(right!.timelineRange).toEqual({ startFrame: 50, durationFrames: 30 })
    expect(rangeEnd(left!.timelineRange)).toBe(right!.timelineRange.startFrame)
    expect(left!.timelineRange.durationFrames + right!.timelineRange.durationFrames).toBe(80)
    expect(left!.sourceRange).toEqual({ startFrame: 0, durationFrames: 50 })
    expect(right!.sourceRange.startFrame).toBe(50)
  })

  test('a roll that would shrink a clip below one frame is rejected', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 4), makeClip('right', 4, 4)]),
    ])
    expect(planSequenceEdit(input({
      kind: 'roll',
      doc,
      playheadFrame: 4,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 4,
      sourceBoundsCatalog: boundsCatalog(['asset-existing']),
    }))).toEqual({ status: 'reject', reason: 'insufficient-source-handle' })
  })

  test('timed roll without catalog handles is rejected', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 40, 0), makeClip('right', 40, 40, 40)]),
    ])
    expect(planSequenceEdit(input({
      kind: 'roll',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 1,
    }))).toEqual({ status: 'reject', reason: 'insufficient-source-handle' })
  })

  test('unknown source bounds cannot supply a roll handle', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 40, 0), makeClip('right', 40, 40, 40)]),
    ])
    expect(planSequenceEdit(input({
      kind: 'roll',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 1,
      sourceBoundsCatalog: boundsCatalog(['asset-existing'], {
        video: { status: 'unknown' },
        audio: { status: 'unknown' },
      }),
    }))).toEqual({ status: 'reject', reason: 'insufficient-source-handle' })
  })

  test('a roll past the remaining source handle is rejected', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 40, 0), makeClip('right', 40, 40, 40)]),
    ])
    expect(planSequenceEdit(input({
      kind: 'roll',
      doc,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 10,
      sourceBoundsCatalog: boundsCatalog(['asset-existing'], exactBounds(1_333_334)),
    }))).toEqual({ status: 'reject', reason: 'insufficient-source-handle' })
  })

  test('a roll that would starve a valid crossfade is rejected', () => {
    const seeded = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 20, 0), makeClip('right', 20, 20, 20)]),
    ])
    const withFade = addCrossfade(seeded, 'left', 'right', 8)
    expect(withFade).not.toBe(seeded)
    const catalog = boundsCatalog(['asset-existing'])
    expect(planSequenceEdit(input({
      kind: 'roll',
      doc: withFade,
      playheadFrame: 20,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 17,
      sourceBoundsCatalog: catalog,
    }))).toEqual({ status: 'reject', reason: 'roll-transition-invalid' })
  })

  test('a modest roll keeps a valid crossfade plan available', () => {
    const seeded = makeDoc([
      makeTrack('V1', 'video', [makeClip('left', 0, 40, 0), makeClip('right', 40, 40, 40)]),
    ])
    const withFade = addCrossfade(seeded, 'left', 'right', 8)
    const catalog = boundsCatalog(['asset-existing'])
    const start = input({
      kind: 'roll',
      doc: withFade,
      playheadFrame: 40,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 4,
      sourceBoundsCatalog: catalog,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(withFade, plan, null, catalog)
    const transition = next.tracks[0]!.transitions[0]!
    expect(resolveCrossfadePlan(next, 'V1', transition.id, catalog).status).toBe('available')
  })

  test('playhead off the seam is roll-seam-invalid', () => {
    expect(planSequenceEdit(input({
      kind: 'roll',
      playheadFrame: 12,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
      rollDeltaFrames: 1,
      sourceBoundsCatalog: boundsCatalog(['asset-existing']),
    }))).toEqual({ status: 'reject', reason: 'roll-seam-invalid' })
  })
})

describe('captions, hidden tracks, stills, and offline', () => {
  test('insert ripples later caption cues', () => {
    let doc = makeDoc([
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
    ])
    doc = addCaptionTrack(doc, createCaptionTrack('cap-1', 'English', 'en'))
    doc = addCaptionItem(doc, 'cap-1', {
      id: 'cue-early',
      range: { startFrame: 0, durationFrames: 10 },
      text: 'early',
    })
    doc = addCaptionItem(doc, 'cap-1', {
      id: 'cue-late',
      range: { startFrame: 80, durationFrames: 10 },
      text: 'late',
    })
    const start = input({
      doc,
      playheadFrame: 50,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 20 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(next.captionTracks?.[0]?.items.map((cue) => cue.range.startFrame)).toEqual([0, 100])
  })

  test('lift removes fully covered caption cues and extract closes them', () => {
    let doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('host', 0, 200)]),
    ])
    doc = addCaptionTrack(doc, createCaptionTrack('cap-1', 'English', 'en'))
    doc = addCaptionItem(doc, 'cap-1', {
      id: 'cue-mid',
      range: { startFrame: 40, durationFrames: 20 },
      text: 'mid',
    })
    doc = addCaptionItem(doc, 'cap-1', {
      id: 'cue-late',
      range: { startFrame: 80, durationFrames: 10 },
      text: 'late',
    })
    const lifted = applySequenceEdit(doc, planSequenceEdit(input({
      kind: 'lift',
      doc,
      timelineInFrame: 40,
      timelineOutExclusive: 60,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
    })), null)
    expect(lifted.captionTracks?.[0]?.items.map((cue) => cue.id)).toEqual(['cue-late'])
    expect(lifted.captionTracks?.[0]?.items[0]?.range.startFrame).toBe(80)

    const extracted = applySequenceEdit(doc, planSequenceEdit(input({
      kind: 'extract',
      doc,
      timelineInFrame: 40,
      timelineOutExclusive: 60,
      videoTargetTrackId: 'V1',
      audioTargetTrackId: null,
    })), null)
    expect(extracted.captionTracks?.[0]?.items.map((cue) => [
      cue.id,
      cue.range.startFrame,
    ])).toEqual([['cue-late', 60]])
  })

  test('insert ripples an unlocked hidden track', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video'),
      { ...makeTrack('V2', 'video', [makeClip('later', 10, 20)]), hidden: true },
    ])
    const start = input({
      doc,
      playheadFrame: 0,
      videoTargetTrackId: 'V1',
      patchAudio: false,
      sourceSession: session({ inFrame: 0, outFrameExclusive: 15 }),
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, start.asset)
    expect(clipsOf(next, 'V2')[0]!.timelineRange.startFrame).toBe(25)
  })

  test('a still image insert keeps the one-frame source', () => {
    const still = asset({
      id: 'asset-still',
      kind: 'image',
      fileName: 'still.png',
      mimeType: 'image/png',
      hasAudio: false,
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
      frameRate: null,
      sourceBounds: {
        video: { status: 'unknown' },
        audio: null,
      },
    })
    const doc = makeDoc([makeTrack('V1', 'video'), makeTrack('A1', 'audio')])
    const start = input({
      doc,
      asset: still,
      sourceSession: session({
        source: {
          assetId: 'asset-still',
          kind: 'image',
          fileName: 'still.png',
          rate: { num: 30, den: 1 },
          durationFrames: 1,
          hasAudio: false,
        },
      }),
      playheadFrame: 12,
      videoTargetTrackId: 'V1',
      patchAudio: false,
    })
    const plan = planSequenceEdit(start)
    expect(plan).toMatchObject({ status: 'ok', still: true })
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, still)
    const placed = clipsOf(next, 'V1')[0]!
    expect(placed.sourceMode).toBe('still')
    expect(placed.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(placed.timelineRange).toEqual({ startFrame: 12, durationFrames: 150 })
  })

  test('audio-only insert lands on the audio target', () => {
    const sound = asset({
      kind: 'audio',
      fileName: 'tone.wav',
      mimeType: 'audio/wav',
      width: null,
      height: null,
      frameRate: null,
      sourceBounds: {
        video: null,
        audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      },
    })
    const doc = makeDoc([makeTrack('V1', 'video'), makeTrack('A1', 'audio')])
    const start = input({
      doc,
      asset: sound,
      sourceSession: session({
        source: { kind: 'audio', hasAudio: true, durationFrames: 120 },
        inFrame: 0,
        outFrameExclusive: 30,
      }),
      playheadFrame: 8,
      patchVideo: false,
      patchAudio: true,
      videoTargetTrackId: null,
      audioTargetTrackId: 'A1',
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, sound)
    expect(clipsOf(next, 'V1')).toHaveLength(0)
    expect(clipsOf(next, 'A1')[0]!.timelineRange).toEqual({ startFrame: 8, durationFrames: 30 })
  })

  test('replace refuses a text overlay', () => {
    const empty = makeDoc([makeTrack('V1', 'video')])
    const text = createTextClip(empty, 0, 40, 'Title')
    const doc = makeDoc([makeTrack('V1', 'video', [text])])
    expect(planSequenceEdit(input({
      kind: 'replace',
      doc,
      selectedClipId: text.id,
      videoTargetTrackId: 'V1',
      patchAudio: false,
    }))).toEqual({ status: 'reject', reason: 'replace-text-clip' })
  })

  test('insert at NTSC keeps integer document frames', () => {
    const ntsc = asset({
      durationFrames: 30,
      durationMicroseconds: 1_001_000,
      frameRate: { num: 30000, den: 1001 },
    })
    const doc = {
      ...makeDoc([makeTrack('V1', 'video'), makeTrack('A1', 'audio')]),
      frameRate: { num: 30000, den: 1001 },
    }
    const start = input({
      doc,
      asset: ntsc,
      sourceSession: session({
        source: { rate: { num: 30000, den: 1001 }, durationFrames: 30 },
        inFrame: 0,
        outFrameExclusive: 30,
      }),
      playheadFrame: 7,
      videoTargetTrackId: 'V1',
      patchAudio: false,
    })
    const plan = planSequenceEdit(start)
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applySequenceEdit(doc, plan, ntsc)
    const placed = clipsOf(next, 'V1')[0]!
    expect(placed.timelineRange).toEqual({ startFrame: 7, durationFrames: 30 })
    expect(Number.isInteger(placed.timelineRange.startFrame)).toBe(true)
  })

  test('an open session with no connected asset is offline', () => {
    expect(planSequenceEdit(input({ asset: null }))).toEqual({
      status: 'reject',
      reason: 'offline',
    })
  })
})

describe('fuzz and identity fixtures', () => {
  test('rejected plans never change the document reference', () => {
    const doc = makeDoc()
    const catalog = boundsCatalog(['asset-existing', 'asset-1'])
    const kinds = ['insert', 'overwrite', 'lift', 'extract', 'replace', 'roll'] as const
    for (const kind of kinds) {
      const plan = planSequenceEdit(input({
        kind,
        doc,
        playheadFrame: 3,
        rollDeltaFrames: 1,
        sourceBoundsCatalog: catalog,
      }))
      if (plan.status !== 'reject') continue
      expect(applySequenceEdit(doc, plan, asset(), catalog)).toBe(doc)
    }
  })

  test.each([1, 7, 13, 29, 99] as const)(
    'seed %s keeps integer ranges and no overlaps',
    (seed) => {
      const duration = 20 + (seed % 40)
      const seam = 10 + (seed % 10)
      const doc = makeDoc([
        makeTrack('V1', 'video', [
          makeClip('left', 0, seam, 0),
          makeClip('right', seam, duration, seam),
        ]),
        makeTrack('V2', 'video', [makeClip('other', 5, 8)]),
        makeTrack('A1', 'audio', [makeClip('tone', 0, 12)]),
      ])
      const catalog = boundsCatalog(['asset-existing', 'asset-1'])
      const kinds = [
        { kind: 'insert' as const, playheadFrame: seed % 15 },
        { kind: 'overwrite' as const, playheadFrame: seed % 15 },
        {
          kind: 'lift' as const,
          timelineInFrame: 2,
          timelineOutExclusive: 6,
        },
        {
          kind: 'extract' as const,
          timelineInFrame: 2,
          timelineOutExclusive: 6,
        },
        { kind: 'replace' as const, selectedClipId: 'left' as const },
        { kind: 'roll' as const, playheadFrame: seam, rollDeltaFrames: seed % 2 === 0 ? 1 : -1 },
      ]
      for (const extras of kinds) {
        const plan = planSequenceEdit(input({
          ...extras,
          doc,
          videoTargetTrackId: 'V1',
          patchAudio: extras.kind === 'insert' || extras.kind === 'overwrite'
            ? false
            : true,
          sourceBoundsCatalog: catalog,
          sourceSession: session({ inFrame: 0, outFrameExclusive: 10 }),
        }))
        if (plan.status === 'reject') {
          expect(applySequenceEdit(doc, plan, asset(), catalog)).toBe(doc)
          continue
        }
        const next = applySequenceEdit(doc, plan, asset(), catalog)
        if (next === doc) continue
        for (const track of next.tracks) {
          const sorted = track.clips.slice().sort(
            (left, right) => left.timelineRange.startFrame - right.timelineRange.startFrame,
          )
          for (const clip of sorted) {
            expect(Number.isInteger(clip.timelineRange.startFrame)).toBe(true)
            expect(clip.timelineRange.durationFrames).toBeGreaterThanOrEqual(1)
            expect(clip.timelineRange.startFrame).toBeGreaterThanOrEqual(0)
          }
          for (let index = 1; index < sorted.length; index++) {
            expect(rangeEnd(sorted[index - 1]!.timelineRange))
              .toBeLessThanOrEqual(sorted[index]!.timelineRange.startFrame)
          }
        }
      }
    },
  )
})

describe('applySequenceEdit rejection contract', () => {
  test('a rejected plan returns the original document reference', () => {
    const doc = makeDoc()
    const next = applySequenceEdit(doc, { status: 'reject', reason: 'missing-source' }, null)
    expect(next).toBe(doc)
  })
})
