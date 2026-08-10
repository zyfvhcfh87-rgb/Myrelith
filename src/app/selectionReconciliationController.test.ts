import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from '../domain/clipInspector'
import {
  createProjectFileSnapshot,
  serializeProjectFile,
  type PortableAssetDescriptor,
} from '../domain/projectFile'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_TRANSPORT_STATE,
  useTransportStore,
} from '../state/transportStore'
import { initSelectionReconciliation } from './selectionReconciliationController'

function makeClip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    id,
    assetId: 'asset-1',
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
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[], locked = false): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function makeAudioTrack(id: string, clips: Clip[]): Track {
  return {
    ...makeTrack(id, clips),
    kind: 'audio',
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 10,
    id: 'doc-selection-reconciliation',
    name: 'Selection reconciliation',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      makeTrack('V1', [
        makeClip('clipA', 100, 50),
        makeClip('clipB', 200, 40),
      ]),
      makeTrack('V2', [makeClip('clipD', 20, 30)]),
      makeTrack('VL', [makeClip('clipE', 0, 30)], true),
    ],
    markers: [],
  }
}

const descriptor: PortableAssetDescriptor = {
  id: 'asset-1',
  fileName: 'selection.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1_725_000_000_000,
  kind: 'video',
  durationMicroseconds: 10_000_000,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    audio: null,
  },
  nativeFrameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
}

const documentState = () => useDocumentStore.getState()
const transportState = () => useTransportStore.getState()

let dispose: (() => void) | undefined
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.setState({ doc: makeDoc(), past: [], future: [] })
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  warnSpy.mockRestore()
})

