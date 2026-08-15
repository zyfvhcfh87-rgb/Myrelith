import { describe, expect, test } from 'vitest'
import type { PluginManifestV1 } from './pluginManifest'
import {
  PLUGIN_WASM_BINARY_POLICY_VERSION,
  selectPluginWasmProfile,
} from './pluginWasmPolicy'

type ManifestFacts = Pick<PluginManifestV1, 'contributions'>

function manifestFacts(migrations: readonly { readonly entrypoint: string }[][]): ManifestFacts {
  return {
    contributions: migrations.map((steps, index) => ({
      kind: 'video-effect' as const,
      contributionVersion: 1,
      id: `effect-${index}`,
      name: `Effect ${index}`,
      descriptorVersion: 1,
      entrypoint: `render_${index}`,
      migrations: steps.map((step, stepIndex) => ({
        fromVersion: stepIndex + 1,
        toVersion: stepIndex + 2,
        entrypoint: step.entrypoint,
      })),
      parameters: [],
    })),
  }
}

describe('plugin WebAssembly policy selection', () => {
  test('selects render-general when every signed contribution has no migrations', () => {
    expect(selectPluginWasmProfile(manifestFacts([[], []]))).toEqual({
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      profileId: 'myrelith-wasm-render-general-v1',
    })
  })

  test('selects migration-integer when any signed contribution declares a migration', () => {
    expect(selectPluginWasmProfile(manifestFacts([
      [],
      [{ entrypoint: 'migrate_effect_1_to_2' }],
      [],
    ]))).toEqual({
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      profileId: 'myrelith-wasm-migration-integer-v1',
    })
  })
})
