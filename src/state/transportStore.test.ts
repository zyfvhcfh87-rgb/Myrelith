/**
 * state/transportStore.test.ts — Phase 1.3.
 */

import { beforeEach, describe, expect, test } from 'vitest'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from './transportStore'

const getState = () => useTransportStore.getState()

beforeEach(() => {
  useTransportStore.getState().setClipVisualPreview(null)
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
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
    expect(after.timelineOriginFrame).toBe(before.timelineOriginFrame)
    expect(after.inOut).toBe(before.inOut)
  })

  test('playhead is forced to a non-negative integer (rule 2)', () => {
    getState().setPlayheadFrame(41.7)
    expect(getState().playheadFrame).toBe(42)
    getState().setPlayheadFrame(-10)
    expect(getState().playheadFrame).toBe(0)
  })

  test('custom zoom updates rendered + remembered values atomically', () => {
    getState().setZoom(2.5)
    expect(getState()).toMatchObject({
      zoom: 2.5,
      customZoom: 2.5,
      zoomMode: 'custom',
    })
    getState().setZoom(0)
    expect(getState().zoom).toBe(2.5)
    getState().setZoom(-1)
    expect(getState().zoom).toBe(2.5)
    getState().setZoom(Number.POSITIVE_INFINITY)
    expect(getState().zoom).toBe(2.5)
  })

  test('Full and Detail presets never overwrite remembered Custom zoom', () => {
    getState().setZoom(4.25)
    getState().setPresetZoom('full', 0.01)
    expect(getState()).toMatchObject({
      zoom: 0.01,
      zoomMode: 'full',
      customZoom: 4.25,
    })
    getState().setPresetZoom('detail', 3)
    expect(getState()).toMatchObject({
      zoom: 3,
      zoomMode: 'detail',
      customZoom: 4.25,
    })
  })

  test('timeline origin is normalized independently of zoom and playhead', () => {
    getState().setPlayheadFrame(77)
    getState().setZoom(2.5)

    getState().setTimelineOriginFrame(1234.6)
    expect(getState()).toMatchObject({
      timelineOriginFrame: 1235,
      playheadFrame: 77,
      zoom: 2.5,
      customZoom: 2.5,
      zoomMode: 'custom',
    })

    getState().setTimelineOriginFrame(-10)
    expect(getState().timelineOriginFrame).toBe(0)
    getState().setTimelineOriginFrame(Number.POSITIVE_INFINITY)
    expect(getState().timelineOriginFrame).toBe(0)
  })

  test('dragPreview sets, normalizes the signed delta, and clears', () => {
    getState().setDragPreview({ clipId: 'clipA', deltaFrames: 41.6 })
    expect(getState().dragPreview).toEqual({ clipId: 'clipA', deltaFrames: 42 })

    getState().setDragPreview({ clipId: 'clipA', deltaFrames: -20.4 })
    expect(getState().dragPreview).toEqual({ clipId: 'clipA', deltaFrames: -20 })

    getState().setDragPreview(null)
    expect(getState().dragPreview).toBeNull()
  })

  test('setDragPreview touches ONLY dragPreview', () => {
    getState().setPlayheadFrame(77)
    getState().setDragPreview({ clipId: 'clipA', deltaFrames: 10 })
    expect(getState().playheadFrame).toBe(77)
    expect(getState().zoom).toBe(1)
    expect(getState().isScrubbing).toBe(false)
  })

  test('setDragPreview preserves cross-track metadata while normalizing only the delta', () => {
    getState().setDragPreview({
      clipId: 'clipA',
      deltaFrames: 41.6,
      targetTrackId: 'V2',
      trackOffsetY: -55.5,
    })
    expect(getState().dragPreview).toEqual({
      clipId: 'clipA',
      deltaFrames: 42,
      targetTrackId: 'V2',
      trackOffsetY: -55.5,
    })
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

  test('resetTransport clears every session-owned field', () => {
    getState().setPlayheadFrame(90)
    getState().setIsPlaying(true)
    getState().setIsScrubbing(true)
    getState().setZoom(3)
    getState().setPresetZoom('detail', 0.5)
    getState().setTimelineOriginFrame(50_000)
    getState().setInOut({ startFrame: 10, durationFrames: 20 })
    getState().setDragPreview({ clipId: 'clipA', deltaFrames: 10 })
    getState().setTool('slide')
    getState().setSelectedClip('clipA')
    getState().toggleClipSelection('clipB')
    getState().setEditPreview({
      clipId: 'clipA',
      kind: 'slide',
      deltaFrames: 4,
    })

    getState().resetTransport()

    expect(getState()).toMatchObject({
      playheadFrame: 0,
      isPlaying: false,
      isScrubbing: false,
      zoom: 1,
      zoomMode: 'custom',
      customZoom: 1,
      timelineOriginFrame: 0,
      inOut: null,
      dragPreview: null,
      tool: 'select',
      selectedClipIds: [],
      selectedClipId: null,
      editPreview: null,
    })
  })
})

