/** App composition for bounded point and similarity-box motion tracking. */

import {
  MAX_ANALYSIS_RESULT_BYTES,
  type AnalysisClipAttachment,
  type AnalysisSourceProvenance,
} from '../domain/analysisCache'
import { clipVisualSettings } from '../domain/clipInspector'
import {
  DEFAULT_MOTION_ANALYSIS_BUDGET,
  MOTION_ANALYSIS_ALGORITHM_VERSION,
  MotionAnalysisCancelledError,
  type GrayFrame,
} from '../domain/motionAnalysis'
import {
  createMotionTrackingPlan,
  createMotionTrackingSamplePlan,
  motionTrackingAvailabilityReason,
  motionTrackingSelectionValidationError,
  MOTION_TRACKING_ALGORITHM_ID,
  MOTION_TRACKING_ALGORITHM_VERSION,
  MOTION_TRACKING_RESULT_VERSION,
  type MotionTrackingAnalysis,
  type MotionTrackingAnalysisFailure,
  type MotionTrackingBoxSample,
  type MotionTrackingDirection,
  type MotionTrackingPlanResult,
  type MotionTrackingPointSample,
  type MotionTrackingSelection,
  type MotionTrackingSource,
} from '../domain/motionTracking'
import {
  trackBoxSequence,
  trackPointSequence,
  validateInitialBoxTrackingSelection,
  validateInitialPointTrackingSelection,
  type TrackingBox,
} from '../domain/motionTrackingResearch'
import type { Clip, ClipId, MediaAsset, TimelineDoc } from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'
import { clipSourceTimeMap } from '../domain/sourceTimeMap'
import type { MotionAnalysisWorkerWindowReply } from '../pipeline/motionAnalysisProtocol'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import {
  MotionAnalysisError,
  type MotionAnalysisResultProcessor,
} from './motionAnalysisController'
import { getMotionAnalysisController } from './motionAnalysisRuntime'
import { sha256Hex } from './sourceFingerprint'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
export const MAX_MOTION_TRACKING_RESULT_BYTES = Math.floor(MAX_ANALYSIS_RESULT_BYTES / 16)
const MAX_SERIALIZED_TRACKING_SAMPLE_BYTES = 256
const RESULT_ENVELOPE_BYTES = 2_048

export interface MotionTrackingAnalysisRequest {
  readonly sourceClipId: ClipId
  readonly selectionGlobalFrame: number
  readonly direction: MotionTrackingDirection
  readonly selection: MotionTrackingSelection
}

export interface MotionTrackingSession {
  readonly sourceClipId: ClipId
  readonly selectionGlobalFrame: number
  readonly selection: MotionTrackingSelection
  readonly direction: MotionTrackingDirection
  readonly analysis: MotionTrackingAnalysis
  readonly source: MotionTrackingSource
  readonly fromCache: boolean
  readonly cacheKey: string
  readonly currentSnapshot: string
  readonly assetId: string
  readonly assetObjectUrl: string
  readonly assetSize: number
  readonly assetLastModified: number
  readonly projectBindingId: string
}

