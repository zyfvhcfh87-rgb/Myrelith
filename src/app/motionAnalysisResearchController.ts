/** App-owned scheduler/worker/support-probe facade for Issue #44 research. */

import {
  MediaJobExecutionError,
  MediaJobScheduler,
  type MediaJobSchedulerSnapshot,
} from './mediaJobScheduler'
import type {
  MotionAnalysisResearchEvidence,
  MotionResearchProgress,
} from '../domain/motionAnalysisResearch'
import type {
  MotionResearchProbeMessage,
  MotionResearchRunReply,
  MotionResearchRunMessage,
  MotionResearchWorkerReply,
} from '../workers/motion-analysis-research-protocol'

export interface MotionAnalysisSupportProbe {
  readonly supported: boolean
  readonly worker: boolean
  readonly offscreenCanvas2d: boolean
  readonly videoFrameRgbaCopy: boolean
  readonly videoFrameClosed: boolean
  readonly opfs: boolean
  readonly cryptoDigest: boolean
  readonly cooperativeYield: 'scheduler.yield' | 'set-timeout'
  readonly failures: readonly string[]
}

export interface MotionResearchRuntimeDiagnostics {
  readonly workersCreated: number
  readonly workersTerminated: number
  readonly activeWorkers: number
  readonly supportFramesCreated: number
  readonly supportFramesClosed: number
  readonly opfsProbeFilesCreated: number
  readonly opfsProbeFilesRemoved: number
}

export interface BrowserMotionResearchResult {
  readonly support: MotionAnalysisSupportProbe
  readonly evidence: MotionAnalysisResearchEvidence
  readonly durationMs: number
  readonly scheduler: MediaJobSchedulerSnapshot
  readonly diagnostics: MotionResearchRuntimeDiagnostics
}

export interface BrowserMotionResearchOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: MotionResearchProgress) => void
  readonly skipSupportProbe?: boolean
}

const diagnostics = {
  workersCreated: 0,
  workersTerminated: 0,
  activeWorkers: 0,
  supportFramesCreated: 0,
  supportFramesClosed: 0,
  opfsProbeFilesCreated: 0,
  opfsProbeFilesRemoved: 0,
}

let requestId = 0
let researchRunActive = false

const SUPPORT_PROBE_STEP_TIMEOUT_MS = 5_000

export function motionAnalysisResearchDiagnostics(): MotionResearchRuntimeDiagnostics {
  return { ...diagnostics }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
}

function motionAnalysisAbortError(): DOMException {
  return new DOMException('Motion analysis was cancelled', 'AbortError')
}

async function probeWorker(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw motionAnalysisAbortError()
  if (typeof Worker !== 'function') return false
  let worker: Worker
  try {
    worker = new Worker(
      new URL('../workers/motion-analysis-research.worker.ts', import.meta.url),
      { type: 'module' },
    )
  } catch {
    return false
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      action()
    }
    const finish = (supported: boolean) => settle(() => resolve(supported))
    const abort = () => settle(() => reject(motionAnalysisAbortError()))
    const currentRequestId = ++requestId
    const onMessage = (event: MessageEvent<MotionResearchWorkerReply>) => {
      if (event.data.type === 'ready' && event.data.requestId === currentRequestId) {
        finish(true)
      }
    }
    const onError = (event: ErrorEvent) => {
      event.preventDefault()
      finish(false)
    }
    const onMessageError = () => finish(false)
    const onAbort = () => abort()
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    timeout = setTimeout(() => finish(false), SUPPORT_PROBE_STEP_TIMEOUT_MS)
    const message: MotionResearchProbeMessage = {
      type: 'probe',
      requestId: currentRequestId,
    }
    try {
      worker.postMessage(message)
    } catch {
      finish(false)
    }
  })
}

function probeOffscreenCanvas(): boolean {
  if (typeof OffscreenCanvas !== 'function') return false
  try {
    return new OffscreenCanvas(2, 2).getContext('2d', { willReadFrequently: true }) !== null
  } catch {
    return false
  }
}

function raceVideoFrameCopy(
  operation: Promise<unknown>,
  signal: AbortSignal | undefined,
  closeFrame: () => void,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = () => {
      closeFrame()
      settle(() => reject(motionAnalysisAbortError()))
    }
    const onTimeout = () => {
      closeFrame()
      settle(() => resolve(false))
    }
    operation.then(
      () => settle(() => resolve(true)),
      (cause) => settle(() => reject(cause)),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    timeout = setTimeout(onTimeout, SUPPORT_PROBE_STEP_TIMEOUT_MS)
  })
}

