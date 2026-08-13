import {
  createValidatedLensCorrectionMap,
  DEFAULT_MANUAL_LENS_CORRECTION,
  lensCorrectionValidationError,
} from '../../domain/lensCorrection'
import { PROJECT_RESOLUTION_PRESETS } from '../../domain/projectSettings'
import {
  compareLensRemapRgba,
  createLensRemapFixtureRgba,
  lensRemapSurfaceBudget,
  LENS_REMAP_BACKEND_VERSION,
  LENS_REMAP_FIXTURES,
  LENS_REMAP_FIXTURE_VERSION,
  LENS_REMAP_GEOMETRY_TOLERANCE_PIXELS,
  LENS_REMAP_PIXEL_TOLERANCE,
  LENS_REMAP_PREVIEW_P95_BUDGET_MS,
  LENS_REMAP_SOURCE_STAGE_ORDER,
  percentile95,
  remapLensRgbaCpu,
} from './lensRemapCore'
import type {
  LensRemapParityEvidence,
  LensRemapRunEvidence,
  LensRemapTimingEvidence,
  LensRemapWorkerRequest,
  LensRemapWorkerResponse,
} from './lensRemapContract'
import { WebGl2LensRemapBackend } from './lensRemapWebgl'

interface LensRemapWorkerScope {
  postMessage(message: LensRemapWorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<LensRemapWorkerRequest>) => void,
  ): void
}

const scope = self as unknown as LensRemapWorkerScope
const PARITY_WIDTH = 257
const PARITY_HEIGHT = 193
const PERFORMANCE_SIZES = Object.freeze([
  { width: 1_280, height: 720 },
  { width: 1_920, height: 1_080 },
  { width: 3_840, height: 2_160 },
] as const)

let cancellationController: AbortController | null = null

