/**
 * state/mediaStore.ts — The durable media catalog plus session connections.
 *
 * Production imports arrive fully analyzed from app/mediaImportController;
 * this store never demuxes files or exposes half-committed placeholders.
 */

import { create } from 'zustand'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { FrameRate, MediaAsset } from '../domain/schema'
import {
  cloneMediaCollections,
  createMediaCollection,
  deleteMediaCollection,
  mediaCollectionsMatchCatalog,
  MEDIA_COLLECTION_LIMITS,
  removeAssetFromMediaCollections,
  renameMediaCollection,
  reorderMediaCollection,
  setMediaCollectionMembership,
  type MediaCollection,
} from '../domain/mediaCollections'
import {
  cloneMediaSourceBounds,
  mediaSourceBoundsAcceptAnalyzed,
  mediaSourceBoundsEqual,
} from '../domain/sourceBounds'
import { microsecondsDurationToFrames } from '../domain/time'

/**
 * Precomputed visuals for one connected asset (filmstrip on video clips,
 * one tile for a still image, waveform on audio clips), generated once per
 * connection by app/mediaVisualsController. Timed-media visuals span the
 * asset's full duration. Every URL here is owned by this store.
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
    ...(asset.partialTrackSelection === undefined
      ? {}
      : { partialTrackSelection: asset.partialTrackSelection }),
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: cloneMediaSourceBounds(asset.sourceBounds),
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
    && descriptor.partialTrackSelection === asset.partialTrackSelection
    && descriptor.durationMicroseconds === asset.durationMicroseconds
    && mediaSourceBoundsAcceptAnalyzed(descriptor.sourceBounds, asset.sourceBounds)
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

function compatibilityMatchesDescriptor(
  item: MediaCompatibilityItem,
  descriptor: PortableAssetDescriptor,
): boolean {
  const readySelectionMatches = item.status !== 'ready'
    || item.report?.partialImport?.selection === descriptor.partialTrackSelection
  return readySelectionMatches
    && item.id === descriptor.id
    && item.fileName === descriptor.fileName
    && item.declaredMimeType === descriptor.mimeType
    && item.size === descriptor.size
    && item.lastModified === descriptor.lastModified
    && (
      item.status === 'checking'
        ? item.report === null || item.report.status !== 'ready'
        : item.report?.status === item.status
    )
}

function compatibilityMapFrom(
  catalog: ReadonlyMap<string, PortableAssetDescriptor>,
  assets: ReadonlyMap<string, MediaAsset>,
  items: Iterable<MediaCompatibilityItem>,
): Map<string, MediaCompatibilityItem> | null {
  const compatibility = new Map<string, MediaCompatibilityItem>()
  for (const item of items) {
    const descriptor = catalog.get(item.id)
    if (
      compatibility.has(item.id)
      || !descriptor
      || !compatibilityMatchesDescriptor(item, descriptor)
      || item.status === 'checking'
      || (item.status === 'ready') !== assets.has(item.id)
    ) return null
    compatibility.set(item.id, item)
  }
  return compatibility
}

interface CollectionHistoryState {
  readonly collections: readonly MediaCollection[]
  readonly collectionPast: readonly (readonly MediaCollection[])[]
  readonly collectionFuture: readonly (readonly MediaCollection[])[]
}

function commitCollectionEdit(
  state: CollectionHistoryState,
  collections: readonly MediaCollection[],
): Pick<MediaState, 'collections' | 'collectionPast' | 'collectionFuture'> {
  return {
    collections,
    collectionPast: [
      ...state.collectionPast,
      state.collections,
    ].slice(-MEDIA_COLLECTION_LIMITS.historyEntries),
    collectionFuture: [],
  }
}

function pruneCollectionHistory(
  history: readonly (readonly MediaCollection[])[],
  assetId: string,
): readonly (readonly MediaCollection[])[] {
  let changed = false
  const next = history.map((snapshot) => {
    const pruned = removeAssetFromMediaCollections(snapshot, assetId)
    if (pruned !== snapshot) changed = true
    return pruned
  })
  return changed ? next : history
}

let fallbackCollectionId = 0

function nextCollectionId(collections: readonly MediaCollection[]): string {
  const generated = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `local-${Date.now()}-${++fallbackCollectionId}`
  const root = `collection-${generated}`
  const ids = new Set(collections.map((collection) => collection.id))
  if (!ids.has(root)) return root
  let suffix = 2
  while (ids.has(`${root}-${suffix}`)) suffix++
  return `${root}-${suffix}`
}

export interface MediaState {
  /** Durable portable descriptors for every project source, online or offline. */
  descriptors: Map<string, PortableAssetDescriptor>
  /** Session-connected analyzed assets, always a subset of descriptors. */
  assets: Map<string, MediaAsset>
  /** Generated clip visuals for connected assets, keyed by asset id. */
  visuals: Map<string, AssetVisuals>
  /** Session-only compatibility checks and provisional rejected imports. */
  compatibility: Map<string, MediaCompatibilityItem>
  /** Durable ordered Media Pool organization referencing stable descriptor ids. */
  collections: readonly MediaCollection[]
  /** Collection-only history; timeline history remains owned by documentStore. */
  collectionPast: readonly (readonly MediaCollection[])[]
  collectionFuture: readonly (readonly MediaCollection[])[]

  /** Begin a guarded import or offline-relink compatibility request. */
  startCompatibility: (item: MediaCompatibilityItem) => boolean
  /** Publish only when the same request still owns the visible item. */
  setCompatibility: (
    id: string,
    requestId: string,
    status: MediaCompatibilityStatus,
    report: MediaCompatibilityReport | null,
  ) => boolean
  /** Remove a provisional/final session report without creating a descriptor. */
  removeCompatibility: (id: string, requestId?: string) => boolean

  /**
   * Import one fully analyzed asset atomically: add its durable descriptor and
   * connected session object together, optionally replacing the exact active
   * import check with its canonical Ready result in the same transaction, then
   * take ownership of its object URL. Duplicate/stale/mismatched commits are
   * rejected; the caller retains URL ownership when false.
   */
  addAsset: (
    asset: MediaAsset,
    compatibility?: MediaCompatibilityItem,
  ) => boolean
  /**
   * Connect an analyzed source to an existing descriptor. Legacy unknown source
   * bounds are atomically upgraded from the analyzed asset on success.
   */
  connectAsset: (
    asset: MediaAsset,
    compatibility?: MediaCompatibilityItem,
  ) => boolean
  /**
   * Disconnect only the exact failed connection/report generation and retain
   * its durable descriptor plus an actionable non-Ready report.
   */
  failAssetCompatibility: (
    id: string,
    expectedObjectUrl: string,
    expectedRequestId: string | null,
    item: MediaCompatibilityItem,
  ) => boolean
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
    compatibility?: Iterable<MediaCompatibilityItem>,
    collections?: readonly MediaCollection[],
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
  createCollection: (name: string) => string | null
  renameCollection: (id: string, name: string) => boolean
  reorderCollection: (id: string, toIndex: number) => boolean
  deleteCollection: (id: string) => boolean
  setCollectionMembership: (
    collectionId: string,
    assetId: string,
    included: boolean,
  ) => boolean
  undoCollectionEdit: () => boolean
  redoCollectionEdit: () => boolean
}

