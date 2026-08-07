import { describe, expect, test } from 'vitest'
import { measureFramePlanningIndex } from './framePlanningBenchmark'

describe('frame-planning benchmark', () => {
  test('compares parity-checked indexed and legacy plans for dense and sparse tracks', () => {
    const evidence = measureFramePlanningIndex({
      clipsPerTrack: 64,
      trackCount: 2,
      transitionsPerTrack: 4,
      framesPerSample: 24,
      sampleCount: 3,
    })

    expect(evidence).toMatchObject({
      version: 'issue-59-v1',
      lookup: 'immutable-per-track-binary-search',
      rebuildPolicy: 'planner-construction-on-document-or-source-catalog-change',
    })
    expect(evidence.scenarios.map((scenario) => scenario.layout))
      .toEqual(['dense', 'sparse'])
    for (const scenario of evidence.scenarios) {
      expect(scenario.trackCount).toBe(2)
      expect(scenario.clipsPerTrack).toBe(64)
      expect(scenario.transitionCount).toBeGreaterThan(0)
      expect(scenario.parityFrameCount).toBe(24)
      expect(scenario.transitionParityFrameCount).toBeGreaterThan(0)
      expect(scenario.legacyMillisecondsPerFrame).toHaveLength(3)
      expect(scenario.indexedMillisecondsPerFrame).toHaveLength(3)
      expect(Number.isFinite(scenario.p95ImprovementPercent)).toBe(true)
    }
  })

  test('rejects unbounded or transition-free fixture options', () => {
    expect(() => measureFramePlanningIndex({ clipsPerTrack: 1 })).toThrow(
      'clipsPerTrack must allow at least one transition seam',
    )
    expect(() => measureFramePlanningIndex({ sampleCount: 0 })).toThrow(
      'sampleCount must be a positive integer',
    )
  })
})
