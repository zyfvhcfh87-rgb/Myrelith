/** Browser-only, source-addressable Issue #75 benchmark. Not in the app graph. */

import {
  analyzeVideoScopes,
  VIDEO_SCOPE_HISTOGRAM_BINS,
  VIDEO_SCOPE_SAMPLE_HEIGHT,
  VIDEO_SCOPE_SAMPLE_WIDTH,
  VIDEO_SCOPE_VECTOR_SIZE,
  VIDEO_SCOPE_WAVEFORM_HEIGHT,
} from '../domain/videoScopes'
import {
  createOptionalVideoScopeAnalyzer,
  videoScopeAnalysesEqual,
  VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES,
  type OptionalVideoScopeAnalyzerSnapshot,
  type VideoScopeWebGpuFallbackReason,
} from './video-scopes-webgpu'

export interface DistributionSummary {
  readonly samples: readonly number[]
  readonly minimum: number
  readonly median: number
  readonly p95: number
  readonly maximum: number
  readonly mean: number
}

export interface VideoScopeWebGpuBenchmarkArtifact {
  readonly schemaVersion: 1
  readonly capturedAt: string
  readonly fixture: {
    readonly width: number
    readonly height: number
    readonly pixels: number
    readonly sha256: string
  }
  readonly environment: {
    readonly userAgent: string
    readonly platform: string
    readonly hardwareConcurrency: number
    readonly deviceMemoryGiB: number | null
    readonly secureContext: boolean
    readonly navigatorGpu: boolean
  }
  readonly configuration: {
    readonly warmupIterations: number
    readonly measuredIterations: number
    readonly currentProductionBackend: 'cpu'
    readonly sampleCadenceHz: 4
  }
  readonly correctness: {
    readonly exact: boolean
    readonly comparedAnalyses: number
  }
  readonly latency: {
    readonly cpuMs: DistributionSummary
    readonly webGpuMs: DistributionSummary | null
    readonly webGpuFirstCallWallMs: number | null
    readonly webGpuStartupMs: number | null
    readonly medianSpeedupRatio: number | null
  }
  readonly memory: {
    readonly cpuOutputBytesPerAnalysis: number
    readonly webGpuPeakBufferBytes: number
    readonly webGpuActiveBufferBytesAfterAnalysis: number
    readonly driverAndPipelineBytes: 'unavailable'
  }
  readonly webGpu: {
    readonly available: boolean
    readonly adapter: OptionalVideoScopeAnalyzerSnapshot['adapterInfo']
    readonly fallbackReason: VideoScopeWebGpuFallbackReason | null
    readonly fallbackDetail: string | null
  }
  readonly deviceLoss: {
    readonly exercised: boolean
    readonly lossDetail: string | null
    readonly fallbackBackend: 'cpu' | null
    readonly fallbackReason: VideoScopeWebGpuFallbackReason | null
    readonly exactCpuResult: boolean | null
  }
  readonly cleanup: {
    readonly state: OptionalVideoScopeAnalyzerSnapshot['state']
    readonly activeBufferBytes: number
  }
}

function createFixture(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(
    VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT * 4,
  )
  let state = 0x75_10_ba_5e
  for (let index = 0; index < rgba.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    rgba[index] = state >>> 24
  }
  for (let pixel = 0; pixel < rgba.length / 4; pixel += 23) {
    rgba[pixel * 4 + 3] = 0
  }
  rgba.set([
    13, 163, 113, 241,
    0, 13, 142, 150,
    0, 35, 190, 102,
    13, 163, 113, 255,
    0, 0, 255, 170,
    255, 0, 0, 170,
    47, 143, 211, 255,
    2, 2, 172, 255,
    172, 2, 2, 255,
  ])
  return rgba
}

async function sha256(bytes: Uint8ClampedArray): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function quantile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[Math.max(0, index)]
}

function summarize(samples: readonly number[]): DistributionSummary {
  if (samples.length === 0) throw new RangeError('Benchmark samples cannot be empty')
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    samples,
    minimum: sorted[0],
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    maximum: sorted.at(-1) ?? sorted[0],
    mean: sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length,
  }
}

