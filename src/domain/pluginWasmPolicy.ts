export const PLUGIN_WASM_BINARY_POLICY_VERSION = 1

export type PluginWasmProfileId =
  | 'myrelith-wasm-render-general-v1'
  | 'myrelith-wasm-migration-integer-v1'

export interface PluginWasmProfileSelection {
  readonly binaryPolicyVersion: typeof PLUGIN_WASM_BINARY_POLICY_VERSION
  readonly profileId: PluginWasmProfileId
}

/**
 * Select the whole-module binary policy from already-validated signed facts:
 * a manifest, or the verified activation bundle derived from one.
 */
export function selectPluginWasmProfile(manifest: {
  readonly contributions: readonly { readonly migrations: readonly unknown[] }[]
}): PluginWasmProfileSelection {
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
