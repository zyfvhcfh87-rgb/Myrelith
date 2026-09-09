import { beforeEach, describe, expect, test } from 'vitest'
import { createTitleTemplateController, pinTitleTemplateDialog } from './titleTemplateController'
import { builtInTitleTemplates, mutateTitleTemplateLibrary, readTitleTemplateLibrary, titleTemplateFromLibrary } from '../domain/titleTemplates'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { useTitleTemplateStore } from '../state/titleTemplateStore'
import { expandedTitleProject } from '../test/titleOwnerFixtures'
function repository() {
  let raw: string | undefined
  return { load: async () => readTitleTemplateLibrary(raw).view, read: async (id: string) => titleTemplateFromLibrary(raw, id),
    mutate: async (mutation: Parameters<typeof mutateTitleTemplateLibrary>[1], current = () => true) => { if (!current()) throw new Error('stale storage'); raw = mutateTitleTemplateLibrary(raw, mutation); return readTitleTemplateLibrary(raw).view } }
}
beforeEach(() => {
  useDocumentStore.getState().setProject(expandedTitleProject()); useTransportStore.getState().resetTransport(); useTransportStore.getState().setSelectedClip('root-text')
  useTitleEditorStore.getState().select('root-text', ['root-element']); useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useTitleTemplateStore.setState({ templates: [], busy: false, readOnlyReason: null, unavailable: [], error: null })
})
describe('title template app admission', () => {
  test('save/delete affects only library; inserting a copy is one undoable edit', async () => {
    const controller = createTitleTemplateController(repository()), project = useDocumentStore.getState().project
    expect(await controller.save(pinTitleTemplateDialog(), { sequenceId: 'root', clipId: 'root-text' }, 'My title')).toBe(true)
    expect(useDocumentStore.getState().project).toBe(project); expect(useDocumentStore.getState().past).toHaveLength(0)
    const id = useTitleTemplateStore.getState().templates[0].id, template = await controller.read(id)
    useTransportStore.getState().setPlayheadFrame(200)
    expect(controller.insert(pinTitleTemplateDialog(), project.sequences[0].tracks[0].id, template)).toBeNull()
    const inserted = useDocumentStore.getState().project
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(await controller.delete(id)).toBe(true); expect(useDocumentStore.getState().project).toBe(inserted)
    useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(project)
  })
  test('stale capture and insertion leave current project and history untouched', async () => {
    const controller = createTitleTemplateController(repository()), pin = pinTitleTemplateDialog()
    useTransportStore.getState().setPlayheadFrame(200)
    const before = useDocumentStore.getState()
    expect(await controller.save(pin, { sequenceId: 'root', clipId: 'root-text' }, 'Stale')).toBe(false)
    expect(controller.insert(pin, before.doc.tracks[0].id, builtInTitleTemplates()[0])).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(before)
  })
  test('store notifications changing selection before capture are caught', async () => {
    const controller = createTitleTemplateController(repository()), pin = pinTitleTemplateDialog()
    const stop = useTitleTemplateStore.subscribe((state) => { if (state.busy) useTitleEditorStore.getState().select('root-text', []) })
    expect(await controller.save(pin, { sequenceId: 'root', clipId: 'root-text' }, 'Raced')).toBe(false)
    stop(); expect(useTitleTemplateStore.getState().templates).toHaveLength(0)
  })
})
