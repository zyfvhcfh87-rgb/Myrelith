/** App composition for Issue #109's browser-local stabilization workflow. */

import type { AnalysisClipAttachment, AnalysisSourceProvenance } from '../domain/analysisCache'
import { clipVisualSettings } from '../domain/clipInspector'
import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  estimateGlobalMotion,
  MOTION_ANALYSIS_ALGORITHM_VERSION,
  MotionAnalysisCancelledError,
  type GlobalMotionEstimate,
  type GrayFrame,
} from '../domain/motionAnalysis'
import type { Clip, ClipId, MediaAsset, TimelineDoc } from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'
import {
  clipSourceTimeMap,
  sourceTicksAtTimelineOffset,
} from '../domain/sourceTimeMap'
import {
  createVideoStabilizationPlan,
  videoStabilizationAvailabilityReason,
  VIDEO_STABILIZATION_ALGORITHM_ID,
  VIDEO_STABILIZATION_ALGORITHM_VERSION,
  VIDEO_STABILIZATION_RESULT_VERSION,
  type VideoStabilizationAnalysis,
  type VideoStabilizationAnalysisSample,
  type VideoStabilizationPlanResult,
  type VideoStabilizationSettings,
  type VideoStabilizationSource,
} from '../domain/videoStabilization'
import type { MotionAnalysisWorkerWindowReply } from '../pipeline/motionAnalysisProtocol'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import {
  MotionAnalysisError,
  type MotionAnalysisResultProcessor,
  type MotionAnalysisRunResult,
} from './motionAnalysisController'
import { getMotionAnalysisController } from './motionAnalysisRuntime'
import { sha256Hex } from './sourceFingerprint'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface VideoStabilizationSession {
  readonly clipId: ClipId
  readonly analysis: VideoStabilizationAnalysis
  readonly source: VideoStabilizationSource
  readonly sourceMappingDigest: string
  readonly projectionDigest: string
  readonly fromCache: boolean
  readonly cacheKey: string
  /** Exact synchronous guard paired with the two durable SHA-256 identities. */
  readonly currentSnapshot: string
  readonly assetId: string
  readonly assetObjectUrl: string
  readonly assetSize: number
  readonly assetLastModified: number
  readonly projectBindingId: string
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function estimate(value: unknown): value is GlobalMotionEstimate {
  if (!record(value) || !exactKeys(value, [
    'transform',
    'matchCount',
    'inlierCount',
    'inlierRatio',
    'meanInlierError',
    'confidence',
  ])) return false
  const transform = value.transform
  return record(transform)
    && exactKeys(transform, ['a', 'b', 'tx', 'ty'])
    && finite(transform.a)
    && finite(transform.b)
    && finite(transform.tx)
    && finite(transform.ty)
    && nonNegativeSafeInteger(value.matchCount)
    && nonNegativeSafeInteger(value.inlierCount)
    && value.inlierCount <= value.matchCount
    && finite(value.inlierRatio)
    && value.inlierRatio >= 0
    && value.inlierRatio <= 1
    && finite(value.meanInlierError)
    && value.meanInlierError >= 0
    && finite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
}

export function parseVideoStabilizationAnalysis(
  bytes: Uint8Array<ArrayBuffer>,
): VideoStabilizationAnalysis {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch (cause) {
    throw new MotionAnalysisError('storage-corrupt', 'Stabilization cache result is not valid UTF-8 JSON', cause)
  }
  if (
    !record(value)
    || !exactKeys(value, ['version', 'width', 'height', 'samples'])
    || value.version !== VIDEO_STABILIZATION_RESULT_VERSION
    || !nonNegativeSafeInteger(value.width)
    || value.width <= 0
    || value.width > DEFAULT_MOTION_ANALYSIS_BUDGET.maxWidth
    || !nonNegativeSafeInteger(value.height)
    || value.height <= 0
    || value.height > DEFAULT_MOTION_ANALYSIS_BUDGET.maxHeight
    || !Array.isArray(value.samples)
    || value.samples.length < 2
    || value.samples.length > 1_000_000
  ) throw new MotionAnalysisError('storage-corrupt', 'Stabilization cache result has an invalid envelope')
  let previousTimestamp = Number.MIN_SAFE_INTEGER
  const samples: VideoStabilizationAnalysisSample[] = []
  for (let index = 0; index < value.samples.length; index++) {
    const sample = value.samples[index]
    const timestampUs = record(sample) ? sample.timestampUs : null
    if (
      !record(sample)
      || !exactKeys(sample, ['timestampUs', 'estimateFromPrevious'])
      || typeof timestampUs !== 'number'
      || !Number.isSafeInteger(timestampUs)
      || timestampUs <= previousTimestamp
      || (index === 0
        ? sample.estimateFromPrevious !== null
        : !estimate(sample.estimateFromPrevious))
    ) throw new MotionAnalysisError('storage-corrupt', 'Stabilization cache samples are invalid')
    previousTimestamp = timestampUs
    samples.push({
      timestampUs,
      estimateFromPrevious: index === 0
        ? null
        : sample.estimateFromPrevious as unknown as GlobalMotionEstimate,
    })
  }
  return {
    version: VIDEO_STABILIZATION_RESULT_VERSION,
    width: value.width,
    height: value.height,
    samples,
  }
}

function releaseBytes(bytes: Uint8Array<ArrayBuffer>): void {
  if (bytes.buffer.byteLength > 0) structuredClone(null, { transfer: [bytes.buffer] })
}

function meanAbsoluteFrameDifference(from: GrayFrame, to: GrayFrame): number {
  let total = 0
  for (let index = 0; index < from.data.length; index++) {
    total += Math.abs(from.data[index]! - to.data[index]!)
  }
  return total / from.data.length
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function createVideoStabilizationProcessor(): MotionAnalysisResultProcessor {
  const samples: VideoStabilizationAnalysisSample[] = []
  let width = 0
  let height = 0
  let nextPairEndIndex = 1
  return {
    consumeWindow: async (window: MotionAnalysisWorkerWindowReply, signal: AbortSignal) => {
      if (signal.aborted) throw new DOMException('Motion analysis was cancelled', 'AbortError')
      const first = window.frames[0]!
      if (samples.length === 0) {
        width = first.width
        height = first.height
        samples.push({ timestampUs: first.timestampUs, estimateFromPrevious: null })
      }
      if (first.width !== width || first.height !== height) {
        throw new MotionAnalysisError('decode-readback', 'Stabilization frames changed dimensions during analysis')
      }
      for (let localEnd = 1; localEnd < window.frames.length; localEnd++) {
        const globalEnd = window.sampleOffset + localEnd
        if (globalEnd < nextPairEndIndex) continue
        if (globalEnd !== nextPairEndIndex) {
          throw new MotionAnalysisError('decode-readback', 'Stabilization analysis received a frame gap')
        }
        if (signal.aborted) throw new DOMException('Motion analysis was cancelled', 'AbortError')
        const fromWorker = window.frames[localEnd - 1]!
        const toWorker = window.frames[localEnd]!
        if (
          fromWorker.width !== width
          || fromWorker.height !== height
          || toWorker.width !== width
          || toWorker.height !== height
        ) throw new MotionAnalysisError(
          'decode-readback',
          'Stabilization frames changed dimensions during analysis',
        )
        // Release the browser event loop between bounded pairs so Cancel and
        // source replacement can be observed while the bridge retains this window.
        await yieldToBrowser()
        if (signal.aborted) throw new DOMException('Motion analysis was cancelled', 'AbortError')
        const from = { width, height, data: fromWorker.pixels } satisfies GrayFrame
        const to = { width, height, data: toWorker.pixels } satisfies GrayFrame
        let motion: GlobalMotionEstimate | null
        try {
          motion = estimateGlobalMotion(
            from,
            to,
            DEFAULT_MOTION_ANALYSIS_BUDGET,
            () => signal.aborted,
          )
        } catch (cause) {
          if (cause instanceof MotionAnalysisCancelledError && signal.aborted) {
            throw new DOMException('Motion analysis was cancelled', 'AbortError')
          }
          throw cause
        }
        if (!motion) {
          const sceneCut = meanAbsoluteFrameDifference(from, to) >= 38
          throw new MotionAnalysisError(
            sceneCut ? 'scene-cut' : 'low-confidence',
            sceneCut
              ? `A scene cut was detected at analyzed frame ${globalEnd}.`
              : `Motion confidence was insufficient at analyzed frame ${globalEnd}.`,
          )
        }
        if (motion.meanInlierError > 1.25 || motion.inlierRatio < 0.55) {
          throw new MotionAnalysisError(
            'excessive-residual',
            `Parallax or residual motion exceeded the reviewed envelope at analyzed frame ${globalEnd}.`,
          )
        }
        samples.push({ timestampUs: toWorker.timestampUs, estimateFromPrevious: motion })
        nextPairEndIndex++
      }
    },
    finish: async (completion, signal) => {
      if (signal.aborted) throw new DOMException('Motion analysis was cancelled', 'AbortError')
      if (samples.length !== completion.sampledFrameCount || samples.length < 2) {
        throw new MotionAnalysisError('decode-readback', 'Stabilization analysis result is incomplete')
      }
      return encoder.encode(JSON.stringify({
        version: VIDEO_STABILIZATION_RESULT_VERSION,
        width,
        height,
        samples,
      })) as Uint8Array<ArrayBuffer>
    },
  }
}

function sourceFor(asset: MediaAsset): VideoStabilizationSource | null {
  const bounds = asset.sourceBounds.video
  if (
    asset.kind !== 'video'
    || asset.width === null
    || asset.height === null
    || asset.frameRate === null
    || !bounds
    || bounds.status !== 'exact'
  ) return null
  return {
    width: asset.width,
    height: asset.height,
    firstTimestampUs: bounds.firstTimestampUs,
    frameRate: { ...asset.frameRate },
  }
}

function sourceMicroseconds(
  ticks: number,
  firstTimestampUs: number,
  rate: VideoStabilizationSource['frameRate'],
  rounding: 'floor' | 'ceil',
): number {
  const numerator = BigInt(ticks) * BigInt(rate.den)
  const denominator = BigInt(rate.num)
  const quotient = rounding === 'floor'
    ? numerator / denominator
    : (numerator + denominator - 1n) / denominator
  const result = BigInt(firstTimestampUs) + quotient
  if (result < BigInt(Number.MIN_SAFE_INTEGER) || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Stabilization source timestamp exceeds the safe integer range')
  }
  return Number(result)
}

function maximumSourceRate(clip: Clip): number {
  const map = clipSourceTimeMap(clip)
  const rates = [map.rate, ...(map.speedCurve?.points.map((point) => point.rate) ?? [])]
  return Math.max(...rates.map((rate) => rate.numerator / rate.denominator))
}

function samplingInterval(doc: TimelineDoc, clip: Clip, source: VideoStabilizationSource): number {
  const nativePerDocument = source.frameRate.num * doc.frameRate.den
    / (source.frameRate.den * doc.frameRate.num)
  return Math.max(1, Math.ceil(nativePerDocument * maximumSourceRate(clip)))
}

function projectionFacts(doc: TimelineDoc, clip: Clip, source: VideoStabilizationSource) {
  return {
    assetId: clip.assetId,
    canvas: { width: doc.width, height: doc.height, frameRate: doc.frameRate },
    timelineRange: clip.timelineRange,
    source: { width: source.width, height: source.height },
    transform: clip.transform,
    visual: clipVisualSettings(clip),
  }
}

async function jsonDigest(value: unknown): Promise<string> {
  return sha256Hex(encoder.encode(JSON.stringify(value)))
}

function exactClipSnapshot(doc: TimelineDoc, clip: Clip, source: VideoStabilizationSource): string {
  return JSON.stringify({
    sourceTimeMap: clipSourceTimeMap(clip),
    projection: projectionFacts(doc, clip, source),
  })
}

function currentFailureFor(
  bindingId: string,
  clipId: ClipId,
  asset: MediaAsset,
  source: VideoStabilizationSource,
  snapshot: string,
): 'offline-source' | 'replaced-source' | null {
  if (getActiveLocalProjectBindingId() !== bindingId) return 'replaced-source'
  const currentAsset = useMediaStore.getState().assets.get(asset.id)
  if (!currentAsset || currentAsset.objectUrl.length === 0) return 'offline-source'
  if (
    currentAsset.objectUrl !== asset.objectUrl
    || currentAsset.size !== asset.size
    || currentAsset.lastModified !== asset.lastModified
  ) return 'replaced-source'
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, clipId)
  if (!clip || clip.assetId !== asset.id) return 'replaced-source'
  return exactClipSnapshot(doc, clip, source) === snapshot ? null : 'replaced-source'
}

export async function analyzeVideoStabilization(clipId: ClipId): Promise<VideoStabilizationSession> {
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, clipId)
  const track = trackOfClip(doc, clipId)
  const asset = clip ? useMediaStore.getState().assets.get(clip.assetId) : undefined
  const source = asset ? sourceFor(asset) : null
  const bindingId = getActiveLocalProjectBindingId()
  const controller = getMotionAnalysisController()
  if (!clip || track?.kind !== 'video' || !asset || !source) {
    throw new MotionAnalysisError('offline-source', 'Stabilization needs one connected video clip')
  }
  if (track.locked) {
    throw new MotionAnalysisError('unsupported-runtime', 'Unlock this video track before analyzing stabilization')
  }
  const unavailable = videoStabilizationAvailabilityReason(doc, clip, source)
  if (unavailable) throw new MotionAnalysisError('unsupported-runtime', unavailable)
  if (!bindingId || !controller) {
    throw new MotionAnalysisError('unsupported-runtime', 'Motion analysis is not ready yet')
  }
  const map = clipSourceTimeMap(clip)
  const videoBounds = asset.sourceBounds.video
  if (!videoBounds || videoBounds.status !== 'exact') {
    throw new MotionAnalysisError('unsupported-runtime', 'The video source has no exact timestamp bounds')
  }
  const startTicks = sourceTicksAtTimelineOffset(map, 0)
  const endTicks = sourceTicksAtTimelineOffset(map, clip.timelineRange.durationFrames)
  const sourceStartMicroseconds = Math.max(
    videoBounds.firstTimestampUs,
    sourceMicroseconds(startTicks, source.firstTimestampUs, source.frameRate, 'floor'),
  )
  const sourceEndMicroseconds = Math.min(
    videoBounds.endTimestampUs,
    sourceMicroseconds(endTicks, source.firstTimestampUs, source.frameRate, 'ceil'),
  )
  if (sourceEndMicroseconds <= sourceStartMicroseconds) {
    throw new MotionAnalysisError('unsupported-runtime', 'The clip maps to an empty video source range')
  }
  const sourceMappingDigest = await jsonDigest(map)
  const projectionDigest = await jsonDigest(projectionFacts(doc, clip, source))
  const parametersDigest = await jsonDigest({
    budget: DEFAULT_MOTION_ANALYSIS_BUDGET,
    estimator: MOTION_ANALYSIS_ALGORITHM_VERSION,
    product: VIDEO_STABILIZATION_ALGORITHM_VERSION,
  })
  const attachment: AnalysisClipAttachment = {
    clipId,
    sourceMappingDigest,
    projectionDigest,
  }
  const snapshot = exactClipSnapshot(doc, clip, source)
  const run: MotionAnalysisRunResult = await controller.analyze({
      projectBindingId: bindingId,
      asset,
      source: {
        videoStreamIndex: 0,
        width: source.width,
        height: source.height,
        frameRate: { ...source.frameRate },
        sourceStartMicroseconds,
        sourceEndMicroseconds,
        samplingIntervalFrames: samplingInterval(doc, clip, source),
      } satisfies Omit<AnalysisSourceProvenance, 'fingerprint'>,
      attachment,
      algorithm: {
        kind: 'stabilization',
        algorithmId: VIDEO_STABILIZATION_ALGORITHM_ID,
        algorithmVersion: VIDEO_STABILIZATION_ALGORITHM_VERSION,
        parametersDigest,
      },
      processor: createVideoStabilizationProcessor(),
      currentFailure: () => currentFailureFor(
        bindingId,
        clipId,
        asset,
        source,
        snapshot,
      ),
  })
  try {
    const analysis = parseVideoStabilizationAnalysis(run.bytes)
    return {
      clipId,
      analysis,
      source,
      sourceMappingDigest,
      projectionDigest,
      fromCache: run.fromCache,
      cacheKey: run.entry.cacheKey,
      currentSnapshot: snapshot,
      assetId: asset.id,
      assetObjectUrl: asset.objectUrl,
      assetSize: asset.size,
      assetLastModified: asset.lastModified,
      projectBindingId: bindingId,
    }
  } finally {
    releaseBytes(run.bytes)
  }
}

