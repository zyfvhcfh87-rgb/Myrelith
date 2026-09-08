import { diagnosticSample, type DiagnosticRequest } from './sample'

// Disposal follows all previously received work; its acknowledgement cannot
// race an in-flight compositor, including after a caller timeout.
let chain = Promise.resolve()
self.onmessage = (event: MessageEvent<{ id: number; request: DiagnosticRequest } | { dispose: true }>) => {
  const message = event.data
  chain = chain.then(async () => {
    if ('dispose' in message) { self.postMessage({ disposed: true }); return }
    const { id, request } = message
    try {
      const result = await diagnosticSample(request)
      self.postMessage({ id, result }, { transfer: [result.pixels.rgba.buffer] })
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.stack ?? error.message : String(error) }) }
  })
}