describe('Phase 4.2 tool / selection / edit-preview state', () => {
  test('tool defaults to select and switches without touching other fields', () => {
    expect(getState().tool).toBe('select')
    getState().setSelectedClip('clipA')
    getState().setTool('razor')
    expect(getState().tool).toBe('razor')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    }) // untouched
  })

  test('setSelectedClip atomically replaces and clears multi-selection', () => {
    getState().setSelectedClip('clipA')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })

    getState().toggleClipSelection('clipB')
    getState().setSelectedClip('clipC')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipC'],
      selectedClipId: 'clipC',
    })

    getState().setSelectedClip(null)
    expect(getState()).toMatchObject({
      selectedClipIds: [],
      selectedClipId: null,
    })
  })

  test('setClipSelection deduplicates ordered ids and chooses an explicit or final primary', () => {
    getState().setSelectedMarker('marker-1')
    getState().setClipSelection(['clipB', 'clipA', 'clipB'], 'clipB')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipB', 'clipA'],
      selectedClipId: 'clipB',
      selectedMarkerId: null,
    })

    getState().setClipSelection(['clipA', 'clipC'])
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipC'],
      selectedClipId: 'clipC',
    })
  })

  test('selection marquee is bounded ephemeral state and reset clears it', () => {
    getState().setSelectionMarquee({
      left: 10.5,
      top: 20,
      width: -4,
      height: 30,
      clipIds: ['clipA', 'clipA', 'clipB'],
    })
    expect(getState().selectionMarquee).toEqual({
      left: 10.5,
      top: 20,
      width: 0,
      height: 30,
      clipIds: ['clipA', 'clipB'],
    })
    getState().resetTransport()
    expect(getState().selectionMarquee).toBeNull()
  })

  test('toggleClipSelection appends unique ids and makes each addition primary', () => {
    getState().toggleClipSelection('clipA')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })

    getState().toggleClipSelection('clipB')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipB'],
      selectedClipId: 'clipB',
    })

    getState().toggleClipSelection('clipC')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipB', 'clipC'],
      selectedClipId: 'clipC',
    })
    expect(new Set(getState().selectedClipIds).size).toBe(3)
  })

  test('context selection preserves a selected group while promoting its target', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().toggleClipSelection('clipC')

    getState().promoteContextClipSelection('clipA')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipB', 'clipC'],
      selectedClipId: 'clipA',
    })

    const selection = getState().selectedClipIds
    getState().promoteContextClipSelection('clipA')
    expect(getState().selectedClipIds).toBe(selection)
  })

  test('context selection replaces the group when its target was not selected', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().setSelectedMarker('marker-1')

    getState().promoteContextClipSelection('clipC')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipC'],
      selectedClipId: 'clipC',
      selectedMarkerId: null,
      editingMarkerId: null,
    })
  })

  test('toggling the primary off promotes the last remaining selected clip', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().toggleClipSelection('clipC')

    getState().toggleClipSelection('clipC')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipB'],
      selectedClipId: 'clipB',
    })

    getState().toggleClipSelection('clipB')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })

    getState().toggleClipSelection('clipA')
    expect(getState()).toMatchObject({
      selectedClipIds: [],
      selectedClipId: null,
    })
  })

  test('toggling a non-primary clip off preserves the primary', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().toggleClipSelection('clipC')

    getState().toggleClipSelection('clipA')
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipB', 'clipC'],
      selectedClipId: 'clipC',
    })
  })

  test('reconcileClipSelection preserves order and primary while pruning stale ids', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().toggleClipSelection('clipC')

    getState().reconcileClipSelection(new Set(['clipA', 'clipC']))
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipC'],
      selectedClipId: 'clipC',
    })

    getState().setSelectedClip(null)
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    getState().toggleClipSelection('clipC')
    getState().reconcileClipSelection(new Set(['clipA', 'clipB']))
    expect(getState()).toMatchObject({
      selectedClipIds: ['clipA', 'clipB'],
      selectedClipId: 'clipB',
    })

    getState().reconcileClipSelection(new Set())
    expect(getState()).toMatchObject({
      selectedClipIds: [],
      selectedClipId: null,
    })
  })

  test('reconcileClipSelection is reference-stable when every selected id still exists', () => {
    getState().toggleClipSelection('clipA')
    getState().toggleClipSelection('clipB')
    const before = getState()
    const selectionBefore = before.selectedClipIds

    getState().reconcileClipSelection(new Set(['clipA', 'clipB', 'clipC']))

    expect(getState()).toBe(before)
    expect(getState().selectedClipIds).toBe(selectionBefore)
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

  test('alignment guides are ephemeral, idempotent, and reset with transport', () => {
    const guide = {
      frame: 42,
      candidateKind: 'marker' as const,
      candidateId: 'marker:m1',
      label: 'Marker: Beat',
      trackId: null,
    }
    getState().setSnapGuide(guide)
    expect(getState().snapGuide).toEqual(guide)
    expect(getState().snapGuide).not.toBe(guide)
    const withGuide = getState()
    getState().setSnapGuide({ ...guide })
    expect(getState()).toBe(withGuide)

    getState().resetTransport()
    expect(getState().snapGuide).toBeNull()
  })
})

