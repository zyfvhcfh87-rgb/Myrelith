import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import {
  editorContextMenuIdentity,
  editorContextMenuTargetExists,
  executeEditorContextMenuItem,
  resolveEditorContextMenu,
  type EditorContextMenuItemId,
  type EditorContextMenuTarget,
  type EditorContextMenuUiActions,
} from './editorContextMenuCommands'

function clip(
  id: string,
  startFrame: number,
  durationFrames: number,
  assetId = `asset-${id}`,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId,
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
    volume: 1,
    effects: [],
    linkGroupId,
  }
}

function track(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  overrides: Partial<Track> = {},
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
    locked: false,
    ...overrides,
  }
}

function documentFixture(overrides: Partial<TimelineDoc> = {}): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'doc-context-menu',
    name: 'Context menu fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      track('V1', 'video', [clip('video', 0, 30)]),
      track('A1', 'audio', [clip('audio', 0, 30)]),
    ],
    markers: [],
    ...overrides,
  }
}

type EditorContextMenuTargetInput = EditorContextMenuTarget extends infer Target
  ? Target extends EditorContextMenuTarget
    ? Omit<Target, 'documentId' | 'sessionRevision'>
    : never
  : never

function target(value: EditorContextMenuTargetInput): EditorContextMenuTarget {
  return { ...editorContextMenuIdentity(), ...value } as EditorContextMenuTarget
}

function resolvedItem(
  contextTarget: EditorContextMenuTarget,
  id: EditorContextMenuItemId,
  actions: EditorContextMenuUiActions = {},
) {
  const found = resolveEditorContextMenu(contextTarget, actions).items.find(
    (candidate) => candidate.id === id,
  )
  expect(found).toBeDefined()
  return found!
}

