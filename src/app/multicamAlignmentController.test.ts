import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MulticamAlignmentController, type MulticamAlignmentControllerDeps, type MulticamAlignmentSettings } from './multicamAlignmentController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { INITIAL_MULTICAM_ALIGNMENT, useMulticamAlignmentStore } from '../state/multicamAlignmentStore'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { setActiveLocalProjectBindingId } from './localProjectProvenance'
import { alignmentAsset } from '../test/fixtures/alignmentAssets'
import { applyMulticamDefinitionEdit } from '../domain/multicamOperations'
import type { AudioAlignmentServiceResult } from './audioAlignmentService'
import { MediaJobScheduler } from './mediaJobScheduler'

const owners: MulticamAlignmentController[] = []
const result = (angleId: string): AudioAlignmentServiceResult => ({ comparisons: [{ angleId, pairKey: 'a'.repeat(64),
  fromCache: false, result: { state: 'aligned', offsetFrames: 23, lagBins: -150,
    facts: { score: 1, margin: 0.2, alternativeScore: 0.8, overlapBins: 1850, comparisons: 100, evaluatedLags: 2001 } } }], cacheHits: 0, cacheWarnings: [] })
beforeEach(() => {
  useDocumentStore.getState().setDoc(createTimelineDoc('Alignment', { ...DEFAULT_PROJECT_SETTINGS, frameRate: { num: 30, den: 1 } }, 'alignment-root'))
  useMulticamAlignmentStore.setState({ ...INITIAL_MULTICAM_ALIGNMENT })
  setActiveLocalProjectBindingId('local-project:alignment')
  useMediaStore.getState().replaceAssets([], [])
  for (const id of ['reference', 'target', 'third']) useMediaStore.getState().addAsset(alignmentAsset(id))
})
afterEach(async () => { for (const owner of owners.splice(0)) await owner.dispose() })
function fixture() {
  useDocumentStore.getState().createMulticam({ name: 'Concert', startFrame: 0, videoTrackId: 'V1', audioTrackId: 'A1',
    angles: [ { assetId: 'reference', name: 'Reference', durationFrames: 600, syncFrame: 0 },
      { assetId: 'target', name: 'Target', durationFrames: 500, syncFrame: 0 },
      { assetId: 'third', name: 'Third', durationFrames: 450, syncFrame: 0 } ], audioPolicy: { kind: 'fixed', angleIndex: 0 } })
  const definition = useDocumentStore.getState().project.multicams![0]
  const deps: MulticamAlignmentControllerDeps = {
    audio: { run: vi.fn(async () => result(definition.angles[1].id)), cancelAndDrain: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
      snapshot: () => new MediaJobScheduler().snapshot() },
    timecode: vi.fn(), blob: vi.fn(),
  }
  const controller = new MulticamAlignmentController(deps)
  owners.push(controller)
  const settings: MulticamAlignmentSettings = { definitionId: definition.id, referenceAngleId: definition.angles[0].id,
    targetAngleIds: [definition.angles[1].id], method: 'audio', binCount: 2000, maxLagBins: 1000,
    startBins: Object.fromEntries(definition.angles.map((angle) => [angle.id, 0])), commonClockAndDay: false }
  return { controller, deps, settings, definition }
}
test('preview leaves document/history untouched; corrected offsets apply once and undo/redo together', async () => {
  const f = fixture()
  const before = useDocumentStore.getState()
  await f.controller.analyze(f.settings)
  expect(useDocumentStore.getState()).toBe(before)
  expect(useMulticamAlignmentStore.getState()).toMatchObject({ phase: 'ready' })
  const offsets = [{ angleId: f.definition.angles[1].id, coverageStartFrame: 24 }]
  expect(f.controller.apply(offsets)).toBe(true)
  const after = useDocumentStore.getState()
  expect(after.past.length).toBe(before.past.length + 1)
  expect(after.project.multicams![0].angles[1].coverage.startFrame).toBe(24)
  expect(after.project.multicams![0].durationFrames).toBe(600)
  expect(after.project.sequences).toEqual(before.project.sequences)
  expect(f.controller.apply(offsets)).toBe(false)
  useDocumentStore.getState().undo()
  expect(useDocumentStore.getState().project).toEqual(before.project)
  useDocumentStore.getState().redo()
  expect(useDocumentStore.getState().project).toEqual(after.project)
  expect(JSON.stringify(after.project)).not.toMatch(/cacheKey|fingerprint|pairKey|decodePolicy/)
})
test('apply ignores an unselected leftover offline angle', async () => {
  const f = fixture()
  await f.controller.analyze(f.settings)
  useMediaStore.getState().removeAsset('third')
  const before = useDocumentStore.getState()
  expect(f.controller.apply([{ angleId: f.definition.angles[1].id, coverageStartFrame: 24 }])).toBe(true)
  expect(useDocumentStore.getState().past.length).toBe(before.past.length + 1)
  expect(useDocumentStore.getState().project.multicams![0].angles[1].coverage.startFrame).toBe(24)
  expect(useMulticamAlignmentStore.getState()).toMatchObject({ phase: 'applied' })
})
test('rejects oversized, negative, fractional and unreviewed offsets without creating history', async () => {
  const f = fixture()
  await f.controller.analyze(f.settings)
  const before = useDocumentStore.getState()
  for (const coverageStartFrame of [-1, 0.5, 101, Infinity]) {
    expect(f.controller.apply([{ angleId: f.definition.angles[1].id, coverageStartFrame }])).toBe(false)
    expect(useDocumentStore.getState()).toBe(before)
  }
  expect(f.controller.apply([{ angleId: f.definition.angles[2].id, coverageStartFrame: 2 }])).toBe(false)
})
test('replacement, locks and project edits invalidate an outstanding result', async () => {
  const f = fixture()
  let complete!: (value: AudioAlignmentServiceResult) => void
  vi.mocked(f.deps.audio.run).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const pending = f.controller.analyze(f.settings)
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  useDocumentStore.getState().editMulticamDefinition({ kind: 'set-angle', definitionId: f.definition.id,
    angleId: f.definition.angles[1].id, name: 'Renamed', coverageStartFrame: 0 })
  complete(result(f.definition.angles[1].id))
  await pending
  expect(useMulticamAlignmentStore.getState().phase).toBe('stale')
  expect(f.controller.apply([{ angleId: f.definition.angles[1].id, coverageStartFrame: 24 }])).toBe(false)
  expect(f.deps.audio.cancelAndDrain).toHaveBeenCalled()
})
test('atomic domain action protects all shared references, rejects stale snapshots, and preserves geometry', () => {
  const f = fixture()
  const project = useDocumentStore.getState().project
  const offsets = f.definition.angles.slice(1).map((angle, index) => ({ angleId: angle.id, coverageStartFrame: 20 + index }))
  const command = { kind: 'set-offsets' as const, definitionId: f.definition.id, expectedDefinition: f.definition, offsets }
  const edited = applyMulticamDefinitionEdit(project, command)
  expect(edited.failure).toBeNull()
  expect(edited.project.multicams![0].angles.map((angle) => angle.coverage.startFrame)).toEqual([0, 20, 21])
  expect(applyMulticamDefinitionEdit(edited.project, command).project).toBe(edited.project)
  const locked = { ...project, sequences: project.sequences.map((sequence) => ({ ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, locked: true })) })) }
  expect(applyMulticamDefinitionEdit(locked, command)).toEqual({ project: locked, failure: 'track-locked' })
  expect(applyMulticamDefinitionEdit(project, { ...command, offsets: [offsets[0], offsets[0]] }).failure).toBe('invalid-definition')
})
