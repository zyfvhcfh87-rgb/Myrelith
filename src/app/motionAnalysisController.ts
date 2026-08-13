import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  MAX_ANALYSIS_RESULT_BYTES,
  type AnalysisAlgorithmProvenance,
  type AnalysisCacheEntry,
  type AnalysisCacheIdentity,
  type AnalysisClipAttachment,
  type AnalysisSourceProvenance,
} from '../domain/analysisCache'
import type { MediaAsset } from '../domain/schema'
import type {
  MotionAnalysisWorkerRunMessage,
} from '../pipeline/motionAnalysisProtocol'
import {
  MediaJobExecutionError,
  MediaJobScheduler,
  type MediaJobPriority,
  type MediaJobSchedulerSnapshot,
} from './mediaJobScheduler'
import {
  runMotionAnalysisWorker,
  type MotionAnalysisWindowConsumer,
  type MotionAnalysisWorkerLike,
  type MotionAnalysisWorkerRunResult,
} from './motionAnalysisWorkerBridge'
import {
  AnalysisStorageQuotaError,
  AnalysisStorageCorruptError,
  AnalysisStorageUnavailableError,
  analysisStorage,
  type AnalysisStorage,
} from './analysisStorage'
import { fingerprintLocalMediaSource, sha256Hex } from './sourceFingerprint'

export type MotionAnalysisFailureCode =
  | 'unsupported-runtime'
  | 'unsupported-codec'
  | 'offline-source'
  | 'replaced-source'
  | 'resource-limit'
  | 'decode-readback'
  | 'low-confidence'
  | 'scene-cut'
  | 'quota'
  | 'storage-corrupt'
  | 'cancelled'
  | 'unexpected'

export class MotionAnalysisError extends Error {
  readonly code: MotionAnalysisFailureCode

  constructor(code: MotionAnalysisFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MotionAnalysisError'
    this.code = code
  }
}

export interface MotionAnalysisSourceRequest extends Omit<AnalysisSourceProvenance, 'fingerprint'> {}

export interface MotionAnalysisResultProcessor {
  consumeWindow: MotionAnalysisWindowConsumer
  finish(
    completion: MotionAnalysisWorkerRunResult,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>
}

export interface MotionAnalysisRunRequest {
  readonly projectBindingId: string
  readonly asset: MediaAsset
  readonly source: MotionAnalysisSourceRequest
  readonly attachment: AnalysisClipAttachment
  readonly algorithm: AnalysisAlgorithmProvenance
  readonly processor: MotionAnalysisResultProcessor
  readonly priority?: MediaJobPriority
  /** Returns null while this exact source/clip/projection snapshot remains current. */
  readonly currentFailure: () => 'offline-source' | 'replaced-source' | null
}

export interface MotionAnalysisRunResult {
  readonly entry: AnalysisCacheEntry
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly fromCache: boolean
  readonly completion: MotionAnalysisWorkerRunResult | null
}

export interface MotionAnalysisStatus {
  readonly id: string
  readonly clipId: string
  readonly kind: AnalysisAlgorithmProvenance['kind']
  readonly phase: 'queued' | 'running' | 'ready' | 'cancelled' | 'error'
  readonly progress: number
  readonly failure: Readonly<{ code: MotionAnalysisFailureCode; detail: string }> | null
  readonly fromCache: boolean
}

export interface MotionAnalysisControllerSnapshot {
  readonly jobs: readonly MotionAnalysisStatus[]
  readonly scheduler: MediaJobSchedulerSnapshot
}

export interface MotionAnalysisControllerDeps {
  readonly storage: AnalysisStorage
  readonly scheduler: MediaJobScheduler
  readonly fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>
  readonly fingerprint: typeof fingerprintLocalMediaSource
  readonly workerFactory?: () => MotionAnalysisWorkerLike
  readonly now: () => number
}

function createRealDeps(): MotionAnalysisControllerDeps {
  return {
    storage: analysisStorage,
    scheduler: new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
    }),
    fetchBlob: async (url, signal) => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`Could not read source bytes (${response.status})`)
      return response.blob()
    },
    fingerprint: fingerprintLocalMediaSource,
    now: () => Date.now(),
  }
}

const OWNED_OPERATION_TIMEOUT_MS = 10_000

interface PendingRun {
  readonly generation: number
  readonly schedulerId: string
  readonly request: MotionAnalysisRunRequest
  readonly reject: (cause: unknown) => void
}

function abortError(): MotionAnalysisError {
  return new MotionAnalysisError('cancelled', 'Motion analysis was cancelled')
}

function raceOwnedOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  label: string,
  timeoutCode: MotionAnalysisFailureCode,
  cleanupLateValue?: (value: T) => Promise<void>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (action: () => void) => {
      if (settled) return false
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      action()
      return true
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timeout = setTimeout(() => settle(() => reject(new MotionAnalysisError(
      timeoutCode,
      `${label} timed out`,
    ))), OWNED_OPERATION_TIMEOUT_MS)
    operation.then(
      (value) => {
        if (!settle(() => resolve(value))) {
          void cleanupLateValue?.(value).catch(() => undefined)
        }
      },
      (cause) => {
        settle(() => reject(cause))
      },
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function jobId(request: MotionAnalysisRunRequest): string {
  return `analysis:${request.attachment.clipId}:${request.algorithm.kind}`
}

function validateRequest(request: MotionAnalysisRunRequest): void {
  if (!request.projectBindingId.startsWith('local-project:')) {
    throw new TypeError('Motion analysis requires an opaque local-project binding')
  }
  if (
    request.asset.id.length === 0
    || request.attachment.clipId.length === 0
    || request.asset.kind !== 'video'
    || request.asset.width === null
    || request.asset.height === null
    || request.asset.frameRate === null
  ) throw new TypeError('Motion analysis requires one connected video asset and clip')
  if (
    request.source.width !== request.asset.width
    || request.source.height !== request.asset.height
    || request.source.frameRate.num !== request.asset.frameRate.num
    || request.source.frameRate.den !== request.asset.frameRate.den
    || request.source.sourceEndMicroseconds <= request.source.sourceStartMicroseconds
    || !Number.isSafeInteger(request.source.samplingIntervalFrames)
    || request.source.samplingIntervalFrames <= 0
  ) throw new TypeError('Motion analysis source facts do not match the connected asset')
}

function tightResult(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.byteOffset !== 0
    || bytes.byteLength !== bytes.buffer.byteLength
    || bytes.byteLength <= 0
    || bytes.byteLength > MAX_ANALYSIS_RESULT_BYTES
  ) throw new MotionAnalysisError(
    'resource-limit',
    'Motion-analysis result exceeded the reviewed cache envelope',
  )
  return bytes as Uint8Array<ArrayBuffer>
}

function publicError(cause: unknown): MotionAnalysisError {
  if (cause instanceof MotionAnalysisError) return cause
  if (cause instanceof AnalysisStorageUnavailableError) {
    return new MotionAnalysisError('unsupported-runtime', cause.message, cause)
  }
  if (cause instanceof AnalysisStorageQuotaError) {
    return new MotionAnalysisError('quota', cause.message, cause)
  }
  if (cause instanceof DOMException && cause.name === 'AbortError') return abortError()
  if (cause instanceof MediaJobExecutionError) {
    const code: MotionAnalysisFailureCode = cause.code === 'unsupported-codec'
      ? 'unsupported-codec'
      : cause.code === 'resource-limit'
        ? 'resource-limit'
        : cause.code === 'decode-failed'
          ? 'decode-readback'
          : cause.code === 'resource-unavailable'
            ? 'unsupported-runtime'
            : 'unexpected'
    return new MotionAnalysisError(code, cause.message, cause)
  }
  if (cause instanceof AnalysisStorageCorruptError) {
    return new MotionAnalysisError('storage-corrupt', cause.message, cause)
  }
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError') {
    return new MotionAnalysisError('quota', cause.message, cause)
  }
  return new MotionAnalysisError(
    'unexpected',
    cause instanceof Error ? cause.message : String(cause),
    cause,
  )
}

export class MotionAnalysisController {
  private readonly deps: MotionAnalysisControllerDeps
  private readonly pending = new Map<string, PendingRun>()
  private readonly statuses = new Map<string, MotionAnalysisStatus>()
  private readonly listeners = new Set<(snapshot: MotionAnalysisControllerSnapshot) => void>()
  private generation = 0
  private requestId = 0
  private disposed = false

  constructor(deps: MotionAnalysisControllerDeps = createRealDeps()) {
    this.deps = deps
  }

