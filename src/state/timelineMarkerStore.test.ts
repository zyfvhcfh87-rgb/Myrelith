import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimelineDoc, TimelineMarker } from '../domain/schema'
import { initSelectionReconciliation } from '../app/selectionReconciliationController'
import { useDocumentStore } from './documentStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from './transportStore'

const first: TimelineMarker = {
  id: 'marker-one',
  frame: 12,
  label: 'First',
  color: 'yellow',
}

function doc(): TimelineDoc {
  return {
    schemaVersion: 8,
    id: 'doc-marker-store',
    name: 'Marker store',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [],
    markers: [],
  }
}

let dispose: (() => void) | undefined

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.getState().setDoc(doc())
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  dispose = initSelectionReconciliation()
})

afterEach(() => {
  dispose?.()
  vi.restoreAllMocks()
})

describe('timeline marker stores', () => {
  test('records each committed marker gesture as one undo/redo entry', () => {
    const store = useDocumentStore.getState()
    store.addTimelineMarker(first)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().doc.markers).toEqual([first])

    useDocumentStore.getState().updateTimelineMarker(first.id, {
      frame: 42,
      label: 'Moved',
      note: 'Beat',
    })
    expect(useDocumentStore.getState().past).toHaveLength(2)
    expect(useDocumentStore.getState().doc.markers?.[0]).toMatchObject({
      frame: 42,
      label: 'Moved',
      note: 'Beat',
    })

    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.markers).toEqual([first])
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc.markers?.[0].frame).toBe(42)
  })

  test('rejected marker edits do not pollute history', () => {
    const before = useDocumentStore.getState().doc
    useDocumentStore.getState().deleteTimelineMarker('missing')
    expect(useDocumentStore.getState().doc).toBe(before)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  test('marker selection is ephemeral, clip-exclusive, and reconciled on delete', () => {
    useDocumentStore.getState().addTimelineMarker(first)
    useTransportStore.getState().setSelectedMarker(first.id)
    useTransportStore.getState().setEditingMarker(first.id)
    expect(useTransportStore.getState()).toMatchObject({
      selectedMarkerId: first.id,
      editingMarkerId: first.id,
      selectedClipId: null,
      selectedClipIds: [],
    })

    useDocumentStore.getState().deleteTimelineMarker(first.id)
    expect(useTransportStore.getState()).toMatchObject({
      selectedMarkerId: null,
      editingMarkerId: null,
    })

    useTransportStore.getState().setSelectedMarker('ephemeral')
    useTransportStore.getState().setSelectedClip('clip-id')
    expect(useTransportStore.getState()).toMatchObject({
      selectedMarkerId: null,
      selectedClipId: 'clip-id',
    })
  })
})
