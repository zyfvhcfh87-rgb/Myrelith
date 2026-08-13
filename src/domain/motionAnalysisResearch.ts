/** Deterministic synthetic quality fixtures for Issue #44 research. */

import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  IDENTITY_SIMILARITY_TRANSFORM,
  MOTION_ANALYSIS_ALGORITHM_VERSION,
  applySimilarityTransform,
  composeSimilarityTransforms,
  createStabilizationPlan,
  detectMotionFeatures,
  estimateGlobalMotion,
  estimateGlobalMotionSequence,
  invertSimilarityTransform,
  similarityFromPathSample,
  type GrayFrame,
  type MotionAnalysisCancellationCheck,
  type SimilarityTransform,
  type StabilizationCropResult,
} from './motionAnalysis'
import {
  trackBoxSequence,
  trackPointSequence,
  trackingSamplesToAnimationTracks,
  type BoxTrackingResult,
  type TrackingBox,
} from './motionTrackingResearch'
import type { Transform } from './schema'

export const MOTION_RESEARCH_FIXTURE_VERSION = 'issue-44-synthetic-v2'

export interface MotionResearchProgress {
  readonly stage: 'stabilization' | 'tracking' | 'negative-fixtures'
  readonly progress: number
}

export interface StabilizationResearchTradeoff {
  readonly strength: number
  readonly jitterReductionRatio: number
  readonly crop: StabilizationCropResult
}

export interface StabilizationResearchEvidence {
  readonly frameCount: number
  readonly meanPairTransformErrorPixels: number
  readonly p95PairTransformErrorPixels: number
  readonly meanConfidence: number
  readonly sceneCutRejected: boolean
  readonly tradeoffs: readonly StabilizationResearchTradeoff[]
  readonly cropFailure: string | null
  readonly passed: boolean
}

export interface StabilizationResearchGateInput {
  readonly meanPairTransformErrorPixels: number
  readonly p95PairTransformErrorPixels: number
  readonly meanConfidence: number
  readonly sceneCutRejected: boolean
  readonly tradeoffs: readonly StabilizationResearchTradeoff[]
}

export interface TrackingResearchEvidence {
  readonly frameCount: number
  readonly pointMeanErrorPixels: number
  readonly pointMaximumErrorPixels: number
  readonly boxCenterMeanErrorPixels: number
  readonly boxScaleMeanRelativeError: number
  readonly occlusionRejected: boolean
  readonly occlusionFailureFrame: number | null
  readonly occlusionLastAcceptedFrame: number | null
  readonly mappedAnimationProperties: readonly string[]
  readonly failure: string | null
  readonly pointPassed: boolean
  readonly boxPassed: boolean
  readonly passed: boolean
}

export interface TrackingResearchGateInput {
  readonly pointMeanErrorPixels: number
  readonly pointMaximumErrorPixels: number
  readonly boxCenterMeanErrorPixels: number
  readonly boxScaleMeanRelativeError: number
  readonly occlusionRejected: boolean
}

export interface MotionAnalysisResearchEvidence {
  readonly fixtureVersion: typeof MOTION_RESEARCH_FIXTURE_VERSION
  readonly algorithmVersion: typeof MOTION_ANALYSIS_ALGORITHM_VERSION
  readonly budgets: typeof DEFAULT_MOTION_ANALYSIS_BUDGET
  readonly stabilization: StabilizationResearchEvidence
  readonly tracking: TrackingResearchEvidence
  readonly decision: {
    readonly stabilization: 'go' | 'no-go'
    readonly pointTracking: 'go' | 'no-go'
    readonly boxTracking: 'go' | 'no-go'
  }
}

interface StabilizationFixture {
  readonly frames: readonly GrayFrame[]
  readonly pairTransforms: readonly SimilarityTransform[]
  readonly sceneCutFrame: GrayFrame
}

interface TrackingFixture {
  readonly pointFrames: readonly GrayFrame[]
  readonly frames: readonly GrayFrame[]
  readonly occludedFrames: readonly GrayFrame[]
  readonly boxes: readonly TrackingBox[]
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

const TRACKING_OCCLUSION_FIRST_FRAME = 18

function lcg(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    return value / 0x1_0000_0000
  }
}

