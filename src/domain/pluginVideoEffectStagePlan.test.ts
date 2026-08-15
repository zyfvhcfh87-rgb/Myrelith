import { describe, expect, test } from 'vitest'
import {
  createColorAdjustEffect,
  createMaskEffect,
} from './effectStack'
import {
  canonicalPluginVideoEffectParameterJson,
  createPluginVideoEffectContributionSnapshot,
  resolveVideoEffectStagePlan,
  type PluginVideoEffectContributionAvailability,
  type PluginVideoEffectContributionDeclarationInput,
} from './pluginVideoEffectStagePlan'
import type { Clip, EffectDescriptor } from './schema'

const SIGNER = `sha256:${'1'.repeat(64)}`
const PACKAGE = `sha256:${'2'.repeat(64)}`
const EFFECT_TYPE = 'plugin:com.example.sparkle/sparkle'

function declaration(
  availability: PluginVideoEffectContributionAvailability = 'ready',
): PluginVideoEffectContributionDeclarationInput {
  return {
    signerFingerprint: SIGNER,
    packageDigest: PACKAGE,
    pluginId: 'com.example.sparkle',
    pluginVersion: '1.2.3',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId: 'sparkle',
    contributionName: 'Sparkle',
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_sparkle',
    parameters: [
      {
        key: 'strength',
        name: 'Strength',
        kind: 'number',
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.1,
        animatable: true,
      },
      {
        key: 'enabled',
        name: 'Enabled',
        kind: 'boolean',
        default: true,
      },
      {
        key: 'mode',
        name: 'Mode',
        kind: 'enum',
        default: 'soft',
        options: [
          { value: 'soft', name: 'Soft' },
          { value: 'hard', name: 'Hard' },
        ],
      },
    ],
    availability,
    detail: availability === 'ready' ? 'Ready to render.' : `Policy status: ${availability}.`,
  }
}

function pluginEffect(
  patch: Partial<EffectDescriptor> = {},
): EffectDescriptor {
  return {
    id: 'plugin-effect',
    type: EFFECT_TYPE,
    version: 1,
    enabled: true,
    params: { strength: 0.25, enabled: true, mode: 'soft' },
    ...patch,
  }
}

