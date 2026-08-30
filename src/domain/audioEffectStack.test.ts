import { describe, expect, test } from 'vitest'
import type { AudioEffectDescriptor } from './schema'
import {
  applyAudioEffectStack,
  audioEffectHostCapabilities,
  audioEffectParamsValidationError,
  COMPRESSOR_EFFECT_TYPE,
  createCompressorEffect,
  createLimiterEffect,
  createParametricEqEffect,
  JS_STEREO_BLOCK_CAPABILITY,
  jsStereoBlockCapabilities,
  LIMITER_EFFECT_TYPE,
  migrateAudioEffectDescriptor,
  PARAMETRIC_EQ_EFFECT_TYPE,
  resolveAudioEffectStack,
  supportsJsStereoBlock,
} from './audioEffectStack'

describe('audio-effect registry and identity evaluation', () => {
  test('creates independent versioned defaults for the three built-ins', () => {
    const eq = createParametricEqEffect('afx-eq')
    const compressor = createCompressorEffect('afx-comp')
    const limiter = createLimiterEffect('afx-lim')

    expect(eq.type).toBe(PARAMETRIC_EQ_EFFECT_TYPE)
    expect(compressor.type).toBe(COMPRESSOR_EFFECT_TYPE)
    expect(limiter.type).toBe(LIMITER_EFFECT_TYPE)
    expect(eq.params.band1Gain).toBe(0)
    expect(compressor.params.ratio).toBe(1)
    expect(limiter.params.ceilingDb).toBe(0)
    expect(eq.params).not.toBe(createParametricEqEffect('afx-eq-2').params)
  })

  test('resolves ready, disabled, invalid, and unknown without mutating payloads', () => {
    const ready = createParametricEqEffect('afx-ready')
    const disabled = createCompressorEffect('afx-off')
    disabled.enabled = false
    const invalid = createLimiterEffect('afx-bad')
    invalid.params.ceilingDb = 12
    const unknown: AudioEffectDescriptor = {
      id: 'afx-future',
      type: 'future.exciter',
      version: 4,
      enabled: true,
      params: { sparkle: 0.8, mode: 'air', keep: true },
    }
    const before = JSON.stringify(unknown)
    const resolutions = resolveAudioEffectStack(
      [ready, disabled, invalid, unknown],
      jsStereoBlockCapabilities(),
    )

    expect(resolutions.map((item) => item.status)).toEqual([
      'ready',
      'disabled',
      'invalid',
      'unsupported',
    ])
    expect(JSON.stringify(unknown)).toBe(before)
    expect(audioEffectParamsValidationError(invalid)).toContain('ceilingDb')
  })

  test('reports missing host capability and preserves the descriptor', () => {
    const eq = createParametricEqEffect('afx-eq')
    const [resolution] = resolveAudioEffectStack([eq], new Set())
    expect(resolution.status).toBe('unsupported')
    expect(resolution.detail).toContain(JS_STEREO_BLOCK_CAPABILITY)
    expect(supportsJsStereoBlock({ processStereoBlock: () => undefined })).toBe(true)
    expect(supportsJsStereoBlock({})).toBe(false)
    expect(audioEffectHostCapabilities({ jsStereoBlock: false }).size).toBe(0)
  })

  test('identity processors leave stereo blocks unchanged', () => {
    const left = new Float32Array([0.25, -0.5, 0.75])
    const right = new Float32Array([-0.25, 0.5, -0.75])
    const beforeLeft = Array.from(left)
    const beforeRight = Array.from(right)
    const unknown: AudioEffectDescriptor = {
      id: 'afx-opaque',
      type: 'future.widen',
      version: 1,
      enabled: true,
      params: { width: 2 },
    }

    const resolutions = applyAudioEffectStack(
      left,
      right,
      [createParametricEqEffect('afx-eq'), createCompressorEffect('afx-comp'), unknown],
      jsStereoBlockCapabilities(),
    )

    expect(Array.from(left)).toEqual(beforeLeft)
    expect(Array.from(right)).toEqual(beforeRight)
    expect(resolutions.map((item) => item.status)).toEqual(['ready', 'ready', 'unsupported'])
  })

  test('clones unknown descriptors losslessly during migration', () => {
    const unknown: AudioEffectDescriptor = {
      id: 'afx-unknown',
      type: 'future.effect',
      version: 0,
      enabled: false,
      params: { opaque: 'yes' },
    }
    const migrated = migrateAudioEffectDescriptor(unknown)
    expect(migrated).toEqual(unknown)
    expect(migrated).not.toBe(unknown)
    expect(migrated.params).not.toBe(unknown.params)
  })
})