function texturedFrame(width: number, height: number, seed: number): GrayFrame {
  const random = lcg(seed)
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

function sampleBilinear(frame: GrayFrame, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= frame.width - 1 || y >= frame.height - 1) return 16
  const left = Math.floor(x)
  const top = Math.floor(y)
  const horizontal = x - left
  const vertical = y - top
  const topLeft = frame.data[top * frame.width + left]!
  const topRight = frame.data[top * frame.width + left + 1]!
  const bottomLeft = frame.data[(top + 1) * frame.width + left]!
  const bottomRight = frame.data[(top + 1) * frame.width + left + 1]!
  return Math.round(
    (topLeft * (1 - horizontal) + topRight * horizontal) * (1 - vertical)
      + (bottomLeft * (1 - horizontal) + bottomRight * horizontal) * vertical,
  )
}

function warpFrame(frame: GrayFrame, transform: SimilarityTransform): GrayFrame {
  const inverse = invertSimilarityTransform(transform)
  const data = new Uint8Array(frame.data.length)
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const source = applySimilarityTransform(inverse, { x, y })
      data[y * frame.width + x] = sampleBilinear(frame, source.x, source.y)
    }
  }
  return { width: frame.width, height: frame.height, data }
}

function centeredPose(
  width: number,
  height: number,
  x: number,
  y: number,
  angleRadians: number,
  scale: number,
): SimilarityTransform {
  const centerX = width / 2
  const centerY = height / 2
  const a = scale * Math.cos(angleRadians)
  const b = scale * Math.sin(angleRadians)
  return {
    a,
    b,
    tx: centerX - a * centerX + b * centerY + x,
    ty: centerY - b * centerX - a * centerY + y,
  }
}

function createStabilizationFixture(): StabilizationFixture {
  const width = 176
  const height = 100
  const base = texturedFrame(width, height, 0x44a11ce)
  const poses: SimilarityTransform[] = []
  for (let index = 0; index < 32; index++) {
    poses.push(centeredPose(
      width,
      height,
      index * 0.32 + Math.sin(index * 2.07) * 1.7,
      index * 0.11 + Math.cos(index * 1.73) * 1.25,
      index * 0.0015 + Math.sin(index * 1.43) * 0.006,
      1 + index * 0.0003 + Math.sin(index * 1.17) * 0.003,
    ))
  }
  const sceneCutFrame = texturedFrame(width, height, 0xbadc0de)
  return {
    frames: poses.map((pose) => warpFrame(base, pose)),
    pairTransforms: poses.slice(1).map((pose, index) => composeSimilarityTransforms(
      pose,
      invertSimilarityTransform(poses[index]!),
    )),
    sceneCutFrame,
  }
}

function renderTrackingObject(
  background: GrayFrame,
  object: GrayFrame,
  box: TrackingBox,
): GrayFrame {
  const data = background.data.slice()
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const right = Math.min(background.width, Math.ceil(box.x + box.width))
  const bottom = Math.min(background.height, Math.ceil(box.y + box.height))
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const objectX = (x - box.x) / box.width * (object.width - 1)
      const objectY = (y - box.y) / box.height * (object.height - 1)
      data[y * background.width + x] = sampleBilinear(object, objectX, objectY)
    }
  }
  return { width: background.width, height: background.height, data }
}

