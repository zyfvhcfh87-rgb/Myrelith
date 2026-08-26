import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import { executeEditorCommand, resolveEditorCommand } from './editorCommands'
import { executeSequenceEdit } from './sequenceEditController'

function clip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    id,
    assetId: 'asset-existing',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function track(id: string, kind: Track['kind'], clips: Clip[] = []): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function documentFixture(): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc-sequence',
    name: 'Sequence fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      track('V1', 'video', [clip('host', 0, 90)]),
      track('A1', 'audio'),
    ],
  }
}

function sourceAsset(): MediaAsset {
  return {
    id: 'asset-source',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 1024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 60,
    durationMicroseconds: 2_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
  }
}

function openSource(): void {
  const asset = sourceAsset()
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([[asset.id, asset]]),
    visuals: new Map(),
    compatibility: new Map([[asset.id, {
      id: asset.id,
      requestId: 'req-source',
      fileName: asset.fileName,
      declaredMimeType: asset.mimeType,
      size: asset.size,
      lastModified: asset.lastModified,
      status: 'ready',
      report: null,
    }]]),
  })
  useSourceMonitorStore.getState().openSource({ asset })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.getState().setDoc(documentFixture())
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE, playheadFrame: 90 })
  useSourceMonitorStore.getState().resetSourceMonitor()
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

describe('sequence edits', () => {
  test('insert is disabled until a source is open', () => {
    expect(resolveEditorCommand('timeline.insert')).toMatchObject({
      enabled: false,
      disabledReason: 'Open a source in the Source Monitor first.',
    })
    expect(executeEditorCommand('timeline.insert').executed).toBe(false)
  })

  test('insert from an open source is one undo entry and restores on undo', () => {
    openSource()
    const before = useDocumentStore.getState().doc
    expect(executeSequenceEdit('insert').executed).toBe(true)
    const after = useDocumentStore.getState().doc
    expect(after).not.toBe(before)
    expect(after.tracks[0]!.clips.map((item) => item.timelineRange)).toEqual([
      { startFrame: 0, durationFrames: 90 },
      { startFrame: 90, durationFrames: 60 },
    ])
    expect(useDocumentStore.getState().past).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc).toBe(before)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc.tracks[0]!.clips).toHaveLength(2)
  })

  test('lift without timeline In/Out stays disabled', () => {
    expect(resolveEditorCommand('timeline.lift')).toMatchObject({
      enabled: false,
      disabledReason: 'Mark both timeline In and Out first.',
    })
  })

  test('I marks Program In when Source is not focused', () => {
    useTransportStore.getState().setPlayheadFrame(12)
    expect(executeEditorCommand('marks.mark-in').executed).toBe(true)
    expect(useTransportStore.getState().timelineInFrame).toBe(12)
    expect(useSourceMonitorStore.getState().session).toBeNull()
  })

  test('overwrite, lift, extract, replace, and roll each undo to the original doc', () => {
    const existing: MediaAsset = {
      ...sourceAsset(),
      id: 'asset-existing',
      durationFrames: 180,
      durationMicroseconds: 6_000_000,
      sourceBounds: {
        video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 6_000_000 },
        audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 6_000_000 },
      },
    }
    useDocumentStore.getState().setDoc({
      ...documentFixture(),
      tracks: [
        track('V1', 'video', [
          clip('left', 0, 40),
          { ...clip('right', 40, 40), sourceRange: { startFrame: 40, durationFrames: 40 } },
        ]),
        track('A1', 'audio'),
      ],
    })
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map([[existing.id, existing]]),
      visuals: new Map(),
      compatibility: new Map(),
    })
    const transport = useTransportStore.getState()
    transport.setPlayheadFrame(0)
    transport.setTimelineIn()
    transport.setPlayheadFrame(20)
    transport.setTimelineOut()

    const assertOneEntryRoundTrip = (run: () => void) => {
      const before = useDocumentStore.getState().doc
      const pastLength = useDocumentStore.getState().past.length
      run()
      const after = useDocumentStore.getState().doc
      expect(after).not.toBe(before)
      expect(useDocumentStore.getState().past).toHaveLength(pastLength + 1)
      useDocumentStore.getState().undo()
      expect(useDocumentStore.getState().doc).toBe(before)
      useDocumentStore.getState().redo()
      expect(useDocumentStore.getState().doc).toBe(after)
      useDocumentStore.getState().undo()
      expect(useDocumentStore.getState().doc).toBe(before)
    }

    assertOneEntryRoundTrip(() => {
      expect(executeSequenceEdit('lift').executed).toBe(true)
    })

    assertOneEntryRoundTrip(() => {
      expect(executeSequenceEdit('extract').executed).toBe(true)
    })

    transport.setPlayheadFrame(40)
    assertOneEntryRoundTrip(() => {
      expect(executeSequenceEdit('roll', { rollDeltaFrames: 5 }).executed).toBe(true)
    })

    openSource()
    useTransportStore.getState().setSelectedClip('left')
    assertOneEntryRoundTrip(() => {
      expect(executeSequenceEdit('replace').executed).toBe(true)
    })

    useTransportStore.getState().setPlayheadFrame(80)
    useTransportStore.getState().clearTimelineIn()
    useTransportStore.getState().clearTimelineOut()
    assertOneEntryRoundTrip(() => {
      expect(executeSequenceEdit('overwrite').executed).toBe(true)
    })
  })
})
