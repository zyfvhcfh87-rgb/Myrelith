import { beforeEach, describe, expect, test } from 'vitest'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { animationCatalog, ATTRIBUTE_ASSET_DESCRIPTOR, foundationProject, PLUGIN_ANIMATION_EFFECT_TYPE, scalarKey } from '../test/animationFoundationFixtures'
import { createAnimationBindingController } from './animationBindingController'

beforeEach(() => {
  const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
  clip.effects = [{ id: 'plugin', type: PLUGIN_ANIMATION_EFFECT_TYPE, version: 1, enabled: true, params: { amount: 0.2 } }]
  clip.animation = { tracks: [], effectTracks: [{ effectId: 'plugin', parameter: 'amount', keyframes: [scalarKey(0, 0), scalarKey(10, 1)] }] }
  useMediaStore.setState({ descriptors: new Map([['asset', ATTRIBUTE_ASSET_DESCRIPTOR]]), collections: [] })
  useDocumentStore.getState().setProject(project)
})

describe('explicit animation declaration binding', () => {
  test('commits exactly once; undo restores unverified data and redo restores the same binding', () => {
    const catalog = animationCatalog(), controller = createAnimationBindingController(() => catalog)
    const original = useDocumentStore.getState().project
    expect(controller.bind(controller.begin(), 'clip', 'plugin', 'amount')).toBeNull()
    const bound = useDocumentStore.getState().project
    expect(bound.sequences[0].tracks[0].clips[0].animation?.effectTracks?.[0].parameterIdentity?.packageDigest).toBe(catalog.declarations[0].packageDigest)
    expect(useDocumentStore.getState().past).toEqual([original])
    expect(controller.bind(controller.begin(), 'clip', 'plugin', 'amount')).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([original])
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(original)
    expect(original.sequences[0].tracks[0].clips[0].animation?.effectTracks?.[0].parameterIdentity).toBeUndefined()
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project).toBe(bound)
  })

  test.each(['project', 'generation', 'sequence', 'catalog'] as const)('rejects changed %s without clearing redo', (change) => {
    let catalog = animationCatalog()
    const controller = createAnimationBindingController(() => catalog)
    useDocumentStore.getState().setClipVolume('clip', 0.5)
    useDocumentStore.getState().undo()
    const session = controller.begin(), before = useDocumentStore.getState()
    if (change === 'project') useDocumentStore.setState({ project: { ...before.project } })
    if (change === 'generation') useDocumentStore.setState({ projectGeneration: before.projectGeneration + 1 })
    if (change === 'sequence') useDocumentStore.setState({ activeSequenceId: 'different' })
    if (change === 'catalog') catalog = animationCatalog(2)
    const expected = useDocumentStore.getState()
    expect(controller.bind(session, 'clip', 'plugin', 'amount')).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(expected)
    expect(useDocumentStore.getState().future).toBe(before.future)
  })

  test('checks the catalog again after candidate creation', () => {
    const catalog = animationCatalog(), replacement = animationCatalog(2)
    let reads = 0
    const controller = createAnimationBindingController(() => ++reads < 3 ? catalog : replacement)
    const session = controller.begin(), before = useDocumentStore.getState()
    expect(controller.bind(session, 'clip', 'plugin', 'amount')).toMatch(/catalog changed/)
    expect(useDocumentStore.getState()).toBe(before)
  })
})
