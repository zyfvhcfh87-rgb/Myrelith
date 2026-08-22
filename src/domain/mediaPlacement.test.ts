import { describe, expect, test } from 'vitest'
import {
  planMediaAssetPlacement,
  resolveTimelineFileDropPolicy,
  TIMELINE_MULTI_FILE_DROP_MESSAGE,
  timelineFrameFromPointer,
  trackKindAcceptsAssetKind,
  visiblePlacementPreviewRange,
} from './mediaPlacement'
import type { Clip, TimelineDoc, Track } from './schema'

function clip(id: string, startFrame: number, durationFrames = 100): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame, durationFrames },
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
    effects: [],
  }
}

function track(
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

function doc(tracks: Track[], id = 'doc-place'): TimelineDoc {
  return {
    schemaVersion: 14,
    id,
    name: 'placement fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

const videoAsset = {
  kind: 'video' as const,
  durationFrames: 120,
  hasAudio: true,
}

describe('timelineFrameFromPointer', () => {
  test('rounds local pixels through zoom and adds the bounded origin', () => {
    expect(timelineFrameFromPointer(0, 240, 1)).toBe(240)
    expect(timelineFrameFromPointer(0, 240, 2)).toBe(120)
    expect(timelineFrameFromPointer(1_000_000, 240, 2)).toBe(1_000_120)
  })

  test('clamps negative frames and ignores invalid zoom', () => {
    expect(timelineFrameFromPointer(0, -40, 1)).toBe(0)
    expect(timelineFrameFromPointer(90, 10, 0)).toBe(90)
    expect(timelineFrameFromPointer(90, 10, Number.NaN)).toBe(90)
  })
})

describe('resolveTimelineFileDropPolicy', () => {
  test('accepts exactly one file and refuses any other count', () => {
    expect(resolveTimelineFileDropPolicy(1)).toEqual({ status: 'accept' })
    expect(resolveTimelineFileDropPolicy(0)).toEqual({
      status: 'refuse',
      message: TIMELINE_MULTI_FILE_DROP_MESSAGE,
    })
    expect(resolveTimelineFileDropPolicy(2)).toEqual({
      status: 'refuse',
      message: TIMELINE_MULTI_FILE_DROP_MESSAGE,
    })
  })
})

describe('trackKindAcceptsAssetKind', () => {
  test('video lanes take video and stills; audio lanes take audio only', () => {
    expect(trackKindAcceptsAssetKind('video', 'video')).toBe(true)
    expect(trackKindAcceptsAssetKind('video', 'image')).toBe(true)
    expect(trackKindAcceptsAssetKind('video', 'audio')).toBe(false)
    expect(trackKindAcceptsAssetKind('audio', 'audio')).toBe(true)
    expect(trackKindAcceptsAssetKind('audio', 'video')).toBe(false)
    expect(trackKindAcceptsAssetKind('audio', 'image')).toBe(false)
  })
})

describe('planMediaAssetPlacement', () => {
  test('links a video-with-audio onto the first unlocked audio lane', () => {
    expect(planMediaAssetPlacement({
      doc: doc([track('V1', 'video'), track('A1', 'audio')]),
      asset: videoAsset,
      trackId: 'V1',
      startFrame: 240,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-linked',
      videoTrackId: 'V1',
      audioTrackId: 'A1',
      startFrame: 240,
    })
  })

  test('falls back to an unlinked video clip when no unlocked audio lane exists', () => {
    expect(planMediaAssetPlacement({
      doc: doc([track('V1', 'video'), track('A1', 'audio', [], true)]),
      asset: videoAsset,
      trackId: 'V1',
      startFrame: 30,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-single',
      trackId: 'V1',
      startFrame: 30,
    })
  })

  test('links onto the next free audio lane when A1 already overlaps', () => {
    expect(planMediaAssetPlacement({
      doc: doc([
        track('V1', 'video'),
        track('V2', 'video'),
        track('A1', 'audio', [clip('existingA', 200, 100)]),
        track('A2', 'audio'),
      ]),
      asset: videoAsset,
      trackId: 'V2',
      startFrame: 240,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-linked',
      videoTrackId: 'V2',
      audioTrackId: 'A2',
      startFrame: 240,
    })
  })

  test('lands an unlinked video when every unlocked audio lane overlaps', () => {
    expect(planMediaAssetPlacement({
      doc: doc([
        track('V1', 'video'),
        track('A1', 'audio', [clip('existingA', 200, 100)]),
      ]),
      asset: videoAsset,
      trackId: 'V1',
      startFrame: 240,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-single',
      trackId: 'V1',
      startFrame: 240,
    })
  })

  test('rejects overlap, lock, kind, compatibility, and missing targets', () => {
    const occupied = doc([
      track('V1', 'video', [clip('existing', 200, 100)]),
      track('A1', 'audio'),
      track('VL', 'video', [], true),
    ])
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: videoAsset,
      trackId: 'V1',
      startFrame: 240,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'overlap' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: videoAsset,
      trackId: 'VL',
      startFrame: 0,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'locked-track' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: videoAsset,
      trackId: 'A1',
      startFrame: 0,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'wrong-kind' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: videoAsset,
      trackId: 'gone',
      startFrame: 0,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'missing-track' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: videoAsset,
      trackId: 'V1',
      startFrame: 0,
      timelineCompatible: false,
    })).toEqual({ status: 'reject', reason: 'incompatible' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: null,
      trackId: 'V1',
      startFrame: 0,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'missing-asset' })
    expect(planMediaAssetPlacement({
      doc: occupied,
      asset: { ...videoAsset, durationFrames: 0 },
      trackId: 'V1',
      startFrame: 0,
      timelineCompatible: true,
    })).toEqual({ status: 'reject', reason: 'invalid-duration' })
  })

  test('places stills and audio on matching lanes without pairing', () => {
    const empty = doc([track('V1', 'video'), track('A1', 'audio')])
    expect(planMediaAssetPlacement({
      doc: empty,
      asset: { kind: 'image', durationFrames: 150, hasAudio: false },
      trackId: 'V1',
      startFrame: 30,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-single',
      trackId: 'V1',
      startFrame: 30,
    })
    expect(planMediaAssetPlacement({
      doc: empty,
      asset: { kind: 'audio', durationFrames: 90, hasAudio: true },
      trackId: 'A1',
      startFrame: 12,
      timelineCompatible: true,
    })).toEqual({
      status: 'place-single',
      trackId: 'A1',
      startFrame: 12,
    })
  })
})

describe('visiblePlacementPreviewRange', () => {
  test('clips a duration-accurate ghost to the bounded window', () => {
    expect(visiblePlacementPreviewRange(90, 40, 100, 120)).toEqual({
      startFrame: 100,
      durationFrames: 20,
    })
  })

  test('renders an OS-file marker as one frame and hides fully offscreen ranges', () => {
    expect(visiblePlacementPreviewRange(240, null, 0, 1_000)).toEqual({
      startFrame: 240,
      durationFrames: 1,
    })
    expect(visiblePlacementPreviewRange(10, 20, 50, 80)).toBeNull()
  })
})
