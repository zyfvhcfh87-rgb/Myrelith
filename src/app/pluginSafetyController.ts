export const PLUGIN_ACTIVATION_SENTINEL_KEY = 'myrelith.plugin-activation:v1'

export interface PluginSafetyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type PluginStartupSafety =
  | { readonly status: 'clean'; readonly offerSafeMode: false }
  | { readonly status: 'invalid-sentinel'; readonly offerSafeMode: true }
  | { readonly status: 'storage-unavailable'; readonly offerSafeMode: true }
  | {
      readonly status: 'stale-activation'
      readonly offerSafeMode: true
      readonly batchId: string
    }

export interface RunPluginActivationBatchOptions<T> {
  readonly storage: PluginSafetyStorage
  readonly batchId: string
  activate(): Promise<T>
}

export interface PluginSessionSafety {
  enterSafeMode(): void
  continueWithReviewedNormalStartup(): boolean
  startupMode(): PluginSessionStartupMode
  isSafeMode(): boolean
  thirdPartyInitializationAllowed(): boolean
}

export type PluginSessionStartupMode = 'normal' | 'review-required' | 'safe-mode'

export function createPluginSessionSafety(
  startupSafety: PluginStartupSafety,
): PluginSessionSafety {
  let mode: PluginSessionStartupMode = startupSafety.status === 'clean'
    ? 'normal'
    : startupSafety.status === 'stale-activation'
      ? 'review-required'
      : 'safe-mode'
  return Object.freeze({
    enterSafeMode: () => { mode = 'safe-mode' },
    continueWithReviewedNormalStartup: () => {
      if (mode !== 'review-required') return false
      mode = 'normal'
      return true
    },
    startupMode: () => mode,
    isSafeMode: () => mode === 'safe-mode',
    thirdPartyInitializationAllowed: () => mode === 'normal',
  })
}

export function readPluginStartupSafety(storage: PluginSafetyStorage): PluginStartupSafety {
  let raw: string | null
  try {
    raw = storage.getItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
  } catch {
    return Object.freeze({ status: 'storage-unavailable', offerSafeMode: true })
  }
  if (raw === null) return Object.freeze({ status: 'clean', offerSafeMode: false })
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (
        Object.keys(record).length === 2
        && record.version === 1
        && typeof record.batchId === 'string'
        && record.batchId.length > 0
        && record.batchId.length <= 128
      ) {
        return Object.freeze({
          status: 'stale-activation',
          offerSafeMode: true,
          batchId: record.batchId,
        })
      }
    }
  } catch {
    // Any persisted but unreadable activation state is conservatively unsafe.
  }
  return Object.freeze({ status: 'invalid-sentinel', offerSafeMode: true })
}

/** Persist crash intent before third-party registration and clear it only after full success. */
export async function runPluginActivationBatch<T>(
  options: RunPluginActivationBatchOptions<T>,
): Promise<T> {
  if (options.batchId.length === 0 || options.batchId.length > 128) {
    throw new TypeError('Plugin activation batch id must contain 1-128 characters')
  }
  options.storage.setItem(
    PLUGIN_ACTIVATION_SENTINEL_KEY,
    JSON.stringify({ version: 1, batchId: options.batchId }),
  )
  const result = await options.activate()
  options.storage.removeItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
  return result
}