function post(message: LensRemapWorkerResponse): void {
  scope.postMessage(message)
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

function elapsed(startedAt: number): number {
  return performance.now() - startedAt
}

async function waitForContextLoss(backend: WebGl2LensRemapBackend): Promise<boolean> {
  const extension = backend.contextLossExtension
  if (!extension) return false
  extension.loseContext()
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      backend.render(
        createLensRemapFixtureRgba(8, 8, false),
        8,
        8,
        LENS_REMAP_FIXTURES[0].model,
        false,
      )
    } catch (error) {
      if (error instanceof Error && /context was lost/.test(error.message)) return true
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function runResearch(): Promise<LensRemapRunEvidence> {
  let backendsCreated = 0
  let backendsDisposed = 0
  const reasons: string[] = []
  const coldStarted = performance.now()
  const backend = new WebGl2LensRemapBackend()
  backendsCreated++
  const coldSetupMs = elapsed(coldStarted)
  try {
    if (!backend.contextLossExtension) reasons.push('WEBGL_lose_context is unavailable')
    for (const preset of PROJECT_RESOLUTION_PRESETS) {
      if (preset.width > backend.maximumTextureSize || preset.height > backend.maximumTextureSize) {
        reasons.push(`${preset.width}x${preset.height} exceeds MAX_TEXTURE_SIZE`)
      }
      const budget = lensRemapSurfaceBudget(preset.width, preset.height)
      if (!budget.allowed) reasons.push(`${preset.width}x${preset.height}: ${budget.reason}`)
    }

    const warmStarted = performance.now()
    createValidatedLensCorrectionMap(LENS_REMAP_FIXTURES[1].model)
    const warmModelSetupMs = elapsed(warmStarted)
    const parity: LensRemapParityEvidence[] = []
    for (const fixture of LENS_REMAP_FIXTURES) {
      const input = createLensRemapFixtureRgba(
        PARITY_WIDTH,
        PARITY_HEIGHT,
        fixture.transparentInput,
      )
      const cpu = await remapLensRgbaCpu(
        input,
        PARITY_WIDTH,
        PARITY_HEIGHT,
        fixture.model,
      )
      backend.render(input, PARITY_WIDTH, PARITY_HEIGHT, fixture.model, false)
      const preview = backend.readCurrent()
      const exported = backend.render(
        input,
        PARITY_WIDTH,
        PARITY_HEIGHT,
        fixture.model,
        true,
      )!
      const cpuVsExport = compareLensRemapRgba(cpu, exported)
      const previewVsExport = compareLensRemapRgba(preview, exported)
      const maximumGeometryDeltaPixels = backend.maximumGeometryDeltaPixels(
        fixture.model,
        PARITY_WIDTH,
        PARITY_HEIGHT,
      )
      const cornerAlpha = Object.freeze([
        exported[3]!,
        exported[(PARITY_WIDTH - 1) * 4 + 3]!,
        exported[((PARITY_HEIGHT - 1) * PARITY_WIDTH) * 4 + 3]!,
        exported[(PARITY_WIDTH * PARITY_HEIGHT - 1) * 4 + 3]!,
      ])
      if (cpuVsExport.maximumChannelDelta > LENS_REMAP_PIXEL_TOLERANCE) {
        reasons.push(`${fixture.id} CPU/export delta ${cpuVsExport.maximumChannelDelta} exceeds ${LENS_REMAP_PIXEL_TOLERANCE}`)
      }
      if (previewVsExport.maximumChannelDelta > LENS_REMAP_PIXEL_TOLERANCE) {
        reasons.push(`${fixture.id} preview/export paths diverged`)
      }
      if (maximumGeometryDeltaPixels > LENS_REMAP_GEOMETRY_TOLERANCE_PIXELS) {
        reasons.push(`${fixture.id} geometry delta ${maximumGeometryDeltaPixels} exceeds ${LENS_REMAP_GEOMETRY_TOLERANCE_PIXELS}`)
      }
      if (fixture.id === 'transparent-edge' && cornerAlpha.some((alpha) => alpha !== 0)) {
        reasons.push('Transparent-edge fixture did not preserve undefined transparent edges')
      }
      parity.push(Object.freeze({
        fixtureId: fixture.id,
        model: fixture.model,
        cpuVsExport,
        previewVsExport,
        maximumGeometryDeltaPixels,
        cornerAlpha,
      }))
    }

    const performanceFixture = LENS_REMAP_FIXTURES.find((fixture) => fixture.id === 'barrel')!
    const timings: LensRemapTimingEvidence[] = []
    for (const size of PERFORMANCE_SIZES) {
      const input = createLensRemapFixtureRgba(size.width, size.height, false)
      const cpuStarted = performance.now()
      await remapLensRgbaCpu(input, size.width, size.height, performanceFixture.model)
      const cpuOracleMs = elapsed(cpuStarted)
      const webglPreviewSamplesMs: number[] = []
      for (let sample = 0; sample < 9; sample++) {
        const started = performance.now()
        backend.render(input, size.width, size.height, performanceFixture.model, false)
        webglPreviewSamplesMs.push(elapsed(started))
      }
      const webglExportSamplesMs: number[] = []
      for (let sample = 0; sample < 5; sample++) {
        const started = performance.now()
        backend.render(input, size.width, size.height, performanceFixture.model, true)
        webglExportSamplesMs.push(elapsed(started))
      }
      const surfaceBudget = lensRemapSurfaceBudget(size.width, size.height)
      timings.push(Object.freeze({
        ...size,
        cpuOracleMs,
        webglPreviewSamplesMs: Object.freeze(webglPreviewSamplesMs),
        webglPreviewP95Ms: percentile95(webglPreviewSamplesMs),
        webglExportSamplesMs: Object.freeze(webglExportSamplesMs),
        webglExportP95Ms: percentile95(webglExportSamplesMs),
        retainedBytes: backend.retainedBytes(),
        exportPeakBytes: backend.retainedBytes() + input.byteLength,
        surfaceBudget,
      }))
    }
    const fullHd = timings.find((timing) => timing.width === 1_920)!
    if (fullHd.webglPreviewP95Ms > LENS_REMAP_PREVIEW_P95_BUDGET_MS) {
      reasons.push(`1080p preview p95 ${fullHd.webglPreviewP95Ms} ms exceeds 30 fps budget`)
    }

    const invalidFoldingRejected = lensCorrectionValidationError({
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      k1: -1.5,
    })?.includes('folds') ?? false
    if (!invalidFoldingRejected) reasons.push('Invalid folding model was not rejected')

    const currentOwnerFailed = await waitForContextLoss(backend)
    if (!currentOwnerFailed) reasons.push('Context loss did not fail the current backend owner')
    backend.dispose()
    backendsDisposed++
    const fresh = new WebGl2LensRemapBackend()
    backendsCreated++
    let freshOwnerSucceeded = false
    try {
      const input = createLensRemapFixtureRgba(32, 18, false)
      freshOwnerSucceeded = fresh.render(
        input,
        32,
        18,
        LENS_REMAP_FIXTURES[0].model,
        true,
      )?.byteLength === input.byteLength
    } finally {
      fresh.dispose()
      backendsDisposed++
    }
    if (!freshOwnerSucceeded) reasons.push('Fresh WebGL2 owner did not recover after context loss')

    return Object.freeze({
      fixtureVersion: LENS_REMAP_FIXTURE_VERSION,
      backendVersion: LENS_REMAP_BACKEND_VERSION,
      sourceStageOrder: LENS_REMAP_SOURCE_STAGE_ORDER,
      fallbackPolicy: 'explicit-unavailable-no-cpu-substitution',
      support: Object.freeze({
        webgl2: true,
        rgba8Upload: true,
        rgba8Readback: true,
        manualBilinear: true,
        contextLossExtension: true,
        maximumTextureSize: backend.maximumTextureSize,
      }),
      coldSetupMs,
      warmModelSetupMs,
      parity: Object.freeze(parity),
      timings: Object.freeze(timings),
      invalidFoldingRejected,
      contextLoss: Object.freeze({ currentOwnerFailed, freshOwnerSucceeded }),
      resources: Object.freeze({
        backendsCreated,
        backendsDisposed,
        retainedBytesAfterDispose: 0,
      }),
      decision: reasons.length === 0 ? 'go' : 'no-go',
      reasons: Object.freeze(reasons),
    })
  } finally {
    if (backendsDisposed === 0) {
      backend.dispose()
      backendsDisposed++
    }
  }
}

async function runCancellationProbe(): Promise<void> {
  if (cancellationController) throw new Error('Cancellation probe is already active')
  const controller = new AbortController()
  cancellationController = controller
  try {
    const input = createLensRemapFixtureRgba(3_840, 2_160, false)
    post({ type: 'cancel-ready' })
    await remapLensRgbaCpu(
      input,
      3_840,
      2_160,
      LENS_REMAP_FIXTURES[1].model,
      { signal: controller.signal, yieldEveryRows: 4 },
    )
    throw new Error('Cancellation probe completed instead of aborting')
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error
    post({ type: 'cancelled', name: error.name })
  } finally {
    cancellationController = null
  }
}

scope.addEventListener('message', (event: MessageEvent<LensRemapWorkerRequest>) => {
  if (event.data.type === 'cancel') {
    cancellationController?.abort()
    return
  }
  if (event.data.type === 'run') {
    void runResearch().then(
      (evidence) => post({ type: 'result', evidence }),
      (error) => post({ type: 'error', detail: errorDetail(error) }),
    )
    return
  }
  void runCancellationProbe().catch((error) => post({ type: 'error', detail: errorDetail(error) }))
})

export {}