function releaseBytes(bytes: Uint8Array<ArrayBuffer>): void {
  if (bytes.buffer.byteLength > 0) structuredClone(null, { transfer: [bytes.buffer] })
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

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function validConfidence(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1
}

function parseFailure(value: unknown): MotionTrackingAnalysisFailure | null | undefined {
  if (value === null) return null
  if (
    !record(value)
    || !exactKeys(value, ['localFrame', 'code', 'detail'])
    || !safeInteger(value.localFrame)
    || value.localFrame < 0
    || !['lost-point', 'lost-box', 'low-confidence'].includes(String(value.code))
    || typeof value.detail !== 'string'
    || value.detail.length < 1
    || value.detail.length > 2_048
  ) return undefined
  return value as unknown as MotionTrackingAnalysisFailure
}

export function parseMotionTrackingAnalysis(
  bytes: Uint8Array<ArrayBuffer>,
): MotionTrackingAnalysis {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_MOTION_TRACKING_RESULT_BYTES) {
    throw new MotionAnalysisError('storage-corrupt', 'Tracking cache result exceeds the product envelope')
  }
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch (cause) {
    throw new MotionAnalysisError('storage-corrupt', 'Tracking cache result is not valid UTF-8 JSON', cause)
  }
  if (
    !record(value)
    || !exactKeys(value, [
      'version', 'kind', 'direction', 'selectionLocalFrame', 'width', 'height', 'samples', 'failure',
    ])
    || value.version !== MOTION_TRACKING_RESULT_VERSION
    || !['point', 'box'].includes(String(value.kind))
    || !['forward', 'backward'].includes(String(value.direction))
    || !safeInteger(value.selectionLocalFrame)
    || value.selectionLocalFrame < 0
    || !safeInteger(value.width)
    || value.width < 1
    || value.width > DEFAULT_MOTION_ANALYSIS_BUDGET.maxWidth
    || !safeInteger(value.height)
    || value.height < 1
    || value.height > DEFAULT_MOTION_ANALYSIS_BUDGET.maxHeight
    || !Array.isArray(value.samples)
    || value.samples.length < 1
    || value.samples.length > 1_024
  ) throw new MotionAnalysisError('storage-corrupt', 'Tracking cache result has an invalid envelope')
  const failure = parseFailure(value.failure)
  if (failure === undefined) {
    throw new MotionAnalysisError('storage-corrupt', 'Tracking cache failure is invalid')
  }
  const samples: (MotionTrackingPointSample | MotionTrackingBoxSample)[] = []
  let previousLocalFrame: number | null = null
  let previousTimestampUs: number | null = null
  for (const candidate of value.samples) {
    const box = value.kind === 'box'
    const expected = box
      ? ['timestampUs', 'sourceTimeTicks', 'localFrame', 'x', 'y', 'width', 'height', 'confidence']
      : ['timestampUs', 'sourceTimeTicks', 'localFrame', 'x', 'y', 'confidence']
    if (
      !record(candidate)
      || !exactKeys(candidate, expected)
      || !safeInteger(candidate.timestampUs)
      || !safeInteger(candidate.sourceTimeTicks)
      || candidate.sourceTimeTicks < 0
      || !safeInteger(candidate.localFrame)
      || candidate.localFrame < 0
      || !finite(candidate.x)
      || !finite(candidate.y)
      || candidate.x < 0
      || candidate.x >= value.width
      || candidate.y < 0
      || candidate.y >= value.height
      || !validConfidence(candidate.confidence)
      || (box && (
        !finite(candidate.width)
        || !finite(candidate.height)
        || (candidate.width as number) <= 0
        || (candidate.height as number) <= 0
        || candidate.x + (candidate.width as number) > value.width
        || candidate.y + (candidate.height as number) > value.height
      ))
      || (previousLocalFrame !== null && (
        value.direction === 'forward'
          ? candidate.localFrame <= previousLocalFrame
          : candidate.localFrame >= previousLocalFrame
      ))
      || (previousTimestampUs !== null && (
        value.direction === 'forward'
          ? candidate.timestampUs < previousTimestampUs
          : candidate.timestampUs > previousTimestampUs
      ))
    ) throw new MotionAnalysisError('storage-corrupt', 'Tracking cache samples are invalid')
    samples.push(candidate as unknown as MotionTrackingPointSample | MotionTrackingBoxSample)
    previousLocalFrame = candidate.localFrame as number
    previousTimestampUs = candidate.timestampUs as number
  }
  return {
    version: MOTION_TRACKING_RESULT_VERSION,
    kind: value.kind,
    direction: value.direction,
    selectionLocalFrame: value.selectionLocalFrame,
    width: value.width,
    height: value.height,
    samples,
    failure,
  } as MotionTrackingAnalysis
}

function ownedGrayFrame(frame: MotionAnalysisWorkerWindowReply['frames'][number]): GrayFrame {
  return { width: frame.width, height: frame.height, data: frame.pixels.slice() }
}

function selectionPoint(selection: MotionTrackingSelection, width: number, height: number) {
  const geometry = selection.kind === 'point' ? selection.point : selection.box
  return {
    x: Math.round(geometry.x * (width - 1)),
    y: Math.round(geometry.y * (height - 1)),
  }
}