function createTrackingFixture(): TrackingFixture {
  const background = texturedFrame(180, 112, 0x510c0de)
  // Keep the background quieter so object patches remain discriminative.
  for (let index = 0; index < background.data.length; index++) {
    background.data[index] = 60 + Math.round(background.data[index]! * 0.28)
  }
  const object = texturedFrame(44, 32, 0x7acced)
  const boxes: TrackingBox[] = []
  const frames: GrayFrame[] = []
  const pointBoxes: TrackingBox[] = []
  const pointFrames: GrayFrame[] = []
  for (let index = 0; index < 34; index++) {
    const scale = 1 + index * 0.003
    const width = 44 * scale
    const height = 32 * scale
    const centerX = 50 + index * 1.15
    const centerY = 50 + Math.sin(index * 0.31) * 2.4
    const box = {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
    }
    boxes.push(box)
    frames.push(renderTrackingObject(background, object, box))
    const pointBox = {
      x: 28 + index,
      y: 34 + Math.round(Math.sin(index * 0.31) * 2),
      width: 44,
      height: 32,
    }
    pointBoxes.push(pointBox)
    pointFrames.push(renderTrackingObject(background, object, pointBox))
  }
  const occludedFrames = frames.map((frame, index) => (
    index < 18 ? frame : { ...background, data: background.data.slice() }
  ))
  const firstBox = pointBoxes[0]!
  const initialPoint = detectMotionFeatures(pointFrames[0]!, DEFAULT_MOTION_ANALYSIS_BUDGET)
    .find((point) => (
      point.x > firstBox.x + 8
      && point.x < firstBox.x + firstBox.width - 8
      && point.y > firstBox.y + 8
      && point.y < firstBox.y + firstBox.height - 8
    )) ?? {
    x: firstBox.x + firstBox.width / 2,
    y: firstBox.y + firstBox.height / 2,
  }
  const pointFractionX = (initialPoint.x - firstBox.x) / firstBox.width
  const pointFractionY = (initialPoint.y - firstBox.y) / firstBox.height
  return {
    pointFrames,
    frames,
    occludedFrames,
    boxes,
    points: pointBoxes.map((box) => ({
      x: box.x + box.width * pointFractionX,
      y: box.y + box.height * pointFractionY,
    })),
  }
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length
}

export function trackingLossIsPrompt(
  result: BoxTrackingResult,
  firstOccludedFrame: number,
): boolean {
  if (!Number.isSafeInteger(firstOccludedFrame) || firstOccludedFrame < 1) {
    throw new RangeError('firstOccludedFrame must be a positive safe integer')
  }
  return !result.ok
    && result.failure.frameIndex === firstOccludedFrame
    && result.samples.every((sample) => sample.frameIndex < firstOccludedFrame)
}

export function evaluateTrackingResearchGates(
  input: TrackingResearchGateInput,
): { readonly pointPassed: boolean; readonly boxPassed: boolean } {
  return {
    pointPassed: input.pointMeanErrorPixels <= 2
      && input.pointMaximumErrorPixels <= 4,
    boxPassed: input.boxCenterMeanErrorPixels <= 3
      && input.boxScaleMeanRelativeError <= 0.08
      && input.occlusionRejected,
  }
}

export function evaluateStabilizationResearchGate(
  input: StabilizationResearchGateInput,
): boolean {
  const halfStrength = input.tradeoffs.find((tradeoff) => tradeoff.strength === 0.5)
  const fullStrength = input.tradeoffs.find((tradeoff) => tradeoff.strength === 1)
  if (
    halfStrength === undefined
    || fullStrength === undefined
    || !halfStrength.crop.ok
    || !fullStrength.crop.ok
  ) return false
  return input.meanPairTransformErrorPixels <= 1.5
    && input.p95PairTransformErrorPixels <= 2.5
    && input.meanConfidence >= 0.35
    && fullStrength.jitterReductionRatio >= 0.45
    && fullStrength.crop.conservativeSafeZoom <= 1.35
    && input.sceneCutRejected
}

function transformError(
  actual: SimilarityTransform,
  expected: SimilarityTransform,
  width: number,
  height: number,
): number {
  const points = [
    { x: width / 2, y: height / 2 },
    { x: width * 0.2, y: height * 0.2 },
    { x: width * 0.8, y: height * 0.2 },
    { x: width * 0.2, y: height * 0.8 },
    { x: width * 0.8, y: height * 0.8 },
  ]
  return mean(points.map((point) => {
    const actualPoint = applySimilarityTransform(actual, point)
    const expectedPoint = applySimilarityTransform(expected, point)
    return Math.hypot(actualPoint.x - expectedPoint.x, actualPoint.y - expectedPoint.y)
  }))
}

