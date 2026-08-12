import { describe, expect, test, vi } from 'vitest'
import {
  analyzeVideoScopes,
  VIDEO_SCOPE_SAMPLE_HEIGHT,
  VIDEO_SCOPE_SAMPLE_WIDTH,
  type VideoScopeAnalysis,
} from '../domain/videoScopes'
import {
  createOptionalVideoScopeAnalyzer,
  expandVideoScopeWebGpuInput,
  VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES,
  type VideoScopeWebGpuSession,
} from './video-scopes-webgpu'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixture(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(
    VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT * 4,
  )
  rgba.set([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0])
  return rgba
}

function fakeSession(options: {
  analyze?: (rgba: Uint8ClampedArray, width: number, height: number) => Promise<VideoScopeAnalysis>
} = {}): {
  session: VideoScopeWebGpuSession
  release: ReturnType<typeof vi.fn>
  lose: (detail: string) => void
} {
  const lost = deferred<string>()
  const release = vi.fn()
  return {
    session: {
      lost: lost.promise,
      analyze: options.analyze ?? (async (rgba, width, height) =>
        analyzeVideoScopes(rgba, width, height)),
      snapshot: () => ({
        adapterInfo: {
          vendor: 'test-vendor',
          architecture: 'test-architecture',
          device: 'test-device',
          description: 'test-adapter',
        },
        activeBufferBytes: 0,
        peakBufferBytes: VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES,
        released: release.mock.calls.length > 0,
      }),
      loseForExperiment: () => lost.promise,
      release,
    },
    release,
    lose: lost.resolve,
  }
}

