import type {
  InventoryWorkerRequest,
  InventoryWorkerResponse,
  WorkerProbeEvidence,
} from './compatibilityInventoryContract'

interface InventoryWorkerScope {
  postMessage(message: InventoryWorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<InventoryWorkerRequest>) => void,
  ): void
}

const scope = self as unknown as InventoryWorkerScope
const AVC_DECODER_CODEC = 'avc1.42001E'

function constructorPresent(name: string): boolean {
  const value = (globalThis as unknown as Record<string, unknown>)[name]
  return typeof value === 'function'
}

function workerEvidence(
  values: Omit<WorkerProbeEvidence, 'reason'> & { reason?: string | null },
): WorkerProbeEvidence {
  return Object.freeze({
    moduleWorker: values.moduleWorker,
    offscreenCanvas2d: values.offscreenCanvas2d,
    transferredCanvas2d: values.transferredCanvas2d,
    webgl2: values.webgl2,
    videoDecoderPresent: values.videoDecoderPresent,
    videoDecoderConfigSupported: values.videoDecoderConfigSupported,
    reason: values.reason ?? null,
  })
}

function offscreen2d(canvas: OffscreenCanvas | null): boolean {
  if (!canvas) return false
  try {
    const context = canvas.getContext('2d')
    if (!context) return false
    context.fillStyle = '#112233'
    context.fillRect(0, 0, 1, 1)
    return true
  } catch {
    return false
  }
}

function workerWebgl2(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false
  const canvas = new OffscreenCanvas(8, 8)
  try {
    const context = canvas.getContext('webgl2')
    return context !== null
  } catch {
    return false
  }
}

async function videoDecoderConfigSupported(): Promise<boolean> {
  if (typeof VideoDecoder !== 'function') return false
  try {
    const result = await VideoDecoder.isConfigSupported({
      codec: AVC_DECODER_CODEC,
      codedWidth: 64,
      codedHeight: 64,
    })
    return result.supported === true
  } catch {
    return false
  }
}

async function runProbe(request: InventoryWorkerRequest): Promise<WorkerProbeEvidence> {
  const local = typeof OffscreenCanvas === 'undefined'
    ? null
    : new OffscreenCanvas(32, 32)
  const videoDecoderPresent = constructorPresent('VideoDecoder')
  const configSupported = await videoDecoderConfigSupported()
  return workerEvidence({
    moduleWorker: true,
    offscreenCanvas2d: offscreen2d(local),
    transferredCanvas2d: offscreen2d(request.canvas),
    webgl2: workerWebgl2(),
    videoDecoderPresent,
    videoDecoderConfigSupported: configSupported,
    reason: null,
  })
}

scope.addEventListener('message', (event: MessageEvent<InventoryWorkerRequest>) => {
  const request = event.data
  if (!request || request.type !== 'run') return
  void runProbe(request).then(
    (worker) => {
      const response: InventoryWorkerResponse = { type: 'result', worker }
      scope.postMessage(response)
    },
    (cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const response: InventoryWorkerResponse = { type: 'error', detail }
      scope.postMessage(response)
    },
  )
})
