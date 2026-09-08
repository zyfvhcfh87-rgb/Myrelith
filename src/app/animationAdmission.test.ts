import { beforeEach, describe, expect, test } from 'vitest'
import { animationRetentionError, projectTitleAnimationOwners, projectPathAnimationSnapshot } from '../domain/animationProjectBudget'
import { maskPathAnimationSnapshotBudget, MASK_PATH_ANIMATION_LIMITS } from '../domain/maskPathAnimation'
import { titlePayloadBudget, TITLE_BUDGET_LIMITS } from '../domain/titleBudgets'
import { createProjectFileSnapshot } from '../domain/projectFile'
import { sequenceProjectWithinEditBudget } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { ATTRIBUTE_ASSET_DESCRIPTOR, foundationProject, scalarKey } from '../test/animationFoundationFixtures'
import { commitPortableProjectEdit } from './portableProjectEdit'

beforeEach(() => {
  useDocumentStore.getState().setProject(foundationProject())
  useMediaStore.setState({ descriptors: new Map([['asset', ATTRIBUTE_ASSET_DESCRIPTOR]]), collections: [] })
})
function orphanProject(tracks = 16) {
  const project = foundationProject()
  project.sequences[0].tracks[0].clips[0].animation = { tracks: [], effectTracks: [], titleTracks: Array.from({ length: tracks }, (_, i) => ({
    elementId: 'missing', property: `future-${i}`, propertyVersion: 9,
    keyframes: Array.from({ length: 512 }, (_, frame) => scalarKey(frame, 123.456)),
  })) }
  return project
}

describe('all-owner animation admission before history mutation', () => {
  test('counts full orphan title lane bytes, even in a dormant sequence without a title owner', () => {
    const project = orphanProject(), owner = projectTitleAnimationOwners(project)[0]
    const budget = titlePayloadBudget(owner)
    expect(budget).toMatchObject({ ok: true, usage: { keyframes: 8192, tracks: 16, serializedUtf8Bytes: JSON.stringify(owner.titleTracks).length } })
    expect(sequenceProjectWithinEditBudget(project)).toBe(true)
    const tooLarge = orphanProject(30)
    const root = foundationProject().sequences[0]; root.id = 'empty'; root.tracks = []
    tooLarge.sequences.unshift(root); tooLarge.rootSequenceId = root.id
    expect(sequenceProjectWithinEditBudget(tooLarge)).toBe(false)
    expect(() => createProjectFileSnapshot(tooLarge, [ATTRIBUTE_ASSET_DESCRIPTOR])).toThrow(/1 MiB/)
  })

  test('retains shared title keys once and rejects new orphan data before clearing a valid redo branch', () => {
    const candidate = orphanProject(), owner = projectTitleAnimationOwners(candidate)[0]
    const usage = titlePayloadBudget(owner)
    expect(usage.ok).toBe(true)
    if (!usage.ok) return
    const count = Math.floor(TITLE_BUDGET_LIMITS.retainedBytes / (2 * usage.usage.serializedUtf8Bytes))
    expect(count).toBeLessThan(100)
    const future = Array.from({ length: count }, () => orphanProject())
    useDocumentStore.setState({ future })
    const before = useDocumentStore.getState()
    expect(animationRetentionError(before, before.project)).toBeNull()
    expect(animationRetentionError({ ...before, past: [future[0]], retainedTitleClipboardOwners: projectTitleAnimationOwners(future[0]), retainedTitleClipboardKeys: future[0].sequences[0].tracks[0].clips[0].animation!.titleTracks! }, before.project)).toBeNull()
    expect(commitPortableProjectEdit(before.project, before.projectGeneration, candidate)).toMatch(/64 MiB/)
    expect(useDocumentStore.getState()).toBe(before)
  }, 30_000)

  test('path strings in dormant unavailable tracks count before redo or clipboard ownership changes', () => {
    const make = () => {
      const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
      clip.animation = { tracks: [], effectTracks: [], effectPathTracks: [0, 1].map((index) => ({
        effectId: `orphan-${index}`, parameter: 'future-path', valueType: 'future-path', valueVersion: 9,
        keyframes: Array.from({ length: 256 }, (_, frame) => ({ frame, sourceTimeTicks: frame * 1_000_000, value: 'a'.repeat(2048), easing: { type: 'hold' as const } })),
      })) }
      return project
    }
    const candidate = make(), budget = maskPathAnimationSnapshotBudget(projectPathAnimationSnapshot(candidate))
    expect(budget.ok).toBe(true)
    if (!budget.ok) return
    const count = Math.floor(MASK_PATH_ANIMATION_LIMITS.retainedBytes / budget.usage.retainedBytes)
    const future = Array.from({ length: count }, make)
    useDocumentStore.setState({ future })
    const before = useDocumentStore.getState()
    expect(animationRetentionError(before, before.project)).toBeNull()
    expect(animationRetentionError({ ...before, retainedAttributePathTracks: projectPathAnimationSnapshot(future[0]).tracks }, before.project)).toBeNull()
    expect(animationRetentionError(before, projectPathAnimationSnapshot(candidate))).toMatch(/32 MiB/)
    expect(commitPortableProjectEdit(before.project, before.projectGeneration, candidate)).toMatch(/32 MiB/)
    expect(useDocumentStore.getState()).toBe(before)
  })

  test('a crop rejected by ordinary store admission preserves project, history and populated redo', () => {
    useDocumentStore.getState().setClipVolume('clip', 0.5)
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState(), next = structuredClone(before.doc)
    next.tracks[0].clips[0].animation = { tracks: [
      { property: 'crop-left', keyframes: [scalarKey(0, 0.8)] },
      { property: 'crop-right', keyframes: [scalarKey(0, 0.3)] },
    ], effectTracks: [] }
    before.setDocWithHistory(next)
    expect(useDocumentStore.getState()).toBe(before)
  })
})