async function probeVideoFrame(signal?: AbortSignal): Promise<{
  readonly copied: boolean
  readonly closed: boolean
}> {
  if (signal?.aborted) throw motionAnalysisAbortError()
  if (typeof VideoFrame !== 'function') return { copied: false, closed: false }
  let frame: VideoFrame | null = null
  let copied = false
  let closed = false
  let closeAttempted = false
  const closeFrame = () => {
    if (!frame || closeAttempted) return
    closeAttempted = true
    try {
      frame.close()
      diagnostics.supportFramesClosed++
      try {
        frame.allocationSize()
      } catch {
        closed = true
      }
    } catch {
      closed = false
    }
  }
  try {
    frame = new VideoFrame(new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]), {
      format: 'RGBA',
      codedWidth: 2,
      codedHeight: 2,
      timestamp: 0,
    })
    diagnostics.supportFramesCreated++
    const output = new Uint8Array(frame.allocationSize({ format: 'RGBA' }))
    const copyOperation = frame.copyTo(output, { format: 'RGBA' })
    const completed = await raceVideoFrameCopy(copyOperation, signal, closeFrame)
    copied = completed && output[0] === 255 && output[15] === 255
  } catch {
    if (signal?.aborted) throw motionAnalysisAbortError()
    copied = false
  } finally {
    closeFrame()
  }
  return { copied, closed }
}

interface OpfsProbeResult {
  readonly supported: boolean
  readonly failure: string | null
  readonly deadlineExpired: boolean
}

interface OpfsProbeLifecycle {
  abandonment: 'abort' | 'deadline' | null
}

const OPFS_UNAVAILABLE_FAILURE = 'Origin-private file storage is unavailable.'
const OPFS_CLEANUP_FAILURE = 'Origin-private file storage probe cleanup failed.'
const OPFS_DEADLINE_FAILURE = 'Origin-private file storage support probe timed out.'
const OPFS_PROBE_FILE_PREFIX = 'issue-44-motion-analysis-support-probe-'
const OPFS_PROBE_ABANDONED = Symbol('OPFS_PROBE_ABANDONED')

function createOpfsProbeFileName(): string {
  const nonce = new Uint32Array(4)
  crypto.getRandomValues(nonce)
  const suffix = Array.from(
    nonce,
    (value) => value.toString(16).padStart(8, '0'),
  ).join('')
  return `${OPFS_PROBE_FILE_PREFIX}${suffix}.tmp`
}

function throwIfMotionAnalysisAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw motionAnalysisAbortError()
}

function throwIfOpfsProbeAbandoned(
  lifecycle: OpfsProbeLifecycle,
  signal?: AbortSignal,
): void {
  if (signal?.aborted && lifecycle.abandonment === null) {
    lifecycle.abandonment = 'abort'
  }
  if (lifecycle.abandonment !== null) throw OPFS_PROBE_ABANDONED
}

function raceOpfsProbe(
  operation: Promise<OpfsProbeResult>,
  signal: AbortSignal | undefined,
  lifecycle: OpfsProbeLifecycle,
): Promise<OpfsProbeResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = () => {
      if (settled) return
      lifecycle.abandonment = 'abort'
      settle(() => reject(motionAnalysisAbortError()))
    }
    const onTimeout = () => {
      if (settled) return
      if (signal?.aborted) {
        onAbort()
        return
      }
      lifecycle.abandonment = 'deadline'
      settle(() => resolve({
        supported: false,
        failure: OPFS_DEADLINE_FAILURE,
        deadlineExpired: true,
      }))
    }
    operation.then(
      (result) => settle(() => resolve(result)),
      (cause) => settle(() => reject(cause)),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    timeout = setTimeout(onTimeout, SUPPORT_PROBE_STEP_TIMEOUT_MS)
  })
}