  analyze(request: MotionAnalysisRunRequest): Promise<MotionAnalysisRunResult> {
    if (this.disposed) return Promise.reject(new MotionAnalysisError(
      'unsupported-runtime',
      'Motion-analysis controller is disposed',
    ))
    validateRequest(request)
    const id = jobId(request)
    this.cancelJob(id, 'cancelled')
    const generation = ++this.generation
    const schedulerId = `${id}:${generation}`
    this.setStatus({
      id,
      clipId: request.attachment.clipId,
      kind: request.algorithm.kind,
      phase: 'queued',
      progress: 0,
      failure: null,
      fromCache: false,
    })
    const promise = new Promise<MotionAnalysisRunResult>((resolve, reject) => {
      this.pending.set(id, { generation, schedulerId, request, reject })
      this.deps.scheduler.enqueue({
        id: schedulerId,
        generation,
        priority: request.priority ?? 'selected',
        resources: { decoderSlots: 1 },
        run: async (context) => {
          this.updatePhase(id, generation, 'running')
          try {
            const result = await this.execute(request, context.signal, {
              reportProgress: (progress) => {
                context.reportProgress(progress)
                this.updateProgress(id, generation, progress)
              },
              setActiveDecoderCount: context.setActiveDecoderCount,
              signal: context.signal,
            })
            if (!this.isPending(id, generation)) return
            this.pending.delete(id)
            this.setStatus({
              id,
              clipId: request.attachment.clipId,
              kind: request.algorithm.kind,
              phase: 'ready',
              progress: 1,
              failure: null,
              fromCache: result.fromCache,
            })
            resolve(result)
          } catch (cause) {
            const failure = publicError(cause)
            if (this.isPending(id, generation)) {
              this.pending.delete(id)
              this.setStatus({
                id,
                clipId: request.attachment.clipId,
                kind: request.algorithm.kind,
                phase: failure.code === 'cancelled' ? 'cancelled' : 'error',
                progress: this.statuses.get(id)?.progress ?? 0,
                failure: { code: failure.code, detail: failure.message },
                fromCache: false,
              })
              reject(failure)
            }
            throw failure
          }
        },
      })
    })
    return promise
  }

  cancelClip(clipId: string): boolean {
    let cancelled = false
    for (const [id, pending] of this.pending) {
      if (pending.request.attachment.clipId !== clipId) continue
      cancelled = this.cancelJob(id, 'cancelled') || cancelled
    }
    return cancelled
  }

  reconcile(): void {
    for (const [id, pending] of this.pending) {
      const currentFailure = pending.request.currentFailure()
      if (currentFailure) this.cancelJob(id, currentFailure)
    }
  }

  subscribe(listener: (snapshot: MotionAnalysisControllerSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): MotionAnalysisControllerSnapshot {
    return {
      jobs: [...this.statuses.values()].map((status) => ({
        ...status,
        failure: status.failure ? { ...status.failure } : null,
      })),
      scheduler: this.deps.scheduler.snapshot(),
    }
  }

  async removeAttachment(projectBindingId: string, clipId: string): Promise<void> {
    this.cancelClip(clipId)
    await this.deps.scheduler.whenIdle()
    await this.deps.storage.removeAttachment(projectBindingId, clipId)
    for (const [id, status] of this.statuses) {
      if (status.clipId === clipId) this.statuses.delete(id)
    }
    this.publish()
  }

  async removeAsset(projectBindingId: string, assetId: string): Promise<void> {
    for (const [id, pending] of this.pending) {
      if (pending.request.asset.id === assetId) this.cancelJob(id, 'offline-source')
    }
    await this.deps.scheduler.whenIdle()
    await this.deps.storage.removeAsset(projectBindingId, assetId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.pending.keys()]) this.cancelJob(id, 'cancelled')
    this.deps.scheduler.dispose()
    await this.deps.scheduler.whenIdle()
    this.listeners.clear()
  }

