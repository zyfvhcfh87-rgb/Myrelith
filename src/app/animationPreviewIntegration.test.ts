import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAnimationEditingController } from './animationEditingController'
import { getAnimationEditorContext } from './animationEditorController'
import { beginTitleEdit } from './titleEditingController'
import { buildAnimationLaneIndex } from '../domain/animationLaneIndex'
import { animationLaneKey, type AnimationLaneAddress } from '../domain/animationAddresses'
import { createColorAdjustEffect, createMaskEffect } from '../domain/effectStack'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { expandedTitleProject, legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { scalarKey } from '../test/animationFoundationFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { retainedEffectPreviewDocuments, useTransportStore } from '../state/transportStore'
import { useTitleEditorStore } from '../state/titleEditorStore'

const lane: AnimationLaneAddress = { owner: { kind: 'clip', id: 'root-text' }, kind: 'effect', effectId: 'color', parameter: 'exposure' }
let editor: ReturnType<typeof createAnimationEditingController>, release: () => void
let pending: Map<number, () => void>, nextFrame: number
const flush = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback()) }
beforeEach(() => {
  useTransportStore.getState().resetTransport()
  useDocumentStore.getState().setProject(replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, effects: [createColorAdjustEffect('color')],
    animation: { ...clip.animation!, effectTracks: [{ effectId: 'color', parameter: 'exposure', keyframes: [scalarKey(0, 0), scalarKey(10, 1)] }] } })))
  useMediaStore.setState({ descriptors: new Map(), collections: [], assets: new Map() })
  useTransportStore.getState().setSelectedClip('root-text')
  useTransportStore.getState().setAnimationSelection([{ lane, frame: 0 }, { lane, frame: 10 }])
  useTitleEditorStore.getState().select('root-text', ['root-element'])
  pending = new Map(); nextFrame = 0
  editor = createAnimationEditingController({ readContext: getAnimationEditorContext,
    requestFrame: (callback) => { pending.set(++nextFrame, callback); return nextFrame }, cancelFrame: (id) => { pending.delete(id) } })
  release = editor.init()
})
afterEach(() => { release(); useTransportStore.getState().resetTransport() })

describe('Animation workspace on the integrated title owner', () => {
  test('canonical title effect lane edits retain source-time intent, evaluate and undo through the app controller', () => {
    const state = useDocumentStore.getState(), context = getAnimationEditorContext()
    expect(buildAnimationLaneIndex(state.doc, context).byId.get(animationLaneKey(lane))?.status).toBe('scalar')
    expect(editor.copy()).toBeNull()
    const clipboard = editor.getClipboard()
    expect(editor.edit({ kind: 'move', deltaFrames: 5 })).toBeNull()
    const edited = useDocumentStore.getState()
    expect(edited.doc.tracks[0].clips[0].animation!.effectTracks![0].keyframes.map(({ frame, sourceTimeTicks }) => [frame, sourceTimeTicks]))
      .toEqual([[5, 5_000_000], [15, 15_000_000]])
    expect(resolveClipAnimationAtFrame(edited.doc.tracks[0].clips[0], 10).effects[0].params.exposure).toBe(0.5)
    expect(edited.past).toEqual([state.project]); expect(editor.getClipboard()).toBe(clipboard)
    edited.undo(); expect(useDocumentStore.getState().project).toBe(state.project)
  })

  test.each(['future-title', 'legacy-title', 'future-effect', 'mask-stage'] as const)('preserves unavailable %s lanes and refuses mutation through the same editor', (kind) => {
    const source = kind === 'legacy-title' ? legacyTitleProject() : useDocumentStore.getState().project
    const project = replaceFirstTitleClip(source, (clip) => ({ ...clip,
      ...(kind === 'future-title' ? { title: { version: 99 } } : {}),
      effects: [kind === 'mask-stage' ? createMaskEffect('color', 'rectangle') : { ...createColorAdjustEffect('color'), version: kind === 'future-effect' ? 99 : 1 }],
      animation: { ...clip.animation!, effectTracks: [{ effectId: 'color', parameter: kind === 'mask-stage' ? 'x' : 'exposure', keyframes: [scalarKey(0, 0)] }] },
    }))
    useDocumentStore.getState().setProject(project)
    const target: AnimationLaneAddress = { ...lane, parameter: kind === 'mask-stage' ? 'x' : 'exposure' }
    useTransportStore.getState().setAnimationSelection([{ lane: target, frame: 0 }])
    const state = useDocumentStore.getState()
    expect(buildAnimationLaneIndex(state.doc, getAnimationEditorContext()).byId.get(animationLaneKey(target))?.status).toBe('unavailable')
    expect(editor.edit({ kind: 'set-value', value: 0.5 })).not.toBeNull()
    expect(useDocumentStore.getState()).toBe(state)
  })

  test('real title draft stays above an older Animation refresh; cancellation reveals its latest candidate', () => {
    const original = useDocumentStore.getState(), gesture = editor.begin()
    gesture.preview({ kind: 'move', deltaFrames: 1 }); flush()
    const title = beginTitleEdit({ sequenceId: 'root', clipId: 'root-text' })
    try {
      expect(title.preview({ kind: 'values', ids: ['root-element'], values: { 'position-x': 12 } })).toBeNull()
      const visibleTitle = useTransportStore.getState().effectDocumentPreview!.document
      gesture.preview({ kind: 'move', deltaFrames: 2 }); flush()
      expect(useTransportStore.getState().effectDocumentPreview).toMatchObject({ owner: 'title-authoring', document: visibleTitle })
      title.cancel()
      expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
      expect(useTransportStore.getState().effectDocumentPreview!.document.tracks[0].clips[0].animation!.effectTracks![0].keyframes[0].frame).toBe(2)
      gesture.cancel(); expect(retainedEffectPreviewDocuments()).toEqual([])
      expect(useDocumentStore.getState()).toBe(original)
    } finally { title.cancel(); gesture.cancel() }
  })

  test('reset releases all five retained owners and both real sessions cannot revive a queued candidate', () => {
    const doc = useDocumentStore.getState().doc, transport = useTransportStore.getState()
    transport.setMaskPreview({ sequenceId: doc.id, effectId: 'mask', params: {}, document: doc })
    transport.setMaskTrackingPreview({ sequenceId: doc.id, document: doc }, false)
    transport.setColorGradingPreview({ sequenceId: doc.id, effectId: 'grade', params: {}, document: doc })
    const gesture = editor.begin(); gesture.preview({ kind: 'move', deltaFrames: 1 }); flush()
    const title = beginTitleEdit({ sequenceId: 'root', clipId: 'root-text' })
    expect(title.preview({ kind: 'values', ids: ['root-element'], values: { 'position-x': 12 } })).toBeNull()
    expect(retainedEffectPreviewDocuments()).toHaveLength(5)
    gesture.preview({ kind: 'move', deltaFrames: 2 }); const late = [...pending.values()][0]
    const original = useDocumentStore.getState()
    transport.resetTransport(); late()
    expect(pending.size).toBe(0); expect(retainedEffectPreviewDocuments()).toEqual([])
    expect(gesture.commit({ kind: 'move', deltaFrames: 3 })).toMatch(/changed/)
    expect(title.commit({ kind: 'values', ids: ['root-element'], values: { 'position-x': 20 } })).toMatch(/changed/)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
    expect(useDocumentStore.getState()).toBe(original)
  })
})
