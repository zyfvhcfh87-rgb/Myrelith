import { describe, expect, test } from 'vitest'
import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  IDENTITY_SIMILARITY_TRANSFORM,
  MotionAnalysisCancelledError,
  applySimilarityTransform,
  composeSimilarityTransforms,
  createStabilizationPlan,
  estimateGlobalMotionSequence,
  invertSimilarityTransform,
  validateMotionAnalysisBudget,
  type GlobalMotionEstimate,
  type GrayFrame,
  type SimilarityTransform,
} from './motionAnalysis'
import {
  researchFixtureIdentityIsExact,
  runMotionAnalysisResearch,
} from './motionAnalysisResearch'

function flatFrame(value: number): GrayFrame {
  return {
    width: 32,
    height: 24,
    data: new Uint8Array(32 * 24).fill(value),
  }
}

function estimate(transform: SimilarityTransform): GlobalMotionEstimate {
  return {
    transform,
    matchCount: 20,
    inlierCount: 18,
    inlierRatio: 0.9,
    meanInlierError: 0.2,
    confidence: 0.8,
  }
}

describe('motion analysis research', () => {
  test('composes and inverts similarity transforms without changing a point', () => {
    const transform = { a: 1.02, b: 0.04, tx: 3, ty: -2 }
    const identity = composeSimilarityTransforms(
      invertSimilarityTransform(transform),
      transform,
    )
    const point = { x: 17, y: 9 }
    expect(applySimilarityTransform(identity, point)).toEqual({ x: 17, y: 9 })
    expect(researchFixtureIdentityIsExact()).toBe(true)
  })

  test('keeps strength zero unchanged and exposes increasing crop at full strength', () => {
    const estimates = [
      estimate({ a: 1, b: 0, tx: 2, ty: -1 }),
      estimate({ a: 1, b: 0, tx: -3, ty: 2 }),
      estimate({ a: 1, b: 0, tx: 3, ty: -2 }),
      estimate({ a: 1, b: 0, tx: -2, ty: 1 }),
    ]
    const off = createStabilizationPlan(estimates, 192, 108, 0, 2)
    const full = createStabilizationPlan(estimates, 192, 108, 1, 2)
    expect(off.corrections.every((item) => (
      item.a === 1 && item.b === 0 && item.tx === 0 && item.ty === 0
    ))).toBe(true)
    expect(off.jitterReductionRatio).toBeCloseTo(0, 10)
    expect(full.jitterReductionRatio).toBeGreaterThan(0)
    expect(full.conservativeSafeZoom).toBeGreaterThan(1)
  })

  test('honors cancellation before expensive frame matching', () => {
    expect(() => estimateGlobalMotionSequence(
      [flatFrame(10), flatFrame(20)],
      { ...DEFAULT_MOTION_ANALYSIS_BUDGET, maxWidth: 32, maxHeight: 24 },
      () => true,
    )).toThrow(MotionAnalysisCancelledError)
  })

  test('rejects caller budgets above every reviewed work ceiling', () => {
    for (const [key, value] of Object.entries(DEFAULT_MOTION_ANALYSIS_BUDGET)) {
      expect(() => validateMotionAnalysisBudget({
        ...DEFAULT_MOTION_ANALYSIS_BUDGET,
        [key]: value + 1,
      })).toThrow(/reviewed bounds/)
    }
    expect(() => createStabilizationPlan(
      Array.from(
        { length: DEFAULT_MOTION_ANALYSIS_BUDGET.maxFrames },
        () => estimate(IDENTITY_SIMILARITY_TRANSFORM),
      ),
      192,
      108,
      1,
      4,
    )).toThrow(/reviewed work bounds/)
  })

  test('passes deterministic positive and negative stabilization/tracking fixtures', () => {
    const evidence = runMotionAnalysisResearch()
    expect(evidence.stabilization, JSON.stringify(evidence.stabilization)).toMatchObject({
      sceneCutRejected: true,
      passed: true,
    })
    expect(evidence.tracking, JSON.stringify(evidence.tracking)).toMatchObject({
      occlusionRejected: true,
      passed: true,
      mappedAnimationProperties: [
        'position-x',
        'position-y',
        'scale-x',
        'scale-y',
      ],
    })
    expect(evidence.decision).toEqual({
      stabilization: 'go',
      pointTracking: 'go',
      boxTracking: 'go',
    })
  })
})
