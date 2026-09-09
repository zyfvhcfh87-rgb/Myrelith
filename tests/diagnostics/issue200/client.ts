import { diagnosticSample, type DiagnosticRequest, type DiagnosticSample } from './sample'

// Serial calls only. A fresh canvas owner is closed before each response.
export function openDiagnosticWorker() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let serial = 0
  return {
    sample(request: DiagnosticRequest): Promise<DiagnosticSample> {
      const id = ++serial
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Diagnostic worker timeout')), 30_000)
        worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)) }
        worker.onmessage = (event) => {
          if (event.data.id !== id) { clearTimeout(timer); reject(new Error('Unexpected diagnostic response')); return }
          clearTimeout(timer)
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result)
        }
        worker.postMessage({ id, request })
      })
    },
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Diagnostic worker disposal unacknowledged')), 3000)
          worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)) }
          worker.onmessage = (event) => {
            clearTimeout(timer)
            if (event.data.disposed === true) resolve(); else reject(new Error('Unexpected disposal response'))
          }
          worker.postMessage({ dispose: true })
        })
      } finally { worker.terminate() }
    },
  }
}
export { diagnosticSample }
