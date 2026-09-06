/**
 * Resource-bounded, priority-aware scheduling for disposable media analysis.
 *
 * The scheduler owns only queue bookkeeping and AbortControllers. Media
 * resources remain inside each injected job and must be released by that job
 * when its signal aborts. Queue facts are bounded, serializable diagnostics;
 * no Blob, decoder, URL, or project truth enters a snapshot.
 */

import { mediaResourceAdmission } from './mediaResourceAdmission'

export type MediaJobPriority = 'background' | 'visible' | 'selected'

export type MediaJobFailureCode =
  | 'resource-unavailable'
  | 'unsupported-codec'
  | 'resource-limit'
  | 'decode-failed'
  | 'unexpected'

export type MediaJobCancellationReason =
  | 'removed'
  | 'replaced'
  | 'superseded'
  | 'disposed'
  | 'aborted'

export interface MediaJobResourceRequest {
  /** Conservative decoder capacity reserved for the complete job. */
  readonly decoderSlots: number
}

export interface MediaJobSchedulerBudget {
  readonly maxConcurrentJobs: number
  readonly maxDecoderSlots: number
}

export const DEFAULT_MEDIA_JOB_SCHEDULER_BUDGET = Object.freeze({
  maxConcurrentJobs: 2,
  maxDecoderSlots: 2,
}) satisfies MediaJobSchedulerBudget

export interface MediaJobContext {
  readonly signal: AbortSignal
  reportProgress(progress: number): void
  setActiveDecoderCount(count: number): void
}

export interface MediaJobRequest {
  readonly id: string
  readonly generation: number
  readonly priority: MediaJobPriority
  readonly resources: MediaJobResourceRequest
  readonly run: (context: MediaJobContext) => Promise<void>
}

export interface MediaJobFailureRecord {
  readonly id: string
  readonly generation: number
  readonly code: MediaJobFailureCode
  readonly detail: string
}

export interface MediaJobDiagnostic {
  readonly id: string
  readonly generation: number
  readonly state: 'queued' | 'running'
  readonly priority: MediaJobPriority
  readonly progress: number
  readonly decoderSlots: number
  readonly activeDecoderCount: number
  readonly queuedAt: number
  readonly startedAt: number | null
}

export interface MediaJobSchedulerSnapshot {
  readonly budget: MediaJobSchedulerBudget
  readonly aging: {
    readonly intervalMs: number
    readonly step: number
  }
  readonly yieldStrategy: 'scheduler.yield' | 'set-timeout' | 'injected'
  readonly queueDepth: number
  readonly activeJobCount: number
  readonly activeDecoderCount: number
  readonly maxQueueDepth: number
  readonly maxActiveJobCount: number
  readonly maxActiveDecoderCount: number
  readonly enqueuedCount: number
  readonly completedCount: number
  readonly cancelledCount: number
  readonly failedCount: number
  readonly waitTimesMs: readonly number[]
  readonly jobs: readonly MediaJobDiagnostic[]
  readonly lastFailures: readonly MediaJobFailureRecord[]
}

export interface MediaJobSchedulerOptions {
  readonly budget?: Partial<MediaJobSchedulerBudget>
  readonly now?: () => number
  readonly yieldControl?: () => Promise<void>
  readonly agingIntervalMs?: number
  readonly agingStep?: number
}

export class MediaJobExecutionError extends Error {
  readonly code: MediaJobFailureCode

  constructor(code: MediaJobFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MediaJobExecutionError'
    this.code = code
  }
}

interface QueuedJob {
  request: MediaJobRequest
  priority: MediaJobPriority
  readonly queuedAt: number
  readonly sequence: number
}

interface ActiveJob {
  readonly request: MediaJobRequest
  readonly priority: MediaJobPriority
  readonly queuedAt: number
  readonly startedAt: number
  readonly controller: AbortController
  progress: number
  activeDecoderCount: number
  cancellationCounted: boolean
}

const PRIORITY_VALUE: Readonly<Record<MediaJobPriority, number>> = Object.freeze({
  background: 0,
  visible: 2,
  selected: 4,
})

