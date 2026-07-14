/**
 * state/mediaStore.ts — The durable media catalog plus session connections.
 *
 * Production imports arrive fully analyzed from app/mediaImportController;
 * this store never demuxes files or exposes half-committed placeholders.
 */

import { create } from 'zustand'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { FrameRate, MediaAsset } from '../domain/schema'
import { microsecondsToFrames } from '../domain/time'

/**
 * Precomputed timeline eye-candy for one connected asset (filmstrip on video
 * clips, waveform on audio clips), generated once per connection by
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

function revokeUrls(
  urls: Iterable<string>,
  protectedUrls: ReadonlySet<string> = new Set(),
): void {
  const unique = new Set(urls)
  for (const url of unique) {
    if (!protectedUrls.has(url)) URL.revokeObjectURL(url)
  }
}

function descriptorFromAsset(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    nativeFrameRate: asset.frameRate === null ? null : { ...asset.frameRate },
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function ratesMatch(
  descriptor: FrameRate | null,
  connected: FrameRate | null,
): boolean {
  if (descriptor === null || connected === null) return descriptor === connected
  return descriptor.num === connected.num && descriptor.den === connected.den
}

function connectionMatchesDescriptor(
  descriptor: PortableAssetDescriptor,
  asset: MediaAsset,
): boolean {
  return descriptor.id === asset.id
    && descriptor.fileName === asset.fileName
    && descriptor.mimeType === asset.mimeType
    && descriptor.size === asset.size
    && descriptor.lastModified === asset.lastModified
    && descriptor.kind === asset.kind
    && descriptor.durationMicroseconds === asset.durationMicroseconds
    && ratesMatch(descriptor.nativeFrameRate, asset.frameRate)
    && descriptor.width === asset.width
    && descriptor.height === asset.height
    && descriptor.hasAudio === asset.hasAudio
    && descriptor.audioSampleRate === asset.audioSampleRate
    && descriptor.audioChannels === asset.audioChannels
}

function descriptorMapFrom(
  descriptors: Iterable<PortableAssetDescriptor>,
): Map<string, PortableAssetDescriptor> | null {
  const catalog = new Map<string, PortableAssetDescriptor>()
  for (const descriptor of descriptors) {
    if (catalog.has(descriptor.id)) return null
    catalog.set(descriptor.id, descriptor)
  }
  return catalog
}

function connectionMapFrom(
  catalog: ReadonlyMap<string, PortableAssetDescriptor>,
  assets: Iterable<MediaAsset>,
): Map<string, MediaAsset> | null {
  const connected = new Map<string, MediaAsset>()
  for (const asset of assets) {
    const descriptor = catalog.get(asset.id)
    if (
      connected.has(asset.id)
      || !descriptor
      || !connectionMatchesDescriptor(descriptor, asset)
    ) {
      return null
    }
    connected.set(asset.id, asset)
  }
  return connected
}

export interface MediaState {
  /** Durable portable descriptors for every project source, online or offline. */
  descriptors: Map<string, PortableAssetDescriptor>
  /** Session-connected analyzed assets, always a subset of descriptors. */
  assets: Map<string, MediaAsset>
  /** Generated clip visuals for connected assets, keyed by asset id. */
  visuals: Map<string, AssetVisuals>

  /**
   * Import one fully analyzed asset atomically: add its durable descriptor and
   * connected session object together, then take ownership of its object URL.
   * Duplicate ids are rejected; the caller retains URL ownership when false.
   */
  addAsset: (asset: MediaAsset) => boolean
  /**
   * Connect an analyzed source to an existing descriptor without replacing the
   * descriptor Map or descriptor object. The caller retains ownership on false.
   */
  connectAsset: (asset: MediaAsset) => boolean
  /**
   * Drop only the session connection and visuals. The durable descriptor stays
   * in the project catalog so the source can be reconnected later.
   */
  disconnectAsset: (id: string) => void
  /**
   * Atomically install a complete project descriptor catalog plus any connected
   * subset. On success the store takes incoming source-URL ownership and revokes
   * every outgoing source/visual URL no longer present. Invalid input is a no-op.
   */
  replaceAssets: (
    descriptors: Iterable<PortableAssetDescriptor>,
    assets: Iterable<MediaAsset>,
  ) => boolean
  /** Revoke and remove every descriptor, connection, and generated visual. */
  clearAssets: () => void
  /** Remove a durable descriptor and any connected source/visual URLs it owns. */
  removeAsset: (id: string) => void
  /**
   * Re-express every connected duration at a new project rate. Canonical
   * microseconds and durable descriptors remain unchanged, and an already-
   * conformed connected pool emits no update.
   */
  reconformAssets: (rate: FrameRate) => void
  /**
   * Attach generated visuals. Late results for disconnected assets are revoked
   * immediately, so URL ownership remains exact on every path.
   */
  setAssetVisuals: (id: string, visuals: AssetVisuals) => void
}

