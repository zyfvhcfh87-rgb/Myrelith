/** Dedicated, disposable Issue #44 research worker. */

import { runMotionAnalysisResearch } from '../domain/motionAnalysisResearch'
import type {
  MotionResearchReadyReply,
  MotionResearchRunReply,
  MotionResearchWorkerMessage,
} from './motion-analysis-research-protocol'

function isMotionResearchWorkerMessage(
  value: unknown,
): value is MotionResearchWorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { readonly type?: unknown; readonly requestId?: unknown }
  return (candidate.type === 'probe' || candidate.type === 'run')
    && Number.isSafeInteger(candidate.requestId)
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data
  if (!isMotionResearchWorkerMessage(message)) return
  if (message.type === 'probe') {
    const reply: MotionResearchReadyReply = {
      type: 'ready',
      requestId: message.requestId,
    }
    self.postMessage(reply)
    return
  }
  try {
    const evidence = runMotionAnalysisResearch(undefined, (progress) => {
      const reply: MotionResearchRunReply = {
        type: 'progress',
        requestId: message.requestId,
        progress,
      }
      self.postMessage(reply)
    })
    if (
      evidence.decision.stabilization !== 'go'
      || evidence.decision.pointTracking !== 'go'
      || evidence.decision.boxTracking !== 'go'
    ) {
      const reply: MotionResearchRunReply = {
        type: 'error',
        requestId: message.requestId,
        code: 'quality-fixture-failed',
        message: 'One or more deterministic motion quality gates failed.',
      }
      self.postMessage(reply)
      return
    }
    const reply: MotionResearchRunReply = {
      type: 'result',
      requestId: message.requestId,
      evidence,
    }
    self.postMessage(reply)
  } catch (error) {
    const reply: MotionResearchRunReply = {
      type: 'error',
      requestId: message.requestId,
      code: 'unexpected',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
    self.postMessage(reply)
  }
})