async function runOwnedOpfsProbe(
  getDirectory: () => Promise<FileSystemDirectoryHandle>,
  signal: AbortSignal | undefined,
  lifecycle: OpfsProbeLifecycle,
): Promise<OpfsProbeResult> {
  let fileName: string | null = null
  let root: FileSystemDirectoryHandle | null = null
  let created = false
  let removed = false
  let supported = false
  let cleanupFailed = false
  try {
    fileName = createOpfsProbeFileName()
    root = await getDirectory()
    throwIfOpfsProbeAbandoned(lifecycle, signal)
    const handle = await root.getFileHandle(fileName, { create: true })
    created = true
    throwIfOpfsProbeAbandoned(lifecycle, signal)
    const writer = await handle.createWritable()
    try {
      throwIfOpfsProbeAbandoned(lifecycle, signal)
      await writer.write(new Uint8Array([0x44, 0x0a]))
      throwIfOpfsProbeAbandoned(lifecycle, signal)
    } finally {
      await writer.close()
    }
    throwIfOpfsProbeAbandoned(lifecycle, signal)
    const file = await handle.getFile()
    throwIfOpfsProbeAbandoned(lifecycle, signal)
    supported = file.size === 2
  } catch {
    supported = false
  } finally {
    if (root && created && fileName) {
      try {
        await root.removeEntry(fileName)
        removed = true
      } catch {
        cleanupFailed = true
      }
    }
  }
  const abandoned = lifecycle.abandonment !== null || signal?.aborted === true
  if (!abandoned) {
    if (created) diagnostics.opfsProbeFilesCreated++
    if (removed) diagnostics.opfsProbeFilesRemoved++
  }
  if (lifecycle.abandonment === 'deadline') {
    return {
      supported: false,
      failure: OPFS_DEADLINE_FAILURE,
      deadlineExpired: true,
    }
  }
  if (abandoned) {
    return {
      supported: false,
      failure: OPFS_UNAVAILABLE_FAILURE,
      deadlineExpired: false,
    }
  }
  if (cleanupFailed) {
    return {
      supported: false,
      failure: OPFS_CLEANUP_FAILURE,
      deadlineExpired: false,
    }
  }
  return {
    supported,
    failure: supported ? null : OPFS_UNAVAILABLE_FAILURE,
    deadlineExpired: false,
  }
}

async function probeOpfs(signal?: AbortSignal): Promise<OpfsProbeResult> {
  throwIfMotionAnalysisAborted(signal)
  const storage = navigator.storage
  if (typeof storage?.getDirectory !== 'function') {
    return {
      supported: false,
      failure: OPFS_UNAVAILABLE_FAILURE,
      deadlineExpired: false,
    }
  }
  const lifecycle: OpfsProbeLifecycle = { abandonment: null }
  const operation = runOwnedOpfsProbe(
    () => storage.getDirectory(),
    signal,
    lifecycle,
  )
  return raceOpfsProbe(operation, signal, lifecycle)
}

export async function probeMotionAnalysisSupport(
  signal?: AbortSignal,
): Promise<MotionAnalysisSupportProbe> {
  const failures: string[] = []
  const worker = await probeWorker(signal)
  if (signal?.aborted) throw motionAnalysisAbortError()
  if (!worker) failures.push('Dedicated module workers are unavailable.')
  const offscreenCanvas2d = probeOffscreenCanvas()
  if (!offscreenCanvas2d) failures.push('OffscreenCanvas 2D readback is unavailable.')
  const videoFrame = await probeVideoFrame(signal)
  if (signal?.aborted) throw motionAnalysisAbortError()
  if (!videoFrame.copied) failures.push('VideoFrame RGBA copyTo is unavailable.')
  if (!videoFrame.closed) failures.push('VideoFrame close could not be observed.')
  const opfs = await probeOpfs(signal)
  if (signal?.aborted && !opfs.deadlineExpired) throw motionAnalysisAbortError()
  if (opfs.failure) failures.push(opfs.failure)
  const cryptoDigest = typeof crypto?.subtle?.digest === 'function'
  if (!cryptoDigest) failures.push('SubtleCrypto digest is unavailable.')
  return {
    supported: failures.length === 0,
    worker,
    offscreenCanvas2d,
    videoFrameRgbaCopy: videoFrame.copied,
    videoFrameClosed: videoFrame.closed,
    opfs: opfs.supported,
    cryptoDigest,
    cooperativeYield: typeof (globalThis as {
      scheduler?: { yield?: unknown }
    }).scheduler?.yield === 'function' ? 'scheduler.yield' : 'set-timeout',
    failures,
  }
}

