import { describe, expect, test } from 'vitest'
import { createTitleUpgradeController } from './titleUpgradeController'
import { commitPortableProjectEdit } from './portableProjectEdit'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile, CURRENT_TIMELINE_SCHEMA_VERSION, PROJECT_FILE_LIMITS } from '../domain/projectFile'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import { updateTextClip } from '../domain/operations/audioText'
import { exactLegacyTitleFile, titleProjectFromFile } from '../test/titleFileBoundaryFixtures'
import { legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import type { SequenceProject } from '../domain/projectSequences'

function currentWire(project: SequenceProject): string {
  const media = useMediaStore.getState()
  return serializeProjectFile(createProjectFileSnapshot(project, media.descriptors.values(), media.collections))
}
function activate(encoded: string): SequenceProject {
  const file = parseProjectFile(encoded)
  useMediaStore.setState({ descriptors: new Map(file.assets.map((asset) => [asset.id, asset])), collections: file.collections })
  const project = titleProjectFromFile(file)
  useDocumentStore.getState().setProject(project)
  return project
}
function createRedo(project: SequenceProject): void {
  const state = useDocumentStore.getState()
  const clip = state.doc.tracks[0].clips[0]
  const doc = updateTextClip(state.doc, clip.id, { content: 'B' + clip.text!.content.slice(1), color: '#eeeeee' })
  expect(commitPortableProjectEdit(project, state.projectGeneration, { ...project, sequences: [doc, project.sequences[1]] })).toBeNull()
  useDocumentStore.getState().undo()
  expect(useDocumentStore.getState().project).toBe(project)
  expect(useDocumentStore.getState().future).toHaveLength(1)
}

describe('schema23 real file and explicit upgrade boundary', () => {
  test.each([9_999_614, 9_999_615, 9_999_999, 10_000_000])('keeps %i-character schema22 legacy files compact through edit/save/undo/reopen', (characters) => {
    const old = exactLegacyTitleFile(characters)
    const project = activate(old)
    const migrated = old.replaceAll('"schemaVersion":22', `"schemaVersion":${CURRENT_TIMELINE_SCHEMA_VERSION}`)
    expect(currentWire(project)).toBe(migrated)
    expect(project.sequences.every((sequence) => sequence.tracks.every((track) => track.clips.every((clip) => clip.title === undefined)))).toBe(true)
    expect(migrated).toContain('世界')
    expect(migrated).toContain('\\u0000')
    expect(migrated).toContain('reserved-orphan')
    createRedo(project)
    const undo = useDocumentStore.getState()
    expect(currentWire(undo.project)).toBe(migrated)
    useDocumentStore.getState().redo()
    expect(currentWire(useDocumentStore.getState().project).length).toBe(characters)
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState()
    const controller = createTitleUpgradeController(() => 'upgraded-element')
    const candidate = upgradeLegacyTextTitle(project, 'root', 'root-text-0', () => 'upgraded-element')
    expect(candidate.ok).toBe(true)
    if (!candidate.ok) return
    const media = useMediaStore.getState()
    const actualLength = JSON.stringify(createProjectFileSnapshot(candidate.project, media.descriptors.values(), media.collections)).length
    const result = controller.upgrade(controller.begin('root-text-0'))
    if (actualLength > PROJECT_FILE_LIMITS.maxSerializedCharacters) {
      expect(result).toMatch(/exceeds 10000000 characters/)
      expect(useDocumentStore.getState()).toBe(before)
    } else {
      expect(result).toBeNull()
      expect(currentWire(useDocumentStore.getState().project).length).toBe(actualLength)
      expect(useDocumentStore.getState().past).toHaveLength(1)
      useDocumentStore.getState().undo()
      expect(useDocumentStore.getState().project).toBe(project)
      expect(currentWire(project)).toBe(migrated)
    }
    expect(parseProjectFile(migrated).sequences[0].tracks[0].clips[0].title).toBeUndefined()
    if (characters === 10_000_000) {
      const over = { ...parseProjectFile(migrated), name: 'Title boundaryx' }
      expect(JSON.stringify(over).length).toBe(10_000_001)
      expect(() => parseProjectFile(JSON.stringify(over))).toThrow(/exceeds 10000000 characters/)
      expect(() => serializeProjectFile(over)).toThrow(/exceeds 10000000 characters/)
    }
  }, 30_000)

  test.each([0, 1])('measures the real upgrade delta and enforces exact-fit plus %i character', (over) => {
    const sample = parseProjectFile(exactLegacyTitleFile(9_900_000))
    const upgraded = upgradeLegacyTextTitle(titleProjectFromFile(sample), 'root', 'root-text-0', () => 'upgraded-element')
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    const delta = serializeProjectFile(createProjectFileSnapshot(upgraded.project, sample.assets, sample.collections)).length - 9_900_000
    expect(delta).toBeGreaterThan(0)
    const originalLength = PROJECT_FILE_LIMITS.maxSerializedCharacters - delta + over
    const project = activate(exactLegacyTitleFile(originalLength))
    createRedo(project)
    const before = useDocumentStore.getState()
    const controller = createTitleUpgradeController(() => 'upgraded-element')
    const result = controller.upgrade(controller.begin('root-text-0'))
    if (over) {
      expect(result).toMatch(/exceeds 10000000 characters/)
      expect(useDocumentStore.getState()).toBe(before)
    } else {
      expect(result).toBeNull()
      expect(currentWire(useDocumentStore.getState().project).length).toBe(10_000_000)
      const committed = useDocumentStore.getState()
      expect(committed.doc.tracks[0].clips[0].text).toBeUndefined()
      expect(committed.doc.tracks[0].clips[0].title).toBeDefined()
      expect(controller.upgrade(controller.begin('root-text-0'))).toBeNull()
      expect(useDocumentStore.getState()).toBe(committed)
      useDocumentStore.getState().undo()
      expect(useDocumentStore.getState().project).toBe(project)
      expect(currentWire(project).length).toBe(originalLength)
      useDocumentStore.getState().redo()
      expect(currentWire(useDocumentStore.getState().project).length).toBe(10_000_000)
    }
  }, 30_000)

  test('keeps historical schema21 files at the exact cap without title or optional animation growth', () => {
    const old = exactLegacyTitleFile(10_000_000, 21)
    expect(serializeProjectFile(parseProjectFile(old))).toBe(old.replaceAll('"schemaVersion":21', `"schemaVersion":${CURRENT_TIMELINE_SCHEMA_VERSION}`))
    expect(old).not.toMatch(/titleTracks|effectPathTracks|propertyVersion|parameterIdentity/)
  }, 30_000)

  test('rejects stale, locked and reentrant upgrades without clearing redo or partially changing state', () => {
    useMediaStore.setState({ descriptors: new Map(), collections: [] })
    const project = legacyTitleProject()
    useDocumentStore.getState().setProject(project)
    const controller = createTitleUpgradeController(() => 'fresh')
    const stale = controller.begin('root-text')
    useDocumentStore.getState().setProject(legacyTitleProject())
    const replaced = useDocumentStore.getState()
    expect(controller.upgrade(stale)).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(replaced)
    const locked = { ...project, sequences: project.sequences.map((sequence) => ({ ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, locked: true })) })) }
    useDocumentStore.getState().setProject(locked)
    const before = useDocumentStore.getState()
    expect(controller.upgrade(controller.begin('root-text'))).toMatch(/Unlock/)
    expect(useDocumentStore.getState()).toBe(before)
    useDocumentStore.getState().setProject(project)
    const race = createTitleUpgradeController(() => {
      useDocumentStore.getState().setProject(replaceFirstTitleClip(project, (clip) => ({ ...clip, name: 'A different project state' })))
      return 'raced-id'
    })
    expect(race.upgrade(race.begin('root-text'))).toMatch(/changed/)
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].text).toBeDefined()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].title).toBeUndefined()
  })
})
