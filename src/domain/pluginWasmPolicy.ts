import type { PluginManifestV1 } from './pluginManifest'

export const PLUGIN_WASM_BINARY_POLICY_VERSION = 1

export type PluginWasmProfileId =
  | 'myrelith-wasm-render-general-v1'
  | 'myrelith-wasm-migration-integer-v1'

export interface PluginWasmProfileSelection {
  readonly binaryPolicyVersion: typeof PLUGIN_WASM_BINARY_POLICY_VERSION
  readonly profileId: PluginWasmProfileId
}

/** Select the whole-module binary policy from already-validated signed manifest facts. */
export function selectPluginWasmProfile(
  manifest: Pick<PluginManifestV1, 'contributions'>,
): PluginWasmProfileSelection {
  const hasMigration = manifest.contributions.some(
    (contribution) => contribution.migrations.length > 0,
  )
  return Object.freeze({
    binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
    profileId: hasMigration
      ? 'myrelith-wasm-migration-integer-v1'
      : 'myrelith-wasm-render-general-v1',
  })
}