const MAX_WAIT_SAMPLES = 1_024
const MAX_FAILURE_RECORDS = 32
const MAX_DIAGNOSTIC_DETAIL_CHARACTERS = 2_048

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`)
  }
  return value
}

function errorDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (detail.length <= MAX_DIAGNOSTIC_DETAIL_CHARACTERS) return detail
  return `${detail.slice(0, MAX_DIAGNOSTIC_DETAIL_CHARACTERS - 1)}…`
}

function failureRecord(
  request: MediaJobRequest,
  cause: unknown,
): MediaJobFailureRecord {
  return {
    id: request.id,
    generation: request.generation,
    code: cause instanceof MediaJobExecutionError ? cause.code : 'unexpected',
    detail: errorDetail(cause),
  }
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(1, progress))
}

function defaultYieldControl(): {
  readonly strategy: MediaJobSchedulerSnapshot['yieldStrategy']
  readonly run: () => Promise<void>
} {
  const candidate = (globalThis as {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  if (typeof candidate?.yield === 'function') {
    return {
      strategy: 'scheduler.yield',
      run: () => candidate.yield!(),
    }
  }
  return {
    strategy: 'set-timeout',
    run: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

export class MediaJobScheduler {
  private readonly budget: MediaJobSchedulerBudget
  private readonly now: () => number
  private readonly yieldControl: () => Promise<void>
  private readonly yieldStrategy: MediaJobSchedulerSnapshot['yieldStrategy']
  private readonly agingIntervalMs: number
  private readonly agingStep: number
  private readonly queued = new Map<string, QueuedJob>()
  private readonly active = new Map<string, ActiveJob>()
  private readonly listeners = new Set<(snapshot: MediaJobSchedulerSnapshot) => void>()
  private readonly idleWaiters = new Set<(snapshot: MediaJobSchedulerSnapshot) => void>()
  private readonly waitTimesMs: number[] = []
  private readonly lastFailures: MediaJobFailureRecord[] = []
  private sequence = 0
  private pumpScheduled = false
  private disposed = false
  private maxQueueDepth = 0
  private maxActiveJobCount = 0
  private maxActiveDecoderCount = 0
  private enqueuedCount = 0
  private completedCount = 0
  private cancelledCount = 0
  private failedCount = 0

  constructor(options: MediaJobSchedulerOptions = {}) {
    this.budget = Object.freeze({
      maxConcurrentJobs: positiveInteger(
        options.budget?.maxConcurrentJobs
          ?? DEFAULT_MEDIA_JOB_SCHEDULER_BUDGET.maxConcurrentJobs,
        'maxConcurrentJobs',
      ),
      maxDecoderSlots: positiveInteger(
        options.budget?.maxDecoderSlots
          ?? DEFAULT_MEDIA_JOB_SCHEDULER_BUDGET.maxDecoderSlots,
        'maxDecoderSlots',
      ),
    })
    this.now = options.now ?? (() => performance.now())
    this.agingIntervalMs = finitePositive(
      options.agingIntervalMs ?? 2_000,
      'agingIntervalMs',
    )
    this.agingStep = finitePositive(options.agingStep ?? 1, 'agingStep')
    if (options.yieldControl) {
      this.yieldStrategy = 'injected'
      this.yieldControl = options.yieldControl
    } else {
      const fallback = defaultYieldControl()
      this.yieldStrategy = fallback.strategy
      this.yieldControl = fallback.run
    }
  }

  enqueue(request: MediaJobRequest): void {
    if (this.disposed) throw new Error('MediaJobScheduler is disposed')
    if (request.id.length === 0) throw new TypeError('Media job id is required')
    if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new RangeError('Media job generation must be a non-negative safe integer')
    }
    const decoderSlots = positiveInteger(
      request.resources.decoderSlots,
      'decoderSlots',
    )
    if (decoderSlots > this.budget.maxDecoderSlots) {
      throw new RangeError(
        `Media job requests ${decoderSlots} decoder slots; budget allows ${this.budget.maxDecoderSlots}`,
      )
    }

    if (this.queued.has(request.id) || this.active.has(request.id)) {
      this.cancel(request.id, 'superseded')
    }
    this.queued.set(request.id, {
      request,
      priority: request.priority,
      queuedAt: this.now(),
      sequence: ++this.sequence,
    })
    this.enqueuedCount++
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queued.size)
    this.publish()
    this.requestPump()
  }

  reprioritize(id: string, priority: MediaJobPriority): boolean {
    const queued = this.queued.get(id)
    if (!queued || queued.priority === priority) return false
    queued.priority = priority
    this.publish()
    this.requestPump()
    return true
  }

  cancel(
    id: string,
    reason: MediaJobCancellationReason = 'removed',
  ): boolean {
    let cancelled = false
    const queued = this.queued.get(id)
    if (queued) {
      this.queued.delete(id)
      this.cancelledCount++
      cancelled = true
    }
    const active = this.active.get(id)
    if (active && !active.controller.signal.aborted) {
      active.cancellationCounted = true
      this.cancelledCount++
      active.controller.abort(reason)
      cancelled = true
    }
    if (cancelled) {
      this.publish()
      this.resolveIdleIfNeeded()
    }
    return cancelled
  }

  cancelAll(reason: MediaJobCancellationReason = 'disposed'): void {
    const ids = new Set([...this.queued.keys(), ...this.active.keys()])
    for (const id of ids) this.cancel(id, reason)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAll('disposed')
    this.listeners.clear()
    this.resolveIdleIfNeeded()
  }

  subscribe(listener: (snapshot: MediaJobSchedulerSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  whenIdle(): Promise<MediaJobSchedulerSnapshot> {
    if (this.queued.size === 0 && this.active.size === 0) {
      return Promise.resolve(this.snapshot())
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  snapshot(): MediaJobSchedulerSnapshot {
    const queuedJobs: MediaJobDiagnostic[] = [...this.queued.values()].map((job) => ({
      id: job.request.id,
      generation: job.request.generation,
      state: 'queued',
      priority: job.priority,
      progress: 0,
      decoderSlots: job.request.resources.decoderSlots,
      activeDecoderCount: 0,
      queuedAt: job.queuedAt,
      startedAt: null,
    }))
    const activeJobs: MediaJobDiagnostic[] = [...this.active.values()].map((job) => ({
      id: job.request.id,
      generation: job.request.generation,
      state: 'running',
      priority: job.priority,
      progress: job.progress,
      decoderSlots: job.request.resources.decoderSlots,
      activeDecoderCount: job.activeDecoderCount,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
    }))
    return {
      budget: { ...this.budget },
      aging: {
        intervalMs: this.agingIntervalMs,
        step: this.agingStep,
      },
      yieldStrategy: this.yieldStrategy,
      queueDepth: this.queued.size,
      activeJobCount: this.active.size,
      activeDecoderCount: this.currentActiveDecoderCount(),
      maxQueueDepth: this.maxQueueDepth,
      maxActiveJobCount: this.maxActiveJobCount,
      maxActiveDecoderCount: this.maxActiveDecoderCount,
      enqueuedCount: this.enqueuedCount,
      completedCount: this.completedCount,
      cancelledCount: this.cancelledCount,
      failedCount: this.failedCount,
      waitTimesMs: [...this.waitTimesMs],
      jobs: [...queuedJobs, ...activeJobs],
      lastFailures: this.lastFailures.map((failure) => ({ ...failure })),
    }
  }

  private requestPump(): void {
    if (this.disposed || this.pumpScheduled || this.queued.size === 0) return
    this.pumpScheduled = true
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      try {
        await this.yieldControl()
      } catch {
        // An injected/native yield failure must not wedge queued analysis.
      }
      while (!this.disposed && this.active.size < this.budget.maxConcurrentJobs) {
        const next = this.nextRunnableJob()
        if (!next) break
        this.start(next)
      }
    } finally {
      this.pumpScheduled = false
    }
  }

  private nextRunnableJob(): QueuedJob | null {
    const availableDecoderSlots = this.budget.maxDecoderSlots
      - this.reservedDecoderSlots()
    const now = this.now()
    let best: QueuedJob | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const job of this.queued.values()) {
      const waited = Math.max(0, now - job.queuedAt)
      const age = Math.floor(waited / this.agingIntervalMs) * this.agingStep
      const score = PRIORITY_VALUE[job.priority] + age
      if (
        score > bestScore
        || (score === bestScore && best && job.sequence < best.sequence)
      ) {
        best = job
        bestScore = score
      }
    }
    if (
      !best
      || this.active.has(best.request.id)
      || best.request.resources.decoderSlots > availableDecoderSlots
    ) return null
    return best
  }

  private start(queued: QueuedJob): void {
    this.queued.delete(queued.request.id)
    const startedAt = this.now()
    const waitTime = Math.max(0, startedAt - queued.queuedAt)
    this.waitTimesMs.push(waitTime)
    if (this.waitTimesMs.length > MAX_WAIT_SAMPLES) this.waitTimesMs.shift()
    const active: ActiveJob = {
      request: queued.request,
      priority: queued.priority,
      queuedAt: queued.queuedAt,
      startedAt,
      controller: new AbortController(),
      progress: 0,
      activeDecoderCount: 0,
      cancellationCounted: false,
    }
    this.active.set(queued.request.id, active)
    this.maxActiveJobCount = Math.max(this.maxActiveJobCount, this.active.size)
    this.publish()

    const context: MediaJobContext = {
      signal: active.controller.signal,
      reportProgress: (progress) => {
        if (this.active.get(queued.request.id) !== active) return
        active.progress = Math.max(active.progress, clampProgress(progress))
        this.publish()
      },
      setActiveDecoderCount: (count) => {
        if (this.active.get(queued.request.id) !== active) return
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new RangeError('Active decoder count must be a non-negative safe integer')
        }
        if (count > active.request.resources.decoderSlots) {
          throw new RangeError('Active decoder count exceeds reserved decoder slots')
        }
        active.activeDecoderCount = count
        this.maxActiveDecoderCount = Math.max(
          this.maxActiveDecoderCount,
          this.currentActiveDecoderCount(),
        )
        this.publish()
      },
    }

    const resourceLease = mediaResourceAdmission.reserve({
      kind: 'analysis', decoderSlots: queued.request.resources.decoderSlots,
      surfaceBytes: 0, monitorCompatible: false,
    })
    void Promise.resolve()
      .then(() => queued.request.run(context))
      .then(
        () => {
          if (!active.controller.signal.aborted) {
            active.progress = 1
            this.completedCount++
          } else if (!active.cancellationCounted) {
            active.cancellationCounted = true
            this.cancelledCount++
          }
        },
        (cause: unknown) => {
          if (active.controller.signal.aborted) {
            if (!active.cancellationCounted) {
              active.cancellationCounted = true
              this.cancelledCount++
            }
            return
          }
          this.failedCount++
          this.lastFailures.push(failureRecord(active.request, cause))
          if (this.lastFailures.length > MAX_FAILURE_RECORDS) {
            this.lastFailures.shift()
          }
        },
      )
      .finally(() => {
        resourceLease.release()
        active.activeDecoderCount = 0
        if (this.active.get(queued.request.id) === active) {
          this.active.delete(queued.request.id)
        }
        this.publish()
        this.resolveIdleIfNeeded()
        this.requestPump()
      })
  }

  private reservedDecoderSlots(): number {
    let total = 0
    for (const job of this.active.values()) {
      total += job.request.resources.decoderSlots
    }
    return total
  }

  private currentActiveDecoderCount(): number {
    let total = 0
    for (const job of this.active.values()) total += job.activeDecoderCount
    return total
  }

  private publish(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Diagnostics are passive and cannot own scheduler progress.
      }
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.queued.size > 0 || this.active.size > 0) return
    const snapshot = this.snapshot()
    for (const resolve of this.idleWaiters) resolve(snapshot)
    this.idleWaiters.clear()
  }
}
