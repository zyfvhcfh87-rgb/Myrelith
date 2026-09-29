import { describe, expect, test } from 'vitest'
import {
  animationRetentionError,
  projectPathAnimationSnapshot,
  projectTitleAnimationOwners,
  type AnimationProjectionCache,
  type AnimationRetentionState,
} from './animationProjectBudget'
import { maskPathAnimationSnapshotBudget, MASK_PATH_ANIMATION_LIMITS } from './maskPathAnimation'
import type { SequenceProject } from './projectSequences'
import { titlePayloadBudget, TITLE_BUDGET_LIMITS } from './titleBudgets'
import { foundationProject, scalarKey } from '../test/animationFoundationFixtures'

function pathProject(): SequenceProject {
  const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
  clip.animation = { tracks: [], effectTracks: [], effectPathTracks: [0, 1].map((index) => ({
    effectId: `orphan-${index}`, parameter: 'future-path', valueType: 'future-path', valueVersion: 9,
    keyframes: Array.from({ length: 256 }, (_, frame) => ({ frame, sourceTimeTicks: frame * 1_000_000, value: 'a'.repeat(2048), easing: { type: 'hold' as const } })),
  })) }
  return project
}

function titleProject(): SequenceProject {
  const project = foundationProject()
  project.sequences[0].tracks[0].clips[0].animation = { tracks: [], effectTracks: [], titleTracks: Array.from({ length: 16 }, (_, i) => ({
    elementId: 'missing', property: `future-${i}`, propertyVersion: 9,
    keyframes: Array.from({ length: 512 }, (_, frame) => scalarKey(frame, 123.456)),
  })) }
  return project
}

function retention(project: SequenceProject, future: SequenceProject[]): AnimationRetentionState {
  return {
    project, past: [], future,
    retainedAttributePathTracks: [], retainedKeyPathTracks: [],
    retainedTitleClipboardOwners: [], retainedTitleClipboardElements: [], retainedTitleClipboardKeys: [],
  }
}

const emptyCache = (): AnimationProjectionCache => ({ paths: new WeakMap(), titles: new WeakMap() })

describe('owner-held animation projection cache', () => {
  test('matches uncached path and title admission at their retained limits, cold and warm', () => {
    const pathBudget = maskPathAnimationSnapshotBudget(projectPathAnimationSnapshot(pathProject()))
    const titleBudget = titlePayloadBudget(projectTitleAnimationOwners(titleProject())[0])
    if (!pathBudget.ok || !titleBudget.ok) throw new Error('fixture exceeds its payload budget')
    const pathCount = Math.floor(MASK_PATH_ANIMATION_LIMITS.retainedBytes / pathBudget.usage.retainedBytes)
    const titleCount = Math.floor(TITLE_BUDGET_LIMITS.retainedBytes / (2 * titleBudget.usage.serializedUtf8Bytes))
    const paths = retention(foundationProject(), Array.from({ length: pathCount }, pathProject))
    const titles = retention(foundationProject(), Array.from({ length: titleCount }, titleProject))
    const cases = [
      [paths, paths.project, null],
      [paths, pathProject(), /32 MiB/],
      [paths, projectPathAnimationSnapshot(pathProject()), /32 MiB/],
      [titles, titles.project, null],
      [titles, titleProject(), /64 MiB/],
      [titles, { tracks: [] }, null],
    ] as const
    const cache = emptyCache()
    for (const pass of ['cold', 'warm']) {
      for (const [state, candidate, expected] of cases) {
        const cached = animationRetentionError(state, candidate, cache)
        expect(cached, pass).toBe(animationRetentionError(state, candidate))
        if (expected === null) expect(cached).toBeNull()
        else expect(cached).toMatch(expected)
      }
    }
  }, 30_000)

  test('caches held snapshots only and shares the current owners with a clipboard check', () => {
    const state = { ...retention(titleProject(), [titleProject()]), past: [pathProject()] }
    const candidate = titleProject()
    const cache = emptyCache()
    expect(animationRetentionError(state, candidate, cache)).toBeNull()
    for (const held of [state.project, ...state.past, ...state.future]) {
      expect(cache.paths.has(held)).toBe(true)
      expect(cache.titles.has(held)).toBe(true)
    }
    expect(cache.paths.has(candidate) || cache.titles.has(candidate)).toBe(false)
    const owners = cache.titles.get(state.project)
    expect(animationRetentionError(state, { tracks: [] }, cache)).toBeNull()
    expect(cache.titles.get(state.project)).toBe(owners)
  })
})
