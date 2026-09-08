import { afterEach, describe, expect, test, vi } from 'vitest'
import { animationEditorController } from './animationEditorController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { expandedTitleProject } from '../test/titleOwnerFixtures'
import { createMaskEffect, DEFAULT_MASK_BEZIER_PATH } from '../domain/effectStack'
import type { AnimationLaneAddress } from '../domain/animationAddresses'

vi.mock('./pluginAppController', () => ({ getPluginAppController: () => ({
  getContributionSnapshot: () => undefined, subscribe: () => () => {},
}) }))

let release: (() => void) | undefined
afterEach(() => { release?.(); release = undefined; useTransportStore.getState().resetTransport() })

describe('schema23 titles in the composed animation facade', () => {
  test('authors and pastes actual element keys with local ticks and one history entry per edit', () => {
    const project = expandedTitleProject()
    useDocumentStore.getState().setProject(project)
    useMediaStore.setState({ descriptors: new Map(), collections: [] })
    useTransportStore.getState().resetTransport()
    release = animationEditorController.init()
    const lane: AnimationLaneAddress = { owner: { kind: 'clip', id: 'root-text' }, kind: 'title',
      elementId: 'root-element', property: 'opacity', propertyVersion: 1 }
    expect(animationEditorController.setKey(lane, 5, 0.4)).toBeNull()
    const first = useDocumentStore.getState()
    expect(first.past).toEqual([project])
    expect(first.doc.tracks[0].clips[0].animation?.titleTracks?.[0].keyframes).toEqual([
      { frame: 5, sourceTimeTicks: 5_000_000, value: 0.4, easing: { type: 'linear' } },
    ])
    expect(animationEditorController.copy()).toBeNull()
    useTransportStore.getState().setPlayheadFrame(10)
    expect(animationEditorController.paste()).toBeNull()
    expect(useDocumentStore.getState().past).toHaveLength(2)
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation?.titleTracks?.[0].keyframes[1]).toMatchObject({ frame: 10, sourceTimeTicks: 10_000_000 })
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(first.project)
  })

  test.each(['supported', 'future'] as const)('%s title keeps outer geometry and mask animation unavailable', (kind) => {
    const project = expandedTitleProject(), clip = project.sequences[0].tracks[0].clips[0]
    if (kind === 'future') clip.title = { version: 9, payload: 'Preserved' }
    clip.effects = [createMaskEffect('mask', 'bezier')]
    useDocumentStore.getState().setProject(project)
    useMediaStore.setState({ descriptors: new Map(), collections: [] })
    useTransportStore.getState().resetTransport()
    release = animationEditorController.init()
    const owner = { kind: 'clip' as const, id: clip.id }
    const before = useDocumentStore.getState()
    expect(animationEditorController.setKey({ owner, kind: 'scalar', property: 'position-x', propertyVersion: 1 }, 5, 10)).toMatch(/outer opacity/)
    expect(animationEditorController.setKey({ owner, kind: 'effect', effectId: 'mask', parameter: 'x' }, 5, 0.2)).toMatch(/does not support animation/)
    expect(animationEditorController.setKey({ owner, kind: 'path', effectId: 'mask', parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1 }, 5, DEFAULT_MASK_BEZIER_PATH)).toMatch(/unavailable/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(animationEditorController.setKey({ owner, kind: 'scalar', property: 'opacity', propertyVersion: 1 }, 5, 0.5)).toBeNull()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].title).toBe(clip.title)
  })
})
