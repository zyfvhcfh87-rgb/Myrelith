import { expect, test } from 'vitest'
import { attributeProject } from '../test/clipAttributeFixtures'
import { createColorAdjustEffect } from '../domain/effectStack'
import { useDocumentStore } from '../state/documentStore'
import { applyVideoBusEdit, applyVideoBusPreset, openVideoBusEdit, openVideoBusPresetSave } from './videoBusController'
import { parseCube, portableColorLut } from '../domain/colorLut'
import { immutableColorLuts } from '../domain/colorLutCatalog'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'

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

test('portable bus presets remap collisions, deduplicate exact tables and keep one undoable copy', () => {
  const table = portableColorLut('table', 'Look', parseCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6'))
  const project = sequenceProjectFromTimeline(createTimelineDoc('Destination', DEFAULT_PROJECT_SETTINGS, 'root'))
  project.colorLuts = immutableColorLuts([{ ...table, domainMin: [-1, 0, 0] }])
  const preset = { id: 'preset', name: 'Portable look', colorLuts: [table], effects: [{ id: 'template', type: 'builtin.cube-lut', version: 1, enabled: true, params: { lutId: table.id, strength: 0.5 } }] }
  useDocumentStore.getState().setProject(project)
  const target = { kind: 'master' as const, sequenceId: 'root' }
  expect(applyVideoBusPreset(openVideoBusEdit(target), preset, 'append')).toBeNull()
  const applied = useDocumentStore.getState().project
  expect(applied.colorLuts).toHaveLength(2)
  const remapped = applied.sequences[0].masterVideoEffects![0]
  expect(remapped.params.lutId).not.toBe(table.id)
  expect(applied.colorLuts![1]).toMatchObject({ id: remapped.params.lutId, data: table.data })
  expect(useDocumentStore.getState().past).toEqual([project])
  expect(openVideoBusPresetSave(target).preset.colorLuts).toEqual([applied.colorLuts![1]])
  useDocumentStore.getState().undo()
  expect(useDocumentStore.getState().project).toBe(project)
  expect(applyVideoBusPreset(openVideoBusEdit(target), { ...preset, colorLuts: [] }, 'append')).toMatch(/missing/)
  expect(useDocumentStore.getState().future).toEqual([applied])
  useDocumentStore.getState().redo()
  expect(applyVideoBusPreset(openVideoBusEdit(target), preset, 'append')).toBeNull()
  const twice = useDocumentStore.getState().project
  expect(twice.colorLuts).toBe(applied.colorLuts)
  expect(twice.sequences[0].masterVideoEffects).toHaveLength(2)
  expect(twice.sequences[0].masterVideoEffects![1].id).not.toBe(remapped.id)
  expect(preset.effects[0].params.lutId).toBe('table')
})

test('preset catalog overflow rejects before altering the project or redo', () => {
  const project = sequenceProjectFromTimeline(createTimelineDoc('Full catalog', DEFAULT_PROJECT_SETTINGS, 'root'))
  project.colorLuts = immutableColorLuts(Array.from({ length: 16 }, (_, index) => portableColorLut(`table-${index}`, `Table ${index}`, parseCube(`LUT_1D_SIZE 2\n0 0 0\n${index / 16} 1 1`))))
  useDocumentStore.getState().setProject(project)
  useDocumentStore.setState({ future: [project] })
  const table = portableColorLut('new', 'New', parseCube('LUT_1D_SIZE 2\n0.1 0 0\n1 1 1'))
  const preset = { id: 'preset', name: 'Overflow', colorLuts: [table], effects: [{ id: 'template', type: 'builtin.cube-lut', version: 1, enabled: true, params: { lutId: table.id, strength: 1 } }] }
  expect(applyVideoBusPreset(openVideoBusEdit({ kind: 'master', sequenceId: 'root' }), preset, 'append')).toMatch(/16/)
  expect(useDocumentStore.getState()).toMatchObject({ project, past: [], future: [project] })
})
