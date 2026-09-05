import { createMulticamMonitorRuntime, openMonitorDemux } from '../pipeline/multicamMonitorDecode'
import type { MulticamMonitorRequest } from '../pipeline/multicamMonitorProtocol'

const runtime = createMulticamMonitorRuntime({
  open: openMonitorDemux,
  createDecoder: (init) => new VideoDecoder(init),
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  post: (message, transfer = []) => globalThis.postMessage(message, { transfer }),
})
globalThis.onmessage = (event: MessageEvent<MulticamMonitorRequest>) => runtime.receive(event.data)
