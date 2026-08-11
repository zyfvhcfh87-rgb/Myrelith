/** Dedicated, disposable Issue #44 research worker. */

import { runMotionAnalysisResearch } from '../domain/motionAnalysisResearch'
import type {
  MotionResearchRunMessage,
  MotionResearchWorkerReply,
} from './motion-analysis-research-protocol'

self.addEventListener('message', (event: MessageEvent<MotionResearchRunMessage>) => {
  const message = event.data
  if (message.type !== 'run') return
  try {
    const evidence = runMotionAnalysisResearch(undefined, (progress) => {
      const reply: MotionResearchWorkerReply = {
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
      const reply: MotionResearchWorkerReply = {
        type: 'error',
        requestId: message.requestId,
        code: 'quality-fixture-failed',
        message: 'One or more deterministic motion quality gates failed.',
      }
      self.postMessage(reply)
      return
    }
    const reply: MotionResearchWorkerReply = {
      type: 'result',
      requestId: message.requestId,
      evidence,
    }
    self.postMessage(reply)
  } catch (error) {
    const reply: MotionResearchWorkerReply = {
      type: 'error',
      requestId: message.requestId,
      code: 'unexpected',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
    self.postMessage(reply)
  }
})