function runResearchWorker(
  signal: AbortSignal,
  onProgress?: (progress: MotionResearchProgress) => void,
): Promise<MotionAnalysisResearchEvidence> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/motion-analysis-research.worker.ts', import.meta.url),
      { type: 'module' },
    )
    diagnostics.workersCreated++
    diagnostics.activeWorkers++
    let settled = false
    const currentRequestId = ++requestId
    const terminate = () => {
      worker.terminate()
      diagnostics.workersTerminated++
      diagnostics.activeWorkers--
    }
    const finish = (
      action: () => void,
    ) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      terminate()
      action()
    }
    function abort(): void {
      finish(() => reject(new DOMException(
        'Motion analysis was cancelled',
        'AbortError',
      )))
    }
    function onMessage(event: MessageEvent<MotionResearchRunReply>): void {
      const reply = event.data
      if (reply.requestId !== currentRequestId || settled) return
      if (reply.type === 'progress') {
        onProgress?.(reply.progress)
        return
      }
      if (reply.type === 'result') {
        finish(() => resolve(reply.evidence))
        return
      }
      finish(() => reject(new MediaJobExecutionError(
        reply.code === 'quality-fixture-failed' ? 'resource-limit' : 'unexpected',
        reply.message,
      )))
    }
    function onError(event: ErrorEvent): void {
      finish(() => reject(new MediaJobExecutionError(
        'unexpected',
        event.message || 'Motion worker failed',
      )))
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    const message: MotionResearchRunMessage = {
      type: 'run',
      requestId: currentRequestId,
    }
    try {
      worker.postMessage(message)
    } catch (cause) {
      finish(() => reject(cause))
    }
  })
}

async function runAdmittedBrowserMotionAnalysisResearch(
  options: BrowserMotionResearchOptions = {},
): Promise<BrowserMotionResearchResult> {
  const support = options.skipSupportProbe
    ? {
        supported: true,
        worker: true,
        offscreenCanvas2d: true,
        videoFrameRgbaCopy: true,
        videoFrameClosed: true,
        opfs: true,
        cryptoDigest: true,
        cooperativeYield: 'set-timeout',
        failures: [],
      } satisfies MotionAnalysisSupportProbe
    : await probeMotionAnalysisSupport(options.signal)
  if (!support.supported) {
    throw new MediaJobExecutionError(
      'resource-unavailable',
      `Motion-analysis support probe failed: ${support.failures.join(' ')}`,
    )
  }
  const scheduler = new MediaJobScheduler({
    budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
  })
  const startedAt = performance.now()
  let resolveEvidence!: (evidence: MotionAnalysisResearchEvidence) => void
  let rejectEvidence!: (cause: unknown) => void
  let evidenceSettled = false
  const evidencePromise = new Promise<MotionAnalysisResearchEvidence>((resolve, reject) => {
    resolveEvidence = resolve
    rejectEvidence = reject
  })
  const settleEvidence = (
    action: () => void,
  ) => {
    if (evidenceSettled) return
    evidenceSettled = true
    action()
  }
  const abortScheduler = () => {
    scheduler.cancel('issue-44-research', 'aborted')
    settleEvidence(() => rejectEvidence(new DOMException(
      'Motion analysis was cancelled',
      'AbortError',
    )))
  }
  options.signal?.addEventListener('abort', abortScheduler, { once: true })
  if (options.signal?.aborted) abortScheduler()
  if (!evidenceSettled) scheduler.enqueue({
    id: 'issue-44-research',
    generation: 1,
    priority: 'selected',
    resources: { decoderSlots: 1 },
    run: async (context) => {
      try {
        const evidence = await runResearchWorker(
          context.signal,
          (progress) => {
            context.reportProgress(progress.progress)
            options.onProgress?.(progress)
          },
        )
        settleEvidence(() => resolveEvidence(evidence))
      } catch (cause) {
        settleEvidence(() => rejectEvidence(cause))
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
        throw cause instanceof MediaJobExecutionError
          ? cause
          : new MediaJobExecutionError('unexpected', errorMessage(cause), cause)
      }
    },
  })
  try {
    const evidence = await evidencePromise
    const schedulerSnapshot = await scheduler.whenIdle()
    return {
      support,
      evidence,
      durationMs: performance.now() - startedAt,
      scheduler: schedulerSnapshot,
      diagnostics: motionAnalysisResearchDiagnostics(),
    }
  } finally {
    options.signal?.removeEventListener('abort', abortScheduler)
    scheduler.dispose()
    await scheduler.whenIdle()
  }
}

export async function runBrowserMotionAnalysisResearch(
  options: BrowserMotionResearchOptions = {},
): Promise<BrowserMotionResearchResult> {
  if (researchRunActive) {
    throw new MediaJobExecutionError(
      'resource-unavailable',
      'A motion-analysis research run is already active.',
    )
  }
  researchRunActive = true
  try {
    return await runAdmittedBrowserMotionAnalysisResearch(options)
  } finally {
    researchRunActive = false
  }
}
