/** Dedicated bounded scope analysis; never competes with preview rendering. */

import { analyzeVideoScopes } from '../domain/videoScopes'
import type {
  VideoScopeWorkerMessage,
  VideoScopeWorkerReply,
} from './video-scopes-protocol'

const WEBGPU_EXPERIMENT_ENABLED =
  import.meta.env.VITE_MYRELITH_WEBGPU_SCOPES_EXPERIMENT === '1'

let lifecycle = 0
let optionalAnalyzer: import('./video-scopes-webgpu').OptionalVideoScopeAnalyzer | null = null

self.addEventListener('message', (event: MessageEvent<VideoScopeWorkerMessage>) => {
  const message = event.data
  if (message.type === 'release') {
    lifecycle++
    optionalAnalyzer?.release()
    optionalAnalyzer = null
    const reply: VideoScopeWorkerReply = { type: 'released' }
    self.postMessage(reply)
    return
  }

  const requestLifecycle = lifecycle
  const run = async (): Promise<void> => {
    try {
      let analysis
      if (WEBGPU_EXPERIMENT_ENABLED) {
        const webGpu = await import('./video-scopes-webgpu')
        optionalAnalyzer ??= webGpu.createOptionalVideoScopeAnalyzer({ preferWebGpu: true })
        analysis = (await optionalAnalyzer.analyze(
          message.rgba,
          message.width,
          message.height,
        )).analysis
      } else {
        analysis = analyzeVideoScopes(message.rgba, message.width, message.height)
      }
      if (lifecycle !== requestLifecycle) return
      const reply: VideoScopeWorkerReply = {
        type: 'analysis',
        requestId: message.requestId,
        analysis,
      }
      self.postMessage(reply)
    } catch (error) {
      if (lifecycle !== requestLifecycle) return
      const reply: VideoScopeWorkerReply = {
        type: 'error',
        requestId: message.requestId,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }
      self.postMessage(reply)
    }
  }
  void run()
})