function stabilizationEvidence(
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (progress: MotionResearchProgress) => void,
): StabilizationResearchEvidence {
  const fixture = createStabilizationFixture()
  const estimates = estimateGlobalMotionSequence(
    fixture.frames,
    DEFAULT_MOTION_ANALYSIS_BUDGET,
    cancelled,
    ({ completedPairs, totalPairs }) => onProgress?.({
      stage: 'stabilization',
      progress: completedPairs / totalPairs,
    }),
  )
  const errors = estimates.map((estimate, index) => transformError(
    estimate.transform,
    fixture.pairTransforms[index]!,
    fixture.frames[0]!.width,
    fixture.frames[0]!.height,
  ))
  const tradeoffs = [0.5, 1].map((strength) => {
    const plan = createStabilizationPlan(
      estimates,
      fixture.frames[0]!.width,
      fixture.frames[0]!.height,
      strength,
      4,
    )
    return {
      strength,
      jitterReductionRatio: plan.jitterReductionRatio,
      crop: plan.crop,
    }
  })
  const sceneCutRejected = estimateGlobalMotion(
    fixture.frames.at(-1)!,
    fixture.sceneCutFrame,
    DEFAULT_MOTION_ANALYSIS_BUDGET,
    cancelled,
  ) === null
  onProgress?.({ stage: 'negative-fixtures', progress: 0.5 })
  const meanPairTransformErrorPixels = mean(errors)
  const p95PairTransformErrorPixels = percentile(errors, 0.95)
  const meanConfidence = mean(estimates.map((estimate) => estimate.confidence))
  const failedCrop = tradeoffs.find((tradeoff) => !tradeoff.crop.ok)
  const cropFailure = failedCrop !== undefined && !failedCrop.crop.ok
    ? `crop:${failedCrop.strength}:${failedCrop.crop.failure.code}`
    : null
  return {
    frameCount: fixture.frames.length,
    meanPairTransformErrorPixels,
    p95PairTransformErrorPixels,
    meanConfidence,
    sceneCutRejected,
    tradeoffs,
    cropFailure,
    passed: evaluateStabilizationResearchGate({
      meanPairTransformErrorPixels,
      p95PairTransformErrorPixels,
      meanConfidence,
      sceneCutRejected,
      tradeoffs,
    }),
  }
}

