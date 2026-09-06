import { beforeEach, expect, test } from 'vitest'
import { applyEffectTemplate, createEffectPresetController, openPresetSave } from './effectPresetController'
import { openAttributeEdit } from './clipAttributeController'
import { mutateEffectPresetLibrary, readEffectPresetLibrary } from '../domain/effectPresets'
import { useEffectPresetStore } from '../state/effectPresetStore'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { attributeProject } from '../test/clipAttributeFixtures'
import type { EffectPresetRepository } from './localEffectPresetStorage'

beforeEach(() => {
  useDocumentStore.getState().setProject(attributeProject())
  useTransportStore.setState({ selectedClipIds: ['source'], selectedClipId: 'source', playheadFrame: 5 })
  useEffectPresetStore.setState({ presets: [], unavailable: [], loaded: false, busy: false, readOnlyReason: null, error: null, message: '' })
})
function repository(): EffectPresetRepository {
  let raw: string | undefined
  return { load: async () => readEffectPresetLibrary(raw).view, mutate: async (mutation, isCurrent) => {
    if (isCurrent && !isCurrent()) throw new Error('Project changed')
    raw = mutateEffectPresetLibrary(raw, mutation)
    return readEffectPresetLibrary(raw).view
  } }
}
test('library persists across controllers and project replacements without history edits', async () => {
  const repo = repository(), controller = createEffectPresetController(repo)
  const session = openPresetSave('source')
  expect(await controller.save(session, 'My look')).toBe(true)
  expect(useDocumentStore.getState().past).toEqual([])
  useDocumentStore.getState().setProject(attributeProject())
  await createEffectPresetController(repo).load()
  expect(useEffectPresetStore.getState().presets[0].name).toBe('My look')
})
test('failed writes retain the existing library and never announce success', async () => {
  const repo = repository(), controller = createEffectPresetController(repo)
  await controller.save(openPresetSave('source'), 'First')
  const previous = useEffectPresetStore.getState().presets
  const broken = createEffectPresetController({ load: repo.load, mutate: async () => { throw new Error('Quota exceeded') } })
  expect(await broken.save(openPresetSave('source'), 'Second')).toBe(false)
  expect(useEffectPresetStore.getState()).toMatchObject({ presets: previous, error: 'Quota exceeded', message: '', busy: false })
})
test('save snapshots survive source edits but reject project replacement before transaction write', async () => {
  let proceed!: () => void
  const barrier = new Promise<void>((resolve) => { proceed = resolve })
  const repo = repository()
  const controller = createEffectPresetController({ load: repo.load, mutate: async (mutation, current) => { await barrier; return repo.mutate(mutation, current) } })
  const snapshot = openPresetSave('source')
  useDocumentStore.getState().removeEffect('source', 'color')
  expect(snapshot.preset.effects).toHaveLength(2)
  const saving = controller.save(snapshot, 'Old project')
  useDocumentStore.getState().setProject(attributeProject())
  proceed()
  expect(await saving).toBe(false)
  expect((await repo.load()).presets).toEqual([])
})
test('preset application makes independent static copies in one undo; deletion cannot affect them', async () => {
  const controller = createEffectPresetController(repository())
  await controller.save(openPresetSave('source'), 'Reusable')
  const preset = useEffectPresetStore.getState().presets[0]
  useTransportStore.setState({ selectedClipIds: ['first', 'second'], selectedClipId: 'second' })
  expect(applyEffectTemplate(openAttributeEdit('reset'), preset.effects, 'append')).toBeNull()
  const pasted = useDocumentStore.getState().project
  expect(useDocumentStore.getState().past).toHaveLength(1)
  const [first, second] = pasted.sequences[0].tracks[0].clips.slice(1)
  expect(first.effects[0].id).not.toBe(second.effects[0].id)
  expect(first.animation?.effectTracks).toEqual([])
  await controller.edit({ kind: 'delete', id: preset.id })
  expect(useDocumentStore.getState().project).toBe(pasted)
  useDocumentStore.getState().undo(); useDocumentStore.getState().redo()
  expect(useDocumentStore.getState().project).toBe(pasted)
})