function selectionBox(selection: Extract<MotionTrackingSelection, { kind: 'box' }>, width: number, height: number): TrackingBox {
  return {
    x: Math.round(selection.box.x * (width - 1)),
    y: Math.round(selection.box.y * (height - 1)),
    width: Math.max(1, Math.round(selection.box.width * width)),
    height: Math.max(1, Math.round(selection.box.height * height)),
  }
}

function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function monotonicNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now()
}

export function createMotionTrackingProcessor(
  selection: MotionTrackingSelection,
  direction: MotionTrackingDirection,
  sampleSourceTimeTicks: readonly number[],
  sampleLocalFrames: readonly number[],
): MotionAnalysisResultProcessor {
  const selectionError = motionTrackingSelectionValidationError(selection)
  if (selectionError) throw new RangeError(selectionError)
  if (
    sampleSourceTimeTicks.length < 2
    || sampleSourceTimeTicks.length !== sampleLocalFrames.length
    || sampleSourceTimeTicks.length > 1_024
  ) throw new RangeError('Motion-tracking processor schedule is invalid')
  const samples: (MotionTrackingPointSample | MotionTrackingBoxSample)[] = []
  let failure: MotionTrackingAnalysisFailure | null = null
  let previous: GrayFrame | null = null
  let point: { x: number; y: number } | null = null
  let box: TrackingBox | null = null
  let width = 0
  let height = 0
  let nextIndex = 0
  let serializedBytes = 0
  let pairsSinceYield = 0
  let lastYieldAt = monotonicNow()

  const append = (sample: MotionTrackingPointSample | MotionTrackingBoxSample): void => {
    const bytes = JSON.stringify(sample).length + 1
    if (
      samples.length >= 1_024
      || bytes > MAX_SERIALIZED_TRACKING_SAMPLE_BYTES
      || serializedBytes + bytes > MAX_MOTION_TRACKING_RESULT_BYTES - RESULT_ENVELOPE_BYTES
    ) throw new MotionAnalysisError('resource-limit', 'Motion-tracking result exceeded the reviewed envelope')
    serializedBytes += bytes
    samples.push(sample)
  }

  return {
    consumeWindow: async (window, signal) => {
      for (let localIndex = 0; localIndex < window.frames.length; localIndex++) {
        const globalIndex = window.sampleOffset + localIndex
        if (globalIndex < nextIndex) continue
        if (globalIndex !== nextIndex) {
          throw new MotionAnalysisError('decode-readback', 'Motion tracking received a frame gap')
        }
        if (signal.aborted) throw new DOMException('Motion tracking was cancelled', 'AbortError')
        const currentWorker = window.frames[localIndex]!
        if (nextIndex === 0) {
          width = currentWorker.width
          height = currentWorker.height
          const firstFrame = ownedGrayFrame(currentWorker)
          point = selectionPoint(selection, width, height)
          if (selection.kind === 'box') {
            box = selectionBox(selection, width, height)
            validateInitialBoxTrackingSelection(
              firstFrame,
              box,
              DEFAULT_MOTION_ANALYSIS_BUDGET,
            )
          } else {
            validateInitialPointTrackingSelection(
              firstFrame,
              point,
              DEFAULT_MOTION_ANALYSIS_BUDGET,
            )
          }
          const first = selection.kind === 'point'
            ? { ...point, confidence: 1 }
            : { ...box!, x: box!.x, y: box!.y, confidence: 1 }
          append({
            timestampUs: currentWorker.timestampUs,
            sourceTimeTicks: sampleSourceTimeTicks[0]!,
            localFrame: sampleLocalFrames[0]!,
            ...first,
          })
          previous = firstFrame
          nextIndex++
          continue
        }
        if (currentWorker.width !== width || currentWorker.height !== height) {
          throw new MotionAnalysisError('decode-readback', 'Motion-tracking frames changed dimensions')
        }
        if (failure) {
          nextIndex++
          continue
        }
        const current = ownedGrayFrame(currentWorker)
        try {
          if (selection.kind === 'point') {
            const result = trackPointSequence(
              [previous!, current],
              point!,
              DEFAULT_MOTION_ANALYSIS_BUDGET,
              () => signal.aborted,
            )
            if (!result.ok) {
              failure = {
                localFrame: sampleLocalFrames[globalIndex]!,
                code: result.failure.code,
                detail: result.failure.detail,
              }
            } else {
              const tracked = result.samples[1]!
              point = { x: tracked.x, y: tracked.y }
              append({
                timestampUs: currentWorker.timestampUs,
                sourceTimeTicks: sampleSourceTimeTicks[globalIndex]!,
                localFrame: sampleLocalFrames[globalIndex]!,
                ...point,
                confidence: tracked.confidence,
              })
            }
          } else {
            const result = trackBoxSequence(
              [previous!, current],
              box!,
              DEFAULT_MOTION_ANALYSIS_BUDGET,
              () => signal.aborted,
            )
            if (!result.ok) {
              failure = {
                localFrame: sampleLocalFrames[globalIndex]!,
                code: result.failure.code,
                detail: result.failure.detail,
              }
            } else {
              const tracked = result.samples[1]!
              box = { x: tracked.x, y: tracked.y, width: tracked.width, height: tracked.height }
              append({
                timestampUs: currentWorker.timestampUs,
                sourceTimeTicks: sampleSourceTimeTicks[globalIndex]!,
                localFrame: sampleLocalFrames[globalIndex]!,
                ...box,
                confidence: tracked.confidence,
              })
            }
          }
        } catch (cause) {
          if (cause instanceof MotionAnalysisCancelledError && signal.aborted) {
            throw new DOMException('Motion tracking was cancelled', 'AbortError')
          }
          throw cause
        } finally {
          previous = current
          nextIndex++
        }
        pairsSinceYield++
        if (pairsSinceYield >= 8 || monotonicNow() - lastYieldAt >= 8) {
          await yieldToBrowser()
          if (signal.aborted) throw new DOMException('Motion tracking was cancelled', 'AbortError')
          pairsSinceYield = 0
          lastYieldAt = monotonicNow()
        }
      }
    },
    finish: async (completion, signal) => {
      if (signal.aborted) throw new DOMException('Motion tracking was cancelled', 'AbortError')
      if (nextIndex !== completion.sampledFrameCount || nextIndex !== sampleLocalFrames.length) {
        throw new MotionAnalysisError('decode-readback', 'Motion-tracking analysis result is incomplete')
      }
      const bytes = encoder.encode(JSON.stringify({
        version: MOTION_TRACKING_RESULT_VERSION,
        kind: selection.kind,
        direction,
        selectionLocalFrame: sampleLocalFrames[0],
        width,
        height,
        samples,
        failure,
      })) as Uint8Array<ArrayBuffer>
      if (bytes.byteLength > MAX_MOTION_TRACKING_RESULT_BYTES) {
        releaseBytes(bytes)
        throw new MotionAnalysisError('resource-limit', 'Motion-tracking result exceeded the product envelope')
      }
      return bytes
    },
  }
}

