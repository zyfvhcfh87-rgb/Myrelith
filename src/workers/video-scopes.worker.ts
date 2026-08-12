/** Dedicated bounded scope analysis; never competes with preview rendering. */

import { analyzeVideoScopes } from '../domain/videoScopes'
import type {
  VideoScopeWorkerMessage,
  VideoScopeWorkerReply,
} from './video-scopes-protocol'
import type { OptionalVideoScopeAnalyzer } from './video-scopes-webgpu'

const WEBGPU_EXPERIMENT_ENABLED =
  import.meta.env.VITE_MYRELITH_WEBGPU_SCOPES_EXPERIMENT === '1'

type VideoScopeWebGpuModule = Pick<
  typeof import('./video-scopes-webgpu'),
  'createOptionalVideoScopeAnalyzer'
>

export interface VideoScopeWorkerEnv {
  readonly experimentEnabled: boolean
  loadWebGpu(): Promise<VideoScopeWebGpuModule>
  post(message: VideoScopeWorkerReply): void
}

export function createVideoScopeWorkerCore(env: VideoScopeWorkerEnv): {
  handleMessage(message: VideoScopeWorkerMessage): Promise<void>
} {
  let lifecycle = 0
  let optionalAnalyzer: OptionalVideoScopeAnalyzer | null = null

  const handleMessage = async (message: VideoScopeWorkerMessage): Promise<void> => {
    if (message.type === 'release') {
      lifecycle++
      optionalAnalyzer?.release()
      optionalAnalyzer = null
      env.post({ type: 'released' })
      return
    }

    const requestLifecycle = lifecycle
    try {
      let analysis
      if (env.experimentEnabled) {
        const webGpu = await env.loadWebGpu()
        if (lifecycle !== requestLifecycle) return
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
      env.post({
        type: 'analysis',
        requestId: message.requestId,
        analysis,
      })
    } catch (error) {
      if (lifecycle !== requestLifecycle) return
      env.post({
        type: 'error',
        requestId: message.requestId,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
    }
  }

  return { handleMessage }
}

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const core = createVideoScopeWorkerCore({
    experimentEnabled: WEBGPU_EXPERIMENT_ENABLED,
    loadWebGpu: WEBGPU_EXPERIMENT_ENABLED
      ? () => import('./video-scopes-webgpu')
      : () => Promise.reject(new Error('WebGPU scope experiment is disabled')),
    post: (message) => self.postMessage(message),
  })
  self.addEventListener('message', (event: MessageEvent<VideoScopeWorkerMessage>) => {
    void core.handleMessage(event.data)
  })
}
