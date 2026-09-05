/** Owns one finite-decoder worker. Frames are borrowed only during onFrame. */
import { MULTICAM_MONITOR_LIMITS as LIMITS } from '../domain/multicamMonitor'
import { multicamMonitorLedgerIsZero, type MulticamMonitorLedger, type MulticamMonitorReply, type MulticamMonitorRequest, type MulticamMonitorSource } from '../pipeline/multicamMonitorProtocol'

export interface MulticamMonitorWorkerLike {
  postMessage(message: MulticamMonitorRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<MulticamMonitorReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}
export interface MulticamMonitorCleanup {
  readonly forced: boolean
  readonly reason: string
  readonly ledger: MulticamMonitorLedger | null
  readonly workers: number
  readonly pending: number
  readonly unclosedReceivedBitmaps: number
}
export interface MulticamMonitorBridgeOptions {
  readonly sources: readonly MulticamMonitorSource[]
  readonly width: number
  readonly height: number
  onFrame(id: string, requestId: number, timestampUs: number, bitmap: ImageBitmap, latencyMs: number): void
  onFailure(reason: string): void
  readonly now?: () => number
  readonly createWorker?: () => MulticamMonitorWorkerLike
}

export function createMulticamMonitorWorkerBridge(options: MulticamMonitorBridgeOptions) {
  const worker: MulticamMonitorWorkerLike = options.createWorker?.() ?? new Worker(new URL('../workers/multicam-monitor.worker.ts', import.meta.url), { type: 'module' })
  const now = options.now ?? (() => performance.now())
  const pending = new Map<string, { requestId: number; at: number; timer: ReturnType<typeof setTimeout> }>()
  const ids = new Set(options.sources.map((source) => source.id))
  let state: 'opening' | 'ready' | 'closing' | 'closed' = 'opening'
  let ledger: MulticamMonitorLedger | null = null
  let received = 0, closedBitmaps = 0
  const borrowedBitmaps = new Set<ImageBitmap>()
  let cleanup: MulticamMonitorCleanup | null = null
  let openTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void, rejectReady!: (cause: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let closePromise: Promise<MulticamMonitorCleanup> | null = null
  let resolveClose: ((value: MulticamMonitorCleanup) => void) | null = null

  function clearPending() { for (const item of pending.values()) clearTimeout(item.timer); pending.clear() }
  function closeBitmap(bitmap: ImageBitmap) {
    if (!borrowedBitmaps.delete(bitmap)) return
    try { bitmap.close() } finally { closedBitmaps++ }
  }
  function terminate(reason: string, forced = true): MulticamMonitorCleanup {
    if (cleanup) return { ...cleanup, unclosedReceivedBitmaps: received - closedBitmaps }
    state = 'closed'
    clearTimeout(openTimer); clearTimeout(closeTimer); clearPending()
    for (const bitmap of borrowedBitmaps) closeBitmap(bitmap)
    // Retain the message handler: a transferred bitmap already queued on the
    // main event loop must still be explicitly closed after worker termination.
    try { worker.terminate() } finally {
      worker.onerror = worker.onmessageerror = null
      rejectReady(new DOMException(reason, 'AbortError'))
    }
    cleanup = { forced, reason, ledger, workers: 0, pending: 0, unclosedReceivedBitmaps: received - closedBitmaps }
    resolveClose?.(cleanup)
    return cleanup
  }
  function fail(reason: string) {
    if (state === 'closed') return
    terminate(reason)
    options.onFailure(reason)
  }
  worker.onerror = () => fail('The live-preview worker failed. Paused previews remain available.')
  worker.onmessageerror = () => fail('A live-preview reply could not be read.')
  worker.onmessage = ({ data }) => {
    if (data.type === 'frame') {
      received++
      borrowedBitmaps.add(data.bitmap)
      let failure: string | null = null
      try {
        if (state === 'closed' || state === 'closing') return
        const waiting = pending.get(data.id)
        if (state !== 'ready' || !waiting || waiting.requestId !== data.requestId) {
          failure = 'A live-preview response did not match its request.'
          return
        }
        clearTimeout(waiting.timer); pending.delete(data.id)
        ledger = data.ledger
        options.onFrame(data.id, data.requestId, data.timestampUs, data.bitmap, now() - waiting.at)
      } catch (cause) { failure = cause instanceof Error ? cause.message : 'Live-preview presentation failed.' }
      finally {
        closeBitmap(data.bitmap)
        if (failure) fail(failure)
      }
      return
    }
    if (state === 'closed') return
    ledger = data.ledger
    if (data.type === 'failure') { fail(data.detail); return }
    if (data.type === 'ready' && state === 'opening') {
      clearTimeout(openTimer); state = 'ready'; resolveReady(); return
    }
    if (data.type === 'closed' && state === 'closing' && ledger && multicamMonitorLedgerIsZero(ledger)) {
      terminate('drained', false); return
    }
    fail('The live-preview worker returned an invalid ownership acknowledgement.')
  }
  openTimer = setTimeout(() => fail('Live-preview setup exceeded its time limit. Use editing proxies or paused previews.'), LIMITS.openDeadlineMs)
  try { worker.postMessage({ type: 'open', sources: options.sources, width: options.width, height: options.height }) }
  catch (cause) { fail(cause instanceof Error ? cause.message : 'Could not start live previews.') }

  return {
    ready,
    request(id: string, requestId: number, sourceTimeUs: number): boolean {
      if (state !== 'ready' || !ids.has(id) || pending.has(id)) return false
      const timer = setTimeout(() => fail('An angle could not keep up with its decode deadline. Use editing proxies or paused previews.'), LIMITS.requestDeadlineMs)
      pending.set(id, { requestId, timer, at: now() })
      try { worker.postMessage({ type: 'frame', id, requestId, sourceTimeUs }) }
      catch (cause) { fail(cause instanceof Error ? cause.message : 'Could not request a live preview.'); return false }
      return true
    },
    terminate,
    close(): Promise<MulticamMonitorCleanup> {
      if (cleanup) return Promise.resolve({ ...cleanup, unclosedReceivedBitmaps: received - closedBitmaps })
      if (closePromise) return closePromise
      state = 'closing'; clearTimeout(openTimer); clearPending()
      rejectReady(new DOMException('Live previews are closing', 'AbortError'))
      closePromise = new Promise((resolve) => { resolveClose = resolve })
      closeTimer = setTimeout(() => terminate('close-deadline'), LIMITS.closeDeadlineMs)
      try { worker.postMessage({ type: 'close' }) } catch { terminate('close-send-failed') }
      return closePromise
    },
    snapshot: () => ({ state, ledger, workers: state === 'closed' ? 0 : 1, pending: pending.size, received, closedBitmaps }),
  }
}
export type MulticamMonitorWorkerBridge = ReturnType<typeof createMulticamMonitorWorkerBridge>
