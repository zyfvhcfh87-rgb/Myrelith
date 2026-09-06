import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { attributeProject } from '../test/clipAttributeFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useClipAttributeStore } from '../state/clipAttributeStore'
import {
  applyAttributeEdit, copyClipAttributes, copyClipEffectStack,
  initClipAttributeClipboard, openAttributeEdit,
} from './clipAttributeController'
import type { AttributePasteOptions } from '../domain/clipAttributes'

const options: AttributePasteOptions = { groups: ['effects'], effectsMode: 'append', includeAnimation: true }
let release: () => void
beforeEach(() => {
  useDocumentStore.getState().setProject(attributeProject())
  useTransportStore.getState().resetTransport()
  release = initClipAttributeClipboard()
})
afterEach(() => release())
function select(...ids: string[]) {
  useTransportStore.setState({ selectedClipIds: ids, selectedClipId: ids.at(-1) ?? null })
}

describe('attribute clipboard and history', () => {
  test('one paste is one history entry with exact undo/redo identities', () => {
    copyClipEffectStack('source')
    select('first', 'second')
    const original = useDocumentStore.getState().project
    expect(applyAttributeEdit(openAttributeEdit('paste'), 'paste', options)).toBeNull()
    const { project: pasted, past } = useDocumentStore.getState()
    expect(past).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(original)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project).toBe(pasted)
  })

  test('stale project or changed selection rejects without erasing redo', () => {
    copyClipAttributes('source')
    select('first', 'second')
    const session = openAttributeEdit('paste')
    useDocumentStore.getState().setClipVolume('first', 0.5)
    useDocumentStore.getState().undo()
    const future = useDocumentStore.getState().future
    select('second')
    expect(applyAttributeEdit(session, 'paste', options)).toMatch(/selection changed/)
    expect(useDocumentStore.getState().future).toBe(future)
    const fresh = openAttributeEdit('paste')
    useDocumentStore.getState().setClipVolume('first', 0.75)
    expect(applyAttributeEdit(fresh, 'paste', options)).toMatch(/project or selection changed/)
  })

  test('clipboard survives edits/deletion but same-id project reload and disposal clear it', () => {
    copyClipEffectStack('source')
    useDocumentStore.getState().rippleDelete('source')
    select('first')
    expect(openAttributeEdit('paste').template?.attributes).toHaveLength(1)
    const project = useDocumentStore.getState().project
    const session = openAttributeEdit('paste')
    useDocumentStore.getState().setProject(project)
    expect(useClipAttributeStore.getState().sourceName).toBeNull()
    expect(applyAttributeEdit(session, 'paste', options)).toMatch(/project or selection changed/)
    expect(openAttributeEdit('paste').template).toBeNull()
  })

  test('copies checked effects only and preserves the full stack snapshot after later source edits', () => {
    copyClipAttributes('source', ['future'])
    select('first')
    const copied = openAttributeEdit('paste')
    useDocumentStore.getState().removeEffect('source', 'future')
    const source = openAttributeEdit('paste').template!.attributes.find((a) => a.kind === 'effects')!
    expect(source.value.map((effect) => effect.type)).toEqual(['future.effect'])
    expect(copied.template).toBe(openAttributeEdit('paste').template)
    expect(applyAttributeEdit(openAttributeEdit('paste'), 'paste', options)).toBeNull()
    expect(useDocumentStore.getState().doc.tracks[0].clips[1].animation?.effectTracks).toHaveLength(1)
  })

  test('idempotent reset preserves populated redo; locked paste is all-or-nothing', () => {
    select('first')
    useDocumentStore.getState().setClipVolume('second', 0.5)
    useDocumentStore.getState().undo()
    const future = useDocumentStore.getState().future
    expect(applyAttributeEdit(openAttributeEdit('reset'), 'reset', { ...options, groups: ['opacity'] })).toBeNull()
    expect(useDocumentStore.getState().future).toBe(future)
    copyClipEffectStack('source')
    useDocumentStore.getState().setTrackFlags(useDocumentStore.getState().doc.tracks[0].id, { locked: true })
    const { project, past } = useDocumentStore.getState()
    expect(applyAttributeEdit(openAttributeEdit('paste'), 'paste', options)).toMatch(/locked/)
    expect(useDocumentStore.getState().project).toBe(project)
    expect(useDocumentStore.getState().past).toBe(past)
  })
})