function sourceFor(asset: MediaAsset): MotionTrackingSource | null {
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

function sourceSnapshot(
  doc: TimelineDoc,
  clip: Clip,
  source: MotionTrackingSource,
  request: Pick<MotionTrackingAnalysisRequest, 'selectionGlobalFrame' | 'direction' | 'selection'>,
): string {
  return JSON.stringify({
    canvas: { width: doc.width, height: doc.height, frameRate: doc.frameRate },
    clip: {
      id: clip.id,
      assetId: clip.assetId,
      timelineRange: clip.timelineRange,
      sourceTimeMap: clipSourceTimeMap(clip),
      transform: clip.transform,
      visual: clipVisualSettings(clip),
      animation: clip.animation,
    },
    source,
    request: {
      selectionGlobalFrame: request.selectionGlobalFrame,
      direction: request.direction,
      selection: request.selection,
    },
  })
}

function currentFailureFor(
  session: Pick<MotionTrackingSession,
    'projectBindingId' | 'sourceClipId' | 'source' | 'selectionGlobalFrame' | 'direction' | 'selection'
    | 'currentSnapshot' | 'assetId' | 'assetObjectUrl' | 'assetSize' | 'assetLastModified'>,
): 'offline-source' | 'replaced-source' | null {
  if (getActiveLocalProjectBindingId() !== session.projectBindingId) return 'replaced-source'
  const asset = useMediaStore.getState().assets.get(session.assetId)
  if (!asset || asset.objectUrl.length === 0) return 'offline-source'
  if (
    asset.objectUrl !== session.assetObjectUrl
    || asset.size !== session.assetSize
    || asset.lastModified !== session.assetLastModified
  ) return 'replaced-source'
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, session.sourceClipId)
  if (!clip || clip.assetId !== asset.id) return 'replaced-source'
  return sourceSnapshot(doc, clip, session.source, session) === session.currentSnapshot
    ? null
    : 'replaced-source'
}

