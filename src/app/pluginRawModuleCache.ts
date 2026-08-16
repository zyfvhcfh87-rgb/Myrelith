import type { PluginWasmProfileSelection } from '../domain/pluginWasmPolicy'

export const PLUGIN_RAW_MODULE_CACHE_MAX_ENTRIES = 8
export const PLUGIN_RAW_MODULE_CACHE_MAX_BYTES = 64 * 1_024 * 1_024
export const PLUGIN_RAW_MODULE_MAX_BYTES = 32 * 1_024 * 1_024

export interface PluginRawModuleCacheKey {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly modulePath: string
  readonly moduleSha256: string
  readonly moduleByteLength: number
  readonly hostApiVersion: number
  readonly selectedCapabilities: readonly {
    readonly id: string
    readonly version: number
  }[]
  readonly memoryMaximumPages: number
  readonly policy: PluginWasmProfileSelection
  readonly opcodeTableDigest: string
  readonly contributionIdentityKey: string
}

export interface PluginRawModuleCacheSnapshot {
  readonly entryCount: number
  readonly byteLength: number
  readonly bypassCount: number
  readonly evictionCount: number
}

export interface PluginRawModuleCache {
  get(key: PluginRawModuleCacheKey): Uint8Array | undefined
  put(key: PluginRawModuleCacheKey, moduleBytes: Uint8Array): boolean
  invalidatePlugin(pluginId: string): void
  clear(): void
  getSnapshot(): PluginRawModuleCacheSnapshot
}

interface CacheEntry {
  readonly key: PluginRawModuleCacheKey
  readonly serializedKey: string
  readonly bytes: Uint8Array
  accessSequence: number
}

function serializeKey(key: PluginRawModuleCacheKey): string {
  const selectedCapabilities = [...key.selectedCapabilities]
    .map((capability) => [capability.id, capability.version] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1])
  return JSON.stringify([
    key.pluginId,
    key.pluginVersion,
    key.packageDigest,
    key.signerFingerprint,
    key.modulePath,
    key.moduleSha256,
    key.moduleByteLength,
    key.hostApiVersion,
    selectedCapabilities,
    key.memoryMaximumPages,
    key.policy.binaryPolicyVersion,
    key.policy.profileId,
    key.opcodeTableDigest,
    key.contributionIdentityKey,
  ])
}

export function createPluginRawModuleCache(): PluginRawModuleCache {
  const entries = new Map<string, CacheEntry>()
  let sequence = 0
  let byteLength = 0
  let bypassCount = 0
  let evictionCount = 0

  const nextSequence = (): number => {
    if (sequence === Number.MAX_SAFE_INTEGER) {
      const ordered = [...entries.values()].sort((left, right) => (
        left.accessSequence - right.accessSequence
          || left.serializedKey.localeCompare(right.serializedKey)
      ))
      ordered.forEach((entry, index) => { entry.accessSequence = index + 1 })
      sequence = ordered.length
    }
    sequence++
    return sequence
  }

  const evictOldest = (): boolean => {
    let oldest: CacheEntry | undefined
    for (const entry of entries.values()) {
      if (!oldest || entry.accessSequence < oldest.accessSequence
        || (entry.accessSequence === oldest.accessSequence
          && entry.serializedKey.localeCompare(oldest.serializedKey) < 0)) {
        oldest = entry
      }
    }
    if (!oldest) return false
    entries.delete(oldest.serializedKey)
    oldest.bytes.fill(0)
    byteLength -= oldest.bytes.byteLength
    evictionCount++
    return true
  }

  return {
    get(key) {
      const entry = entries.get(serializeKey(key))
      if (!entry) return undefined
      entry.accessSequence = nextSequence()
      return entry.bytes.slice()
    },
    put(key, moduleBytes) {
      if (!(moduleBytes instanceof Uint8Array)
        || moduleBytes.byteLength === 0
        || moduleBytes.byteLength !== key.moduleByteLength
        || moduleBytes.byteLength > PLUGIN_RAW_MODULE_MAX_BYTES
        || moduleBytes.byteLength > PLUGIN_RAW_MODULE_CACHE_MAX_BYTES) {
        bypassCount++
        return false
      }
      const serializedKey = serializeKey(key)
      const existing = entries.get(serializedKey)
      if (existing) {
        byteLength -= existing.bytes.byteLength
        entries.delete(serializedKey)
        existing.bytes.fill(0)
      }
      while (entries.size >= PLUGIN_RAW_MODULE_CACHE_MAX_ENTRIES
        || byteLength > PLUGIN_RAW_MODULE_CACHE_MAX_BYTES - moduleBytes.byteLength) {
        if (!evictOldest()) {
          bypassCount++
          return false
        }
      }
      const bytes = moduleBytes.slice()
      entries.set(serializedKey, {
        key: Object.freeze({
          ...key,
          policy: Object.freeze({ ...key.policy }),
          selectedCapabilities: Object.freeze(
            key.selectedCapabilities.map((capability) => Object.freeze({ ...capability })),
          ),
        }),
        serializedKey,
        bytes,
        accessSequence: nextSequence(),
      })
      byteLength += bytes.byteLength
      return true
    },
    invalidatePlugin(pluginId) {
      for (const [serializedKey, entry] of entries) {
        if (entry.key.pluginId === pluginId) {
          entries.delete(serializedKey)
          entry.bytes.fill(0)
          byteLength -= entry.bytes.byteLength
        }
      }
    },
    clear() {
      for (const entry of entries.values()) entry.bytes.fill(0)
      entries.clear()
      byteLength = 0
    },
    getSnapshot() {
      return Object.freeze({
        entryCount: entries.size,
        byteLength,
        bypassCount,
        evictionCount,
      })
    },
  }
}