function clip(effects: EffectDescriptor[]): Clip {
  return {
    id: 'clip',
    assetId: 'asset',
    name: 'Clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 20 },
    timelineRange: { startFrame: 10, durationFrames: 20 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects,
  }
}

function snapshot(
  availability: PluginVideoEffectContributionAvailability = 'ready',
) {
  return createPluginVideoEffectContributionSnapshot(7, [declaration(availability)])
}

describe('plugin video effect stage plan', () => {
  test('keeps built-in pixel projections and a ready plugin in authored order', () => {
    const color = createColorAdjustEffect('color')
    color.params.exposure = 0.5
    const mask = createMaskEffect('mask', 'ellipse')
    mask.params.width = 0.5
    const plan = resolveVideoEffectStagePlan(
      clip([color, pluginEffect(), mask]),
      10,
      snapshot(),
    )

    expect(plan?.requiresOrderedPixelPath).toBe(true)
    expect(plan?.stages.map((stage) => [stage.kind, stage.effect.id, stage.status]))
      .toEqual([
        ['builtin', 'color', 'ready'],
        ['plugin', 'plugin-effect', 'ready'],
        ['builtin', 'mask', 'ready'],
      ])
    expect(plan?.stages[0]).toMatchObject({
      kind: 'builtin',
      pixelEffect: { kind: 'color-adjust' },
    })
    expect(plan?.stages[2]).toMatchObject({
      kind: 'builtin',
      pixelEffect: { kind: 'mask' },
    })
    expect(plan?.stages[1]).toMatchObject({
      kind: 'plugin',
      execution: {
        catalogGeneration: 7,
        signerFingerprint: SIGNER,
        packageDigest: PACKAGE,
        pluginId: 'com.example.sparkle',
        pluginVersion: '1.2.3',
        contributionVersion: 1,
        contributionId: 'sparkle',
        entrypoint: 'myrelith_effect_sparkle',
      },
    })
  })

  test('uses the shared animation evaluator and canonicalizes cloned bounded parameters', () => {
    const source = declaration()
    const installed = createPluginVideoEffectContributionSnapshot(9, [source])
    const animated = clip([pluginEffect({ params: { enabled: true, mode: 'soft' } })])
    animated.animation = {
      tracks: [],
      effectTracks: [
        {
          effectId: 'plugin-effect',
          parameter: 'strength',
          keyframes: [
            { frame: 0, value: 0, easing: { type: 'linear' } },
            { frame: 10, value: 1, easing: { type: 'linear' } },
          ],
        },
        {
          effectId: 'plugin-effect',
          parameter: 'enabled',
          keyframes: [
            { frame: 0, value: 0, easing: { type: 'linear' } },
          ],
        },
      ],
    }

    const plan = resolveVideoEffectStagePlan(animated, 15, installed)
    const stage = plan?.stages[0]
    expect(stage).toMatchObject({
      kind: 'plugin',
      status: 'ready',
      execution: {
        parameterRecord: { enabled: true, mode: 'soft', strength: 0.5 },
        canonicalParameterJson: '{"enabled":true,"mode":"soft","strength":0.5}',
      },
    })
    if (stage?.kind !== 'plugin' || stage.execution === null) return
    expect(Object.isFrozen(stage.execution.parameterRecord)).toBe(true)
    expect(Object.isFrozen(installed)).toBe(true)
    expect(Object.isFrozen(installed.declarations[0].parameters)).toBe(true)

    const strength = source.parameters[0]
    if (strength.kind !== 'number') return
    const mutableStrength = strength as { default: number }
    mutableStrength.default = 0.9
    expect(installed.declarations[0].parameters[0]).toMatchObject({ default: 0.2 })
  })

  test('canonicalizes the restricted JCS primitive vocabulary without browser APIs', () => {
    expect(canonicalPluginVideoEffectParameterJson({ z: -0, a: true, m: 'soft' }))
      .toBe('{"a":true,"m":"soft","z":0}')
    expect(() => canonicalPluginVideoEffectParameterJson({ constructor: true }))
      .toThrow(/invalid key/)
  })

  test.each([
    'disabled',
    'incompatible',
    'failed',
    'revoked',
    'untrusted',
    'safe-mode',
    'quarantined',
  ] as const)('retains exact host-authored %s availability without execution', (status) => {
    const plan = resolveVideoEffectStagePlan(
      clip([pluginEffect()]),
      10,
      snapshot(status),
    )
    const stage = plan?.stages[0]
    expect(stage).toMatchObject({ kind: 'plugin', status, execution: null })
    expect(plan?.requiresOrderedPixelPath).toBe(false)
  })

  test('derives missing, malformed, disabled, version, and schema failures fail-closed', () => {
    const cases: Array<[EffectDescriptor, ReturnType<typeof snapshot> | undefined, string]> = [
      [pluginEffect({ type: 'plugin:com.example.missing/missing' }), snapshot(), 'missing'],
      [pluginEffect({ type: 'plugin:malformed' }), snapshot(), 'invalid'],
      [pluginEffect({ enabled: false }), snapshot(), 'disabled'],
      [pluginEffect({ version: 2 }), snapshot(), 'version-mismatch'],
      [pluginEffect({ params: { strength: 'loud', enabled: true, mode: 'soft' } }), snapshot(), 'invalid'],
      [pluginEffect({ params: { strength: 0.5, enabled: true, mode: 'soft', future: true } }), snapshot(), 'unsupported'],
      [pluginEffect(), undefined, 'missing'],
    ]
    for (const [effect, installed, status] of cases) {
      const stage = resolveVideoEffectStagePlan(clip([effect]), 10, installed)?.stages[0]
      expect(stage).toMatchObject({ kind: 'plugin', status, execution: null })
    }
  })

  test('returns null for wholly built-in stacks and rejects malformed catalog identities', () => {
    expect(resolveVideoEffectStagePlan(
      clip([createColorAdjustEffect('color')]),
      10,
      snapshot(),
    )).toBeNull()
    expect(() => createPluginVideoEffectContributionSnapshot(0, [{
      ...declaration(),
      packageDigest: 'sha256:not-a-digest',
    }])).toThrow(/packageDigest/)
  })
})
