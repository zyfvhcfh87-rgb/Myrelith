import { beforeEach, describe, expect, test } from 'vitest'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { animationCatalog, ATTRIBUTE_ASSET_DESCRIPTOR, foundationProject, PLUGIN_ANIMATION_EFFECT_TYPE, scalarKey } from '../test/animationFoundationFixtures'
import { bindAnimationParameter } from './animationBindingController'

beforeEach(() => {
  const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
  clip.effects = [{ id: 'plugin', type: PLUGIN_ANIMATION_EFFECT_TYPE, version: 1, enabled: true, params: { amount: 0.2 } }]
  clip.animation = { tracks: [], effectTracks: [{ effectId: 'plugin', parameter: 'amount', keyframes: [scalarKey(0, 0), scalarKey(10, 1)] }] }
  useMediaStore.setState({ descriptors: new Map([['asset', ATTRIBUTE_ASSET_DESCRIPTOR]]), collections: [] })
  useDocumentStore.getState().setProject(project)
})

describe('explicit animation declaration binding', () => {
  test('commits exactly once; undo restores unverified data and redo restores the same binding', () => {
    const catalog = animationCatalog(), bind = () => bindAnimationParameter(() => catalog, 'clip', 'plugin', 'amount')
    const original = useDocumentStore.getState().project
    expect(bind()).toBeNull()
    const bound = useDocumentStore.getState().project
    expect(bound.sequences[0].tracks[0].clips[0].animation?.effectTracks?.[0].parameterIdentity?.packageDigest).toBe(catalog.declarations[0].packageDigest)
    expect(useDocumentStore.getState().past).toEqual([original])
    expect(bind()).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([original])
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(original)
    expect(original.sequences[0].tracks[0].clips[0].animation?.effectTracks?.[0].parameterIdentity).toBeUndefined()
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project).toBe(bound)
  })

  test.each(['missing catalog', 'catalog replaced after candidate creation'] as const)('rejects a %s without clearing redo', (change) => {
    const catalog = animationCatalog(), replacement = animationCatalog(2)
    let reads = 0
    useDocumentStore.getState().setClipVolume('clip', 0.5)
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState()
    const read = change === 'missing catalog' ? () => undefined : () => ++reads < 2 ? catalog : replacement
    expect(bindAnimationParameter(read, 'clip', 'plugin', 'amount')).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useDocumentStore.getState().future).toBe(before.future)
  })
})
