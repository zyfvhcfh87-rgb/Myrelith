import { describe, expect, test, vi } from 'vitest'
import type { VideoScopeWorkerReply } from './video-scopes-protocol'
import {
  createVideoScopeWorkerCore,
  type VideoScopeWorkerEnv,
} from './video-scopes.worker'

type VideoScopeWebGpuModule = Awaited<ReturnType<VideoScopeWorkerEnv['loadWebGpu']>>

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('video scope analysis worker lifecycle', () => {
  test('release during the WebGPU import cannot resurrect an analyzer after acknowledgement', async () => {
    const moduleLoad = deferred<VideoScopeWebGpuModule>()
    const createOptionalVideoScopeAnalyzer = vi.fn()
    const replies: VideoScopeWorkerReply[] = []
    const core = createVideoScopeWorkerCore({
      experimentEnabled: true,
      loadWebGpu: () => moduleLoad.promise,
      post: (message) => replies.push(message),
    })

    const analysis = core.handleMessage({
      type: 'analyze',
      requestId: 1,
      rgba: new Uint8ClampedArray([10, 20, 30, 255]),
      width: 1,
      height: 1,
    })
    await core.handleMessage({ type: 'release' })

    expect(replies).toEqual([{ type: 'released' }])

    moduleLoad.resolve({
      createOptionalVideoScopeAnalyzer,
    } as unknown as VideoScopeWebGpuModule)
    await analysis

    expect(createOptionalVideoScopeAnalyzer).not.toHaveBeenCalled()
    expect(replies).toEqual([{ type: 'released' }])
  })
})