function trackingEvidence(
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (progress: MotionResearchProgress) => void,
): TrackingResearchEvidence {
  const fixture = createTrackingFixture()
  const point = trackPointSequence(
    fixture.pointFrames,
    fixture.points[0]!,
    DEFAULT_MOTION_ANALYSIS_BUDGET,
    cancelled,
    (completed, total) => onProgress?.({
      stage: 'tracking',
      progress: completed / total * 0.45,
    }),
  )
  const box = trackBoxSequence(
    fixture.frames,
    fixture.boxes[0]!,
    DEFAULT_MOTION_ANALYSIS_BUDGET,
    cancelled,
    (completed, total) => onProgress?.({
      stage: 'tracking',
      progress: 0.45 + completed / total * 0.45,
    }),
  )
  const pointErrors = point.ok ? point.samples.map((sample) => {
    const truth = fixture.points[sample.frameIndex]!
    return Math.hypot(
      sample.x - truth.x,
      sample.y - truth.y,
    )
  }) : []
  const boxCenterErrors = box.ok ? box.samples.map((sample) => {
    const truth = fixture.boxes[sample.frameIndex]!
    return Math.hypot(
      sample.x + sample.width / 2 - (truth.x + truth.width / 2),
      sample.y + sample.height / 2 - (truth.y + truth.height / 2),
    )
  }) : []
  const boxScaleErrors = box.ok ? box.samples.map((sample) => {
    const truth = fixture.boxes[sample.frameIndex]!
    return Math.abs(sample.width / truth.width - 1)
  }) : []
  const occluded = trackBoxSequence(
    fixture.occludedFrames,
    fixture.boxes[0]!,
    DEFAULT_MOTION_ANALYSIS_BUDGET,
    cancelled,
  )
  const occlusionRejected = trackingLossIsPrompt(
    occluded,
    TRACKING_OCCLUSION_FIRST_FRAME,
  )
  const occlusionFailureFrame = occluded.ok ? null : occluded.failure.frameIndex
  const occlusionLastAcceptedFrame = occluded.samples.at(-1)?.frameIndex ?? null
  const baseTransform: Transform = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
  }
  const sourceProjection = {
    width: fixture.frames[0]!.width,
    height: fixture.frames[0]!.height,
    transform: baseTransform,
    visual: {
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      flipHorizontal: false,
      flipVertical: false,
    },
  }
  const tracks = box.ok
    ? trackingSamplesToAnimationTracks(
        box.samples.map((sample) => ({
          frame: sample.frameIndex,
          centerX: sample.x + sample.width / 2,
          centerY: sample.y + sample.height / 2,
          width: sample.width,
          height: sample.height,
          source: sourceProjection,
        })),
        baseTransform,
        {
          includeScale: true,
          target: {
            width: fixture.frames[0]!.width,
            height: fixture.frames[0]!.height,
            visual: {
              crop: { left: 0, right: 0, top: 0, bottom: 0 },
              flipHorizontal: false,
              flipVertical: false,
            },
          },
        },
      )
    : []
  onProgress?.({ stage: 'tracking', progress: 1 })
  const pointMeanErrorPixels = point.ok
    ? mean(pointErrors)
    : Number.POSITIVE_INFINITY
  const pointMaximumErrorPixels = point.ok
    ? Math.max(...pointErrors)
    : Number.POSITIVE_INFINITY
  const boxCenterMeanErrorPixels = box.ok
    ? mean(boxCenterErrors)
    : Number.POSITIVE_INFINITY
  const boxScaleMeanRelativeError = box.ok
    ? mean(boxScaleErrors)
    : Number.POSITIVE_INFINITY
  const { pointPassed, boxPassed } = evaluateTrackingResearchGates({
    pointMeanErrorPixels,
    pointMaximumErrorPixels,
    boxCenterMeanErrorPixels,
    boxScaleMeanRelativeError,
    occlusionRejected,
  })
  const failures: string[] = []
  if (!point.ok) {
    failures.push(`point:${point.failure.frameIndex}:${point.failure.code}`)
  } else if (!pointPassed) {
    failures.push('point:quality-threshold')
  }
  if (!box.ok) {
    failures.push(`box:${box.failure.frameIndex}:${box.failure.code}`)
  } else if (boxCenterMeanErrorPixels > 3 || boxScaleMeanRelativeError > 0.08) {
    failures.push('box:quality-threshold')
  }
  if (!occlusionRejected) {
    failures.push(occluded.ok
      ? 'occlusion:not-rejected'
      : `occlusion:${occluded.failure.frameIndex}:unexpected-loss-frame`)
  }
  return {
    frameCount: fixture.frames.length,
    pointMeanErrorPixels,
    pointMaximumErrorPixels,
    boxCenterMeanErrorPixels,
    boxScaleMeanRelativeError,
    occlusionRejected,
    occlusionFailureFrame,
    occlusionLastAcceptedFrame,
    mappedAnimationProperties: tracks.map((track) => track.property),
    failure: failures.length > 0 ? failures.join(';') : null,
    pointPassed,
    boxPassed,
    passed: pointPassed && boxPassed,
  }
}

export function runMotionAnalysisResearch(
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (progress: MotionResearchProgress) => void,
): MotionAnalysisResearchEvidence {
  const stabilization = stabilizationEvidence(cancelled, onProgress)
  const tracking = trackingEvidence(cancelled, onProgress)
  onProgress?.({ stage: 'negative-fixtures', progress: 1 })
  return {
    fixtureVersion: MOTION_RESEARCH_FIXTURE_VERSION,
    algorithmVersion: MOTION_ANALYSIS_ALGORITHM_VERSION,
    budgets: DEFAULT_MOTION_ANALYSIS_BUDGET,
    stabilization,
    tracking,
    decision: {
      stabilization: stabilization.passed ? 'go' : 'no-go',
      pointTracking: tracking.pointPassed ? 'go' : 'no-go',
      boxTracking: tracking.boxPassed ? 'go' : 'no-go',
    },
  }
}

/** Exported solely for deterministic unit checks of transform composition. */
export function researchIdentityTransform(): SimilarityTransform {
  return similarityFromPathSample({ x: 0, y: 0, angleRadians: 0, logScale: 0 })
}

export function researchFixtureIdentityIsExact(): boolean {
  const identity = researchIdentityTransform()
  return JSON.stringify(identity) === JSON.stringify(IDENTITY_SIMILARITY_TRANSFORM)
}
