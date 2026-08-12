import { describe, expect, test } from 'vitest'
import { EFFECT_STACK_LIMITS } from './effectBounds'
import { RENDER_SURFACE_BYTES_PER_PIXEL } from './renderSurfaceBudget'
import {
  PLUGIN_HOST_PROFILE_V1,
  PLUGIN_MANIFEST_LIMITS,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  VIDEO_EFFECT_FRAME_CAPABILITY,
  negotiatePluginCompatibility,
  pluginEffectType,
  validatePluginManifest,
} from './pluginManifest'

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: 'com.example.sparkle',
    name: 'Sparkle',
    version: '1.2.3-beta.1+build.7',
    api: { minVersion: 1, maxVersion: 1 },
    runtime: {
      kind: 'wasm',
      entry: 'runtime/sparkle.wasm',
      memoryMaximumPages: 512,
    },
    permissions: [{
      id: VIDEO_EFFECT_FRAME_CAPABILITY,
      minVersion: 1,
      maxVersion: 1,
      required: true,
    }],
    contributions: [{
      kind: 'video-effect',
      contributionVersion: 1,
      id: 'sparkle',
      name: 'Sparkle',
      descriptorVersion: 1,
      entrypoint: 'myrelith_effect_sparkle',
      migrations: [],
      parameters: [
        {
          key: 'strength',
          name: 'Strength',
          kind: 'number',
          default: 0.5,
          min: 0,
          max: 1,
          step: 0.01,
          animatable: true,
        },
        {
          key: 'preserve-alpha',
          name: 'Preserve alpha',
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
    }],
  }
}

function validatedManifest() {
  const result = validatePluginManifest(manifest())
  if (!result.ok) throw new Error(`${result.problem.path}: ${result.problem.message}`)
  return result.manifest
}

