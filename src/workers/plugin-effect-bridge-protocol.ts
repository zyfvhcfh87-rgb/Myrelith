/** Typed, bounded RPC between the render worker and its main-thread effect host. */

import { PLUGIN_MANIFEST_LIMITS } from '../domain/pluginManifest'
import type { PluginVideoEffectExecutionPlan } from '../domain/pluginVideoEffectStagePlan'

export const PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION = 1 as const
export const PLUGIN_EFFECT_BRIDGE_LIMITS = Object.freeze({
  maxDescriptorIdCharacters: 128,
  maxCanonicalParameterBytes: PLUGIN_MANIFEST_LIMITS.maxCanonicalParameterBytes,
  maxFrameBytes: PLUGIN_MANIFEST_LIMITS.maxPluginFrameBytes,
})

export interface PluginEffectBridgeApplyMessage {
  readonly type: 'pluginEffectApply'
  readonly protocolVersion: typeof PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION
  readonly generation: number
  readonly renderRequestId: number
  readonly effectRequestId: number
  readonly execution: PluginVideoEffectExecutionPlan
  readonly descriptorId: string
  readonly timelineFrame: number
  readonly frameRateNumerator: number
  readonly frameRateDenominator: number
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly rgbaBytes: ArrayBuffer
}

export interface PluginEffectBridgeCancelMessage {
  readonly type: 'pluginEffectCancel'
  readonly protocolVersion: typeof PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION
  readonly generation: number
  readonly renderRequestId: number
  readonly effectRequestId: number
}

export type PluginEffectBridgeWorkerMessage =
  | PluginEffectBridgeApplyMessage
  | PluginEffectBridgeCancelMessage

export interface PluginEffectBridgeAppliedMessage {
  readonly type: 'pluginEffectApplied'
  readonly protocolVersion: typeof PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION
  readonly generation: number
  readonly renderRequestId: number
  readonly effectRequestId: number
  readonly rgbaBytes: ArrayBuffer
}

export interface PluginEffectBridgeBypassedMessage {
  readonly type: 'pluginEffectBypassed'
  readonly protocolVersion: typeof PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION
  readonly generation: number
  readonly renderRequestId: number
  readonly effectRequestId: number
}

export type PluginEffectBridgeHostMessage =
  | PluginEffectBridgeAppliedMessage
  | PluginEffectBridgeBypassedMessage

export interface PluginEffectBridgeHandlerRequest {
  /** Stable positive id passed through to the app-owned runtime request. */
  readonly requestId: number
  readonly execution: PluginVideoEffectExecutionPlan
  readonly descriptorId: string
  readonly timelineFrame: number
  readonly frameRateNumerator: number
  readonly frameRateDenominator: number
  readonly width: number
  readonly height: number
  readonly stride: number
  /** Full-span bytes owned by the handler until it settles. */
  readonly rgbaBytes: Uint8Array
}

export type PluginEffectBridgeHandlerResult =
  | {
      readonly status: 'applied'
      /** Fresh full-span exact-length bytes transferred to the render worker. */
      readonly rgbaBytes: Uint8Array
    }
  | { readonly status: 'bypassed' }

