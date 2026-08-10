/** Dedicated bounded scope analysis; never competes with preview rendering. */

import { analyzeVideoScopes } from '../domain/videoScopes'
import type {
  VideoScopeAnalyzeMessage,
  VideoScopeWorkerReply,
} from './video-scopes-protocol'

self.addEventListener('message', (event: MessageEvent<VideoScopeAnalyzeMessage>) => {
  const message = event.data
  try {
    const analysis = analyzeVideoScopes(message.rgba, message.width, message.height)
    const reply: VideoScopeWorkerReply = {
      type: 'analysis',
      requestId: message.requestId,
      analysis,
    }
    self.postMessage(reply)
  } catch (error) {
    const reply: VideoScopeWorkerReply = {
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
    self.postMessage(reply)
  }
})
