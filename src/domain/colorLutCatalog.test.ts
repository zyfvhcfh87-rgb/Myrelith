import { describe, expect, test } from 'vitest'
import { COLOR_LUT_LIMITS, COLOR_LUT_TYPE, parseCube, portableColorLut } from './colorLut'
import { colorLutCatalogError, immutableColorLuts, mergeColorLuts, newColorLutReferenceError, retainedColorLutBytes } from './colorLutCatalog'
import { applyColorLutToProject, removeUnusedColorLuts, type ColorGradingTarget } from './colorGradingEdits'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from './projectFile'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import { duplicateProjectSequence, sequenceProjectFromTimeline } from './projectSequences'
import { captureClipAttributes, pasteClipAttributes } from './clipAttributes'
import { attributeClip } from '../test/clipAttributeFixtures'
import { useDocumentStore } from '../state/documentStore'

const table = (id = 'lut') => portableColorLut(id, 'Swap red and green', parseCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6'))
function fixture() { return sequenceProjectFromTimeline(structuredClone(createTimelineDoc('Grading', DEFAULT_PROJECT_SETTINGS, 'root'))) }
let id = 0
const fresh = () => `fresh-${++id}`

describe('portable LUT ownership', () => {
  test('format 8 roundtrips embedded data and schema 21; format 7 migrates with an empty catalog', () => {
    const original = fixture()
    original.colorLuts = immutableColorLuts([table()])
    const snapshot = createProjectFileSnapshot(original, [])
    const loaded = parseProjectFile(serializeProjectFile(snapshot))
    expect(loaded.formatVersion).toBe(8)
    expect(loaded.sequences[0].schemaVersion).toBe(21)
    expect(loaded.colorLuts).toEqual(original.colorLuts)
    expect(Object.isFrozen(loaded.colorLuts[0])).toBe(true)
    const legacy = { ...snapshot, formatVersion: 7 } as Record<string, unknown>
    delete legacy.colorLuts
    expect(parseProjectFile(JSON.stringify(legacy)).colorLuts).toEqual([])
    expect(() => parseProjectFile(JSON.stringify({ ...legacy, colorLuts: [] }))).toThrow(/unknown field/)
    expect(() => parseProjectFile(JSON.stringify({ ...legacy, formatVersion: 8 }))).toThrow(/colorLuts/)
  })
  test('preserves bounded future records without decoding, but rejects corrupt current payloads', () => {
    const project = fixture()
    project.colorLuts = [{ version: 4, id: 'future', custom: { retained: ['opaque', 2, null] }, data: 'not v1 base64' }]
    const loaded = parseProjectFile(serializeProjectFile(createProjectFileSnapshot(project, [])))
    expect(loaded.colorLuts).toEqual(project.colorLuts)
    expect(colorLutCatalogError([{ ...table(), data: '!'.repeat(table().data.length) }], true)).toMatch(/base64/)
    expect(colorLutCatalogError([{ version: 2, id: 'future', custom: Array(257).fill(0) }])).toMatch(/entries/)
    expect(colorLutCatalogError([table(), table()], true)).toMatch(/unique/)
  })
  test('deduplicates exact shape/domain/data, remints collisions, and shares immutable records', () => {
    const catalog = immutableColorLuts([table()])
    const merge = mergeColorLuts(catalog, [table('other')], fresh)
    expect(merge.catalog).toBe(catalog)
    expect(merge.ids.get('other')).toBe('lut')
    const changed = { ...table(), domainMin: [-1, 0, 0] as const }
    const added = mergeColorLuts(catalog, [changed], fresh)
    expect(added.catalog[0]).toBe(catalog[0])
    expect(added.ids.get('lut')).not.toBe('lut')
    expect(retainedColorLutBytes([{ ...fixture(), colorLuts: catalog }, { ...fixture(), colorLuts: catalog }], catalog)).toBe(table().data.length * 2)
  })
  test('enforces decoded, serialized, record and distinct history budgets without dropping redo', () => {
    const large = portableColorLut('large', 'Large', { kind: '3d', size: 33, title: '', domainMin: [0, 0, 0], domainMax: [1, 1, 1], samples: new Float64Array(33 ** 3 * 3) })
    expect(colorLutCatalogError(Array.from({ length: 5 }, (_, i) => ({ ...large, id: `large-${i}` })))).toMatch(/4 MiB/)
    expect(colorLutCatalogError(Array.from({ length: 17 }, (_, i) => table(`t-${i}`)))).toMatch(/16/)
    expect(colorLutCatalogError([{ version: 2, id: 'future', data: 'é'.repeat(COLOR_LUT_LIMITS.catalogBytes / 2) }])).toMatch(/6 MiB/)
    const base = fixture(), future = fixture()
    useDocumentStore.getState().setProject(base)
    const past = Array.from({ length: 30 }, () => ({ ...fixture(), colorLuts: [Object.freeze({ ...large })] }))
    useDocumentStore.setState({ past, future: [future] })
    const state = useDocumentStore.getState()
    const next = applyColorLutToProject(base, { sequenceId: 'root', kind: 'master' }, table(), fresh)
    expect(state.commitColorLutEdit(base, state.projectGeneration, next)).toMatch(/64 MiB/)
    expect(useDocumentStore.getState().past).toBe(past)
    expect(useDocumentStore.getState().future).toEqual([future])
    expect(useDocumentStore.getState().project).toBe(base)
    useDocumentStore.getState().setProject(fixture())
  })
  test.each(['master', 'track', 'clip', 'adjustment'] as const)('applies table plus descriptor atomically to %s with one undo', (kind) => {
    const project = fixture(), track = project.sequences[0].tracks[0]
    track.clips = [attributeClip('clip')]
    track.adjustments = [{ kind: 'adjustment', enabled: true, opacity: 1, id: 'adjustment', name: 'Correction', animation: { tracks: [], effectTracks: [] }, timelineRange: { startFrame: 0, durationFrames: 60 }, effects: [] }]
    const target = { sequenceId: 'root', kind, trackId: track.id, clipId: 'clip', adjustmentId: 'adjustment' } as ColorGradingTarget
    const next = applyColorLutToProject(project, target, table(), fresh)
    useDocumentStore.getState().setProject(project)
    const state = useDocumentStore.getState()
    expect(state.commitColorLutEdit(project, state.projectGeneration, next)).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([project])
    state.undo(); expect(useDocumentStore.getState().project).toBe(project)
    state.redo(); expect(useDocumentStore.getState().project).toBe(next)
    track.locked = true
    if (kind !== 'master') expect(() => applyColorLutToProject(project, target, table(), fresh)).toThrow(/unlocked/)
  })
  test('copy restores tables after undo and remaps collisions; sequence duplication shares the catalog', () => {
    const source = fixture(), track = source.sequences[0].tracks[0]
    track.clips = [attributeClip('source'), attributeClip('destination', 100)]
    const graded = applyColorLutToProject(source, { sequenceId: 'root', kind: 'clip', clipId: 'source' }, table(), fresh)
    const capture = captureClipAttributes(graded.sequences[0].tracks[0].clips[0], 'video', ['effects'], undefined, graded.colorLuts)
    if (!capture.ok) throw new Error(capture.reason)
    const copied = pasteClipAttributes(source, 'root', ['destination'], capture.template, { groups: ['effects'], effectsMode: 'append', includeAnimation: true }, fresh)
    expect(copied.ok).toBe(true)
    if (!copied.ok) return
    expect(copied.project.colorLuts).toEqual(graded.colorLuts)
    expect(newColorLutReferenceError(source, copied.project)).toBeNull()
    const clone = duplicateProjectSequence(copied.project, 'root', 'Copy', fresh)
    expect(clone.failure).toBeNull()
    expect(clone.project.colorLuts).toBe(copied.project.colorLuts)
    const dangling = { ...copied.project, colorLuts: [] }
    expect(newColorLutReferenceError(source, dangling)).toMatch(/unavailable/)
  })
  test('removal is explicit, conservative for unknown effects and undoable; missing intent survives save', () => {
    const project = fixture()
    project.colorLuts = immutableColorLuts([table()])
    expect(removeUnusedColorLuts(project).colorLuts).toEqual([])
    project.sequences[0].masterVideoEffects = [{ id: 'unknown', type: 'future', version: 1, enabled: false, params: {} }]
    expect(() => removeUnusedColorLuts(project)).toThrow(/unsupported/)
    project.sequences[0].masterVideoEffects = [{ id: 'missing', type: COLOR_LUT_TYPE, version: 1, enabled: true, params: { lutId: 'absent', strength: 1 } }]
    expect(parseProjectFile(serializeProjectFile(createProjectFileSnapshot(project, []))).sequences[0].masterVideoEffects).toEqual(project.sequences[0].masterVideoEffects)
  })
})