export function videoStabilizationSessionCurrentReason(
  session: VideoStabilizationSession,
): string | null {
  if (getActiveLocalProjectBindingId() !== session.projectBindingId) {
    return 'The local project changed; analyze again.'
  }
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, session.clipId)
  if (!clip) return 'The analyzed clip is no longer available.'
  const asset = useMediaStore.getState().assets.get(clip.assetId)
  const source = asset ? sourceFor(asset) : null
  if (!asset || !source) return 'The analyzed source is offline or no longer exact.'
  // The digest values are async SHA-256, so the synchronous Apply guard also
  // compares the exact frozen JSON facts. Analysis re-runs if either changes.
  if (
    exactClipSnapshot(doc, clip, source) !== session.currentSnapshot
    || source.width !== session.source.width
    || source.height !== session.source.height
    || source.firstTimestampUs !== session.source.firstTimestampUs
    || source.frameRate.num !== session.source.frameRate.num
    || source.frameRate.den !== session.source.frameRate.den
    || asset.id !== session.assetId
    || asset.objectUrl !== session.assetObjectUrl
    || asset.size !== session.assetSize
    || asset.lastModified !== session.assetLastModified
  ) return 'The clip, source mapping, or projection changed; analyze again.'
  return null
}

export function planVideoStabilization(
  session: VideoStabilizationSession,
  settings: VideoStabilizationSettings,
): VideoStabilizationPlanResult {
  const currentReason = videoStabilizationSessionCurrentReason(session)
  if (currentReason) return { ok: false, reason: currentReason }
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, session.clipId)
  if (!clip) return { ok: false, reason: 'The analyzed clip is no longer available.' }
  return createVideoStabilizationPlan(doc, clip, session.source, session.analysis, settings)
}

export function applyVideoStabilization(
  session: VideoStabilizationSession,
  settings: VideoStabilizationSettings,
  replaceExisting: boolean,
) {
  const planned = planVideoStabilization(session, settings)
  if (!planned.ok) return planned
  const result = useDocumentStore.getState().applyVideoStabilization(
    session.clipId,
    planned.plan,
    replaceExisting,
  )
  return result.ok
    ? { ok: true as const, changed: result.changed, plan: planned.plan }
    : { ok: false as const, reason: result.reason }
}

export function cancelVideoStabilization(clipId: ClipId): boolean {
  return getMotionAnalysisController()?.cancelClip(clipId) ?? false
}
