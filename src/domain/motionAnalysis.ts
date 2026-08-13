/**
 * Browser-free motion-analysis research primitives.
 *
 * This is deliberately a bounded feasibility surface, not product authoring.
 * Runtime owners decode/downsample frames, schedule work, and persist results;
 * this module only sees small owned grayscale buffers and pure numeric facts.
 */

export interface GrayFrame {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export interface MotionPoint {
  readonly x: number
  readonly y: number
}

export interface FeatureMatch {
  readonly from: MotionPoint
  readonly to: MotionPoint
  readonly meanAbsoluteError: number
}

/** q = [a -b; b a] p + [tx, ty]. */
export interface SimilarityTransform {
  readonly a: number
  readonly b: number
  readonly tx: number
  readonly ty: number
}

export interface GlobalMotionEstimate {
  readonly transform: SimilarityTransform
  readonly matchCount: number
  readonly inlierCount: number
  readonly inlierRatio: number
  readonly meanInlierError: number
  readonly confidence: number
}

export interface MotionAnalysisBudget {
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxFrames: number
  readonly maxFeatures: number
  readonly patchRadius: number
  readonly searchRadius: number
  readonly maxRansacHypotheses: number
  readonly inlierThreshold: number
  readonly maxRetainedBytes: number
}

export const MOTION_ANALYSIS_ALGORITHM_VERSION = 'similarity-block-ransac-v2'

export const DEFAULT_MOTION_ANALYSIS_BUDGET = Object.freeze({
  maxWidth: 320,
  maxHeight: 180,
  maxFrames: 300,
  maxFeatures: 64,
  patchRadius: 2,
  searchRadius: 6,
  maxRansacHypotheses: 256,
  inlierThreshold: 1.75,
  maxRetainedBytes: 32 * 1024 * 1024,
}) satisfies MotionAnalysisBudget

export const IDENTITY_SIMILARITY_TRANSFORM = Object.freeze({
  a: 1,
  b: 0,
  tx: 0,
  ty: 0,
}) satisfies SimilarityTransform

const MIN_GLOBAL_MATCHES = 8
const MIN_GLOBAL_INLIERS = 6
const MIN_FEATURE_SPACING = 7
const MIN_FEATURE_RESPONSE = 256
const MAX_PATCH_ERROR = 48
const MAX_BACKTRACK_ERROR = 1.5
const MIN_DISTINCT_PATCH_ERROR = 0.5
const MIN_FEATURE_MATCH_RATIO = 0.5

export class MotionAnalysisCancelledError extends Error {
  constructor() {
    super('Motion analysis was cancelled')
    this.name = 'MotionAnalysisCancelledError'
  }
}

export type MotionAnalysisCancellationCheck = () => boolean

function checkCancellation(cancelled?: MotionAnalysisCancellationCheck): void {
  if (cancelled?.()) throw new MotionAnalysisCancelledError()
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`)
  }
}

export function validateMotionAnalysisBudget(budget: MotionAnalysisBudget): void {
  positiveSafeInteger(budget.maxWidth, 'maxWidth')
  positiveSafeInteger(budget.maxHeight, 'maxHeight')
  positiveSafeInteger(budget.maxFrames, 'maxFrames')
  positiveSafeInteger(budget.maxFeatures, 'maxFeatures')
  positiveSafeInteger(budget.patchRadius, 'patchRadius')
  positiveSafeInteger(budget.searchRadius, 'searchRadius')
  positiveSafeInteger(budget.maxRansacHypotheses, 'maxRansacHypotheses')
  finitePositive(budget.inlierThreshold, 'inlierThreshold')
  positiveSafeInteger(budget.maxRetainedBytes, 'maxRetainedBytes')
  if (
    budget.maxWidth > DEFAULT_MOTION_ANALYSIS_BUDGET.maxWidth
    || budget.maxHeight > DEFAULT_MOTION_ANALYSIS_BUDGET.maxHeight
    || budget.maxFrames > DEFAULT_MOTION_ANALYSIS_BUDGET.maxFrames
    || budget.maxFeatures > DEFAULT_MOTION_ANALYSIS_BUDGET.maxFeatures
    || budget.patchRadius > DEFAULT_MOTION_ANALYSIS_BUDGET.patchRadius
    || budget.searchRadius > DEFAULT_MOTION_ANALYSIS_BUDGET.searchRadius
    || budget.maxRansacHypotheses
      > DEFAULT_MOTION_ANALYSIS_BUDGET.maxRansacHypotheses
    || budget.inlierThreshold > DEFAULT_MOTION_ANALYSIS_BUDGET.inlierThreshold
    || budget.maxRetainedBytes > DEFAULT_MOTION_ANALYSIS_BUDGET.maxRetainedBytes
  ) {
    throw new RangeError('Motion-analysis budget exceeds the reviewed bounds')
  }
}

export function validateGrayFrame(
  frame: GrayFrame,
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
): void {
  validateMotionAnalysisBudget(budget)
  positiveSafeInteger(frame.width, 'frame width')
  positiveSafeInteger(frame.height, 'frame height')
  if (frame.width > budget.maxWidth || frame.height > budget.maxHeight) {
    throw new RangeError('Motion-analysis frame exceeds the reviewed dimensions')
  }
  const pixels = frame.width * frame.height
  if (!Number.isSafeInteger(pixels) || frame.data.length !== pixels) {
    throw new RangeError('Motion-analysis frame data does not match its dimensions')
  }
  grayFrameBackingBytes(frame)
}

function grayFrameBackingBytes(frame: GrayFrame): number {
  if (
    frame.data.byteOffset !== 0
    || frame.data.byteLength !== frame.data.buffer.byteLength
  ) {
    throw new RangeError(
      'Motion-analysis frame data must cover its entire backing buffer',
    )
  }
  return frame.data.buffer.byteLength
}

export function motionAnalysisRetainedBytes(frames: readonly GrayFrame[]): number {
  let total = 0
  for (const frame of frames) {
    total += grayFrameBackingBytes(frame)
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Motion-analysis retained bytes exceed the safe integer range')
    }
  }
  return total
}

export function validateMotionFrameSequence(
  frames: readonly GrayFrame[],
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
): void {
  validateMotionAnalysisBudget(budget)
  if (frames.length < 2 || frames.length > budget.maxFrames) {
    throw new RangeError(`Motion analysis requires 2 to ${budget.maxFrames} frames`)
  }
  const first = frames[0]
  if (!first) throw new RangeError('Motion analysis requires frames')
  for (const frame of frames) {
    validateGrayFrame(frame, budget)
    if (frame.width !== first.width || frame.height !== first.height) {
      throw new RangeError('Motion-analysis frames must share exact dimensions')
    }
  }
  if (motionAnalysisRetainedBytes(frames) > budget.maxRetainedBytes) {
    throw new RangeError('Motion-analysis frames exceed the retained-byte budget')
  }
}

interface FeatureCandidate extends MotionPoint {
  readonly response: number
}

function pixel(frame: GrayFrame, x: number, y: number): number {
  return frame.data[y * frame.width + x] ?? 0
}

/** A small Shi-Tomasi-style minimum-eigenvalue detector. */
export function detectMotionFeatures(
  frame: GrayFrame,
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
): MotionPoint[] {
  validateGrayFrame(frame, budget)
  const margin = budget.patchRadius + budget.searchRadius + 2
  if (frame.width <= margin * 2 || frame.height <= margin * 2) return []
  const candidates: FeatureCandidate[] = []
  for (let y = margin; y < frame.height - margin; y += 2) {
    checkCancellation(cancelled)
    for (let x = margin; x < frame.width - margin; x += 2) {
      let xx = 0
      let xy = 0
      let yy = 0
      for (let wy = -1; wy <= 1; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          const gx = pixel(frame, x + wx + 1, y + wy)
            - pixel(frame, x + wx - 1, y + wy)
          const gy = pixel(frame, x + wx, y + wy + 1)
            - pixel(frame, x + wx, y + wy - 1)
          xx += gx * gx
          xy += gx * gy
          yy += gy * gy
        }
      }
      const trace = xx + yy
      const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2))
      const response = (trace - discriminant) / 2
      if (response >= MIN_FEATURE_RESPONSE) candidates.push({ x, y, response })
    }
  }
  candidates.sort((left, right) => (
    right.response - left.response || left.y - right.y || left.x - right.x
  ))
  const selected: MotionPoint[] = []
  const minimumDistanceSquared = MIN_FEATURE_SPACING ** 2
  for (const candidate of candidates) {
    if (selected.every((point) => (
      (point.x - candidate.x) ** 2 + (point.y - candidate.y) ** 2
        >= minimumDistanceSquared
    ))) {
      selected.push({ x: candidate.x, y: candidate.y })
      if (selected.length >= budget.maxFeatures) break
    }
  }
  return selected
}

interface PatchMatch {
  readonly point: MotionPoint
  readonly meanAbsoluteError: number
  readonly separation: number
}

function patchError(
  from: GrayFrame,
  to: GrayFrame,
  source: MotionPoint,
  target: MotionPoint,
  radius: number,
): number {
  let error = 0
  let count = 0
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      error += Math.abs(
        pixel(from, source.x + x, source.y + y)
          - pixel(to, target.x + x, target.y + y),
      )
      count++
    }
  }
  return error / count
}

function bestPatchMatch(
  from: GrayFrame,
  to: GrayFrame,
  source: MotionPoint,
  budget: MotionAnalysisBudget,
): PatchMatch | null {
  let bestError = Number.POSITIVE_INFINITY
  let secondError = Number.POSITIVE_INFINITY
  let bestX = source.x
  let bestY = source.y
  for (let dy = -budget.searchRadius; dy <= budget.searchRadius; dy++) {
    for (let dx = -budget.searchRadius; dx <= budget.searchRadius; dx++) {
      const target = { x: source.x + dx, y: source.y + dy }
      const error = patchError(from, to, source, target, budget.patchRadius)
      if (error < bestError) {
        secondError = bestError
        bestError = error
        bestX = target.x
        bestY = target.y
      } else if (error < secondError) {
        secondError = error
      }
    }
  }
  if (
    bestError > MAX_PATCH_ERROR
    || !Number.isFinite(secondError)
    || secondError - bestError < MIN_DISTINCT_PATCH_ERROR
  ) return null
  return {
    point: { x: bestX, y: bestY },
    meanAbsoluteError: bestError,
    separation: secondError - bestError,
  }
}

export function matchMotionFeatures(
  from: GrayFrame,
  to: GrayFrame,
  features: readonly MotionPoint[],
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
): FeatureMatch[] {
  validateGrayFrame(from, budget)
  validateGrayFrame(to, budget)
  if (from.width !== to.width || from.height !== to.height) {
    throw new RangeError('Feature matching requires equal frame dimensions')
  }
  if (features.length > budget.maxFeatures) {
    throw new RangeError('Feature list exceeds the reviewed feature budget')
  }
  const matches: FeatureMatch[] = []
  for (const feature of features) {
    checkCancellation(cancelled)
    const forward = bestPatchMatch(from, to, feature, budget)
    if (!forward) continue
    const backward = bestPatchMatch(to, from, forward.point, budget)
    if (!backward) continue
    const backtrackError = Math.hypot(
      backward.point.x - feature.x,
      backward.point.y - feature.y,
    )
    if (backtrackError > MAX_BACKTRACK_ERROR) continue
    matches.push({
      from: { ...feature },
      to: { ...forward.point },
      meanAbsoluteError: forward.meanAbsoluteError,
    })
  }
  return matches
}

function transformFromPair(
  first: FeatureMatch,
  second: FeatureMatch,
): SimilarityTransform | null {
  const px = second.from.x - first.from.x
  const py = second.from.y - first.from.y
  const qx = second.to.x - first.to.x
  const qy = second.to.y - first.to.y
  const denominator = px * px + py * py
  if (denominator < 64) return null
  const a = (px * qx + py * qy) / denominator
  const b = (px * qy - py * qx) / denominator
  const scale = Math.hypot(a, b)
  const angle = Math.abs(Math.atan2(b, a))
  if (scale < 0.85 || scale > 1.15 || angle > Math.PI / 12) return null
  return {
    a,
    b,
    tx: first.to.x - a * first.from.x + b * first.from.y,
    ty: first.to.y - b * first.from.x - a * first.from.y,
  }
}

export function applySimilarityTransform(
  transform: SimilarityTransform,
  point: MotionPoint,
): MotionPoint {
  return {
    x: transform.a * point.x - transform.b * point.y + transform.tx,
    y: transform.b * point.x + transform.a * point.y + transform.ty,
  }
}

function reprojectionError(
  transform: SimilarityTransform,
  match: FeatureMatch,
): number {
  const projected = applySimilarityTransform(transform, match.from)
  return Math.hypot(projected.x - match.to.x, projected.y - match.to.y)
}

function refineSimilarity(
  matches: readonly FeatureMatch[],
): SimilarityTransform | null {
  if (matches.length < 2) return null
  let sourceX = 0
  let sourceY = 0
  let targetX = 0
  let targetY = 0
  for (const match of matches) {
    sourceX += match.from.x
    sourceY += match.from.y
    targetX += match.to.x
    targetY += match.to.y
  }
  sourceX /= matches.length
  sourceY /= matches.length
  targetX /= matches.length
  targetY /= matches.length
  let numeratorA = 0
  let numeratorB = 0
  let denominator = 0
  for (const match of matches) {
    const px = match.from.x - sourceX
    const py = match.from.y - sourceY
    const qx = match.to.x - targetX
    const qy = match.to.y - targetY
    numeratorA += px * qx + py * qy
    numeratorB += px * qy - py * qx
    denominator += px * px + py * py
  }
  if (denominator < 1e-9) return null
  const a = numeratorA / denominator
  const b = numeratorB / denominator
  return {
    a,
    b,
    tx: targetX - a * sourceX + b * sourceY,
    ty: targetY - b * sourceX - a * sourceY,
  }
}

export function estimateSimilarityFromMatches(
  matches: readonly FeatureMatch[],
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
): GlobalMotionEstimate | null {
  validateMotionAnalysisBudget(budget)
  if (matches.length < MIN_GLOBAL_MATCHES || matches.length > budget.maxFeatures) {
    return null
  }
  let bestTransform: SimilarityTransform | null = null
  let bestInliers: FeatureMatch[] = []
  let bestError = Number.POSITIVE_INFINITY
  let hypotheses = 0
  for (let left = 0; left < matches.length; left++) {
    for (let right = left + 1; right < matches.length; right++) {
      checkCancellation(cancelled)
      if (hypotheses++ >= budget.maxRansacHypotheses) break
      const candidate = transformFromPair(matches[left]!, matches[right]!)
      if (!candidate) continue
      const inliers = matches.filter(
        (match) => reprojectionError(candidate, match) <= budget.inlierThreshold,
      )
      const error = inliers.reduce(
        (total, match) => total + reprojectionError(candidate, match),
        0,
      )
      if (
        inliers.length > bestInliers.length
        || (inliers.length === bestInliers.length && error < bestError)
      ) {
        bestTransform = candidate
        bestInliers = inliers
        bestError = error
      }
    }
    if (hypotheses >= budget.maxRansacHypotheses) break
  }
  if (!bestTransform || bestInliers.length < MIN_GLOBAL_INLIERS) return null
  const refined = refineSimilarity(bestInliers)
  if (!refined) return null
  const finalInliers = matches.filter(
    (match) => reprojectionError(refined, match) <= budget.inlierThreshold,
  )
  if (finalInliers.length < MIN_GLOBAL_INLIERS) return null
  const meanInlierError = finalInliers.reduce(
    (total, match) => total + reprojectionError(refined, match),
    0,
  ) / finalInliers.length
  const inlierRatio = finalInliers.length / matches.length
  if (inlierRatio < 0.45) return null
  return {
    transform: refined,
    matchCount: matches.length,
    inlierCount: finalInliers.length,
    inlierRatio,
    meanInlierError,
    confidence: Math.max(
      0,
      Math.min(1, inlierRatio * (1 - meanInlierError / budget.inlierThreshold)),
    ),
  }
}

export function estimateGlobalMotion(
  from: GrayFrame,
  to: GrayFrame,
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
): GlobalMotionEstimate | null {
  const features = detectMotionFeatures(from, budget, cancelled)
  const matches = matchMotionFeatures(from, to, features, budget, cancelled)
  if (
    features.length < MIN_GLOBAL_MATCHES
    || matches.length / features.length < MIN_FEATURE_MATCH_RATIO
  ) return null
  return estimateSimilarityFromMatches(matches, budget, cancelled)
}

export interface MotionSequenceProgress {
  readonly completedPairs: number
  readonly totalPairs: number
}

export function estimateGlobalMotionSequence(
  frames: readonly GrayFrame[],
  budget: MotionAnalysisBudget = DEFAULT_MOTION_ANALYSIS_BUDGET,
  cancelled?: MotionAnalysisCancellationCheck,
  onProgress?: (progress: MotionSequenceProgress) => void,
): GlobalMotionEstimate[] {
  validateMotionFrameSequence(frames, budget)
  const estimates: GlobalMotionEstimate[] = []
  const totalPairs = frames.length - 1
  for (let index = 1; index < frames.length; index++) {
    checkCancellation(cancelled)
    const estimate = estimateGlobalMotion(
      frames[index - 1]!,
      frames[index]!,
      budget,
      cancelled,
    )
    if (!estimate) {
      throw new Error(`Global motion confidence failed at frame pair ${index - 1}/${index}`)
    }
    estimates.push(estimate)
    onProgress?.({ completedPairs: index, totalPairs })
  }
  return estimates
}

export function composeSimilarityTransforms(
  after: SimilarityTransform,
  before: SimilarityTransform,
): SimilarityTransform {
  return {
    a: after.a * before.a - after.b * before.b,
    b: after.b * before.a + after.a * before.b,
    tx: after.a * before.tx - after.b * before.ty + after.tx,
    ty: after.b * before.tx + after.a * before.ty + after.ty,
  }
}

export function invertSimilarityTransform(
  transform: SimilarityTransform,
): SimilarityTransform {
  const denominator = transform.a ** 2 + transform.b ** 2
  if (!Number.isFinite(denominator) || denominator < 1e-12) {
    throw new RangeError('Similarity transform is not invertible')
  }
  const a = transform.a / denominator
  const b = -transform.b / denominator
  return {
    a,
    b,
    tx: -a * transform.tx + b * transform.ty,
    ty: -b * transform.tx - a * transform.ty,
  }
}

export interface SimilarityPathSample {
  readonly x: number
  readonly y: number
  readonly angleRadians: number
  readonly logScale: number
}

export function similarityPathSample(
  transform: SimilarityTransform,
): SimilarityPathSample {
  const scale = Math.hypot(transform.a, transform.b)
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('Similarity transform has an invalid scale')
  }
  return {
    x: transform.tx,
    y: transform.ty,
    angleRadians: Math.atan2(transform.b, transform.a),
    logScale: Math.log(scale),
  }
}

export function similarityFromPathSample(
  sample: SimilarityPathSample,
): SimilarityTransform {
  const scale = Math.exp(sample.logScale)
  return {
    a: scale * Math.cos(sample.angleRadians),
    b: scale * Math.sin(sample.angleRadians),
    tx: sample.x,
    ty: sample.y,
  }
}

function movingAverage(
  values: readonly number[],
  radius: number,
): number[] {
  return values.map((_, index) => {
    let total = 0
    let count = 0
    for (
      let sample = Math.max(0, index - radius);
      sample <= Math.min(values.length - 1, index + radius);
      sample++
    ) {
      total += values[sample]!
      count++
    }
    return total / count
  })
}

function unwrapAngles(values: readonly number[]): number[] {
  if (values.length === 0) return []
  const output = [values[0]!]
  for (let index = 1; index < values.length; index++) {
    let angle = values[index]!
    const previous = output[index - 1]!
    while (angle - previous > Math.PI) angle -= Math.PI * 2
    while (angle - previous < -Math.PI) angle += Math.PI * 2
    output.push(angle)
  }
  return output
}

export function rootMeanSquareSecondDifference(
  values: readonly number[],
): number {
  if (values.length < 3) return 0
  let total = 0
  for (let index = 2; index < values.length; index++) {
    const difference = values[index]! - 2 * values[index - 1]! + values[index - 2]!
    total += difference ** 2
  }
  return Math.sqrt(total / (values.length - 2))
}

export type StabilizationCropResult =
  | {
      readonly ok: true
      readonly conservativeCropRatio: number
      readonly conservativeSafeZoom: number
    }
  | {
      readonly ok: false
      readonly failure: {
        readonly code: 'finite-centered-zoom-unavailable'
        readonly requiredCropRatio: number
        readonly detail: string
      }
    }

export interface StabilizationPlan {
  readonly strength: number
  readonly smoothingRadius: number
  readonly cameraPath: readonly SimilarityTransform[]
  readonly stabilizedPath: readonly SimilarityTransform[]
  readonly corrections: readonly SimilarityTransform[]
  readonly jitterBefore: number
  readonly jitterAfter: number
  readonly jitterReductionRatio: number
  readonly maximumCornerDisplacementPixels: number
  readonly crop: StabilizationCropResult
}

function pathJitter(samples: readonly SimilarityPathSample[]): number {
  const components = [
    samples.map((sample) => sample.x),
    samples.map((sample) => sample.y),
    samples.map((sample) => sample.angleRadians * 100),
    samples.map((sample) => sample.logScale * 100),
  ]
  return Math.hypot(...components.map(rootMeanSquareSecondDifference))
}

function interpolatePathSample(
  original: SimilarityPathSample,
  smoothed: SimilarityPathSample,
  strength: number,
): SimilarityPathSample {
  return {
    x: original.x + (smoothed.x - original.x) * strength,
    y: original.y + (smoothed.y - original.y) * strength,
    angleRadians: original.angleRadians
      + (smoothed.angleRadians - original.angleRadians) * strength,
    logScale: original.logScale + (smoothed.logScale - original.logScale) * strength,
  }
}

export function createStabilizationPlan(
  estimates: readonly GlobalMotionEstimate[],
  width: number,
  height: number,
  strength: number,
  smoothingRadius: number,
): StabilizationPlan {
  positiveSafeInteger(width, 'stabilization width')
  positiveSafeInteger(height, 'stabilization height')
  if (
    width > DEFAULT_MOTION_ANALYSIS_BUDGET.maxWidth
    || height > DEFAULT_MOTION_ANALYSIS_BUDGET.maxHeight
    || estimates.length < 1
    || estimates.length >= DEFAULT_MOTION_ANALYSIS_BUDGET.maxFrames
  ) throw new RangeError('Stabilization plan exceeds the reviewed work bounds')
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new RangeError('Stabilization strength must be from 0 to 1')
  }
  if (!Number.isSafeInteger(smoothingRadius) || smoothingRadius < 1 || smoothingRadius > 120) {
    throw new RangeError('Stabilization smoothing radius must be from 1 to 120 frames')
  }
  const cameraPath: SimilarityTransform[] = [{ ...IDENTITY_SIMILARITY_TRANSFORM }]
  for (const estimate of estimates) {
    if (Object.values(estimate.transform).some((value) => !Number.isFinite(value))) {
      throw new RangeError('Stabilization estimate contains a non-finite transform')
    }
    const accumulated = composeSimilarityTransforms(
      estimate.transform,
      cameraPath[cameraPath.length - 1]!,
    )
    if (Object.values(accumulated).some((value) => !Number.isFinite(value))) {
      throw new RangeError('Stabilization camera path contains a non-finite transform')
    }
    cameraPath.push(accumulated)
  }
  const originalSamples = cameraPath.map(similarityPathSample)
  const angles = unwrapAngles(originalSamples.map((sample) => sample.angleRadians))
  const smoothedComponents = {
    x: movingAverage(originalSamples.map((sample) => sample.x), smoothingRadius),
    y: movingAverage(originalSamples.map((sample) => sample.y), smoothingRadius),
    angle: movingAverage(angles, smoothingRadius),
    logScale: movingAverage(originalSamples.map((sample) => sample.logScale), smoothingRadius),
  }
  const stabilizedSamples = originalSamples.map((sample, index) => interpolatePathSample(
    { ...sample, angleRadians: angles[index]! },
    {
      x: smoothedComponents.x[index]!,
      y: smoothedComponents.y[index]!,
      angleRadians: smoothedComponents.angle[index]!,
      logScale: smoothedComponents.logScale[index]!,
    },
    strength,
  ))
  const stabilizedPath = stabilizedSamples.map(similarityFromPathSample)
  const corrections = stabilizedPath.map((target, index) => (
    composeSimilarityTransforms(target, invertSimilarityTransform(cameraPath[index]!))
  ))
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ]
  let maximumCornerDisplacementPixels = 0
  for (const correction of corrections) {
    for (const corner of corners) {
      const deltaX = (correction.a - 1) * corner.x
        - correction.b * corner.y
        + correction.tx
      const deltaY = correction.b * corner.x
        + (correction.a - 1) * corner.y
        + correction.ty
      const displacement = Math.hypot(deltaX, deltaY)
      if (!Number.isFinite(displacement)) {
        throw new RangeError('Stabilization correction contains non-finite crop geometry')
      }
      maximumCornerDisplacementPixels = Math.max(maximumCornerDisplacementPixels, displacement)
    }
  }
  const requiredCropRatio = maximumCornerDisplacementPixels / Math.min(width, height)
  if (!Number.isFinite(requiredCropRatio) || requiredCropRatio < 0) {
    throw new RangeError('Stabilization crop requirement is not finite')
  }
  // Deliberately use the exact half-open geometric boundary without an epsilon
  // band: every representable ratio below 0.5 has a positive finite denominator.
  const finiteZoomDenominator = 1 - 2 * requiredCropRatio
  const conservativeSafeZoom = finiteZoomDenominator > 0
    ? 1 / finiteZoomDenominator
    : null
  const crop: StabilizationCropResult = conservativeSafeZoom !== null
    && Number.isFinite(conservativeSafeZoom)
    ? {
        ok: true,
        conservativeCropRatio: requiredCropRatio,
        conservativeSafeZoom,
      }
    : {
        ok: false,
        failure: {
          code: 'finite-centered-zoom-unavailable',
          requiredCropRatio,
          detail: 'The required centered inset must remain below half the shorter frame dimension.',
        },
      }
  const jitterBefore = pathJitter(originalSamples.map((sample, index) => ({
    ...sample,
    angleRadians: angles[index]!,
  })))
  const jitterAfter = pathJitter(stabilizedSamples)
  const jitterReductionRatio = jitterBefore === 0 ? 0 : 1 - jitterAfter / jitterBefore
  if (
    !Number.isFinite(jitterBefore)
    || !Number.isFinite(jitterAfter)
    || !Number.isFinite(jitterReductionRatio)
  ) throw new RangeError('Stabilization path metrics are not finite')
  return {
    strength,
    smoothingRadius,
    cameraPath,
    stabilizedPath,
    corrections,
    jitterBefore,
    jitterAfter,
    jitterReductionRatio,
    maximumCornerDisplacementPixels,
    crop,
  }
}