beforeEach(() => {
  vi.restoreAllMocks()
  useDocumentStore.getState().setDoc(documentFixture())
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
  useSourceMonitorStore.getState().resetSourceMonitor()
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

describe('editor context menu commands', () => {
  test('uses the exact invoked clip and integer frame for split and ripple delete', () => {
    const contextTarget = target({ kind: 'clip', clipId: 'video', frame: 10 })

    expect(resolvedItem(contextTarget, 'clip.split').disabledReason).toBeNull()
    expect(executeEditorContextMenuItem(contextTarget, 'clip.split')).toEqual({
      executed: true,
      reason: null,
    })
    expect(useDocumentStore.getState().doc.tracks[0]?.clips).toHaveLength(2)

    const boundaryTarget = target({ kind: 'clip', clipId: 'video', frame: 0 })
    expect(resolvedItem(boundaryTarget, 'clip.split').disabledReason).toContain(
      'strictly inside',
    )

    const rightHalf = useDocumentStore.getState().doc.tracks[0]?.clips[1]
    expect(rightHalf).toBeDefined()
    const deleteTarget = target({
      kind: 'clip',
      clipId: rightHalf!.id,
      frame: rightHalf!.timelineRange.startFrame,
    })
    expect(executeEditorContextMenuItem(deleteTarget, 'clip.ripple-delete').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0]?.clips).toHaveLength(1)
  })

  test('links the preserved two-clip selection and then resolves unlink on the target', () => {
    useTransportStore.getState().setSelectedClip('video')
    useTransportStore.getState().toggleClipSelection('audio')
    const contextTarget = target({ kind: 'clip', clipId: 'video', frame: 10 })

    expect(resolvedItem(contextTarget, 'clip.link').disabledReason).toBeNull()
    expect(executeEditorContextMenuItem(contextTarget, 'clip.link').executed).toBe(true)

    const linkedTarget = target({ kind: 'clip', clipId: 'video', frame: 10 })
    expect(resolveEditorContextMenu(linkedTarget).items.map(({ id }) => id))
      .toContain('clip.unlink')
    expect(executeEditorContextMenuItem(linkedTarget, 'clip.unlink').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks.flatMap(({ clips }) => clips)
      .every(({ linkGroupId }) => linkGroupId === undefined)).toBe(true)
  })

  test('exposes lift/extract on the ruler and roll on a touching seam', () => {
    const ruler = target({ kind: 'ruler', frame: 12 })
    expect(resolvedItem(ruler, 'timeline.lift').disabledReason).toMatch(/Mark both timeline/)
    expect(resolvedItem(ruler, 'timeline.extract').disabledReason).toMatch(/Mark both timeline/)

    useDocumentStore.getState().setDoc(documentFixture({
      tracks: [
        track('V1', 'video', [clip('left', 0, 20), clip('right', 20, 20)]),
        track('A1', 'audio', []),
      ],
    }))
    const existing = {
      id: 'asset-left',
      fileName: 'left.mp4',
      mimeType: 'video/mp4',
      size: 1024,
      lastModified: 1,
      objectUrl: 'blob:left',
      kind: 'video' as const,
      durationFrames: 120,
      durationMicroseconds: 4_000_000,
      sourceBounds: {
        video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 4_000_000 },
        audio: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      },
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
      decoderConfigB64: null,
    }
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map([
        ['asset-left', existing],
        ['asset-right', { ...existing, id: 'asset-right', fileName: 'right.mp4' }],
      ]),
      visuals: new Map(),
      compatibility: new Map(),
    })
    const seam = target({ kind: 'clip', clipId: 'left', frame: 20 })
    expect(resolvedItem(seam, 'clip.roll-right').disabledReason).toBeNull()
    expect(executeEditorContextMenuItem(seam, 'clip.roll-right').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0]?.clips.map((item) => item.timelineRange))
      .toEqual([
        { startFrame: 0, durationFrames: 21 },
        { startFrame: 21, durationFrames: 19 },
      ])
  })

  test('executes ruler and lane commands at their captured frame', () => {
    const ruler = target({ kind: 'ruler', frame: 12 })
    expect(executeEditorContextMenuItem(ruler, 'timeline.move-playhead').executed)
      .toBe(true)
    expect(useTransportStore.getState().playheadFrame).toBe(12)

    expect(executeEditorContextMenuItem(ruler, 'timeline.add-marker').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.markers?.[0]?.frame).toBe(12)

    const lane = target({ kind: 'lane', trackId: 'V1', frame: 15 })
    expect(executeEditorContextMenuItem(lane, 'timeline.split').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0]?.clips).toHaveLength(2)
    expect(executeEditorContextMenuItem(lane, 'timeline.add-audio-track').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.tracks.at(-1)?.kind).toBe('audio')
  })

  test('resolves and executes track, marker, and transition targets independently', () => {
    const rename = vi.fn(() => true)
    const trackTarget = target({ kind: 'track', trackId: 'V1' })
    expect(executeEditorContextMenuItem(trackTarget, 'track.rename', {
      openTrackRename: rename,
    }).executed).toBe(true)
    expect(rename).toHaveBeenCalledOnce()
    expect(executeEditorContextMenuItem(trackTarget, 'track.visibility').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0]?.hidden).toBe(true)

    const markerTarget = target({ kind: 'marker', markerId: 'marker-1' })
    useDocumentStore.getState().addTimelineMarker({
      id: 'marker-1',
      frame: 7,
      label: 'Beat',
      color: 'yellow',
    })
    expect(executeEditorContextMenuItem(markerTarget, 'marker.duplicate').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.markers).toHaveLength(2)

    const from = clip('from', 0, 20)
    const to = clip('to', 20, 20)
    useDocumentStore.getState().setDoc(documentFixture({
      tracks: [track('V1', 'video', [from, to], {
        transitions: [{
          id: 'transition-1',
          type: 'crossfade',
          fromClipId: 'from',
          toClipId: 'to',
          durationFrames: 8,
          audio: { enabled: true, curve: 'equal-power' },
        }],
      })],
    }))
    const transitionTarget = target({
      kind: 'transition',
      trackId: 'V1',
      fromClipId: 'from',
      toClipId: 'to',
      transitionId: 'transition-1',
    })
    expect(executeEditorContextMenuItem(transitionTarget, 'transition.remove').executed)
      .toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0]?.transitions).toEqual([])
  })

  test('fails closed after project replacement or exact target removal', () => {
    const staleProjectTarget = target({ kind: 'clip', clipId: 'video', frame: 10 })
    useDocumentStore.getState().setDoc(documentFixture({ id: 'replacement' }))

    expect(editorContextMenuTargetExists(staleProjectTarget)).toBe(false)
    expect(executeEditorContextMenuItem(staleProjectTarget, 'clip.split').executed)
      .toBe(false)

    const exactTarget = target({ kind: 'clip', clipId: 'video', frame: 10 })
    useDocumentStore.getState().setDoc(documentFixture({ id: 'replacement', tracks: [] }))
    expect(useDocumentStore.getState().doc.tracks).toEqual([])
    expect(editorContextMenuTargetExists(exactTarget)).toBe(false)
    expect(resolveEditorContextMenu(exactTarget).items.every(
      ({ disabledReason }) => disabledReason !== null,
    )).toBe(true)

    useDocumentStore.getState().setDoc(documentFixture({
      id: 'replacement',
      markers: [{ id: 'marker-removed', frame: 4, label: 'Cue', color: 'blue' }],
    }))
    const markerTarget = target({ kind: 'marker', markerId: 'marker-removed' })
    useDocumentStore.getState().deleteTimelineMarker('marker-removed')
    expect(editorContextMenuTargetExists(markerTarget)).toBe(false)
  })

  test('opens a connected Media Pool asset in Source Monitor from the asset menu', () => {
    const asset = {
      id: 'asset-source',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 1_024,
      lastModified: 1_725_000_000_000,
      objectUrl: 'blob:source',
      kind: 'video' as const,
      durationFrames: 300,
      durationMicroseconds: 10_000_000,
      sourceBounds: {
        video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 10_000_000 },
        audio: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      },
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
      decoderConfigB64: null,
    }
    useMediaStore.setState({
      descriptors: new Map([[asset.id, {
        id: asset.id,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
        lastModified: asset.lastModified,
        kind: asset.kind,
        durationMicroseconds: asset.durationMicroseconds,
        sourceBounds: asset.sourceBounds,
        nativeFrameRate: asset.frameRate,
        width: asset.width,
        height: asset.height,
        hasAudio: asset.hasAudio,
        audioSampleRate: asset.audioSampleRate,
        audioChannels: asset.audioChannels,
      }]]),
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
    const contextTarget = target({ kind: 'asset', assetId: asset.id })
    expect(resolvedItem(contextTarget, 'asset.open-source').disabledReason).toBeNull()
    expect(executeEditorContextMenuItem(contextTarget, 'asset.open-source')).toEqual({
      executed: true,
      reason: null,
    })
    expect(useSourceMonitorStore.getState().session?.source.assetId).toBe(asset.id)
    expect(useDocumentStore.getState().doc.id).toBe('doc-context-menu')
  })
})
