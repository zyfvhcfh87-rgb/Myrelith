import { beforeEach, describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc } from '../domain/schema'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { useDocumentStore } from './documentStore'

const linear = { type: 'linear' } as const

function makeClip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Animated media',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
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
    volume: 1,
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc-animation-store',
    name: 'Animation store',
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

function animation() {
  return useDocumentStore.getState().doc.tracks[0].clips[0].animation
}

describe('clip animation store history', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(makeDoc())
  })

  test('each edit is one undoable entry and redo restores byte-identical state', () => {
    const store = useDocumentStore.getState()
    store.setClipKeyframe('clip-1', 'position-x', {
      frame: 0,
      value: 0,
      easing: linear,
    })
    store.setClipKeyframe('clip-1', 'position-x', {
      frame: 10,
      value: 100,
      easing: linear,
    })
    const beforeMove = JSON.stringify(useDocumentStore.getState().doc)

    useDocumentStore.getState().moveClipKeyframe('clip-1', 'position-x', 10, 15)
    const afterMove = JSON.stringify(useDocumentStore.getState().doc)

    expect(useDocumentStore.getState().past).toHaveLength(3)
    expect(animation()?.tracks[0].keyframes[1].frame).toBe(15)

    useDocumentStore.getState().undo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(beforeMove)
    useDocumentStore.getState().redo()
    expect(JSON.stringify(useDocumentStore.getState().doc)).toBe(afterMove)

    useDocumentStore.getState().removeClipKeyframe('clip-1', 'position-x', 15)
    expect(useDocumentStore.getState().past).toHaveLength(4)
    useDocumentStore.getState().resetClipAnimationTrack('clip-1', 'position-x')
    expect(useDocumentStore.getState().past).toHaveLength(5)
    expect(animation()).toEqual({ tracks: [], effectTracks: [] })
  })

  test('rejected and idempotent edits do not pollute history', () => {
    const store = useDocumentStore.getState()
    store.setClipKeyframe('clip-1', 'opacity', {
      frame: 0,
      value: 2,
      easing: linear,
    })
    store.moveClipKeyframe('clip-1', 'opacity', 99, 100)
    store.resetClipAnimationTrack('clip-1', 'opacity')

    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(animation()).toEqual({ tracks: [], effectTracks: [] })
  })
})