describe('Phase 4.3.8 linked clip previews', () => {
  test('setDragPreview preserves linkGroupId when given, omits it when not, and clears with null', () => {
    getState().setDragPreview({ clipId: 'clipA', deltaFrames: 10, linkGroupId: 'link_1' })
    expect(getState().dragPreview).toEqual({
      clipId: 'clipA',
      deltaFrames: 10,
      linkGroupId: 'link_1',
    })

    getState().setDragPreview({ clipId: 'clipB', deltaFrames: 20 })
    expect(getState().dragPreview).toEqual({ clipId: 'clipB', deltaFrames: 20 })
    expect(getState().dragPreview?.linkGroupId).toBeUndefined()

    getState().setDragPreview(null)
    expect(getState().dragPreview).toBeNull()
  })

  test('setEditPreview preserves linkGroupId when given, omits it when not, and clears with null', () => {
    getState().setEditPreview({ clipId: 'clipA', kind: 'trim-start', deltaFrames: 5, linkGroupId: 'link_2' })
    expect(getState().editPreview).toEqual({
      clipId: 'clipA',
      kind: 'trim-start',
      deltaFrames: 5,
      linkGroupId: 'link_2',
    })

    getState().setEditPreview({ clipId: 'clipB', kind: 'slip', deltaFrames: -3 })
    expect(getState().editPreview).toEqual({ clipId: 'clipB', kind: 'slip', deltaFrames: -3 })
    expect(getState().editPreview?.linkGroupId).toBeUndefined()

    getState().setEditPreview(null)
    expect(getState().editPreview).toBeNull()
  })
})

describe('owned clip visual preview arbitration', () => {
  const visual = {
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    fit: 'cover' as const,
    flipHorizontal: false,
    flipVertical: false,
    scaleLocked: true,
  }
  const transform = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
  }

  test('restores the previous live owner after the active owner releases', () => {
    getState().setOwnedClipVisualPreview('stabilization', {
      clipId: 'stabilized',
      transform: { ...transform, x: 10 },
      visual,
    })
    getState().setOwnedClipVisualPreview('motion-tracking', {
      clipId: 'tracked',
      transform: { ...transform, x: 20 },
      visual,
    })
    expect(getState().clipVisualPreview).toMatchObject({
      owner: 'motion-tracking',
      clipId: 'tracked',
      transform: { x: 20 },
    })

    getState().setOwnedClipVisualPreview('stabilization', {
      clipId: 'stabilized',
      transform: { ...transform, x: 11 },
      visual,
    })
    expect(getState().clipVisualPreview?.owner).toBe('motion-tracking')

    getState().setOwnedClipVisualPreview('motion-tracking', null)
    expect(getState().clipVisualPreview).toMatchObject({
      owner: 'stabilization',
      clipId: 'stabilized',
      transform: { x: 11 },
    })

    getState().setOwnedClipVisualPreview('stabilization', null)
    expect(getState().clipVisualPreview).toBeNull()
  })

  test('restores an editor preview after direct manipulation and resets all candidates', () => {
    getState().setOwnedClipVisualPreview('stabilization', {
      clipId: 'stabilized',
      transform,
      visual,
    })
    getState().setOwnedClipVisualPreview('visual-gesture', {
      clipId: 'gesture',
      transform: { ...transform, y: 5 },
      visual,
    })
    expect(getState().clipVisualPreview?.owner).toBe('visual-gesture')

    getState().setOwnedClipVisualPreview('visual-gesture', null)
    expect(getState().clipVisualPreview?.owner).toBe('stabilization')

    getState().resetTransport()
    expect(getState().clipVisualPreview).toBeNull()
    getState().setOwnedClipVisualPreview('motion-tracking', null)
    expect(getState().clipVisualPreview).toBeNull()
  })
})
