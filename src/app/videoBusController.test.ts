import { expect, test } from 'vitest'
import { attributeProject } from '../test/clipAttributeFixtures'
import { createColorAdjustEffect } from '../domain/effectStack'
import { useDocumentStore } from '../state/documentStore'
import { applyVideoBusEdit, openVideoBusEdit } from './videoBusController'

test('video bus edits use one history entry, preserve redo on rejection and reject stale project sessions', () => {
  useDocumentStore.getState().setProject(attributeProject())
  const initial = useDocumentStore.getState().project
  const session = openVideoBusEdit({ kind: 'master', sequenceId: initial.rootSequenceId })
  expect(applyVideoBusEdit(session, { kind: 'apply', effects: [createColorAdjustEffect('template')], mode: 'append' })).toBeNull()
  const applied = useDocumentStore.getState().project
  expect(useDocumentStore.getState().past).toEqual([initial])
  useDocumentStore.getState().undo()
  expect(useDocumentStore.getState().project).toBe(initial)
  const fresh = openVideoBusEdit(session.target)
  expect(applyVideoBusEdit(fresh, { kind: 'apply', effects: [{ ...createColorAdjustEffect('template'), type: 'plugin:missing/source' }], mode: 'append' })).toContain('stage')
  expect(useDocumentStore.getState().future).toEqual([applied])
  useDocumentStore.getState().redo()
  expect(useDocumentStore.getState().project).toBe(applied)
  useDocumentStore.getState().setProject(initial)
  expect(applyVideoBusEdit(session, { kind: 'apply', effects: [], mode: 'replace' })).toContain('project changed')
  expect(useDocumentStore.getState().past).toEqual([])
})