describe('plugin manifest', () => {
  test('accepts the bounded non-executing version-1 contract', () => {
    const result = validatePluginManifest(manifest())
    expect(result).toMatchObject({
      ok: true,
      manifest: {
        id: 'com.example.sparkle',
        version: '1.2.3-beta.1+build.7',
        runtime: { kind: 'wasm', entry: 'runtime/sparkle.wasm' },
      },
    })
  })

  test.each([
    ['unknown root field', (value: Record<string, unknown>) => { value.url = 'https://example.com/plugin.js' }, '$.url'],
    ['JavaScript runtime', (value: Record<string, unknown>) => {
      value.runtime = { kind: 'javascript', entry: 'runtime/plugin.js', memoryMaximumPages: 1 }
    }, '$.runtime.kind'],
    ['remote entry', (value: Record<string, unknown>) => {
      value.runtime = { kind: 'wasm', entry: 'https://example.com/plugin.wasm', memoryMaximumPages: 1 }
    }, '$.runtime.entry'],
    ['traversal entry', (value: Record<string, unknown>) => {
      value.runtime = { kind: 'wasm', entry: '../plugin.wasm', memoryMaximumPages: 1 }
    }, '$.runtime.entry'],
    ['unbounded memory', (value: Record<string, unknown>) => {
      value.runtime = {
        kind: 'wasm',
        entry: 'plugin.wasm',
        memoryMaximumPages: PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages + 1,
      }
    }, '$.runtime.memoryMaximumPages'],
  ])('rejects %s before compatibility or execution', (_name, mutate, path) => {
    const value = manifest()
    mutate(value)
    const result = validatePluginManifest(value)
    expect(result).toMatchObject({ ok: false, problem: { path } })
  })

  test('rejects duplicate contributions and malformed parameter defaults', () => {
    const duplicate = manifest()
    const contributions = duplicate.contributions as Record<string, unknown>[]
    contributions.push(structuredClone(contributions[0]))
    expect(validatePluginManifest(duplicate)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[1].id' },
    })

    const malformed = manifest()
    const contribution = (malformed.contributions as Record<string, unknown>[])[0]
    const parameters = contribution.parameters as Record<string, unknown>[]
    parameters[2].default = 'missing'
    expect(validatePluginManifest(malformed)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[0].parameters[2].default' },
    })
  })

  test('requires each contribution to own a unique render entrypoint', () => {
    const value = manifest()
    const contributions = value.contributions as Record<string, unknown>[]
    const secondContribution = structuredClone(contributions[0])
    secondContribution.id = 'glow'
    secondContribution.name = 'Glow'
    contributions.push(secondContribution)

    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[1].entrypoint' },
    })

    secondContribution.entrypoint = 'myrelith_effect_glow'
    expect(validatePluginManifest(value)).toMatchObject({ ok: true })
  })

  test('keeps migration exports disjoint from every render entrypoint', () => {
    const value = manifest()
    const contributions = value.contributions as Record<string, unknown>[]
    const migratingContribution = contributions[0]
    migratingContribution.descriptorVersion = 2
    migratingContribution.migrations = [{
      fromVersion: 1,
      toVersion: 2,
      entrypoint: 'myrelith_effect_glow',
    }]
    const glowContribution = structuredClone(migratingContribution)
    glowContribution.id = 'glow'
    glowContribution.name = 'Glow'
    glowContribution.descriptorVersion = 1
    glowContribution.entrypoint = 'myrelith_effect_glow'
    glowContribution.migrations = []

    for (const orderedContributions of [
      [migratingContribution, glowContribution],
      [glowContribution, migratingContribution],
    ]) {
      value.contributions = orderedContributions
      const migrationIndex = orderedContributions.indexOf(migratingContribution)
      expect(validatePluginManifest(value)).toMatchObject({
        ok: false,
        problem: {
          path: `$.contributions[${migrationIndex}].migrations[0].entrypoint`,
        },
      })
    }
  })

  test('keeps declared numeric values inside the shared durable effect bound', () => {
    for (const field of ['min', 'max', 'default'] as const) {
      const value = manifest()
      const contribution = (value.contributions as Record<string, unknown>[])[0]
      const parameter = (contribution.parameters as Record<string, unknown>[])[0]
      parameter[field] = field === 'min'
        ? -(EFFECT_STACK_LIMITS.maxFiniteMagnitude + 1)
        : EFFECT_STACK_LIMITS.maxFiniteMagnitude + 1
      const result = validatePluginManifest(value)
      expect(result).toMatchObject({
        ok: false,
        problem: { path: `$.contributions[0].parameters[0].${field}` },
      })
    }
  })

  test.each([
    ['minimum', -EFFECT_STACK_LIMITS.maxFiniteMagnitude, 0, 1e-9],
    ['maximum', 0, EFFECT_STACK_LIMITS.maxFiniteMagnitude, 1e-9],
    ['both large positive', 999_999_999, 1_000_000_000, Number.MIN_VALUE],
  ])('rejects a numeric step that cannot advance from the %s endpoint', (_name, minimum, maximum, step) => {
    const value = manifest()
    const contribution = (value.contributions as Record<string, unknown>[])[0]
    const parameter = (contribution.parameters as Record<string, unknown>[])[0]
    parameter.min = minimum
    parameter.max = maximum
    parameter.default = minimum
    parameter.step = step

    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: {
        path: '$.contributions[0].parameters[0].step',
        message: 'must make representable progress from both declared endpoints',
      },
    })
  })

  test.each([
    [-EFFECT_STACK_LIMITS.maxFiniteMagnitude, 0, 0.25],
    [0, EFFECT_STACK_LIMITS.maxFiniteMagnitude, 0.25],
    [999_999_999, 1_000_000_000, 0.25],
  ])('accepts a numeric step that advances both endpoints in [%s, %s]', (minimum, maximum, step) => {
    const value = manifest()
    const contribution = (value.contributions as Record<string, unknown>[])[0]
    const parameter = (contribution.parameters as Record<string, unknown>[])[0]
    parameter.min = minimum
    parameter.max = maximum
    parameter.default = minimum
    parameter.step = step

    expect(validatePluginManifest(value)).toMatchObject({ ok: true })
  })

  test.each(['constructor', 'prototype'])(
    'rejects reserved durable parameter key %s',
    (key) => {
      const value = manifest()
      const contribution = (value.contributions as Record<string, unknown>[])[0]
      const parameter = (contribution.parameters as Record<string, unknown>[])[0]
      parameter.key = key
      expect(validatePluginManifest(value)).toMatchObject({
        ok: false,
        problem: { path: '$.contributions[0].parameters[0].key' },
      })
    },
  )

  test('pins the fixed module-owned and host I/O memory regions', () => {
    expect(PLUGIN_MANIFEST_LIMITS.wasmPageBytes).toBe(65_536)
    expect(PLUGIN_MANIFEST_LIMITS.moduleDataRegionBytes).toBe(8 * 1024 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.moduleWorkspaceRegionBytes).toBe(8 * 1024 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.maxCanonicalParameterBytes).toBe(65_536)
    expect(PLUGIN_MANIFEST_LIMITS.parameterRegionOffsetBytes).toBe(16 * 1024 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.pixelRegionOffsetBytes).toBe(16 * 1024 * 1024 + 65_536)
    expect(PLUGIN_MANIFEST_LIMITS.pixelRegionOffsetPages).toBe(257)
    expect(PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages).toBe(258)
    expect(PLUGIN_MANIFEST_LIMITS.minWasmMemoryBytes).toBe(16 * 1024 * 1024 + 128 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages).toBe(1_025)
    expect(PLUGIN_MANIFEST_LIMITS.maxWasmMemoryBytes).toBe(64 * 1024 * 1024 + 65_536)
    expect(PLUGIN_MANIFEST_LIMITS.maxPixelRegionBytes).toBe(48 * 1024 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.maxPluginFrameBytes).toBe(48 * 1024 * 1024)
    expect(PLUGIN_MANIFEST_LIMITS.maxPluginFramePixels).toBe(12_582_912)
    expect(PLUGIN_MANIFEST_LIMITS.pluginFramePixelsPerMemoryPage).toBe(16_384)
    expect(
      (PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages
        - PLUGIN_MANIFEST_LIMITS.pixelRegionOffsetPages)
        * PLUGIN_MANIFEST_LIMITS.pluginFramePixelsPerMemoryPage,
    ).toBe(PLUGIN_MANIFEST_LIMITS.maxPluginFramePixels)
    expect(
      PLUGIN_MANIFEST_LIMITS.maxPluginFramePixels
        * RENDER_SURFACE_BYTES_PER_PIXEL,
    ).toBe(PLUGIN_MANIFEST_LIMITS.maxPluginFrameBytes)
    expect(
      (PLUGIN_MANIFEST_LIMITS.maxPluginFramePixels + 1)
        * RENDER_SURFACE_BYTES_PER_PIXEL,
    ).toBe(PLUGIN_MANIFEST_LIMITS.maxPluginFrameBytes + 4)

    const value = manifest()
    const runtime = value.runtime as Record<string, unknown>
    runtime.memoryMaximumPages = PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages
    expect(validatePluginManifest(value)).toMatchObject({ ok: true })
  })

  test('rejects memory requests below the fixed-layout minimum', () => {
    const value = manifest()
    const runtime = value.runtime as Record<string, unknown>
    runtime.memoryMaximumPages = PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages - 1
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: {
        path: '$.runtime.memoryMaximumPages',
        message: `must be a safe integer between ${PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages} and ${PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages}`,
      },
    })
  })

  test('the minimum memory request exposes exactly one RGBA page', () => {
    const value = manifest()
    const runtime = value.runtime as Record<string, unknown>
    runtime.memoryMaximumPages = PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages
    expect(validatePluginManifest(value)).toMatchObject({ ok: true })
    expect(
      (PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages
        - PLUGIN_MANIFEST_LIMITS.pixelRegionOffsetPages)
        * PLUGIN_MANIFEST_LIMITS.pluginFramePixelsPerMemoryPage,
    ).toBe(16_384)
  })

  test('validates explicit descriptor migration chains and entrypoints', () => {
    const value = manifest()
    const contribution = (value.contributions as Record<string, unknown>[])[0]
    contribution.descriptorVersion = 3
    contribution.migrations = [
      { fromVersion: 1, toVersion: 2, entrypoint: 'migrate_sparkle_v1_to_v2' },
      { fromVersion: 2, toVersion: 3, entrypoint: 'migrate_sparkle_v2_to_v3' },
    ]
    expect(validatePluginManifest(value)).toMatchObject({
      ok: true,
      manifest: {
        contributions: [{
          descriptorVersion: 3,
          migrations: [
            { fromVersion: 1, toVersion: 2, entrypoint: 'migrate_sparkle_v1_to_v2' },
            { fromVersion: 2, toVersion: 3, entrypoint: 'migrate_sparkle_v2_to_v3' },
          ],
        }],
      },
    })

    contribution.migrations = [
      { fromVersion: 1, toVersion: 2, entrypoint: 'migrate_sparkle_v1_to_v2' },
    ]
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[0].migrations[0].toVersion' },
    })

    contribution.descriptorVersion = 2
    contribution.migrations = []
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[0].migrations' },
    })
  })

  test('requires distinct migration buffers and a non-render export', () => {
    const value = manifest()
    const contribution = (value.contributions as Record<string, unknown>[])[0]
    contribution.descriptorVersion = 2
    contribution.migrations = [{
      fromVersion: 1,
      toVersion: 2,
      entrypoint: 'myrelith_effect_sparkle',
    }]
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.contributions[0].migrations[0].entrypoint' },
    })

    const migrations = contribution.migrations as Record<string, unknown>[]
    migrations[0].entrypoint = 'migrate_sparkle_v1_to_v2'
    const runtime = value.runtime as Record<string, unknown>
    runtime.memoryMaximumPages = PLUGIN_MANIFEST_LIMITS.minWasmMemoryPages - 1
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.runtime.memoryMaximumPages' },
    })
  })

  test('requires video effects to declare their frame permission as required', () => {
    const value = manifest()
    const permissions = value.permissions as Record<string, unknown>[]
    permissions[0].required = false
    expect(validatePluginManifest(value)).toMatchObject({
      ok: false,
      problem: { path: '$.permissions' },
    })
  })

  test('negotiates exact API and permission versions without granting consent', () => {
    const compatible = negotiatePluginCompatibility(validatedManifest())
    expect(compatible).toEqual({
      status: 'compatible',
      apiVersion: 1,
      permissions: [{
        id: VIDEO_EFFECT_FRAME_CAPABILITY,
        required: true,
        version: 1,
        status: 'available',
      }],
      contributions: [{
        id: 'sparkle',
        kind: 'video-effect',
        version: 1,
        status: 'available',
      }],
      reasons: [],
    })

    const unavailable = negotiatePluginCompatibility(validatedManifest(), {
      ...PLUGIN_HOST_PROFILE_V1,
      permissions: [],
    })
    expect(unavailable.status).toBe('incompatible')
    expect(unavailable.reasons).toEqual([
      `Required permission ${VIDEO_EFFECT_FRAME_CAPABILITY} 1-1 is unavailable.`,
    ])
  })

  test('allows unavailable optional future permissions without silently selecting them', () => {
    const value = manifest()
    const permissions = value.permissions as Record<string, unknown>[]
    permissions.push({
      id: 'com.example.optional-cache',
      minVersion: 1,
      maxVersion: 2,
      required: false,
    })
    const result = validatePluginManifest(value)
    if (!result.ok) throw new Error(`${result.problem.path}: ${result.problem.message}`)
    expect(negotiatePluginCompatibility(result.manifest)).toMatchObject({
      status: 'compatible',
      permissions: [
        { id: VIDEO_EFFECT_FRAME_CAPABILITY, status: 'available' },
        { id: 'com.example.optional-cache', status: 'unavailable', version: null },
      ],
    })
  })

  test('rejects an unsupported contribution contract without changing the descriptor schema', () => {
    const plugin = validatedManifest()
    const incompatible = negotiatePluginCompatibility(plugin, {
      ...PLUGIN_HOST_PROFILE_V1,
      contributions: [{ kind: 'video-effect', version: 2 }],
    })
    expect(incompatible).toMatchObject({
      status: 'incompatible',
      contributions: [{ id: 'sparkle', version: 1, status: 'unavailable' }],
      reasons: ['Contribution sparkle requires video-effect version 1.'],
    })
    expect(plugin.contributions[0].descriptorVersion).toBe(1)
  })

  test('derives a stable namespaced effect type without a location or package digest', () => {
    expect(pluginEffectType('com.example.sparkle', 'sparkle'))
      .toBe('plugin:com.example.sparkle/sparkle')
  })
})
