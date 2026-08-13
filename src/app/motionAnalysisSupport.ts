import {
  probeMotionAnalysisSupport,
  type MotionAnalysisSupportProbe,
} from './motionAnalysisResearchController'
import { probeMotionAnalysisWorker } from './motionAnalysisWorkerBridge'
import { fingerprintLocalMediaSource } from './sourceFingerprint'

export interface MotionAnalysisFoundationSupport extends MotionAnalysisSupportProbe {
  readonly dedicatedAnalysisWorker: boolean
  readonly sampledFingerprint: boolean
  readonly transferableArrayBuffers: boolean
}

function probeTransferableArrayBuffers(): boolean {
  try {
    const buffer = new ArrayBuffer(1)
    structuredClone(buffer, { transfer: [buffer] })
    return buffer.byteLength === 0
  } catch {
    return false
  }
}

/**
 * Exact browser-local foundation probe. Decoder/codec fitness remains source
 * specific and is revalidated when the dedicated worker opens that source.
 */
export async function probeMotionAnalysisFoundationSupport(
  signal?: AbortSignal,
): Promise<MotionAnalysisFoundationSupport> {
  const [base, dedicatedAnalysisWorker, sampledFingerprint] = await Promise.all([
    probeMotionAnalysisSupport(signal),
    probeMotionAnalysisWorker(signal),
    fingerprintLocalMediaSource(
      new Blob([new Uint8Array([1, 2, 3, 4])]),
      { fileName: 'support-probe.bin', size: 4, lastModified: 0 },
    ).then(() => true, () => false),
  ])
  const transferableArrayBuffers = probeTransferableArrayBuffers()
  const failures = [...base.failures]
  if (!dedicatedAnalysisWorker) failures.push('Dedicated motion-analysis worker startup failed.')
  if (!sampledFingerprint) failures.push('Sampled SHA-256 source fingerprinting failed.')
  if (!transferableArrayBuffers) failures.push('Transferable ArrayBuffer ownership is unavailable.')
  return {
    ...base,
    supported: base.supported
      && dedicatedAnalysisWorker
      && sampledFingerprint
      && transferableArrayBuffers,
    dedicatedAnalysisWorker,
    sampledFingerprint,
    transferableArrayBuffers,
    failures,
  }
}