export const useMediaStore = create<MediaState>()((set) => ({
  descriptors: new Map(),
  assets: new Map(),
  visuals: new Map(),
  compatibility: new Map(),
  collections: [],
  collectionPast: [],
  collectionFuture: [],

  startCompatibility: (item) => {
    let started = false
    set((state) => {
      const current = state.compatibility.get(item.id)
      const descriptor = state.descriptors.get(item.id)
      if (
        item.status !== 'checking'
        || state.assets.has(item.id)
        || current?.status === 'checking'
        || (descriptor !== undefined
          && !compatibilityMatchesDescriptor(item, descriptor))
      ) {
        return state
      }
      const previousReport = descriptor !== undefined
        && current !== undefined
        && compatibilityMatchesDescriptor(current, descriptor)
        && current.report?.status !== 'ready'
          ? current.report
          : null
      const checkingItem = previousReport === null
        ? item
        : { ...item, report: previousReport }
      const compatibility = new Map(state.compatibility)
      compatibility.set(item.id, checkingItem)
      started = true
      return { compatibility }
    })
    return started
  },

  setCompatibility: (id, requestId, status, report) => {
    let updated = false
    set((state) => {
      const current = state.compatibility.get(id)
      if (!current || current.requestId !== requestId) return state
      if (current.status === status && current.report === report) return state
      const next = { ...current, status, report }
      const descriptor = state.descriptors.get(id)
      if (
        descriptor !== undefined
        && (
          !compatibilityMatchesDescriptor(next, descriptor)
          || (status === 'ready') !== state.assets.has(id)
        )
      ) return state
      const compatibility = new Map(state.compatibility)
      compatibility.set(id, next)
      updated = true
      return { compatibility }
    })
    return updated
  },

  removeCompatibility: (id, requestId) => {
    let removed = false
    set((state) => {
      const current = state.compatibility.get(id)
      if (!current || (requestId !== undefined && current.requestId !== requestId)) {
        return state
      }
      const compatibility = new Map(state.compatibility)
      compatibility.delete(id)
      removed = true
      return { compatibility }
    })
    return removed
  },

  addAsset: (asset, readyCompatibility) => {
    let added = false
    set((state) => {
      if (state.descriptors.has(asset.id) || state.assets.has(asset.id)) {
        return state
      }
      const descriptor = descriptorFromAsset(asset)
      const currentCompatibility = state.compatibility.get(asset.id)
      if (readyCompatibility === undefined) {
        if (currentCompatibility !== undefined) return state
      } else if (
        readyCompatibility.status !== 'ready'
        || !compatibilityMatchesDescriptor(readyCompatibility, descriptor)
        || currentCompatibility?.status !== 'checking'
        || currentCompatibility.requestId !== readyCompatibility.requestId
        || currentCompatibility.fileName !== descriptor.fileName
        || currentCompatibility.size !== descriptor.size
        || currentCompatibility.lastModified !== descriptor.lastModified
      ) {
        return state
      }
      const descriptors = new Map(state.descriptors)
      descriptors.set(asset.id, descriptor)
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      const compatibility = readyCompatibility === undefined
        ? state.compatibility
        : new Map(state.compatibility).set(asset.id, readyCompatibility)
      added = true
      return { descriptors, assets, compatibility }
    })
    return added
  },

  connectAsset: (asset, readyCompatibility) => {
    let connected = false
    set((state) => {
      const descriptor = state.descriptors.get(asset.id)
      if (
        state.assets.has(asset.id)
        || !descriptor
        || !connectionMatchesDescriptor(descriptor, asset)
        || (
          readyCompatibility !== undefined
          && (
            readyCompatibility.status !== 'ready'
            || !compatibilityMatchesDescriptor(readyCompatibility, descriptor)
          )
        )
      ) {
        return state
      }
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      const descriptors = mediaSourceBoundsEqual(
        descriptor.sourceBounds,
        asset.sourceBounds,
      )
        ? state.descriptors
        : new Map(state.descriptors).set(asset.id, descriptorFromAsset(asset))
      const compatibility = readyCompatibility === undefined
        ? state.compatibility
        : new Map(state.compatibility).set(asset.id, readyCompatibility)
      connected = true
      return { descriptors, assets, compatibility }
    })
    return connected
  },

  failAssetCompatibility: (
    id,
    expectedObjectUrl,
    expectedRequestId,
    item,
  ) => {
    let failed = false
    set((state) => {
      const descriptor = state.descriptors.get(id)
      const asset = state.assets.get(id)
      const current = state.compatibility.get(id)
      if (
        !descriptor
        || !asset
        || asset.objectUrl !== expectedObjectUrl
        || (current?.requestId ?? null) !== expectedRequestId
        || item.status === 'checking'
        || item.status === 'ready'
        || !compatibilityMatchesDescriptor(item, descriptor)
      ) return state

      const existingVisuals = state.visuals.get(id)
      revokeUrls([
        asset.objectUrl,
        ...(existingVisuals ? visualUrls(existingVisuals) : []),
      ])
      const assets = new Map(state.assets)
      assets.delete(id)
      const visuals = new Map(state.visuals)
      visuals.delete(id)
      const compatibility = new Map(state.compatibility)
      compatibility.set(id, item)
      failed = true
      return { assets, visuals, compatibility }
    })
    return failed
  },

  disconnectAsset: (id) =>
    set((state) => {
      const asset = state.assets.get(id)
      const existingVisuals = state.visuals.get(id)
      const existingCompatibility = state.compatibility.has(id)
      if (!asset && !existingVisuals && !existingCompatibility) return state
      revokeUrls([
        ...(asset ? [asset.objectUrl] : []),
        ...(existingVisuals ? visualUrls(existingVisuals) : []),
      ])
      const assets = new Map(state.assets)
      assets.delete(id)
      const visuals = new Map(state.visuals)
      visuals.delete(id)
      const compatibility = new Map(state.compatibility)
      compatibility.delete(id)
      return { assets, visuals, compatibility }
    }),

  replaceAssets: (
    nextDescriptors,
    nextAssets,
    nextCompatibility = [],
    nextCollections = [],
  ) => {
    const descriptors = descriptorMapFrom(nextDescriptors)
    if (!descriptors) return false
    const assets = connectionMapFrom(descriptors, nextAssets)
    if (!assets) return false
    if (!mediaCollectionsMatchCatalog(
      nextCollections,
      new Set(descriptors.keys()),
    )) return false
    for (const asset of assets.values()) {
      const descriptor = descriptors.get(asset.id)
      if (
        descriptor
        && !mediaSourceBoundsEqual(descriptor.sourceBounds, asset.sourceBounds)
      ) {
        descriptors.set(asset.id, descriptorFromAsset(asset))
      }
    }
    const compatibility = compatibilityMapFrom(
      descriptors,
      assets,
      nextCompatibility,
    )
    if (!compatibility) return false

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
      return {
        descriptors,
        assets,
        visuals: new Map(),
        compatibility,
        collections: cloneMediaCollections(nextCollections),
        collectionPast: [],
        collectionFuture: [],
      }
    })
    return true
  },

  clearAssets: () =>
    set((state) => {
      if (
        state.descriptors.size === 0
        && state.assets.size === 0
        && state.visuals.size === 0
        && state.compatibility.size === 0
        && state.collections.length === 0
        && state.collectionPast.length === 0
        && state.collectionFuture.length === 0
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
        compatibility: new Map(),
        collections: [],
        collectionPast: [],
        collectionFuture: [],
      }
    }),

  removeAsset: (id) =>
    set((state) => {
      const descriptor = state.descriptors.get(id)
      const asset = state.assets.get(id)
      const existingVisuals = state.visuals.get(id)
      const existingCompatibility = state.compatibility.has(id)
      if (!descriptor && !asset && !existingVisuals && !existingCompatibility) {
        return state
      }
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
      const compatibility = new Map(state.compatibility)
      compatibility.delete(id)
      const collections = removeAssetFromMediaCollections(state.collections, id)
      const collectionPast = pruneCollectionHistory(state.collectionPast, id)
      const collectionFuture = pruneCollectionHistory(state.collectionFuture, id)
      return {
        descriptors,
        assets,
        visuals,
        compatibility,
        collections,
        collectionPast,
        collectionFuture,
      }
    }),

  reconformAssets: (rate) =>
    set((state) => {
      let assets: Map<string, MediaAsset> | null = null
      for (const asset of state.assets.values()) {
        const durationFrames = microsecondsDurationToFrames(
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

  createCollection: (name) => {
    let createdId: string | null = null
    set((state) => {
      const id = nextCollectionId(state.collections)
      const collections = createMediaCollection(state.collections, id, name)
      if (collections === state.collections) return state
      createdId = id
      return commitCollectionEdit(state, collections)
    })
    return createdId
  },

  renameCollection: (id, name) => {
    let changed = false
    set((state) => {
      const collections = renameMediaCollection(state.collections, id, name)
      if (collections === state.collections) return state
      changed = true
      return commitCollectionEdit(state, collections)
    })
    return changed
  },

  reorderCollection: (id, toIndex) => {
    let changed = false
    set((state) => {
      const collections = reorderMediaCollection(state.collections, id, toIndex)
      if (collections === state.collections) return state
      changed = true
      return commitCollectionEdit(state, collections)
    })
    return changed
  },

  deleteCollection: (id) => {
    let changed = false
    set((state) => {
      const collections = deleteMediaCollection(state.collections, id)
      if (collections === state.collections) return state
      changed = true
      return commitCollectionEdit(state, collections)
    })
    return changed
  },

  setCollectionMembership: (collectionId, assetId, included) => {
    let changed = false
    set((state) => {
      if (!state.descriptors.has(assetId)) return state
      const collections = setMediaCollectionMembership(
        state.collections,
        collectionId,
        assetId,
        included,
      )
      if (collections === state.collections) return state
      changed = true
      return commitCollectionEdit(state, collections)
    })
    return changed
  },

  undoCollectionEdit: () => {
    let changed = false
    set((state) => {
      const previous = state.collectionPast.at(-1)
      if (!previous) return state
      changed = true
      return {
        collections: previous,
        collectionPast: state.collectionPast.slice(0, -1),
        collectionFuture: [state.collections, ...state.collectionFuture]
          .slice(0, MEDIA_COLLECTION_LIMITS.historyEntries),
      }
    })
    return changed
  },

  redoCollectionEdit: () => {
    let changed = false
    set((state) => {
      const next = state.collectionFuture[0]
      if (!next) return state
      changed = true
      return {
        collections: next,
        collectionPast: [...state.collectionPast, state.collections]
          .slice(-MEDIA_COLLECTION_LIMITS.historyEntries),
        collectionFuture: state.collectionFuture.slice(1),
      }
    })
    return changed
  },
}))