export interface PluginEffectBridgeHandler {
  apply(
    request: PluginEffectBridgeHandlerRequest,
    signal: AbortSignal,
  ): Promise<PluginEffectBridgeHandlerResult>
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer
    || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isExecutionPlan(value: unknown): value is PluginVideoEffectExecutionPlan {
  if (!isRecord(value) || !exactKeys(value, [
    'catalogGeneration',
    'signerFingerprint',
    'packageDigest',
    'pluginId',
    'pluginVersion',
    'kind',
    'contributionVersion',
    'contributionId',
    'descriptorVersion',
    'entrypoint',
    'parameterRecord',
    'canonicalParameterJson',
  ])) return false
  if (
    !isNonNegativeSafeInteger(value.catalogGeneration)
    || typeof value.signerFingerprint !== 'string'
    || typeof value.packageDigest !== 'string'
    || typeof value.pluginId !== 'string'
    || typeof value.pluginVersion !== 'string'
    || value.kind !== 'video-effect'
    || !isPositiveSafeInteger(value.contributionVersion)
    || typeof value.contributionId !== 'string'
    || !isPositiveSafeInteger(value.descriptorVersion)
    || typeof value.entrypoint !== 'string'
    || !isRecord(value.parameterRecord)
    || Object.keys(value.parameterRecord).length > 64
    || typeof value.canonicalParameterJson !== 'string'
  ) return false
  const parameterBytes = utf8ByteLength(value.canonicalParameterJson)
  return parameterBytes >= 2
    && parameterBytes <= PLUGIN_EFFECT_BRIDGE_LIMITS.maxCanonicalParameterBytes
    && !value.canonicalParameterJson.startsWith('\ufeff')
    && Object.entries(value.parameterRecord).every(([key, parameter]) => (
      key.length > 0
      && key.length <= PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters
      && (typeof parameter === 'boolean'
        || typeof parameter === 'string'
        || (typeof parameter === 'number' && Number.isFinite(parameter)))
    ))
}

function validIdentity(value: UnknownRecord): boolean {
  return value.protocolVersion === PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION
    && isPositiveSafeInteger(value.generation)
    && isPositiveSafeInteger(value.renderRequestId)
    && isPositiveSafeInteger(value.effectRequestId)
}

export function isPluginEffectBridgeWorkerMessage(
  value: unknown,
): value is PluginEffectBridgeWorkerMessage {
  if (!isRecord(value) || !validIdentity(value)) return false
  if (value.type === 'pluginEffectCancel') {
    return exactKeys(value, [
      'type', 'protocolVersion', 'generation', 'renderRequestId', 'effectRequestId',
    ])
  }
  if (value.type !== 'pluginEffectApply' || !exactKeys(value, [
    'type',
    'protocolVersion',
    'generation',
    'renderRequestId',
    'effectRequestId',
    'execution',
    'descriptorId',
    'timelineFrame',
    'frameRateNumerator',
    'frameRateDenominator',
    'width',
    'height',
    'stride',
    'rgbaBytes',
  ])) return false
  if (
    !isExecutionPlan(value.execution)
    || typeof value.descriptorId !== 'string'
    || value.descriptorId.length < 1
    || value.descriptorId.length > PLUGIN_EFFECT_BRIDGE_LIMITS.maxDescriptorIdCharacters
    || !isNonNegativeSafeInteger(value.timelineFrame)
    || !isPositiveSafeInteger(value.frameRateNumerator)
    || !isPositiveSafeInteger(value.frameRateDenominator)
    || !isPositiveSafeInteger(value.width)
    || !isPositiveSafeInteger(value.height)
    || !isPositiveSafeInteger(value.stride)
    || value.stride !== value.width * 4
    || !isArrayBuffer(value.rgbaBytes)
  ) return false
  const expectedBytes = value.stride * value.height
  return Number.isSafeInteger(expectedBytes)
    && expectedBytes <= PLUGIN_EFFECT_BRIDGE_LIMITS.maxFrameBytes
    && value.rgbaBytes.byteLength === expectedBytes
}

export function isPluginEffectBridgeHostMessage(
  value: unknown,
  expectedByteLength: number,
): value is PluginEffectBridgeHostMessage {
  if (!isRecord(value) || !validIdentity(value)) return false
  if (value.type === 'pluginEffectBypassed') {
    return exactKeys(value, [
      'type', 'protocolVersion', 'generation', 'renderRequestId', 'effectRequestId',
    ])
  }
  return value.type === 'pluginEffectApplied'
    && exactKeys(value, [
      'type',
      'protocolVersion',
      'generation',
      'renderRequestId',
      'effectRequestId',
      'rgbaBytes',
    ])
    && Number.isSafeInteger(expectedByteLength)
    && expectedByteLength > 0
    && expectedByteLength <= PLUGIN_EFFECT_BRIDGE_LIMITS.maxFrameBytes
    && isArrayBuffer(value.rgbaBytes)
    && value.rgbaBytes.byteLength === expectedByteLength
}

/** Zero a transferred payload only while this realm still owns its backing store. */
export function zeroAttachedPluginEffectBuffer(buffer: ArrayBuffer): void {
  if (buffer.byteLength > 0) new Uint8Array(buffer).fill(0)
}
