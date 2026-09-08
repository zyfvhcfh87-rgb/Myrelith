import { beforeEach, describe, expect, test } from 'vitest'
import { expandedTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { beginTitleEdit, commitTitleEdit } from './titleEditingController'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { readTitleElement } from '../domain/titleElements'
import type { TitleEditCommand } from '../domain/titleEditing'
import { serializeProjectFile, createProjectFileSnapshot, parseProjectFile } from '../domain/projectFile'
const target = { sequenceId: 'root', clipId: 'root-text' }
const patch: TitleEditCommand = { kind: 'values', ids: ['root-element'], values: { 'position-x': 35 } }
function activate() {
  useTransportStore.getState().resetTransport()
  useDocumentStore.getState().setProject(expandedTitleProject())
  useMediaStore.setState({ descriptors: new Map(), collections: [], assets: new Map() })
  useTransportStore.getState().setSelectedClip('root-text')
  useTitleEditorStore.getState().select('root-text', ['root-element'])
}
function x() {
  const element = readTitleElement((useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as unknown[])[0])
  return element.status === 'supported' ? element.element.transform.x : NaN
}
beforeEach(activate)
describe('title app session ownership', () => {
  test('preview is ephemeral and one Apply is exactly undoable, then portable reopen retains data', () => {
    const original = useDocumentStore.getState().project
    const session = beginTitleEdit(target)
    expect(session.preview(patch)).toBeNull()
    expect(useDocumentStore.getState().project).toBe(original)
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    expect(session.commit(patch)).toBeNull()
    expect(x()).toBe(35)
    expect(useDocumentStore.getState().past).toEqual([original])
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
    const encoded = serializeProjectFile(createProjectFileSnapshot(useDocumentStore.getState().project, [], []))
    expect(parseProjectFile(encoded).sequences[0].tracks[0].clips[0].title).toBeDefined()
    useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(original)
    useDocumentStore.getState().redo(); expect(x()).toBe(35)
  })
  test('cancel, no-op and rejected complete padding candidate preserve redo', () => {
    expect(commitTitleEdit(target, patch)).toBeNull(); useDocumentStore.getState().undo()
    const before = useDocumentStore.getState(), session = beginTitleEdit(target)
    expect(session.preview(patch)).toBeNull(); session.cancel()
    expect(useDocumentStore.getState()).toBe(before)
    expect(commitTitleEdit(target, { kind: 'values', ids: ['root-element'], values: { 'position-x': 0 } })).toBeNull()
    expect(useDocumentStore.getState()).toBe(before)
    expect(commitTitleEdit(target, { kind: 'patch', ids: ['root-element'], patch: { text: { paddingPx: 1000 } } })).toMatch(/padding/i)
    expect(useDocumentStore.getState()).toBe(before)
  })
  test.each(['project', 'generation', 'sequence', 'selection', 'elements', 'playhead', 'reset', 'media', 'playback'] as const)('rejects a stale %s without changing history', (change) => {
    const session = beginTitleEdit(target); expect(session.preview(patch)).toBeNull()
    switch (change) {
      case 'project': useDocumentStore.getState().setProject(expandedTitleProject()); break
      case 'generation': useDocumentStore.getState().setProject(useDocumentStore.getState().project); break
      case 'sequence': useDocumentStore.setState({ activeSequenceId: 'dormant' }); break
      case 'selection': useTransportStore.getState().setSelectedClip(null); break
      case 'elements': useTitleEditorStore.getState().select('root-text', []); break
      case 'playhead': useTransportStore.getState().setPlayheadFrame(5); break
      case 'reset': useTransportStore.getState().resetTransport(); break
      case 'media': useMediaStore.setState({ descriptors: new Map() }); break
      case 'playback': useTransportStore.setState({ isPlaying: true }); break
    }
    const before = useDocumentStore.getState()
    expect(session.commit(patch)).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test('all four existing named previews survive title cancellation in their activation order', () => {
    const document = useDocumentStore.getState().doc, transport = useTransportStore.getState()
    transport.setColorGradingPreview({ sequenceId: 'root', effectId: 'grade', params: {}, document })
    transport.setMaskPreview({ sequenceId: 'root', effectId: 'mask', params: {}, document })
    transport.setAnimationPreview({ sequenceId: 'root', document })
    transport.setMaskTrackingPreview({ sequenceId: 'root', document })
    const session = beginTitleEdit(target); expect(session.preview(patch)).toBeNull()
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    session.cancel(); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
    transport.setMaskTrackingPreview(null); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
    transport.setAnimationPreview(null); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-gesture')
    transport.setMaskPreview(null); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('color-grading')
  })
  test('replacing a title draft retains its activation order beneath a newer preview owner', () => {
    const session = beginTitleEdit(target), document = useDocumentStore.getState().doc
    expect(session.preview(patch)).toBeNull()
    useTransportStore.getState().setMaskTrackingPreview({ sequenceId: 'root', document })
    expect(session.preview({ ...patch, values: { 'position-x': 70 } } as TitleEditCommand)).toBeNull()
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
    useTransportStore.getState().setMaskTrackingPreview(null)
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    session.cancel()
  })
  test('synchronous preview subscriber replacing the project cleans only this owner', () => {
    const session = beginTitleEdit(target), external = expandedTitleProject()
    const stop = useTransportStore.subscribe((state) => { if (state.effectDocumentPreview?.owner === 'title-authoring') useDocumentStore.getState().setProject(external) })
    expect(session.preview(patch)).toMatch(/changed/); stop()
    expect(useDocumentStore.getState().project).toBe(external)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test('a new owner started during cancellation cannot be overwritten by the old commit', () => {
    let replacement: ReturnType<typeof beginTitleEdit> | undefined
    const session = beginTitleEdit(target, () => { replacement = beginTitleEdit(target) })
    expect(session.commit(patch)).toMatch(/changed/)
    expect(x()).toBe(0)
    expect(replacement!.preview(patch)).toBeNull()
    replacement!.cancel()
  })
  test('reentrant preview admission cannot mutate history', () => {
    const session = beginTitleEdit(target)
    let nested: string | null = null
    const stop = useTransportStore.subscribe((state) => { if (state.effectDocumentPreview?.owner === 'title-authoring') nested = session.commit(patch) })
    expect(session.preview(patch)).toBeNull(); stop()
    expect(nested).toMatch(/already being admitted/)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    session.cancel()
  })
  test('sampled motion preserves unrelated future and orphan lane status', () => {
    const orphan = { elementId: 'missing-element', propertyVersion: 9, property: 'future', keyframes: [{ frame: 1, value: 4, easing: { type: 'linear' as const } }] }
    useDocumentStore.getState().setProject(replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [orphan] } })))
    const session = beginTitleEdit(target)
    expect(session.preview({ kind: 'motion', ids: ['root-element'], direction: 'up', start: 0, end: 99, replace: false }, 50)).toBeNull()
    expect(useTransportStore.getState().effectDocumentPreview!.document.tracks[0].clips[0].animation!.titleTracks).toEqual([orphan])
    session.cancel()
  })
  test('motion sample uses the shared resolver without moving the playhead or committing', () => {
    const before = useDocumentStore.getState().project, session = beginTitleEdit(target)
    const command: TitleEditCommand = { kind: 'motion', ids: ['root-element'], direction: 'up', start: 0, end: 99, replace: false }
    expect(session.preview(command, 50)).toBeNull()
    expect(useTransportStore.getState().playheadFrame).toBe(0)
    expect(useDocumentStore.getState().project).toBe(before)
    expect(session.commit(command)).toBeNull()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation!.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([0, 99])
  })
})