async function jsonDigest(value: unknown): Promise<string> {
  return sha256Hex(encoder.encode(JSON.stringify(value)))
}

export async function analyzeMotionTracking(
  request: MotionTrackingAnalysisRequest,
): Promise<MotionTrackingSession> {
  const doc = useDocumentStore.getState().doc
  const clip = findClip(doc, request.sourceClipId)
  const track = trackOfClip(doc, request.sourceClipId)
  const asset = clip ? useMediaStore.getState().assets.get(clip.assetId) : undefined
  const source = asset ? sourceFor(asset) : null
  const bindingId = getActiveLocalProjectBindingId()
  const controller = getMotionAnalysisController()
  if (!clip || track?.kind !== 'video' || !asset || !source) {
    throw new MotionAnalysisError('offline-source', 'Tracking needs one connected source video clip')
  }
  if (track.locked) throw new MotionAnalysisError('unsupported-runtime', 'Unlock the source video track before tracking')
  const selectionError = motionTrackingSelectionValidationError(request.selection)
  if (selectionError) throw new MotionAnalysisError('unsupported-runtime', selectionError)
  const unavailable = motionTrackingAvailabilityReason(doc, clip, source, request.selectionGlobalFrame)
  if (unavailable) throw new MotionAnalysisError('unsupported-runtime', unavailable)
  if (!bindingId || !controller) throw new MotionAnalysisError('unsupported-runtime', 'Motion analysis is not ready yet')
  const bounds = asset.sourceBounds.video
  if (!bounds || bounds.status !== 'exact') {
    throw new MotionAnalysisError('unsupported-runtime', 'The source video has no exact timestamp bounds')
  }
  let samplePlan
  try {
    samplePlan = createMotionTrackingSamplePlan(
      doc,
      clip,
      source,
      bounds,
      request.selectionGlobalFrame,
      request.direction,
    )
  } catch (cause) {
    throw new MotionAnalysisError('unsupported-runtime', cause instanceof Error ? cause.message : String(cause), cause)
  }
  const snapshot = sourceSnapshot(doc, clip, source, request)
  const sourceMappingDigest = await jsonDigest(clipSourceTimeMap(clip))
  const projectionDigest = await jsonDigest(JSON.parse(snapshot))
  const parametersDigest = await jsonDigest({
    selection: request.selection,
    direction: request.direction,
    selectionLocalFrame: samplePlan.selectionLocalFrame,
    budget: DEFAULT_MOTION_ANALYSIS_BUDGET,
    estimator: MOTION_ANALYSIS_ALGORITHM_VERSION,
    product: MOTION_TRACKING_ALGORITHM_VERSION,
  })
  const sessionFacts = {
    sourceClipId: clip.id,
    source,
    selectionGlobalFrame: request.selectionGlobalFrame,
    selection: request.selection,
    direction: request.direction,
    currentSnapshot: snapshot,
    assetId: asset.id,
    assetObjectUrl: asset.objectUrl,
    assetSize: asset.size,
    assetLastModified: asset.lastModified,
    projectBindingId: bindingId,
  } as const
  const run = await controller.analyze({
    projectBindingId: bindingId,
    asset,
    source: {
      videoStreamIndex: 0,
      width: source.width,
      height: source.height,
      frameRate: { ...source.frameRate },
      sourceStartMicroseconds: samplePlan.sourceStartMicroseconds,
      sourceEndMicroseconds: samplePlan.sourceEndMicroseconds,
      samplingIntervalFrames: 1,
    } satisfies Omit<AnalysisSourceProvenance, 'fingerprint'>,
    attachment: {
      clipId: clip.id,
      sourceMappingDigest,
      projectionDigest,
    } satisfies AnalysisClipAttachment,
    algorithm: {
      kind: request.selection.kind === 'point' ? 'point-tracking' : 'box-tracking',
      algorithmId: MOTION_TRACKING_ALGORITHM_ID,
      algorithmVersion: MOTION_TRACKING_ALGORITHM_VERSION,
      parametersDigest,
    },
    sampleTimestampsUs: samplePlan.sampleTimestampsUs,
    processor: createMotionTrackingProcessor(
      request.selection,
      request.direction,
      samplePlan.sampleSourceTimeTicks,
      samplePlan.sampleLocalFrames,
    ),
    currentFailure: () => currentFailureFor(sessionFacts),
  })
  try {
    const analysis = parseMotionTrackingAnalysis(run.bytes)
    if (
      analysis.direction !== request.direction
      || analysis.kind !== request.selection.kind
      || analysis.selectionLocalFrame !== samplePlan.selectionLocalFrame
      || (analysis.failure === null
        && analysis.samples.length !== samplePlan.sampleLocalFrames.length)
      || (analysis.failure !== null && (
        analysis.samples.length >= samplePlan.sampleLocalFrames.length
        || analysis.failure.localFrame !== samplePlan.sampleLocalFrames[analysis.samples.length]
      ))
      || analysis.samples.some((sample, index) => (
        sample.sourceTimeTicks !== samplePlan.sampleSourceTimeTicks[index]
        || sample.localFrame !== samplePlan.sampleLocalFrames[index]
      ))
    ) throw new MotionAnalysisError(
      run.fromCache ? 'storage-corrupt' : 'decode-readback',
      'Tracking result does not match the exact rendered-frame schedule',
    )
    return {
      ...sessionFacts,
      analysis,
      fromCache: run.fromCache,
      cacheKey: run.entry.cacheKey,
    }
  } finally {
    releaseBytes(run.bytes)
  }
}

