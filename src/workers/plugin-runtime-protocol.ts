import type {
  PluginWasmModuleExpectations,
  PluginWasmModuleFacts,
} from './plugin-wasm/moduleParser'

export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1 as const
export const PLUGIN_PARAMETER_POINTER = 0x01000000
export const PLUGIN_PIXEL_POINTER = 0x01010000
export const PLUGIN_IO_PAGE_BYTES = 65_536

export type PluginRuntimeFailureCode =
  | 'aborted'
  | 'activation-failed'
  | 'busy'
  | 'closed'
  | 'crashed'
  | 'invalid-envelope'
  | 'invalid-input'
  | 'invalid-output'
  | 'plugin-failure'
  | 'queue-full'
  | 'session-disabled'
  | 'stale-plan'
  | 'stale-request'
  | 'stale-generation'
  | 'timeout'

export interface PluginRuntimeFailure {
  readonly code: PluginRuntimeFailureCode
  readonly message: string
  readonly terminal: boolean
  readonly pluginCode?: number
}

export interface PluginWorkerConnectRequest {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'connect'
  readonly generation: number
  readonly port: MessagePort
}

export interface PluginWorkerActivateRequest {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'activate'
  readonly generation: number
  readonly requestId: number
  readonly moduleBytes: ArrayBuffer
  readonly expectations: PluginWasmModuleExpectations
}

export interface PluginWorkerRenderRequest {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'render'
  readonly generation: number
  readonly requestId: number
  readonly entrypoint: string
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly timelineFrame: number
  readonly frameRateNumerator: number
  readonly frameRateDenominator: number
  readonly canonicalParameterBytes: ArrayBuffer
  readonly rgbaBytes: ArrayBuffer
}

export interface PluginWorkerMigrateRequest {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'migrate'
  readonly generation: number
  readonly requestId: number
  readonly entrypoint: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly canonicalInputBytes: ArrayBuffer
}

export interface PluginWorkerCloseRequest {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'close'
  readonly generation: number
  readonly requestId: number
  readonly reason: string
}

export type PluginWorkerRequest =
  | PluginWorkerActivateRequest
  | PluginWorkerRenderRequest
  | PluginWorkerMigrateRequest
  | PluginWorkerCloseRequest

export interface PluginWorkerReadyResponse {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'ready'
  readonly generation: number
  readonly requestId: number
  readonly facts: PluginWasmModuleFacts
}

export interface PluginWorkerRenderResponse {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'rendered'
  readonly generation: number
  readonly requestId: number
  readonly identity: boolean
  readonly rgbaBytes: ArrayBuffer
}

export interface PluginWorkerMigrationResponse {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'migrated'
  readonly generation: number
  readonly requestId: number
  readonly canonicalOutputBytes: ArrayBuffer
}

export interface PluginWorkerFailureResponse {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'failure'
  readonly generation: number
  readonly requestId: number
  readonly failure: PluginRuntimeFailure
}

export interface PluginWorkerClosedResponse {
  readonly protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  readonly kind: 'closed'
  readonly generation: number
  readonly requestId: number
}

export type PluginWorkerResponse =
  | PluginWorkerReadyResponse
  | PluginWorkerRenderResponse
  | PluginWorkerMigrationResponse
  | PluginWorkerFailureResponse
  | PluginWorkerClosedResponse