function cpuOutputBytes(): number {
  return (
    VIDEO_SCOPE_HISTOGRAM_BINS * 4
    + VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_WAVEFORM_HEIGHT
    + VIDEO_SCOPE_VECTOR_SIZE * VIDEO_SCOPE_VECTOR_SIZE
  ) * Uint16Array.BYTES_PER_ELEMENT
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

export async function runVideoScopeWebGpuBenchmark(options: {
  readonly warmupIterations?: number
  readonly measuredIterations?: number
} = {}): Promise<VideoScopeWebGpuBenchmarkArtifact> {
  const warmupIterations = positiveInteger(options.warmupIterations ?? 10, 'warmupIterations')
  const measuredIterations = positiveInteger(
    options.measuredIterations ?? 60,
    'measuredIterations',
  )
  const fixture = createFixture()
  const cpuOracle = analyzeVideoScopes(
    fixture,
    VIDEO_SCOPE_SAMPLE_WIDTH,
    VIDEO_SCOPE_SAMPLE_HEIGHT,
  )

  for (let iteration = 0; iteration < warmupIterations; iteration++) {
    analyzeVideoScopes(fixture, VIDEO_SCOPE_SAMPLE_WIDTH, VIDEO_SCOPE_SAMPLE_HEIGHT)
  }
  const cpuSamples: number[] = []
  for (let iteration = 0; iteration < measuredIterations; iteration++) {
    const startedAt = performance.now()
    analyzeVideoScopes(fixture, VIDEO_SCOPE_SAMPLE_WIDTH, VIDEO_SCOPE_SAMPLE_HEIGHT)
    cpuSamples.push(performance.now() - startedAt)
  }

  const analyzer = createOptionalVideoScopeAnalyzer({ preferWebGpu: true })
  const firstStartedAt = performance.now()
  const first = await analyzer.analyze(
    fixture,
    VIDEO_SCOPE_SAMPLE_WIDTH,
    VIDEO_SCOPE_SAMPLE_HEIGHT,
  )
  const firstCallWallMs = performance.now() - firstStartedAt
  let comparedAnalyses = 1
  let exact = first.backend === 'webgpu'
    && videoScopeAnalysesEqual(first.analysis, cpuOracle)
  const gpuSamples: number[] = []

  if (first.backend === 'webgpu') {
    for (let iteration = 0; iteration < warmupIterations; iteration++) {
      const result = await analyzer.analyze(
        fixture,
        VIDEO_SCOPE_SAMPLE_WIDTH,
        VIDEO_SCOPE_SAMPLE_HEIGHT,
      )
      exact &&= result.backend === 'webgpu'
        && videoScopeAnalysesEqual(result.analysis, cpuOracle)
      comparedAnalyses++
    }
    for (let iteration = 0; iteration < measuredIterations; iteration++) {
      const result = await analyzer.analyze(
        fixture,
        VIDEO_SCOPE_SAMPLE_WIDTH,
        VIDEO_SCOPE_SAMPLE_HEIGHT,
      )
      exact &&= result.backend === 'webgpu'
        && videoScopeAnalysesEqual(result.analysis, cpuOracle)
      comparedAnalyses++
      if (result.backend === 'webgpu') gpuSamples.push(result.elapsedMs)
    }
  }

  const readySnapshot = analyzer.snapshot()
  let lossDetail: string | null = null
  let lossBackend: 'cpu' | null = null
  let lossReason: VideoScopeWebGpuFallbackReason | null = null
  let lossExact: boolean | null = null
  if (first.backend === 'webgpu') {
    lossDetail = await analyzer.loseDeviceForExperiment()
    const afterLoss = await analyzer.analyze(
      fixture,
      VIDEO_SCOPE_SAMPLE_WIDTH,
      VIDEO_SCOPE_SAMPLE_HEIGHT,
    )
    lossBackend = afterLoss.backend === 'cpu' ? 'cpu' : null
    lossReason = afterLoss.fallbackReason
    lossExact = videoScopeAnalysesEqual(afterLoss.analysis, cpuOracle)
  }
  const fallbackSnapshot = analyzer.snapshot()
  analyzer.release()
  const cleanupSnapshot = analyzer.snapshot()

  const cpuSummary = summarize(cpuSamples)
  const gpuSummary = gpuSamples.length === measuredIterations ? summarize(gpuSamples) : null
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    fixture: {
      width: VIDEO_SCOPE_SAMPLE_WIDTH,
      height: VIDEO_SCOPE_SAMPLE_HEIGHT,
      pixels: VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT,
      sha256: await sha256(fixture),
    },
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: 'deviceMemory' in navigator
        ? (navigator as Navigator & { readonly deviceMemory: number }).deviceMemory
        : null,
      secureContext: isSecureContext,
      navigatorGpu: 'gpu' in navigator,
    },
    configuration: {
      warmupIterations,
      measuredIterations,
      currentProductionBackend: 'cpu',
      sampleCadenceHz: 4,
    },
    correctness: { exact, comparedAnalyses },
    latency: {
      cpuMs: cpuSummary,
      webGpuMs: gpuSummary,
      webGpuFirstCallWallMs: first.backend === 'webgpu' ? firstCallWallMs : null,
      webGpuStartupMs: readySnapshot.startupMs,
      medianSpeedupRatio: gpuSummary ? cpuSummary.median / gpuSummary.median : null,
    },
    memory: {
      cpuOutputBytesPerAnalysis: cpuOutputBytes(),
      webGpuPeakBufferBytes: first.backend === 'webgpu'
        ? readySnapshot.peakBufferBytes || VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES
        : 0,
      webGpuActiveBufferBytesAfterAnalysis: readySnapshot.activeBufferBytes,
      driverAndPipelineBytes: 'unavailable',
    },
    webGpu: {
      available: first.backend === 'webgpu',
      adapter: readySnapshot.adapterInfo,
      fallbackReason: first.backend === 'webgpu'
        ? fallbackSnapshot.fallbackReason
        : first.fallbackReason,
      fallbackDetail: first.backend === 'webgpu'
        ? fallbackSnapshot.fallbackDetail
        : readySnapshot.fallbackDetail,
    },
    deviceLoss: {
      exercised: first.backend === 'webgpu',
      lossDetail,
      fallbackBackend: lossBackend,
      fallbackReason: lossReason,
      exactCpuResult: lossExact,
    },
    cleanup: {
      state: cleanupSnapshot.state,
      activeBufferBytes: cleanupSnapshot.activeBufferBytes,
    },
  }
}
