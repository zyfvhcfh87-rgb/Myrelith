import { describe, expect, test } from 'vitest'
import { captionIntentOwners, captionRetentionError, type CaptionUsageCache } from './captionIntentBudget'
import type { SequenceProject } from './projectSequences'
import { captionBudgetProject } from '../test/captionIntentFixtures'

/** Current + 7 past + 7 future snapshots at exactly 2 MiB each: 30 MiB held. */
function heldHistory() {
  const project = captionBudgetProject(2_097_152)
  const copy = (name: string): SequenceProject => ({ ...project, name })
  return {
    project,
    past: Array.from({ length: 7 }, (_, i) => copy(`Past ${i}`)),
    future: Array.from({ length: 7 }, (_, i) => copy(`Future ${i}`)),
    retainedCaptionOwners: {},
  }
}

describe('owner-held caption usage cache', () => {
  test('matches uncached admission at the 32 MiB boundary, cold and warm', () => {
    const state = heldHistory()
    const candidate = { ...state.project, name: 'Candidate' }
    const oneMore = [{ style: { version: 1, params: {} } }]
    const oversized = captionBudgetProject(2_097_153)
    const invalid = { ...state, future: [...state.future.slice(1), captionBudgetProject(0)] }
    invalid.future[6].sequences[0].captionTracks![0].style = { version: 1, params: { color: 'x'.repeat(129) } }
    const cases = [
      [state, candidate, []],
      [state, candidate, oneMore],
      [state, oversized, []],
      [invalid, candidate, []],
    ] as const
    const cache: CaptionUsageCache = new WeakMap()
    for (const pass of ['cold', 'warm']) {
      for (const [held, next, owners] of cases) {
        expect(captionRetentionError(held, next, owners, cache), pass)
          .toBe(captionRetentionError(held, next, owners))
      }
    }
    expect(captionRetentionError(state, candidate, [], cache)).toBeNull()
    expect(captionRetentionError(state, candidate, oneMore, cache)).toMatch(/32 MiB/)
    expect(captionRetentionError(state, oversized, [], cache)).toMatch(/2 MiB/)
    expect(captionRetentionError(invalid, candidate, [], cache)).toMatch(/character bound|primitive/)
  })

  test('reuses held snapshot usage but always measures the candidate afresh', () => {
    const state = heldHistory()
    const candidate = { ...state.project, name: 'Candidate' }
    const cache: CaptionUsageCache = new WeakMap()
    expect(captionRetentionError(state, candidate, [], cache)).toBeNull()
    for (const held of [state.project, ...state.past, ...state.future]) expect(cache.get(held)).toBe(2_097_152)
    expect(cache.has(candidate)).toBe(false)

    // A stale entry for the candidate is ignored; a held entry is trusted.
    cache.set(candidate, Number.MAX_SAFE_INTEGER)
    expect(captionRetentionError(state, candidate, [], cache)).toBeNull()
    cache.set(state.past[0], 2_097_153)
    expect(captionRetentionError(state, candidate, [], cache)).toMatch(/2 MiB/)
    expect(captionRetentionError(state, candidate)).toBeNull()
  })

  test('undo-style checks without a candidate charge every held occurrence', () => {
    const state = heldHistory()
    const repeated = { ...state, past: [...state.past, state.project] }
    const cache: CaptionUsageCache = new WeakMap()
    const extra = captionIntentOwners(captionBudgetProject(2_097_152))
    expect(captionRetentionError(repeated, undefined, [], cache)).toBeNull()
    expect(captionRetentionError(repeated, undefined, extra, cache)).toMatch(/32 MiB/)
    expect(captionRetentionError(repeated, undefined, extra)).toMatch(/32 MiB/)
  })
})
