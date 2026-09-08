import { beforeEach, describe, expect, test, vi } from 'vitest'
import { animationRetentionError, projectTitleAnimationOwners } from '../domain/animationProjectBudget'
import { retainedTitleDataBudget, titlePayloadBudget, TITLE_BUDGET_LIMITS } from '../domain/titleBudgets'
import { TITLE_LIMITS } from '../domain/titleElements'
import { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } from '../domain/projectFile'
import { updateTextClip } from '../domain/operations/audioText'
import { expandedTitleProject, legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { opaqueTitleHistoryProject, opaqueTitleWithBytes } from '../test/titleBudgetFixtures'
import { scalarKey } from '../test/animationFoundationFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { commitPortableProjectEdit } from './portableProjectEdit'
import { createTitleUpgradeController } from './titleUpgradeController'
import { titleDefinitionUsage } from '../domain/titleOwnership'

beforeEach(() => {
  useDocumentStore.getState().setProject(legacyTitleProject())
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
})

describe('actual schema23 title payload and retained ownership', () => {
  test.each(['clip', 'playhead', 'range'] as const)('the %s split store action reserves dormant orphan IDs and commits one undoable edit', (kind) => {
    const project = expandedTitleProject()
    const reserved = 'title-element_00000000-0000-0000-0000-000000000000'
    project.sequences[1].tracks[0].clips[0].animation = { tracks: [], effectTracks: [], titleTracks: [
      { elementId: reserved, propertyVersion: 9, property: 'future', keyframes: [scalarKey(0, 1)] },
    ] }
    useDocumentStore.getState().setProject(project)
    let serial = 0
    const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-0000-0000-${String(serial++).padStart(12, '0')}` as ReturnType<Crypto['randomUUID']>)
    try {
      const state = useDocumentStore.getState()
      if (kind === 'clip') state.splitClipAt('root-text', 40)
      else if (kind === 'playhead') state.splitClipAtPlayhead(40)
      else state.applySequenceEdit({ status: 'ok', kind: 'lift', trackIds: [state.doc.tracks[0].id], timelineRange: { startFrame: 20, durationFrames: 30 } }, null)
      const committed = useDocumentStore.getState()
      expect(committed.past).toEqual([project])
      expect(committed.doc.tracks[0].clips).toHaveLength(2)
      const ids = committed.doc.tracks[0].clips.flatMap((clip) => titleDefinitionUsage(clip.title!).elementIds)
      expect(ids).not.toContain(reserved)
      expect(new Set(ids).size).toBe(ids.length)
      expect(() => serializeProjectFile(createProjectFileSnapshot(committed.project, []))).not.toThrow()
      committed.undo()
      expect(useDocumentStore.getState().project).toBe(project)
    } finally { uuid.mockRestore() }
  })

  test('enforces one shared 1 MiB cap for an actual title plus its orphan lanes', () => {
    const titleTracks = [{ elementId: 'orphan', propertyVersion: 9, property: 'future', keyframes: [scalarKey(-1, 123)] }]
    const remaining = TITLE_LIMITS.serializedBytes - JSON.stringify(titleTracks).length
    const candidate = (over: number) => replaceFirstTitleClip(expandedTitleProject(), (clip) => ({
      ...clip, title: opaqueTitleWithBytes(remaining + over), animation: { ...clip.animation!, titleTracks },
    }))
    const exact = candidate(0)
    expect(titlePayloadBudget(projectTitleAnimationOwners(exact)[0])).toMatchObject({ ok: true, usage: { serializedUtf8Bytes: TITLE_LIMITS.serializedBytes } })
    expect(parseProjectFile(serializeProjectFile(createProjectFileSnapshot(exact, []))).sequences[0].tracks[0].clips[0].title).toEqual(exact.sequences[0].tracks[0].clips[0].title)
    const over = candidate(1)
    const owner = projectTitleAnimationOwners(over)[0]
    expect(titlePayloadBudget({ title: owner.title! }).ok).toBe(true)
    expect(titlePayloadBudget({ titleTracks }).ok).toBe(true)
    expect(() => createProjectFileSnapshot(over, [])).toThrow(/1 MiB/)
    useDocumentStore.setState({ future: [legacyTitleProject()] })
    const before = useDocumentStore.getState()
    expect(commitPortableProjectEdit(before.project, before.projectGeneration, over)).toMatch(/1 MiB/)
    expect(useDocumentStore.getState()).toBe(before)
  })

  test('counts actual dormant owners, both history branches and clipboards at exactly 64 MiB before clearing redo', () => {
    const snapshots = Array.from({ length: 4 }, opaqueTitleHistoryProject)
    // These are real supported portable files, not synthetic owner projections.
    for (const project of snapshots) {
      const file = serializeProjectFile(createProjectFileSnapshot(project, []))
      expect(file.length).toBeLessThan(10_000_000)
      expect(parseProjectFile(file).sequences).toHaveLength(2)
    }
    const past = snapshots.slice(0, 2), future = [snapshots[2]]
    const clipboards = projectTitleAnimationOwners(snapshots[3])
    useDocumentStore.setState({ past, future, retainedTitleClipboardOwners: clipboards })
    const before = useDocumentStore.getState()
    const result = retainedTitleDataBudget({ candidate: [], current: [], past: past.map(projectTitleAnimationOwners),
      future: future.map(projectTitleAnimationOwners), clipboards: { titles: clipboards, elements: [], keys: [] },
    })
    expect(result).toEqual({ ok: true, retainedBytes: TITLE_BUDGET_LIMITS.retainedBytes })
    expect(animationRetentionError(before, before.project)).toBeNull()
    const controller = createTitleUpgradeController(() => 'new-element')
    expect(controller.upgrade(controller.begin('root-text'))).toMatch(/64 MiB/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useDocumentStore.getState().future).toBe(future)
    // The same history pressure imposes no expanded-title cost on ordinary legacy editing.
    const doc = updateTextClip(before.doc, 'root-text', { content: 'Same compact owner', color: '#eeeeee' })
    const project = { ...before.project, sequences: [doc, before.project.sequences[1]] }
    expect(commitPortableProjectEdit(before.project, before.projectGeneration, project)).toBeNull()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].title).toBeUndefined()
    expect(useDocumentStore.getState().past.at(-1)).toBe(before.project)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
  }, 30_000)
})
