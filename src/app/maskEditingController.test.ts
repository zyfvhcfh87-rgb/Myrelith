import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { beginMaskEdit, commitMaskParams } from './maskEditingController'
import { attributeClip } from '../test/clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { createMaskEffect } from '../domain/effectStack'
import { MAX_KEYFRAMES_PER_TRACK, resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { updateEffectParamsAtFrame } from '../domain/operations/effects'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

const target = { sequenceId: 'mask-edit', clipId: 'clip', effectId: 'mask' }
beforeEach(() => {
  useTransportStore.getState().resetTransport()
  const doc = structuredClone(createTimelineDoc('Mask', DEFAULT_PROJECT_SETTINGS, target.sequenceId))
  const clip = attributeClip('clip'); clip.effects = [createMaskEffect('mask', 'rectangle')]
  doc.tracks[0].clips = [clip]
  useDocumentStore.getState().setProject(sequenceProjectFromTimeline(doc))
  useTransportStore.getState().setSelectedClip('clip')
  useTransportStore.getState().setMaskEditorTarget(target)
})
afterEach(() => useTransportStore.getState().resetTransport())

test('many previews are disposable; release applies the latest patch once and supports undo/redo', () => {
  const before = useDocumentStore.getState().project, session = beginMaskEdit(target)
  for (let i = 1; i <= 20; i++) expect(session.preview({ x: i / 100 })).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
  expect(useTransportStore.getState().effectDocumentPreview).toMatchObject({ owner: 'mask-gesture' })
  expect(session.commit({ x: 0.3 })).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([before])
  expect(useDocumentStore.getState().doc.tracks[0].clips[0].effects[0].params.x).toBe(0.3)
  expect(useTransportStore.getState().maskPreview).toBeNull()
  expect(session.commit({ x: 0.4 })).toMatch(/changed/)
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(before)
  useDocumentStore.getState().redo(); expect(useDocumentStore.getState().past).toHaveLength(1)
})

test.each(['cancel', 'project', 'generation', 'sequence', 'selection', 'primary', 'adjustment', 'frame', 'play', 'scrub', 'reset', 'target'] as const)('%s invalidates immediately and rejects late release', (action) => {
  useTransportStore.getState().setClipSelection(['other', 'clip'], 'clip')
  const session = beginMaskEdit(target); session.preview({ width: 0.7 })
  if (action === 'cancel') session.cancel()
  if (action === 'project') useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project))
  if (action === 'generation') useDocumentStore.setState({ projectGeneration: useDocumentStore.getState().projectGeneration + 1 })
  if (action === 'sequence') useDocumentStore.setState({ activeSequenceId: 'other' })
  if (action === 'selection') useTransportStore.getState().setSelectedClip(null)
  if (action === 'primary') useTransportStore.getState().setClipSelection(['other', 'clip'], 'other')
  if (action === 'adjustment') useTransportStore.getState().setSelectedAdjustment('other')
  if (action === 'frame') useTransportStore.getState().setPlayheadFrame(2)
  if (action === 'play') useTransportStore.getState().setIsPlaying(true)
  if (action === 'scrub') useTransportStore.getState().setIsScrubbing(true)
  if (action === 'reset') useTransportStore.getState().resetTransport()
  if (action === 'target') useTransportStore.getState().setMaskEditorTarget(null)
  expect(useTransportStore.getState().maskPreview).toBeNull()
  expect(session.commit({ width: 0.7 })).toMatch(/changed/)
  expect(useDocumentStore.getState().past).toEqual([])
})

test('no-op and invalid numeric/path edits preserve undo and redo; a replaced session cannot erase its successor', () => {
  const state = useDocumentStore.getState(); useDocumentStore.setState({ future: [state.project] })
  const params = state.doc.tracks[0].clips[0].effects[0].params
  expect(commitMaskParams(target, { x: params.x as number })).toBeNull()
  expect(commitMaskParams(target, { width: 0 })).toBeTruthy()
  expect(commitMaskParams(target, { shape: 'bezier', path: 'M 0 0 L 1 1 Z' })).toBeTruthy()
  expect(useDocumentStore.getState()).toMatchObject({ project: state.project, past: [], future: [state.project] })
  const first = beginMaskEdit(target), second = beginMaskEdit(target)
  second.preview({ x: 0.3 }); first.cancel()
  expect(first.commit({ x: 0.8 })).toMatch(/changed/)
  expect(useTransportStore.getState().maskPreview?.params.x).toBe(0.3)
})

