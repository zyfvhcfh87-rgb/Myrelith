import { create } from 'zustand'
import type { ProxyCacheEntry } from '../domain/proxyCache'

export type ProxyAssetPhase =
  | 'checking'
  | 'unavailable'
  | 'available'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'error'

export interface ProxyAssetState {
  readonly assetId: string
  readonly phase: ProxyAssetPhase
  readonly progress: number
  readonly detail: string
  readonly canGenerate: boolean
  readonly originalAvailable: boolean
  readonly entry: ProxyCacheEntry | null
}

export interface ProxyStorageState {
  readonly supported: boolean
  readonly cacheBytes: number
  readonly itemCount: number
  readonly originUsageBytes: number | null
  readonly originQuotaBytes: number | null
  readonly persisted: boolean | null
  readonly error: string | null
}

const EMPTY_STORAGE: ProxyStorageState = Object.freeze({
  supported: false,
  cacheBytes: 0,
  itemCount: 0,
  originUsageBytes: null,
  originQuotaBytes: null,
  persisted: null,
  error: null,
})

export interface ProxyState {
  readonly assets: Map<string, ProxyAssetState>
  readonly storage: ProxyStorageState
  setAsset(item: ProxyAssetState): void
  removeAsset(assetId: string): void
  replaceAssets(items: Iterable<ProxyAssetState>): void
  setStorage(storage: ProxyStorageState): void
  reset(): void
}

export const useProxyStore = create<ProxyState>()((set) => ({
  assets: new Map(),
  storage: EMPTY_STORAGE,
  setAsset: (item) => set((state) => {
    const current = state.assets.get(item.assetId)
    if (current === item) return state
    const assets = new Map(state.assets)
    assets.set(item.assetId, item)
    return { assets }
  }),
  removeAsset: (assetId) => set((state) => {
    if (!state.assets.has(assetId)) return state
    const assets = new Map(state.assets)
    assets.delete(assetId)
    return { assets }
  }),
  replaceAssets: (items) => set({
    assets: new Map(Array.from(items, (item) => [item.assetId, item])),
  }),
  setStorage: (storage) => set({ storage }),
  reset: () => set({ assets: new Map(), storage: EMPTY_STORAGE }),
}))
