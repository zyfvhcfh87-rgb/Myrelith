import { describe, expect, test } from 'vitest'
import {
  PLUGIN_HOST_PROFILE_V1,
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
      value.runtime = { kind: 'wasm', entry: 'plugin.wasm', memoryMaximumPages: 1025 }
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
