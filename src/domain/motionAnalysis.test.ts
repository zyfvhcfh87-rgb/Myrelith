import { describe, expect, test } from 'vitest'
import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  IDENTITY_SIMILARITY_TRANSFORM,
  MOTION_ANALYSIS_ALGORITHM_VERSION,
  MotionAnalysisCancelledError,
  applySimilarityTransform,
  composeSimilarityTransforms,
  createStabilizationPlan,
  estimateGlobalMotion,
  estimateGlobalMotionSequence,
  estimateSimilarityFromMatches,
  invertSimilarityTransform,
  motionAnalysisRetainedBytes,
  motionHypothesisPairRanks,
  validateGrayFrame,
  validateMotionAnalysisBudget,
  validateMotionFrameSequence,
  type FeatureMatch,
  type GlobalMotionEstimate,
  type GrayFrame,
  type SimilarityTransform,
} from './motionAnalysis'
import {
  evaluateStabilizationResearchGate,
  evaluateTrackingResearchGates,
  researchFixtureIdentityIsExact,
  runMotionAnalysisResearch,
  trackingLossIsPrompt,
} from './motionAnalysisResearch'
import type { BoxTrackingResult } from './motionTrackingResearch'

function flatFrame(value: number): GrayFrame {
  return {
    width: 32,
    height: 24,
    data: new Uint8Array(32 * 24).fill(value),
  }
}

function texturedFrame(seed: number): GrayFrame {
  let value = seed >>> 0
  const random = () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    return value / 0x1_0000_0000
  }
  const width = 96
  const height = 64
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = ((Math.floor(x / 9) + Math.floor(y / 7)) & 1) * 42
      const wave = 28 * Math.sin(x * 0.31) + 22 * Math.cos(y * 0.27)
      data[y * width + x] = Math.max(0, Math.min(
        255,
        Math.round(75 + checker + wave + random() * 90),
      ))
    }
  }
  return { width, height, data }
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

const SIMILARITY_FIXTURE_CENTER = Object.freeze({ x: 64, y: 64 })
const SIMILARITY_FIXTURE_POINTS = Object.freeze([
  { x: 44, y: 44 },
  { x: 84, y: 84 },
  { x: 44, y: 84 },
  { x: 84, y: 44 },
  { x: 64, y: 44 },
  { x: 64, y: 84 },
  { x: 44, y: 64 },
  { x: 84, y: 64 },
])

function similarityFixtureMatches(
  scale: number,
  rotationRadians: number,
): FeatureMatch[] {
  const a = scale * Math.cos(rotationRadians)
  const b = scale * Math.sin(rotationRadians)
  const transform = {
    a,
    b,
    tx: SIMILARITY_FIXTURE_CENTER.x
      - a * SIMILARITY_FIXTURE_CENTER.x
      + b * SIMILARITY_FIXTURE_CENTER.y,
    ty: SIMILARITY_FIXTURE_CENTER.y
      - b * SIMILARITY_FIXTURE_CENTER.x
      - a * SIMILARITY_FIXTURE_CENTER.y,
  }
  return SIMILARITY_FIXTURE_POINTS.map((from) => ({
    from,
    to: applySimilarityTransform(transform, from),
    meanAbsoluteError: 0,
  }))
}

function competingMotionMatches(): FeatureMatch[] {
  return Array.from({ length: 64 }, (_, index) => {
    const from = {
      x: 12 + (index % 8) * 12,
      y: 12 + Math.floor(index / 8) * 12,
    }
    return {
      from,
      to: {
        x: from.x + (index < 29 ? 6 : 0),
        y: from.y,
      },
      meanAbsoluteError: 0,
    }
  })
}

function translatedPlanForCropRatio(requiredCropRatio: number) {
  const width = 256
  const height = 128
  return createStabilizationPlan(
    [estimate({
      a: 1,
      b: 0,
      tx: requiredCropRatio * height * 2,
      ty: 0,
    })],
    width,
    height,
    1,
    1,
  )
}

