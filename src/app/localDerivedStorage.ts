import { proxyStorage } from './proxyStorage'
import { analysisStorage } from './analysisStorage'

/**
 * Strict registry for disposable origin-local artifacts.
 *
 * Project files, recovery journals, recent handles, and remembered media
 * handles are deliberately absent. Future proxy/cache owners must opt in with
 * an exact provider, so clearing derived data cannot broaden into project
 * truth by accident.
 */

export interface DisposableStorageEstimate {
  bytes: number
  itemCount: number
}

export interface DisposableStorageProvider {
  readonly id: string
  estimate(): Promise<DisposableStorageEstimate>
  clear(): Promise<void>
}

export interface DisposableStorageController {
  estimate(): Promise<DisposableStorageEstimate>
  clear(): Promise<void>
}

function assertEstimate(
  providerId: string,
  estimate: DisposableStorageEstimate,
): DisposableStorageEstimate {
  if (
    !Number.isSafeInteger(estimate.bytes)
    || estimate.bytes < 0
    || !Number.isSafeInteger(estimate.itemCount)
    || estimate.itemCount < 0
  ) {
    throw new TypeError(`Disposable storage provider "${providerId}" returned invalid usage`)
  }
  return estimate
}

export function createDisposableStorageController(
  providers: readonly DisposableStorageProvider[],
): DisposableStorageController {
  const ids = new Set<string>()
  for (const provider of providers) {
    if (!provider.id || ids.has(provider.id)) {
      throw new TypeError('Disposable storage provider ids must be unique')
    }
    ids.add(provider.id)
  }

  return {
    async estimate() {
      const estimates = await Promise.all(providers.map(async (provider) => (
        assertEstimate(provider.id, await provider.estimate())
      )))
      return estimates.reduce<DisposableStorageEstimate>(
        (total, estimate) => ({
          bytes: total.bytes + estimate.bytes,
          itemCount: total.itemCount + estimate.itemCount,
        }),
        { bytes: 0, itemCount: 0 },
      )
    },
    async clear() {
      for (const provider of providers) await provider.clear()
    },
  }
}

export const localDerivedStorage = createDisposableStorageController([
  {
    id: 'opfs-proxy-cache-v1',
    async estimate() {
      const estimate = await proxyStorage.estimate()
      return {
        bytes: estimate.cacheBytes,
        itemCount: estimate.itemCount,
      }
    },
    async clear() {
      await proxyStorage.clear()
    },
  },
  {
    id: 'opfs-analysis-cache-v1',
    async estimate() {
      const estimate = await analysisStorage.estimate()
      return {
        bytes: estimate.cacheBytes,
        itemCount: estimate.itemCount,
      }
    },
    async clear() {
      await analysisStorage.clear()
    },
  },
])
