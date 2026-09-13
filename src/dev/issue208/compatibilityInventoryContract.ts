/** Serializable Issue #208 capability inventory. Browser-free; facts only. */

export const COMPATIBILITY_INVENTORY_CONTRACT =
  'issue-208-compatibility-inventory-v1' as const
export const COMPATIBILITY_INVENTORY_SCHEMA_VERSION = 1 as const

export type CompatibilityInventoryCoreDecision = 'go' | 'no-go'

export type CompatibilityInventoryCoreReason =
  | 'missing-video-decoder'
  | 'missing-video-encoder'
  | 'missing-audio-decoder'
  | 'missing-audio-encoder'
  | 'missing-offscreencanvas-2d'
  | 'transfer-control-to-offscreen-failed'
  | 'missing-module-dedicated-worker'
  | 'module-worker-decode-unavailable'
  | 'audio-context-construct-failed'
  | 'no-honest-download-profile'

export type CompatibilityInventoryOptionalFeatureId =
  | 'remembered-media-handles'
  | 'remembered-project-files'
  | 'live-save'
  | 'direct-file-export'
  | 'folder-png-export'
  | 'opfs-derived-caches'
  | 'worker-webgl2'
  | 'plugin-isolation'

export interface ConstructorPresence {
  readonly present: boolean
}

export interface SupportProbe {
  readonly supported: boolean
  readonly reason: string | null
}

export interface WebCodecsConstructorFacts {
  readonly VideoDecoder: ConstructorPresence
  readonly VideoEncoder: ConstructorPresence
  readonly AudioDecoder: ConstructorPresence
  readonly AudioEncoder: ConstructorPresence
  readonly ImageDecoder: ConstructorPresence
  readonly VideoFrame: ConstructorPresence
  readonly AudioData: ConstructorPresence
}

export interface NativeCodecProbe {
  readonly id: string
  readonly codec: string
  readonly isConfigSupported: SupportProbe
  readonly roundTrip: SupportProbe
}

export interface ExportProfileInventory {
  readonly id: 'compatibility' | 'web' | 'modern' | 'hevc'
  readonly autoCandidate: boolean
  readonly canEncode: SupportProbe
  readonly freshEncode: SupportProbe
}

export interface FileSystemAccessFacts {
  readonly showOpenFilePicker: boolean
  readonly showSaveFilePicker: boolean
  readonly showDirectoryPicker: boolean
  readonly rememberedMediaHandles: boolean
  readonly rememberedProjectFiles: boolean
  readonly liveSaveAvailable: boolean
  readonly directFileExportAvailable: boolean
  readonly folderExportAvailable: boolean
  readonly liveSaveReason: string | null
  readonly folderExportReason: string | null
}

export interface OriginStorageFacts {
  readonly indexedDB: boolean
  readonly cacheStorage: boolean
  readonly opfsGetDirectory: boolean
  readonly opfsCreateWritable: SupportProbe
  readonly persisted: boolean | null
}

export interface AudioContextFacts {
  readonly constructed: boolean
  readonly initialState: string | null
  readonly resumeAttempted: boolean
  readonly stateAfterResume: string | null
  readonly closed: boolean
  readonly reason: string | null
}

export interface GraphicsFacts {
  readonly offscreenCanvas: boolean
  readonly offscreenCanvas2d: boolean
  readonly transferControlToOffscreen: boolean
}

export interface WorkerProbeEvidence {
  readonly moduleWorker: boolean
  readonly offscreenCanvas2d: boolean
  readonly transferredCanvas2d: boolean
  readonly webgl2: boolean
  readonly videoDecoderPresent: boolean
  readonly videoDecoderConfigSupported: boolean
  readonly reason: string | null
}

export interface PluginIsolationFacts {
  readonly srcdocSandboxCreated: boolean
  readonly wasmUnsafeEvalInSrcdoc: boolean
  readonly opaqueOrigin: boolean | null
  readonly networkFetchBlocked: boolean | null
  readonly networkXhrBlocked: boolean | null
  readonly networkWebSocketBlocked: boolean | null
  readonly sendBeaconBlocked: boolean | null
  readonly indexedDbBlocked: boolean | null
  readonly cacheStorageBlocked: boolean | null
  readonly opfsBlocked: boolean | null
  readonly parentDomUnavailable: boolean | null
  readonly isolationProven: boolean
  readonly reason: string | null
}

export interface InventoryResourceLedger {
  readonly videoFramesCreated: number
  readonly videoFramesClosed: number
  readonly audioDataCreated: number
  readonly audioDataClosed: number
  readonly imageBitmapsCreated: number
  readonly imageBitmapsClosed: number
}

export interface WorkerLifecycleEvidence {
  readonly workersCreated: number
  readonly workersTerminated: number
  readonly activeWorkers: 0
}

export interface CompatibilityInventoryFacts {
  readonly secureContext: boolean
  readonly webCodecs: WebCodecsConstructorFacts
  readonly videoCodecs: readonly NativeCodecProbe[]
  readonly audioCodecs: readonly NativeCodecProbe[]
  readonly stillImages: {
    readonly imageDecoder: SupportProbe
    readonly createImageBitmap: SupportProbe
  }
  readonly exportProfiles: readonly ExportProfileInventory[]
  readonly fileSystem: FileSystemAccessFacts
  readonly storage: OriginStorageFacts
  readonly audioContext: AudioContextFacts
  readonly graphics: GraphicsFacts
  readonly worker: WorkerProbeEvidence
  readonly plugins: PluginIsolationFacts
}

export interface CompatibilityInventoryDecision {
  readonly core: CompatibilityInventoryCoreDecision
  readonly reasons: readonly CompatibilityInventoryCoreReason[]
  readonly autoPreset: 'modern' | 'web' | 'compatibility' | null
  readonly optional: Readonly<Record<CompatibilityInventoryOptionalFeatureId, boolean>>
}

export interface CompatibilityInventoryEvidence {
  readonly contract: typeof COMPATIBILITY_INVENTORY_CONTRACT
  readonly schemaVersion: typeof COMPATIBILITY_INVENTORY_SCHEMA_VERSION
  readonly publicSupportClaim: false
  readonly facts: CompatibilityInventoryFacts
  readonly decision: CompatibilityInventoryDecision
  readonly resources: InventoryResourceLedger
  readonly workerLifecycle: WorkerLifecycleEvidence
}

export type InventoryWorkerRequest = {
  readonly type: 'run'
  readonly canvas: OffscreenCanvas | null
}

export type InventoryWorkerResponse =
  | { readonly type: 'result'; readonly worker: WorkerProbeEvidence }
  | { readonly type: 'error'; readonly detail: string }