test('static and animated patches match Inspector numeric operations, including source ticks and existing easing', () => {
  useDocumentStore.getState().setEffectKeyframe('clip', 'mask', 'x', { frame: 0, value: 0.1, easing: { type: 'hold' } })
  useTransportStore.getState().setPlayheadFrame(15)
  const state = useDocumentStore.getState(), patch = { x: 0.4, feather: 0.2 }
  const expected = updateEffectParamsAtFrame(state.doc, 'clip', 'mask', 15, patch)
  expect(commitMaskParams(target, patch)).toBeNull()
  expect(useDocumentStore.getState().doc).toEqual(expected)
  const clip = useDocumentStore.getState().doc.tracks[0].clips[0]
  expect(clip.effects[0].params.x).toBe(0)
  expect(clip.animation!.effectTracks![0].keyframes.at(-1)).toMatchObject({ frame: 15, sourceTimeTicks: 15_000_000, value: 0.4 })
  expect(resolveClipAnimationAtFrame(clip, 15).effects[0].params.x).toBe(0.4)
})

test('full scalar lanes reject growth atomically but permit updates at capacity', () => {
  const doc = structuredClone(useDocumentStore.getState().doc)
  doc.tracks[0].clips[0].animation = { tracks: [], effectTracks: [{ effectId: 'mask', parameter: 'x', keyframes: Array.from({ length: MAX_KEYFRAMES_PER_TRACK }, (_, i) => ({ frame: i * 2, value: 0, easing: { type: 'linear' } })) }] }
  useDocumentStore.getState().setDoc(doc)
  const project = useDocumentStore.getState().project; useDocumentStore.setState({ future: [project] })
  useTransportStore.getState().setPlayheadFrame(1)
  expect(commitMaskParams(target, { x: 0.1, feather: 0.2 })).toMatch(/budget/)
  expect(useDocumentStore.getState()).toMatchObject({ project, past: [], future: [project] })
  useTransportStore.getState().setPlayheadFrame(2)
  expect(commitMaskParams(target, { x: 0.1, feather: 0.2 })).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([project])
})

test.each(['document', 'transport'] as const)('reentrant %s changes while clearing preview fail the final commit guard', (kind) => {
  const session = beginMaskEdit(target); session.preview({ x: 0.2 })
  const unsubscribe = useTransportStore.subscribe((state, before) => {
    if (before.maskPreview && !state.maskPreview) {
      if (kind === 'document') useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project))
      else useTransportStore.getState().setPlayheadFrame(3)
    }
  })
  expect(session.commit({ x: 0.3 })).toMatch(/changed/)
  unsubscribe()
  expect(useDocumentStore.getState().past).toEqual([])
})

test.each(['mask', 'grading'] as const)('preview ownership preserves activation order with %s first, and restores the live sibling', (first) => {
  const store = useTransportStore.getState(), doc = useDocumentStore.getState().doc
  const mask = { sequenceId: doc.id, effectId: 'mask', params: { x: 0.2 }, document: doc }
  const grade = { ...mask, effectId: 'grade', params: { liftR: 0.2 } }
  const setters = first === 'mask' ? [store.setMaskPreview, store.setColorGradingPreview] : [store.setColorGradingPreview, store.setMaskPreview]
  setters[0](mask); setters[1](grade); setters[0]({ ...mask, document: { ...doc, name: 'updated hidden draft' } })
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe(first === 'mask' ? 'color-grading' : 'mask-gesture')
  setters[1](null)
  expect(useTransportStore.getState().effectDocumentPreview?.document.name).toBe('updated hidden draft')
  store.resetTransport()
  expect(useTransportStore.getState()).toMatchObject({ maskPreview: null, colorGradingPreview: null, effectDocumentPreview: null })
})

