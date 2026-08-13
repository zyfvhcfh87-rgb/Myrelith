import type { ManualLensCorrectionModel } from '../../domain/lensCorrection'
import type { LensRemapSurfaceBudget, RgbaAgreement } from './lensRemapCore'

export interface LensRemapTimingEvidence {
  readonly width: number
  readonly height: number
  readonly cpuOracleMs: number
  readonly webglPreviewSamplesMs: readonly number[]
  readonly webglPreviewP95Ms: number
  readonly webglExportSamplesMs: readonly number[]
  readonly webglExportP95Ms: number
  readonly retainedBytes: number
  readonly exportPeakBytes: number
  readonly surfaceBudget: LensRemapSurfaceBudget
}

export interface LensRemapParityEvidence {
  readonly fixtureId: string
  readonly model: Readonly<ManualLensCorrectionModel>
  readonly cpuVsExport: RgbaAgreement
  readonly previewVsExport: RgbaAgreement
  readonly maximumGeometryDeltaPixels: number
  readonly cornerAlpha: readonly number[]
}

export interface LensRemapBackendSupport {
  readonly webgl2: true
  readonly rgba8Upload: true
  readonly rgba8Readback: true
  readonly manualBilinear: true
  readonly contextLossExtension: true
  readonly maximumTextureSize: number
}

export interface LensRemapRunEvidence {
  readonly fixtureVersion: string
  readonly backendVersion: string
  readonly sourceStageOrder: readonly string[]
  readonly fallbackPolicy: 'explicit-unavailable-no-cpu-substitution'
  readonly support: LensRemapBackendSupport
  readonly coldSetupMs: number
  readonly warmModelSetupMs: number
  readonly parity: readonly LensRemapParityEvidence[]
  readonly timings: readonly LensRemapTimingEvidence[]
  readonly invalidFoldingRejected: boolean
  readonly contextLoss: {
    readonly currentOwnerFailed: boolean
    readonly freshOwnerSucceeded: boolean
  }
  readonly resources: {
    readonly backendsCreated: number
    readonly backendsDisposed: number
    readonly retainedBytesAfterDispose: number
  }
  readonly decision: 'go' | 'no-go'
  readonly reasons: readonly string[]
}

export interface LensRemapCancellationEvidence {
  readonly name: 'AbortError'
  readonly workersCreated: number
  readonly workersTerminated: number
  readonly activeWorkers: 0
}

export interface LensRemapGateEvidence {
  readonly run: LensRemapRunEvidence
  readonly cancellation: LensRemapCancellationEvidence
  readonly workerLifecycle: {
    readonly workersCreated: 3
    readonly workersTerminated: 3
    readonly activeWorkers: 0
  }
}

export type LensRemapWorkerRequest =
  | { readonly type: 'run' }
  | { readonly type: 'recovery-probe' }
  | { readonly type: 'cancel-probe' }
  | { readonly type: 'cancel' }

export type LensRemapWorkerResponse =
  | { readonly type: 'result'; readonly evidence: LensRemapRunEvidence }
  | { readonly type: 'recovery-succeeded' }
  | { readonly type: 'cancel-ready' }
  | { readonly type: 'cancelled'; readonly name: string }
  | { readonly type: 'error'; readonly detail: string }
