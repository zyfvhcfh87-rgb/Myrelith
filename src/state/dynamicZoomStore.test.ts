import { beforeEach, describe, expect, test } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import {
  dynamicZoomRequestFromPreset,
  reverseDynamicZoomRequest,
} from '../domain/dynamicZoom'
import type { Clip, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from './documentStore'
import { useTransportStore } from './transportStore'

function makeClip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Dynamic zoom clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 120 },
    timelineRange: { startFrame: 0, durationFrames: 120 },
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
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'doc-dynamic-store',
    name: 'Dynamic zoom history',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [makeClip()],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

describe('dynamic zoom store history', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(makeDoc())
    useTransportStore.getState().resetTransport()
  })

  test('apply, reverse, and reset are three deliberate byte-exact history entries', () => {
    const source = { width: 3840, height: 2160 }
    const request = dynamicZoomRequestFromPreset('reframe-left-right', 90)
    const original = JSON.stringify(useDocumentStore.getState().doc)

    useDocumentStore.getState().applyDynamicZoom('clip-1', source, request)
    const applied = JSON.stringify(useDocumentStore.getState().doc)
    expect(useDocumentStore.getState().past).toHaveLength(1)

    useDocumentStore.getState().applyDynamicZoom(
      'clip-1',
      source,
      reverseDynamicZoomRequest(request),
    )
    const reversed = JSON.stringify(useDocumentStore.getState().doc)
    expect(reversed).not.toBe(applied)
    expect(useDocumentStore.getState().past).toHaveLength(2)

    useDocumentStore.getState().resetClipFramingAnimation('clip-1')
    const reset = JSON.stringify(useDocumentStore.getState().doc)
    expect(useDocumentStore.getState().past).toHaveLength(3)
    expect(useTransportStore.getState().clipVisualPreview).toBeNull()

    useDocumentStore.getState().undo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(reversed)
    useDocumentStore.getState().undo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(applied)
    useDocumentStore.getState().undo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(original)
    useDocumentStore.getState().redo()
    useDocumentStore.getState().redo()
    useDocumentStore.getState().redo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(reset)
  })

  test('idempotent and rejected actions preserve history and redo by reference', () => {
    const source = { width: 1920, height: 1080 }
    const request = dynamicZoomRequestFromPreset('gentle-in', 90)
    useDocumentStore.getState().applyDynamicZoom('clip-1', source, request)
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState()

    useDocumentStore.getState().applyDynamicZoom(
      'missing',
      source,
      request,
    )
    expect(useDocumentStore.getState().doc).toBe(before.doc)
    expect(useDocumentStore.getState().past).toBe(before.past)
    expect(useDocumentStore.getState().future).toBe(before.future)

    useDocumentStore.getState().redo()
    const afterRedo = useDocumentStore.getState()
    useDocumentStore.getState().applyDynamicZoom('clip-1', source, request)
    expect(useDocumentStore.getState().doc).toBe(afterRedo.doc)
    expect(useDocumentStore.getState().past).toBe(afterRedo.past)
  })
})