export const useMediaStore = create<MediaState>()((set) => ({
  descriptors: new Map(),
  assets: new Map(),
  visuals: new Map(),

  addAsset: (asset) => {
    let added = false
    set((state) => {
      if (state.descriptors.has(asset.id) || state.assets.has(asset.id)) {
        return state
      }
      const descriptors = new Map(state.descriptors)
      descriptors.set(asset.id, descriptorFromAsset(asset))
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      added = true
      return { descriptors, assets }
    })
    return added
  },

  connectAsset: (asset) => {
    let connected = false
    set((state) => {
      const descriptor = state.descriptors.get(asset.id)
      if (
        state.assets.has(asset.id)
        || !descriptor
        || !connectionMatchesDescriptor(descriptor, asset)
      ) {
        return state
      }
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      connected = true
      return { assets }
    })
    return connected
  },

  disconnectAsset: (id) =>
    set((state) => {
      const asset = state.assets.get(id)
      const existingVisuals = state.visuals.get(id)
      if (!asset && !existingVisuals) return state
      revokeUrls([
        ...(asset ? [asset.objectUrl] : []),
        ...(existingVisuals ? visualUrls(existingVisuals) : []),
      ])
      const assets = new Map(state.assets)
      assets.delete(id)
      const visuals = new Map(state.visuals)
      visuals.delete(id)
      return { assets, visuals }
    }),

  replaceAssets: (nextDescriptors, nextAssets) => {
    const descriptors = descriptorMapFrom(nextDescriptors)
    if (!descriptors) return false
    const assets = connectionMapFrom(descriptors, nextAssets)
    if (!assets) return false

    const protectedUrls = new Set(
      Array.from(assets.values(), (asset) => asset.objectUrl),
    )
    set((state) => {
      const outgoingUrls: string[] = []
      for (const asset of state.assets.values()) outgoingUrls.push(asset.objectUrl)
      for (const visuals of state.visuals.values()) {
        outgoingUrls.push(...visualUrls(visuals))
      }
      revokeUrls(outgoingUrls, protectedUrls)
      return { descriptors, assets, visuals: new Map() }
    })
    return true
  },

  clearAssets: () =>
    set((state) => {
      if (
        state.descriptors.size === 0
        && state.assets.size === 0
        && state.visuals.size === 0
      ) {
        return state
      }
      const urls: string[] = []
      for (const asset of state.assets.values()) urls.push(asset.objectUrl)
      for (const visuals of state.visuals.values()) {
        urls.push(...visualUrls(visuals))
      }
      revokeUrls(urls)
      return {
        descriptors: new Map(),
        assets: new Map(),
        visuals: new Map(),
      }
    }),

  removeAsset: (id) =>
    set((state) => {
      const descriptor = state.descriptors.get(id)
      const asset = state.assets.get(id)
      const existingVisuals = state.visuals.get(id)
      if (!descriptor && !asset && !existingVisuals) return state
      revokeUrls([
        ...(asset ? [asset.objectUrl] : []),
        ...(existingVisuals ? visualUrls(existingVisuals) : []),
      ])
      const descriptors = new Map(state.descriptors)
      descriptors.delete(id)
      const assets = new Map(state.assets)
      assets.delete(id)
      const visuals = new Map(state.visuals)
      visuals.delete(id)
      return { descriptors, assets, visuals }
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
        revokeUrls(visualUrls(next))
        return state
      }
      const previous = state.visuals.get(id)
      if (previous) {
        revokeUrls(visualUrls(previous), new Set(visualUrls(next)))
      }
      const visuals = new Map(state.visuals)
      visuals.set(id, next)
      return { visuals }
    }),
}))
