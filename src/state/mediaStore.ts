/**
 * state/mediaStore.ts — The session-owned media pool.
 *
 * Production imports arrive fully analyzed from app/mediaImportController;
 * this store never demuxes files or exposes half-committed placeholders.
 */

import { create } from 'zustand'
import type { FrameRate, MediaAsset } from '../domain/schema'
import { microsecondsToFrames } from '../domain/time'

/**
 * Precomputed timeline eye-candy for one asset (filmstrip on video clips,
 * waveform on audio clips), generated once per asset by
 * app/mediaVisualsController. Both images span the asset's full duration.
 * Every URL here is owned by this store.
 */
export interface AssetVisuals {
  filmstrip: {
    url: string
    tiles: number
    tileWidth: number
    tileHeight: number
  } | null
  waveform: { url: string; width: number; height: number } | null
}

function visualUrls(visuals: AssetVisuals): string[] {
  const urls: string[] = []
  if (visuals.filmstrip) urls.push(visuals.filmstrip.url)
  if (visuals.waveform) urls.push(visuals.waveform.url)
  return urls
}

export interface MediaState {
  /** All imported assets, keyed by stable asset id. Treated as immutable. */
  assets: Map<string, MediaAsset>
  /** Generated clip visuals, keyed by asset id. */
  visuals: Map<string, AssetVisuals>

  /**
   * Commit one fully analyzed asset and take ownership of its object URL.
   * Duplicate ids are rejected; the caller retains URL ownership when false.
   */
  addAsset: (asset: MediaAsset) => boolean
  /** Revoke and remove every session-owned source and generated visual. */
  clearAssets: () => void
  /** Remove an asset and revoke every object URL owned for it. */
  removeAsset: (id: string) => void
  /**
   * Re-express every duration at a new project rate. Canonical microseconds
   * remain unchanged, and an already-conformed pool emits no update.
   */
  reconformAssets: (rate: FrameRate) => void
  /**
   * Attach generated visuals. Late results for removed assets are revoked
   * immediately, so URL ownership remains exact on every path.
   */
  setAssetVisuals: (id: string, visuals: AssetVisuals) => void
}

export const useMediaStore = create<MediaState>()((set) => ({
  assets: new Map(),
  visuals: new Map(),

  addAsset: (asset) => {
    let added = false
    set((state) => {
      if (state.assets.has(asset.id)) return state
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      added = true
      return { assets }
    })
    return added
  },

  clearAssets: () =>
    set((state) => {
      if (state.assets.size === 0 && state.visuals.size === 0) return state
      const urls = new Set<string>()
      for (const asset of state.assets.values()) urls.add(asset.objectUrl)
      for (const visuals of state.visuals.values()) {
        for (const url of visualUrls(visuals)) urls.add(url)
      }
      for (const url of urls) URL.revokeObjectURL(url)
      return { assets: new Map(), visuals: new Map() }
    }),

  removeAsset: (id) =>
    set((state) => {
      const asset = state.assets.get(id)
      if (!asset) return state
      URL.revokeObjectURL(asset.objectUrl)
      const assets = new Map(state.assets)
      assets.delete(id)
      const existingVisuals = state.visuals.get(id)
      if (!existingVisuals) return { assets }
      for (const url of visualUrls(existingVisuals)) URL.revokeObjectURL(url)
      const visuals = new Map(state.visuals)
      visuals.delete(id)
      return { assets, visuals }
    }),

  reconformAssets: (rate) =>
    set((state) => {
      let assets: Map<string, MediaAsset> | null = null
      for (const asset of state.assets.values()) {
        const durationFrames = microsecondsToFrames(
          asset.durationMicroseconds,
          rate,
        )
        if (durationFrames === asset.durationFrames) continue
        assets ??= new Map(state.assets)
        assets.set(asset.id, { ...asset, durationFrames })
      }
      return assets ? { assets } : state
    }),

  setAssetVisuals: (id, next) =>
    set((state) => {
      if (!state.assets.has(id)) {
        for (const url of visualUrls(next)) URL.revokeObjectURL(url)
        return state
      }
      const previous = state.visuals.get(id)
      if (previous) {
        for (const url of visualUrls(previous)) URL.revokeObjectURL(url)
      }
      const visuals = new Map(state.visuals)
      visuals.set(id, next)
      return { visuals }
    }),
}))