test.each(['locked', 'hidden', 'disabled', 'future', 'outside'] as const)('%s masks give a reason before opening a gesture', (kind) => {
  const doc = structuredClone(useDocumentStore.getState().doc)
  if (kind === 'locked') doc.tracks[0].locked = true
  if (kind === 'hidden') doc.tracks[0].hidden = true
  if (kind === 'disabled') doc.tracks[0].clips[0].effects[0].enabled = false
  if (kind === 'future') doc.tracks[0].clips[0].effects[0].version = 2
  useDocumentStore.getState().setDoc(doc)
  if (kind === 'outside') useTransportStore.getState().setPlayheadFrame(60)
  expect(() => beginMaskEdit(target)).toThrow()
  expect(useDocumentStore.getState().past).toEqual([])
})

test('long-lived authoring owners are notified once when invalidated or replaced', () => {
  const canceled = vi.fn(), first = beginMaskEdit(target, canceled)
  useTransportStore.getState().setClipSelection(['other', 'clip'], 'clip')
  expect(canceled).toHaveBeenCalledTimes(1)
  first.cancel(); expect(first.commit({ shape: 'bezier' })).toMatch(/changed/)
  expect(canceled).toHaveBeenCalledTimes(1)
  const replaced = vi.fn(), second = beginMaskEdit(target, replaced), third = beginMaskEdit(target)
  expect(replaced).toHaveBeenCalledTimes(1)
  second.cancel(); expect(replaced).toHaveBeenCalledTimes(1)
  expect(third.commit({ x: 0.3 })).toBeNull()
  expect(useDocumentStore.getState().past).toHaveLength(1)
})

test('a new owner started during the end notification prevents an older release from committing', () => {
  let replacement: ReturnType<typeof beginMaskEdit> | null = null
  const before = useDocumentStore.getState().project
  const original = beginMaskEdit(target, () => { replacement = beginMaskEdit(target); replacement.preview({ x: 0.7 }) })
  expect(original.commit({ x: 0.3 })).toMatch(/changed/)
  expect(useDocumentStore.getState().project).toBe(before)
  expect(useTransportStore.getState().maskPreview?.params.x).toBe(0.7)
  expect(replacement!.commit({ x: 0.7 })).toBeNull()
  expect(useDocumentStore.getState().past).toHaveLength(1)
})

test('reentrant startup preserves the replacement owner and never installs orphan subscriptions', () => {
  const originalDocumentSubscribe = useDocumentStore.subscribe, originalTransportSubscribe = useTransportStore.subscribe
  const documentSubscriptions = new Set<symbol>(), transportSubscriptions = new Set<symbol>()
  const documentSpy = vi.spyOn(useDocumentStore, 'subscribe').mockImplementation((listener) => {
    const token = Symbol(), unsubscribe = originalDocumentSubscribe(listener); documentSubscriptions.add(token)
    return () => { documentSubscriptions.delete(token); unsubscribe() }
  })
  const transportSpy = vi.spyOn(useTransportStore, 'subscribe').mockImplementation((listener) => {
    const token = Symbol(), unsubscribe = originalTransportSubscribe(listener); transportSubscriptions.add(token)
    return () => { transportSubscriptions.delete(token); unsubscribe() }
  })
  try {
    const before = useDocumentStore.getState().project, replacementEnded = vi.fn(), outerEnded = vi.fn()
    let replacement: ReturnType<typeof beginMaskEdit> | null = null
    const initialEnded = vi.fn(() => { replacement = beginMaskEdit(target, replacementEnded); replacement.preview({ x: 0.6 }) })
    const initial = beginMaskEdit(target, initialEnded)
    expect(() => beginMaskEdit(target, outerEnded)).toThrow(/Another mask edit started/)
    expect(initialEnded).toHaveBeenCalledTimes(1)
    expect(outerEnded).not.toHaveBeenCalled()
    expect(replacementEnded).not.toHaveBeenCalled()
    expect(documentSubscriptions.size).toBe(1)
    expect(transportSubscriptions.size).toBe(1)
    expect(useTransportStore.getState().maskPreview?.params.x).toBe(0.6)
    expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
    initial.cancel()
    expect(replacement!.preview({ x: 0.7 })).toBeNull()
    expect(replacement!.commit({ x: 0.7 })).toBeNull()
    expect(replacementEnded).toHaveBeenCalledTimes(1)
    expect(documentSubscriptions.size).toBe(0)
    expect(transportSubscriptions.size).toBe(0)
    expect(useTransportStore.getState().maskPreview).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([before])
  } finally { documentSpy.mockRestore(); transportSpy.mockRestore() }
})