export function motionTrackingSessionCurrentReason(session: MotionTrackingSession): string | null {
  const failure = currentFailureFor(session)
  return failure === 'offline-source'
    ? 'The analyzed source is offline; reconnect and analyze again.'
    : failure === 'replaced-source'
      ? 'The source clip, mapping, selection, or project changed; analyze again.'
      : null
}

function targetDimensions(target: Clip): { width: number; height: number } | null {
  const asset = useMediaStore.getState().assets.get(target.assetId)
  return asset?.width && asset.height ? { width: asset.width, height: asset.height } : null
}

export function planMotionTracking(
  session: MotionTrackingSession,
  targetClipId: ClipId,
  includeScale: boolean,
): MotionTrackingPlanResult {
  const current = motionTrackingSessionCurrentReason(session)
  if (current) return { ok: false, reason: current }
  const doc = useDocumentStore.getState().doc
  const sourceClip = findClip(doc, session.sourceClipId)
  const target = findClip(doc, targetClipId)
  const targetTrack = trackOfClip(doc, targetClipId)
  if (!sourceClip || !target || targetTrack?.kind !== 'video') {
    return { ok: false, reason: 'Choose an overlapping visual target clip.' }
  }
  if (targetTrack.locked) return { ok: false, reason: 'Unlock the target video track before applying tracking.' }
  const dimensions = targetDimensions(target)
  if (!dimensions) return { ok: false, reason: 'The target visual source is offline or has no exact dimensions.' }
  return createMotionTrackingPlan(
    doc,
    sourceClip,
    target,
    session.source,
    dimensions,
    session.analysis,
    includeScale,
  )
}

export function applyMotionTracking(
  session: MotionTrackingSession,
  targetClipId: ClipId,
  includeScale: boolean,
  replaceExisting: boolean,
) {
  const planned = planMotionTracking(session, targetClipId, includeScale)
  if (!planned.ok) return planned
  const result = useDocumentStore.getState().applyMotionTracking(planned.plan, replaceExisting)
  return result.ok
    ? { ok: true as const, changed: result.changed, plan: planned.plan }
    : { ok: false as const, reason: result.reason }
}

export function cancelMotionTracking(sourceClipId: ClipId): boolean {
  const controller = getMotionAnalysisController()
  if (!controller) return false
  const pointCancelled = controller.cancelClipKind(sourceClipId, 'point-tracking')
  const boxCancelled = controller.cancelClipKind(sourceClipId, 'box-tracking')
  return pointCancelled || boxCancelled
}
