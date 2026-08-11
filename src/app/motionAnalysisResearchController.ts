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

export function motionAnalysisResearchDiagnostics(): MotionResearchRuntimeDiagnostics {
  return { ...diagnostics }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
}

async function probeWorker(): Promise<boolean> {
  if (typeof Worker !== 'function') return false
  let worker: Worker | null = null
  try {
    worker = new Worker(
      new URL('../workers/motion-analysis-research.worker.ts', import.meta.url),
      { type: 'module' },
    )
    return true
  } catch {
    return false
  } finally {
    worker?.terminate()
  }
}

function probeOffscreenCanvas(): boolean {
  if (typeof OffscreenCanvas !== 'function') return false
  try {
    return new OffscreenCanvas(2, 2).getContext('2d', { willReadFrequently: true }) !== null
  } catch {
    return false
  }
}

async function probeVideoFrame(): Promise<{
  readonly copied: boolean
  readonly closed: boolean
}> {
  if (typeof VideoFrame !== 'function') return { copied: false, closed: false }
  let frame: VideoFrame | null = null
  let copied = false
  let closed = false
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
    await frame.copyTo(output, { format: 'RGBA' })
    copied = output[0] === 255 && output[15] === 255
  } catch {
    copied = false
  } finally {
    if (frame) {
      frame.close()
      diagnostics.supportFramesClosed++
      try {
        frame.allocationSize()
      } catch {
        closed = true
      }
    }
  }
  return { copied, closed }
}

async function probeOpfs(): Promise<boolean> {
  if (typeof navigator.storage?.getDirectory !== 'function') return false
  const fileName = 'issue-44-motion-analysis-support-probe.tmp'
  let root: FileSystemDirectoryHandle | null = null
  let created = false
  try {
    root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(fileName, { create: true })
    created = true
    diagnostics.opfsProbeFilesCreated++
    const writer = await handle.createWritable()
    try {
      await writer.write(new Uint8Array([0x44, 0x0a]))
    } finally {
      await writer.close()
    }
    const file = await handle.getFile()
    return file.size === 2
  } catch {
    return false
  } finally {
    if (root && created) {
      await root.removeEntry(fileName)
      diagnostics.opfsProbeFilesRemoved++
    }
  }
}

export async function probeMotionAnalysisSupport(): Promise<MotionAnalysisSupportProbe> {
  const failures: string[] = []
  const worker = await probeWorker()
  if (!worker) failures.push('Dedicated module workers are unavailable.')
  const offscreenCanvas2d = probeOffscreenCanvas()
  if (!offscreenCanvas2d) failures.push('OffscreenCanvas 2D readback is unavailable.')
  const videoFrame = await probeVideoFrame()
  if (!videoFrame.copied) failures.push('VideoFrame RGBA copyTo is unavailable.')
  if (!videoFrame.closed) failures.push('VideoFrame close could not be observed.')
  const opfs = await probeOpfs()
  if (!opfs) failures.push('Origin-private file storage is unavailable.')
  const cryptoDigest = typeof crypto?.subtle?.digest === 'function'
  if (!cryptoDigest) failures.push('SubtleCrypto digest is unavailable.')
  return {
    supported: failures.length === 0,
    worker,
    offscreenCanvas2d,
    videoFrameRgbaCopy: videoFrame.copied,
    videoFrameClosed: videoFrame.closed,
    opfs,
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
      terminate()
      action()
    }
    const abort = () => finish(() => reject(new DOMException(
      'Motion analysis was cancelled',
      'AbortError',
    )))
    signal.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<MotionResearchWorkerReply>) => {
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
    })
    worker.addEventListener('error', (event) => finish(() => reject(
      new MediaJobExecutionError('unexpected', event.message || 'Motion worker failed'),
    )), { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    const message: MotionResearchRunMessage = {
      type: 'run',
      requestId: currentRequestId,
    }
    worker.postMessage(message)
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
    : await probeMotionAnalysisSupport()
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