describe('optional WebGPU video scope adapter', () => {
  test('marks only legacy midpoint-down bins in the expanded upload', () => {
    const expanded = expandVideoScopeWebGpuInput(new Uint8ClampedArray([
      13, 163, 113, 241,
      0, 13, 142, 150,
      0, 35, 190, 102,
      13, 163, 113, 255,
      0, 0, 255, 170,
      255, 0, 0, 170,
      47, 143, 211, 255,
      2, 2, 172, 255,
      172, 2, 2, 255,
    ]))

    expect([
      expanded[3],
      expanded[7],
      expanded[11],
      expanded[15],
      expanded[19],
      expanded[23],
      expanded[27],
      expanded[31],
      expanded[35],
    ]).toEqual([
      241 | 0x100,
      150,
      102,
      0x3ff,
      0x4aa,
      0x8aa,
      255,
      255,
      255,
    ])
  })

  test('keeps CPU as the default without probing WebGPU', async () => {
    const requestSession = vi.fn()
    const analyzer = createOptionalVideoScopeAnalyzer({ requestSession })

    const result = await analyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )

    expect(result.backend).toBe('cpu')
    expect(result.fallbackReason).toBe('not-requested')
    expect(requestSession).not.toHaveBeenCalled()
  })

  test('runs a parity self-test before using and explicitly releasing WebGPU', async () => {
    const gpu = fakeSession()
    const analyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession: async () => ({ status: 'ready', session: gpu.session }),
    })

    const result = await analyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )

    expect(result.backend).toBe('webgpu')
    expect(result.fallbackReason).toBeNull()
    expect(analyzer.snapshot()).toMatchObject({
      state: 'ready',
      fallbackReason: null,
      adapterInfo: { vendor: 'test-vendor' },
      activeBufferBytes: 0,
      peakBufferBytes: VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES,
    })
    analyzer.release()
    analyzer.release()
    expect(gpu.release).toHaveBeenCalledOnce()
    expect(analyzer.snapshot().state).toBe('released')
  })

  test('falls back for unsupported and failed initialization', async () => {
    for (const request of [
      {
        status: 'unavailable' as const,
        reason: 'api-unavailable' as const,
        detail: 'navigator.gpu is unavailable',
      },
      {
        status: 'unavailable' as const,
        reason: 'initialization-failed' as const,
        detail: 'pipeline compilation failed',
      },
    ]) {
      const analyzer = createOptionalVideoScopeAnalyzer({
        preferWebGpu: true,
        requestSession: async () => request,
      })
      const result = await analyzer.analyze(
        fixture(),
        VIDEO_SCOPE_SAMPLE_WIDTH,
        VIDEO_SCOPE_SAMPLE_HEIGHT,
      )
      expect(result.backend).toBe('cpu')
      expect(result.fallbackReason).toBe(request.reason)
      expect(analyzer.snapshot()).toMatchObject({
        state: 'fallback',
        fallbackDetail: request.detail,
      })
    }
  })

  test('rejects a mismatched shader oracle and keeps CPU output', async () => {
    const gpu = fakeSession({
      analyze: async (rgba, width, height) => {
        const analysis = analyzeVideoScopes(rgba, width, height)
        analysis.histogram.red[0]++
        return analysis
      },
    })
    const analyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession: async () => ({ status: 'ready', session: gpu.session }),
    })

    const result = await analyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )

    expect(result.backend).toBe('cpu')
    expect(result.fallbackReason).toBe('self-test-mismatch')
    expect(gpu.release).toHaveBeenCalledOnce()
  })

  test('falls back after execution failure and device loss without retaining the session', async () => {
    let calls = 0
    const failing = fakeSession({
      analyze: async (rgba, width, height) => {
        calls++
        if (calls > 1) throw new Error('dispatch failed')
        return analyzeVideoScopes(rgba, width, height)
      },
    })
    const analyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession: async () => ({ status: 'ready', session: failing.session }),
    })
    const executionFallback = await analyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )
    expect(executionFallback).toMatchObject({
      backend: 'cpu',
      fallbackReason: 'execution-failed',
    })
    expect(failing.release).toHaveBeenCalledOnce()

    const lost = fakeSession()
    const lossAnalyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession: async () => ({ status: 'ready', session: lost.session }),
    })
    expect((await lossAnalyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )).backend).toBe('webgpu')
    lost.lose('destroyed: test loss')
    await Promise.resolve()
    const lossFallback = await lossAnalyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )
    expect(lossFallback).toMatchObject({
      backend: 'cpu',
      fallbackReason: 'device-lost',
    })
    expect(lost.release).toHaveBeenCalledOnce()
  })

  test('uses CPU for non-production sample geometry without creating a device', async () => {
    const requestSession = vi.fn()
    const analyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession,
    })
    const result = await analyzer.analyze(new Uint8ClampedArray(4), 1, 1)
    expect(result).toMatchObject({
      backend: 'cpu',
      fallbackReason: 'unsupported-input-shape',
    })
    expect(requestSession).not.toHaveBeenCalled()
  })

  test('releases a session that arrives after shutdown without producing a late result', async () => {
    const requested = deferred<{
      status: 'ready'
      session: VideoScopeWebGpuSession
    }>()
    const gpu = fakeSession()
    const analyzer = createOptionalVideoScopeAnalyzer({
      preferWebGpu: true,
      requestSession: () => requested.promise,
    })
    const result = analyzer.analyze(
      fixture(),
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )

    analyzer.release()
    requested.resolve({ status: 'ready', session: gpu.session })

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(gpu.release).toHaveBeenCalledOnce()
    expect(analyzer.snapshot()).toMatchObject({
      state: 'released',
      activeBufferBytes: 0,
    })
  })

  test('keeps release terminal however a pending parity self-test settles', async () => {
    for (const outcome of ['reject', 'mismatch'] as const) {
      const selfTestStarted = deferred<void>()
      const selfTest = deferred<VideoScopeAnalysis>()
      const gpu = fakeSession({
        analyze: () => {
          selfTestStarted.resolve(undefined)
          return selfTest.promise
        },
      })
      const cpuAnalyze = vi.fn(analyzeVideoScopes)
      const analyzer = createOptionalVideoScopeAnalyzer({
        preferWebGpu: true,
        requestSession: async () => ({ status: 'ready', session: gpu.session }),
        cpuAnalyze,
      })
      const inFlight = analyzer.analyze(
        fixture(),
        VIDEO_SCOPE_SAMPLE_WIDTH,
        VIDEO_SCOPE_SAMPLE_HEIGHT,
      )
      const inFlightRejection = expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })

      await selfTestStarted.promise
      analyzer.release()
      if (outcome === 'reject') {
        selfTest.reject(new Error('self-test failed after shutdown'))
      } else {
        const mismatched = analyzeVideoScopes(
          fixture(),
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        mismatched.histogram.red[0]++
        selfTest.resolve(mismatched)
      }

      await inFlightRejection
      expect(gpu.release).toHaveBeenCalledOnce()
      expect(analyzer.snapshot()).toMatchObject({
        state: 'released',
        fallbackReason: null,
        fallbackDetail: null,
      })
      await expect(analyzer.analyze(
        fixture(),
        VIDEO_SCOPE_SAMPLE_WIDTH,
        VIDEO_SCOPE_SAMPLE_HEIGHT,
      )).rejects.toMatchObject({ name: 'AbortError' })
      expect(cpuAnalyze).toHaveBeenCalledOnce()
      expect(gpu.release).toHaveBeenCalledOnce()
    }
  })
})
