import { describe, expect, test } from 'vitest'
import {
  PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
  isPluginEffectBridgeHostMessage,
  isPluginEffectBridgeWorkerMessage,
  zeroAttachedPluginEffectBuffer,
  type PluginEffectBridgeApplyMessage,
} from './plugin-effect-bridge-protocol'

function execution() {
  return {
    catalogGeneration: 3,
    signerFingerprint: `sha256:${'1'.repeat(64)}`,
    packageDigest: `sha256:${'2'.repeat(64)}`,
    pluginId: 'com.example.fixture',
    pluginVersion: '1.2.3',
    kind: 'video-effect' as const,
    contributionVersion: 1,
    contributionId: 'fixture',
    descriptorVersion: 2,
    entrypoint: 'myrelith_effect_fixture',
    parameterRecord: { strength: 0.5 },
    canonicalParameterJson: '{"strength":0.5}',
  }
}

function applyMessage(): PluginEffectBridgeApplyMessage {
  return {
    type: 'pluginEffectApply',
    protocolVersion: PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
    generation: 1,
    renderRequestId: 2,
    effectRequestId: 3,
    execution: execution(),
    descriptorId: 'effect-1',
    timelineFrame: 4,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    width: 2,
    height: 1,
    stride: 8,
    rgbaBytes: new ArrayBuffer(8),
  }
}

describe('plugin effect bridge protocol', () => {
  test('accepts exact apply, cancel, applied, and bypassed variants', () => {
    expect(isPluginEffectBridgeWorkerMessage(applyMessage())).toBe(true)
    expect(isPluginEffectBridgeWorkerMessage({
      type: 'pluginEffectCancel',
      protocolVersion: 1,
      generation: 1,
      renderRequestId: 2,
      effectRequestId: 3,
    })).toBe(true)
    expect(isPluginEffectBridgeHostMessage({
      type: 'pluginEffectApplied',
      protocolVersion: 1,
      generation: 1,
      renderRequestId: 2,
      effectRequestId: 3,
      rgbaBytes: new ArrayBuffer(8),
    }, 8)).toBe(true)
    expect(isPluginEffectBridgeHostMessage({
      type: 'pluginEffectBypassed',
      protocolVersion: 1,
      generation: 1,
      renderRequestId: 2,
      effectRequestId: 3,
    }, 8)).toBe(true)
  })

  test('rejects extra keys, stale identities, and malformed byte geometry', () => {
    expect(isPluginEffectBridgeWorkerMessage({ ...applyMessage(), extra: true })).toBe(false)
    expect(isPluginEffectBridgeWorkerMessage({ ...applyMessage(), generation: 0 })).toBe(false)
    expect(isPluginEffectBridgeWorkerMessage({ ...applyMessage(), stride: 7 })).toBe(false)
    expect(isPluginEffectBridgeWorkerMessage({
      ...applyMessage(),
      rgbaBytes: new ArrayBuffer(4),
    })).toBe(false)
    expect(isPluginEffectBridgeHostMessage({
      type: 'pluginEffectApplied',
      protocolVersion: 1,
      generation: 1,
      renderRequestId: 2,
      effectRequestId: 3,
      rgbaBytes: new ArrayBuffer(4),
    }, 8)).toBe(false)
  })

  test('rejects incomplete execution identity and non-canonical parameter bounds', () => {
    const missingDescriptorVersion = { ...execution() } as Record<string, unknown>
    delete missingDescriptorVersion.descriptorVersion
    expect(isPluginEffectBridgeWorkerMessage({
      ...applyMessage(),
      execution: missingDescriptorVersion,
    })).toBe(false)
    expect(isPluginEffectBridgeWorkerMessage({
      ...applyMessage(),
      execution: { ...execution(), canonicalParameterJson: '\ufeff{}' },
    })).toBe(false)
    expect(isPluginEffectBridgeWorkerMessage({
      ...applyMessage(),
      execution: { ...execution(), canonicalParameterJson: '' },
    })).toBe(false)
  })

  test('zeroes only an attached owned buffer', () => {
    const buffer = Uint8Array.of(1, 2, 3, 4).buffer
    zeroAttachedPluginEffectBuffer(buffer)
    expect([...new Uint8Array(buffer)]).toEqual([0, 0, 0, 0])
  })
})