  private async execute(
    request: MotionAnalysisRunRequest,
    signal: AbortSignal,
    context: Parameters<typeof runMotionAnalysisWorker>[2],
  ): Promise<MotionAnalysisRunResult> {
    this.throwIfStale(request, signal)
    const blob = await this.deps.fetchBlob(request.asset.objectUrl, signal)
    this.throwIfStale(request, signal)
    const fingerprint = await raceOwnedOperation(
      this.deps.fingerprint(blob, request.asset),
      signal,
      'Source fingerprinting',
      'decode-readback',
    )
    this.throwIfStale(request, signal)
    const identity: AnalysisCacheIdentity = {
      projectBindingId: request.projectBindingId,
      assetId: request.asset.id,
      source: { ...request.source, fingerprint },
      attachment: { ...request.attachment },
      algorithm: { ...request.algorithm },
    }
    const cacheKey = await raceOwnedOperation(
      sha256Hex(new TextEncoder().encode(JSON.stringify(identity))),
      signal,
      'Analysis cache key derivation',
      'unexpected',
    )
    const cached = await raceOwnedOperation(
      this.deps.storage.findFreshEntry(identity),
      signal,
      'Analysis cache lookup',
      'storage-corrupt',
    )
    this.throwIfStale(request, signal)
    if (cached) {
      const bytes = await raceOwnedOperation(
        this.deps.storage.readResult(cached),
        signal,
        'Analysis cache read',
        'storage-corrupt',
      )
      this.throwIfStale(request, signal)
      void this.deps.storage.touch(cached.cacheKey).catch(() => undefined)
      return { entry: cached, bytes, fromCache: true, completion: null }
    }

    const workerMessage: MotionAnalysisWorkerRunMessage = {
      type: 'run',
      requestId: ++this.requestId,
      blob,
      sourceId: request.asset.id,
      budget: mediaAssetDecoderBudget(request.asset, blob.size),
      startTimestampUs: request.source.sourceStartMicroseconds,
      endTimestampUs: request.source.sourceEndMicroseconds,
      samplingIntervalFrames: request.source.samplingIntervalFrames,
    }
    const completion = await runMotionAnalysisWorker(
      workerMessage,
      request.processor.consumeWindow,
      context,
      this.deps.workerFactory,
    )
    this.throwIfStale(request, signal)
    const bytes = tightResult(await raceOwnedOperation(
      request.processor.finish(completion, signal),
      signal,
      'Motion-analysis result finalization',
      'unexpected',
    ))
    this.throwIfStale(request, signal)
    const staged = await raceOwnedOperation(
      this.deps.storage.stageResult(cacheKey, bytes),
      signal,
      'Analysis result staging',
      'storage-corrupt',
      (late) => late.discard(),
    )
    let transaction: Awaited<ReturnType<AnalysisStorage['commitEntry']>> | null = null
    try {
      this.throwIfStale(request, signal)
      const now = this.deps.now()
      const entry: AnalysisCacheEntry = {
        ...identity,
        cacheKey,
        resultFileName: staged.fileName,
        resultBytes: bytes.byteLength,
        sampleCount: completion.sampledFrameCount,
        createdAt: now,
        lastUsedAt: now,
      }
      transaction = await raceOwnedOperation(
        this.deps.storage.commitEntry(entry),
        signal,
        'Analysis manifest commit',
        'storage-corrupt',
        (late) => late.rollback(),
      )
      this.throwIfStale(request, signal)
      void transaction.finalize().catch(() => undefined)
      return { entry, bytes, fromCache: false, completion }
    } catch (cause) {
      if (transaction) await transaction.rollback().catch(() => undefined)
      else await staged.discard().catch(() => undefined)
      throw cause
    }
  }

  private throwIfStale(request: MotionAnalysisRunRequest, signal: AbortSignal): void {
    if (signal.aborted) throw abortError()
    const currentFailure = request.currentFailure()
    if (currentFailure) {
      throw new MotionAnalysisError(
        currentFailure,
        currentFailure === 'offline-source'
          ? 'The source went offline during motion analysis'
          : 'The source or clip changed during motion analysis',
      )
    }
  }

  private cancelJob(
    id: string,
    code: 'cancelled' | 'offline-source' | 'replaced-source',
  ): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.deps.scheduler.cancel(
      pending.schedulerId,
      code === 'cancelled' ? 'aborted' : code === 'offline-source' ? 'removed' : 'replaced',
    )
    this.pending.delete(id)
    const error = new MotionAnalysisError(
      code,
      code === 'cancelled'
        ? 'Motion analysis was cancelled'
        : code === 'offline-source'
          ? 'The source went offline during motion analysis'
          : 'The source or clip changed during motion analysis',
    )
    this.setStatus({
      id,
      clipId: pending.request.attachment.clipId,
      kind: pending.request.algorithm.kind,
      phase: code === 'cancelled' ? 'cancelled' : 'error',
      progress: this.statuses.get(id)?.progress ?? 0,
      failure: { code, detail: error.message },
      fromCache: false,
    })
    pending.reject(error)
    return true
  }

  private isPending(id: string, generation: number): boolean {
    return this.pending.get(id)?.generation === generation
  }

  private updatePhase(
    id: string,
    generation: number,
    phase: MotionAnalysisStatus['phase'],
  ): void {
    if (!this.isPending(id, generation)) return
    const status = this.statuses.get(id)
    if (status) this.setStatus({ ...status, phase })
  }

  private updateProgress(id: string, generation: number, progress: number): void {
    if (!this.isPending(id, generation)) return
    const status = this.statuses.get(id)
    if (!status) return
    this.setStatus({
      ...status,
      progress: Math.max(status.progress, Math.max(0, Math.min(1, progress))),
    })
  }

  private setStatus(status: MotionAnalysisStatus): void {
    this.statuses.set(status.id, status)
    this.publish()
  }

  private publish(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // UI-facing diagnostics cannot own analysis progress.
      }
    }
  }
}
