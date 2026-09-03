import { beforeEach, describe, expect, test } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import {
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from '../domain/clipInspector'
import {
  DEFAULT_MANUAL_LENS_CORRECTION,
  type ManualLensCorrectionModel,
} from '../domain/lensCorrection'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore } from './documentStore'

function document(locked = false): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'lens-doc',
    name: 'Lens',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [],
    captionTracks: [],
    tracks: [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      hidden: false,
      muted: false,
      solo: false,
      locked,
      transitions: [],
      clips: [{
        id: 'clip',
        assetId: 'asset',
        name: 'Clip',
        sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 30 },
        sourceTimeMap: defaultSourceTimeMap(0, 30),
        timelineRange: { startFrame: 0, durationFrames: 30 },
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
      }],
    }],
  }
}

function authoredModel(): ManualLensCorrectionModel {
  return {
    ...DEFAULT_MANUAL_LENS_CORRECTION,
    k1: 0.16,
    k2: 0.025,
    outputScale: 1.24,
  }
}

describe('manual lens-correction history', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(document())
  })

  test('authors, undoes, redoes, and resets as one entry per commit', () => {
    const model = authoredModel()
    useDocumentStore.getState().setManualLensCorrection('clip', model)

    let state = useDocumentStore.getState()
    expect(state.past).toHaveLength(1)
    expect(state.doc.tracks[0].clips[0].lensCorrection).toEqual(model)
    expect(state.doc.tracks[0].clips[0].lensCorrection).not.toBe(model)

    state.undo()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].lensCorrection).toBeNull()
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].lensCorrection).toEqual(model)

    useDocumentStore.getState().setManualLensCorrection('clip', null)
    expect(useDocumentStore.getState().past).toHaveLength(2)
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].lensCorrection).toBeNull()
  })

  test('idempotent, invalid, and locked edits preserve history by reference', () => {
    const model = authoredModel()
    useDocumentStore.getState().setManualLensCorrection('clip', model)
    const after = useDocumentStore.getState()
    useDocumentStore.getState().setManualLensCorrection('clip', model)
    expect(useDocumentStore.getState()).toBe(after)

    useDocumentStore.getState().setManualLensCorrection('clip', {
      ...model,
      outputScale: 0.5,
    })
    expect(useDocumentStore.getState()).toBe(after)

    useDocumentStore.getState().setDoc(document(true))
    const locked = useDocumentStore.getState()
    locked.setManualLensCorrection('clip', model)
    expect(useDocumentStore.getState()).toBe(locked)
  })
})
