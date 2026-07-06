/**
 * state/transportStore.test.ts — Phase 1.3.
 */

import { beforeEach, describe, expect, test } from 'vitest'
import { useTransportStore } from './transportStore'

const getState = () => useTransportStore.getState()

beforeEach(() => {
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
    tool: 'select',
    selectedClipId: null,
    editPreview: null,
  })
})

describe('transportStore', () => {
  test('setPlayheadFrame updates ONLY playheadFrame', () => {
    const before = getState()
    getState().setPlayheadFrame(42)
    const after = getState()
    expect(after.playheadFrame).toBe(42)
    expect(after.isPlaying).toBe(before.isPlaying)
    expect(after.isScrubbing).toBe(before.isScrubbing)
    expect(after.zoom).toBe(before.zoom)
    expect(after.inOut).toBe(before.inOut)
  })

  test('playhead is forced to a non-negative integer (rule 2)', () => {
    getState().setPlayheadFrame(41.7)
    expect(getState().playheadFrame).toBe(42)
    getState().setPlayheadFrame(-10)
    expect(getState().playheadFrame).toBe(0)
  })

  test('zoom rejects non-positive values', () => {
    getState().setZoom(2.5)
    expect(getState().zoom).toBe(2.5)
    getState().setZoom(0)
    expect(getState().zoom).toBe(2.5)
    getState().setZoom(-1)
    expect(getState().zoom).toBe(2.5)
  })

  test('dragPreview sets, normalizes the frame, and clears', () => {
    getState().setDragPreview({ clipId: 'clipA', startFrame: 41.6 })
    expect(getState().dragPreview).toEqual({ clipId: 'clipA', startFrame: 42 })

    getState().setDragPreview({ clipId: 'clipA', startFrame: -20 })
    expect(getState().dragPreview).toEqual({ clipId: 'clipA', startFrame: 0 })

    getState().setDragPreview(null)
    expect(getState().dragPreview).toBeNull()
  })

  test('setDragPreview touches ONLY dragPreview', () => {
    getState().setPlayheadFrame(77)
    getState().setDragPreview({ clipId: 'clipA', startFrame: 10 })
    expect(getState().playheadFrame).toBe(77)
    expect(getState().zoom).toBe(1)
    expect(getState().isScrubbing).toBe(false)
  })

  test('flags and inOut set independently', () => {
    getState().setIsPlaying(true)
    getState().setIsScrubbing(true)
    getState().setInOut({ startFrame: 10, durationFrames: 50 })
    expect(getState().isPlaying).toBe(true)
    expect(getState().isScrubbing).toBe(true)
    expect(getState().inOut).toEqual({ startFrame: 10, durationFrames: 50 })
    getState().setInOut(null)
    expect(getState().inOut).toBeNull()
  })
})

describe('Phase 4.2 tool / selection / edit-preview state', () => {
  test('tool defaults to select and switches without touching other fields', () => {
    expect(getState().tool).toBe('select')
    getState().setSelectedClip('clipA')
    getState().setTool('razor')
    expect(getState().tool).toBe('razor')
    expect(getState().selectedClipId).toBe('clipA') // untouched
  })

  test('selection sets and clears', () => {
    getState().setSelectedClip('clipA')
    expect(getState().selectedClipId).toBe('clipA')
    getState().setSelectedClip(null)
    expect(getState().selectedClipId).toBeNull()
  })

  test('editPreview rounds deltas, keeps them signed, and clears', () => {
    getState().setEditPreview({ clipId: 'clipA', kind: 'trim-start', deltaFrames: 4.6 })
    expect(getState().editPreview).toEqual({
      clipId: 'clipA',
      kind: 'trim-start',
      deltaFrames: 5,
    })
    getState().setEditPreview({ clipId: 'clipA', kind: 'slip', deltaFrames: -7.4 })
    expect(getState().editPreview?.deltaFrames).toBe(-7) // negative allowed
    getState().setEditPreview(null)
    expect(getState().editPreview).toBeNull()
  })
})