describe('selection reconciliation lifecycle', () => {
  test('initialization prunes stale ids and promotes the latest surviving clip', () => {
    transportState().toggleClipSelection('clipD')
    transportState().toggleClipSelection('clipA')
    transportState().toggleClipSelection('missing')

    dispose = initSelectionReconciliation()

    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD', 'clipA'],
      selectedClipId: 'clipA',
    })
  })

  test('ripple delete prunes only the missing primary; undo and redo do not resurrect selection', () => {
    dispose = initSelectionReconciliation()
    transportState().toggleClipSelection('clipD')
    transportState().toggleClipSelection('clipA')
    transportState().toggleClipSelection('clipB')

    documentState().rippleDelete('clipB')

    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD', 'clipA'],
      selectedClipId: 'clipA',
    })
    expect(documentState().past).toHaveLength(1)

    documentState().undo()
    expect(
      documentState().doc.tracks[0].clips.some((clip) => clip.id === 'clipB'),
    ).toBe(true)
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD', 'clipA'],
      selectedClipId: 'clipA',
    })

    documentState().redo()
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD', 'clipA'],
      selectedClipId: 'clipA',
    })
  })

  test('linked deletion prunes both removed partners but keeps an unrelated survivor', () => {
    const linkedDoc = makeDoc()
    linkedDoc.tracks = [
      makeTrack('V1', [
        makeClip('clipA', 100, 50),
        { ...makeClip('clipB', 200, 40), linkGroupId: 'link-selection' },
      ]),
      makeAudioTrack('A1', [
        { ...makeClip('clipF', 15, 25), linkGroupId: 'link-selection' },
      ]),
      makeTrack('V2', [makeClip('clipD', 20, 30)]),
    ]
    useDocumentStore.setState({ doc: linkedDoc, past: [], future: [] })
    dispose = initSelectionReconciliation()
    transportState().toggleClipSelection('clipD')
    transportState().toggleClipSelection('clipB')
    transportState().toggleClipSelection('clipF')

    documentState().rippleDelete('clipF')

    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD'],
      selectedClipId: 'clipD',
    })
    expect(documentState().past).toHaveLength(1)

    documentState().undo()
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD'],
      selectedClipId: 'clipD',
    })
  })

  test('rejected deletion on a locked track preserves exact selection and history', () => {
    dispose = initSelectionReconciliation()
    transportState().setSelectedClip('clipA')
    transportState().toggleClipSelection('clipE')
    const selectionBefore = transportState().selectedClipIds
    const documentBefore = documentState().doc
    const pastBefore = documentState().past
    const futureBefore = documentState().future

    documentState().rippleDelete('clipE')

    expect(transportState().selectedClipIds).toBe(selectionBefore)
    expect(transportState().selectedClipId).toBe('clipE')
    expect(documentState().doc).toBe(documentBefore)
    expect(documentState().past).toBe(pastBefore)
    expect(documentState().future).toBe(futureBefore)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('undoing a split prunes the vanished right half without resurrecting it on redo', () => {
    dispose = initSelectionReconciliation()
    transportState().setSelectedClip('clipA')
    documentState().splitClipAt('clipA', 120)
    const rightHalfId = documentState().doc.tracks[0].clips[1].id
    expect(rightHalfId).not.toBe('clipA')

    transportState().toggleClipSelection(rightHalfId)
    expect(transportState().selectedClipId).toBe(rightHalfId)

    documentState().undo()
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })

    documentState().redo()
    expect(
      documentState().doc.tracks[0].clips.some(
        (clip) => clip.id === rightHalfId,
      ),
    ).toBe(true)
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })
  })

  test('track removal prunes all removed clips while retaining a cross-track survivor', () => {
    dispose = initSelectionReconciliation()
    transportState().toggleClipSelection('clipD')
    transportState().toggleClipSelection('clipA')
    transportState().toggleClipSelection('clipB')

    documentState().removeTrack('V1')

    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD'],
      selectedClipId: 'clipD',
    })
    expect(documentState().past).toHaveLength(1)

    documentState().undo()
    expect(documentState().doc.tracks.some((track) => track.id === 'V1')).toBe(
      true,
    )
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD'],
      selectedClipId: 'clipD',
    })
  })

  test('project replacement retains existing ids in order and clears the rest', () => {
    dispose = initSelectionReconciliation()
    transportState().toggleClipSelection('clipA')
    transportState().toggleClipSelection('clipD')

    documentState().setDoc({
      ...makeDoc(),
      id: 'doc-replacement',
      tracks: [makeTrack('V2', [makeClip('clipD', 20, 30)])],
    })
    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipD'],
      selectedClipId: 'clipD',
    })

    documentState().setDoc({
      ...makeDoc(),
      id: 'doc-empty-replacement',
      tracks: [],
    })
    expect(transportState()).toMatchObject({
      selectedClipIds: [],
      selectedClipId: null,
    })
  })

  test('selection changes are absent from document history and serialized projects', () => {
    dispose = initSelectionReconciliation()
    documentState().removeTrack('V2')
    documentState().undo()
    const documentBefore = documentState().doc
    const pastBefore = documentState().past
    const futureBefore = documentState().future
    const serializedBefore = serializeProjectFile(
      createProjectFileSnapshot(documentBefore, [descriptor]),
    )

    transportState().setSelectedClip('clipA')
    transportState().toggleClipSelection('clipD')
    transportState().reconcileClipSelection(
      new Set(['clipA', 'clipD', 'clipE']),
    )

    expect(documentState().doc).toBe(documentBefore)
    expect(documentState().past).toBe(pastBefore)
    expect(documentState().future).toBe(futureBefore)
    const serializedAfter = serializeProjectFile(
      createProjectFileSnapshot(documentState().doc, [descriptor]),
    )
    expect(serializedAfter).toBe(serializedBefore)
    expect(serializedAfter).not.toContain('selectedClip')
  })

  test('disposing the lifecycle stops later document reconciliation', () => {
    dispose = initSelectionReconciliation()
    transportState().setSelectedClip('clipA')
    dispose()
    dispose = undefined

    documentState().removeTrack('V1')

    expect(transportState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })
  })
})