function boxLoss(frameIndex: number, lastAcceptedFrame: number): BoxTrackingResult {
  return {
    ok: false,
    samples: [{
      frameIndex: lastAcceptedFrame,
      x: 10,
      y: 12,
      width: 20,
      height: 16,
      confidence: 0.9,
    }],
    failure: {
      frameIndex,
      code: 'lost-box',
      detail: 'synthetic loss',
    },
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
    expect(full.crop.ok).toBe(true)
    if (!full.crop.ok) throw new Error(full.crop.failure.detail)
    expect(full.crop.conservativeCropRatio).toBe(
      full.maximumCornerDisplacementPixels / 108,
    )
    expect(full.crop.conservativeSafeZoom).toBe(
      1 / (1 - 2 * full.crop.conservativeCropRatio),
    )
    expect(translatedPlanForCropRatio(0.125).crop).toEqual({
      ok: true,
      conservativeCropRatio: 0.125,
      conservativeSafeZoom: 4 / 3,
    })
  })

  test.each([
    ['the representable value immediately below half', 0.5 - Number.EPSILON / 4, true],
    ['exactly half', 0.5, false],
    ['the representable value immediately above half', 0.5 + Number.EPSILON / 2, false],
  ] as const)('reports centered crop feasibility at %s', (_label, requiredRatio, ok) => {
    const plan = translatedPlanForCropRatio(requiredRatio)

    expect(plan.maximumCornerDisplacementPixels / 128).toBe(requiredRatio)
    expect(plan.crop.ok).toBe(ok)
    if (plan.crop.ok) {
      expect(plan.crop.conservativeCropRatio).toBe(requiredRatio)
      expect(plan.crop.conservativeSafeZoom).toBe(1 / (1 - 2 * requiredRatio))
      return
    }
    expect(plan.crop.failure).toEqual({
      code: 'finite-centered-zoom-unavailable',
      requiredCropRatio: requiredRatio,
      detail: 'The required centered inset must remain below half the shorter frame dimension.',
    })
    expect(JSON.stringify(plan.crop)).not.toMatch(/Infinity|NaN/)
  })

  test('fails crop planning for sustained pan at the maximum smoothing radius', () => {
    const estimates = Array.from(
      { length: 240 },
      () => estimate({ a: 1, b: 0, tx: 1, ty: 0 }),
    )
    const plan = createStabilizationPlan(estimates, 200, 100, 1, 120)

    expect(plan.cameraPath).toHaveLength(241)
    expect(plan.corrections).toHaveLength(241)
    expect(plan.maximumCornerDisplacementPixels).toBe(60)
    expect(plan.crop).toMatchObject({
      ok: false,
      failure: {
        code: 'finite-centered-zoom-unavailable',
        requiredCropRatio: 0.6,
      },
    })
  })

  test('rejects non-finite accumulated stabilization geometry', () => {
    expect(() => createStabilizationPlan(
      [
        estimate({ a: Number.MAX_VALUE, b: 0, tx: 0, ty: 0 }),
        estimate({ a: Number.MAX_VALUE, b: 0, tx: 0, ty: 0 }),
      ],
      200,
      100,
      1,
      1,
    )).toThrow(/camera path contains a non-finite transform/)
  })

  test('rejects non-finite derived path metrics instead of leaking JSON-unsafe values', () => {
    expect(() => createStabilizationPlan(
      [
        estimate({ a: 1, b: 0, tx: 1e200, ty: 0 }),
        estimate({ a: 1, b: 0, tx: -1e200, ty: 0 }),
        estimate({ a: 1, b: 0, tx: 1e200, ty: 0 }),
      ],
      200,
      100,
      0,
      1,
    )).toThrow(/path metrics are not finite/)
  })

  test('refuses the stabilization go gate when any required crop is unavailable', () => {
    expect(evaluateStabilizationResearchGate({
      meanPairTransformErrorPixels: 0,
      p95PairTransformErrorPixels: 0,
      meanConfidence: 1,
      sceneCutRejected: true,
      tradeoffs: [
        {
          strength: 0.5,
          jitterReductionRatio: 0.5,
          crop: translatedPlanForCropRatio(0.1).crop,
        },
        {
          strength: 1,
          jitterReductionRatio: 1,
          crop: translatedPlanForCropRatio(0.5).crop,
        },
      ],
    })).toBe(false)
  })

  test('honors cancellation before expensive frame matching', () => {
    expect(() => estimateGlobalMotionSequence(
      [flatFrame(10), flatFrame(20)],
      { ...DEFAULT_MOTION_ANALYSIS_BUDGET, maxWidth: 32, maxHeight: 24 },
      () => true,
    )).toThrow(MotionAnalysisCancelledError)
  })

  test('rejects a hard cut between two independently textured frames', () => {
    expect(estimateGlobalMotion(
      texturedFrame(0x44a11ce),
      texturedFrame(0xbadc0de),
    )).toBeNull()
  })

  test('finds the majority motion beyond a leading coherent foreground', () => {
    const ordered = competingMotionMatches()
    const permuted = ordered.map((_, index) => ordered[(index * 17) % ordered.length]!)

    for (const matches of [ordered, permuted]) {
      const result = estimateSimilarityFromMatches(matches)

      expect(result).not.toBeNull()
      expect(result!.inlierCount).toBe(35)
      expect(result!.transform).toMatchObject({ a: 1, b: 0, tx: 0, ty: 0 })
    }
  })

  test('spans the complete pair-rank space with an exact bounded schedule', () => {
    const ranks = motionHypothesisPairRanks(64, 256)

    expect(MOTION_ANALYSIS_ALGORITHM_VERSION).toBe('similarity-block-ransac-v3')
    expect(ranks).toHaveLength(256)
    expect(new Set(ranks).size).toBe(ranks.length)
    expect(ranks[0]).toBe(0)
    expect(ranks.at(-1)).toBe(2_015)
    expect(motionHypothesisPairRanks(64, 1)).toEqual([1_007])
    expect(motionHypothesisPairRanks(8, 256)).toEqual(
      Array.from({ length: 28 }, (_, rank) => rank),
    )
  })

  test('rejects a refined similarity transform outside the reviewed motion envelope', () => {
    const matches: FeatureMatch[] = [
      [{ x: 60, y: 64 }, { x: 60, y: 64 }],
      [{ x: 68, y: 64 }, { x: 68, y: 64 }],
      [{ x: 64, y: 61 }, { x: 64, y: 62 }],
      [{ x: 64, y: 67 }, { x: 64, y: 66 }],
      [{ x: 61, y: 61 }, { x: 62, y: 62 }],
      [{ x: 67, y: 61 }, { x: 66, y: 62 }],
      [{ x: 61, y: 67 }, { x: 62, y: 66 }],
      [{ x: 67, y: 67 }, { x: 66, y: 66 }],
    ].map(([from, to]) => ({ from, to, meanAbsoluteError: 0 }))

    expect(matches.every(({ from, to }) => (
      Math.hypot(from.x - to.x, from.y - to.y)
        <= DEFAULT_MOTION_ANALYSIS_BUDGET.inlierThreshold
    ))).toBe(true)
    expect(92 / 122).toBeCloseTo(0.754098, 6)
    expect(estimateSimilarityFromMatches(matches)).toBeNull()
  })

  test.each([
    ['inside the reviewed envelope', 1, 0],
    ['at the minimum scale boundary', 0.85, 0],
    ['at the maximum scale boundary', 1.15, 0],
    ['at the maximum positive rotation boundary', 1, Math.PI / 12],
    ['at the maximum negative rotation boundary', 1, -Math.PI / 12],
  ] as const)('accepts similarity motion %s', (_label, scale, angle) => {
    const result = estimateSimilarityFromMatches(
      similarityFixtureMatches(scale, angle),
    )

    expect(result).not.toBeNull()
    expect(Math.hypot(result!.transform.a, result!.transform.b)).toBeCloseTo(
      scale,
      12,
    )
    expect(Math.atan2(result!.transform.b, result!.transform.a)).toBeCloseTo(
      angle,
      12,
    )
  })

  test.each([
    ['below minimum scale', 0.85 - 1e-12, 0],
    ['above maximum scale', 1.15 + 1e-12, 0],
    ['above maximum positive rotation', 1, Math.PI / 12 + 1e-12],
    ['below maximum negative rotation', 1, -Math.PI / 12 - 1e-12],
  ] as const)('rejects similarity motion %s', (_label, scale, angle) => {
    expect(estimateSimilarityFromMatches(
      similarityFixtureMatches(scale, angle),
    )).toBeNull()
  })

  test('rejects non-finite similarity geometry', () => {
    const matches = similarityFixtureMatches(1, 0).map((match) => ({
      ...match,
      to: { ...match.to, x: Number.POSITIVE_INFINITY },
    }))

    expect(estimateSimilarityFromMatches(matches)).toBeNull()
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

  test.each([
    ['zero-offset', 0],
    ['nonzero-offset', 64],
  ] as const)(
    'rejects a %s grayscale view into an oversized backing allocation',
    (_label, byteOffset) => {
      const pixels = 32 * 24
      const backing = new ArrayBuffer(
        DEFAULT_MOTION_ANALYSIS_BUDGET.maxRetainedBytes + pixels + byteOffset,
      )
      const frame: GrayFrame = {
        width: 32,
        height: 24,
        data: new Uint8Array(backing, byteOffset, pixels),
      }
      const message = /must cover its entire backing buffer/

      expect(() => validateGrayFrame(frame)).toThrow(message)
      expect(() => motionAnalysisRetainedBytes([frame])).toThrow(message)
      expect(() => validateMotionFrameSequence([frame, flatFrame(0)])).toThrow(message)
    },
  )

  test('accepts tightly sized grayscale backing buffers and counts them exactly', () => {
    const frames = [flatFrame(10), flatFrame(20)]

    expect(frames.every((frame) => (
      frame.data.byteOffset === 0
      && frame.data.byteLength === frame.data.buffer.byteLength
    ))).toBe(true)
    expect(() => frames.forEach((frame) => validateGrayFrame(frame))).not.toThrow()
    expect(motionAnalysisRetainedBytes(frames)).toBe(2 * 32 * 24)
    expect(() => validateMotionFrameSequence(frames, {
      ...DEFAULT_MOTION_ANALYSIS_BUDGET,
      maxWidth: 32,
      maxHeight: 24,
    })).not.toThrow()
  })

  test('accepts occlusion loss only on the first fully occluded frame', () => {
    expect(trackingLossIsPrompt(boxLoss(18, 17), 18)).toBe(true)
    expect(trackingLossIsPrompt(boxLoss(19, 18), 18)).toBe(false)
    expect(trackingLossIsPrompt(boxLoss(17, 16), 18)).toBe(false)
  })

  test('evaluates point and box research gates independently', () => {
    expect(evaluateTrackingResearchGates({
      pointMeanErrorPixels: 1,
      pointMaximumErrorPixels: 3,
      boxCenterMeanErrorPixels: 2,
      boxScaleMeanRelativeError: 0.09,
      occlusionRejected: true,
    })).toEqual({ pointPassed: true, boxPassed: false })
    expect(evaluateTrackingResearchGates({
      pointMeanErrorPixels: 1,
      pointMaximumErrorPixels: 5,
      boxCenterMeanErrorPixels: 2,
      boxScaleMeanRelativeError: 0.05,
      occlusionRejected: true,
    })).toEqual({ pointPassed: false, boxPassed: true })
  })

  test('passes deterministic positive and negative stabilization/tracking fixtures', () => {
    const evidence = runMotionAnalysisResearch()
    expect(evidence.stabilization, JSON.stringify(evidence.stabilization)).toMatchObject({
      sceneCutRejected: true,
      cropFailure: null,
      passed: true,
    })
    expect(evidence.stabilization.tradeoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strength: 0.5,
        crop: expect.objectContaining({ ok: true }),
      }),
      expect.objectContaining({
        strength: 1,
        crop: expect.objectContaining({ ok: true }),
      }),
    ]))
    expect(JSON.parse(JSON.stringify(evidence.stabilization))).toEqual(
      evidence.stabilization,
    )
    expect(evidence.tracking, JSON.stringify(evidence.tracking)).toMatchObject({
      occlusionRejected: true,
      occlusionFailureFrame: 18,
      occlusionLastAcceptedFrame: 17,
      pointPassed: true,
      boxPassed: true,
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
