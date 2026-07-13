/**
 * state/mediaStore.ts — The media pool: every imported asset, by id.
 * Phase 1.3.
 *
 * Session-scoped state: a Map does not JSON-serialize and objectUrl dies
 * with the page, so this store is rebuilt on project load (asset re-linking
 * is a post-MVP concern). Real demuxing replaces the placeholder fields in
 * Phase 2 (pipeline/demux.ts).
 */

import { create } from 'zustand'
import type { AssetKind, MediaAsset } from '../domain/schema'

/** Best-effort kind from the file's MIME type; video when unrecognizable. */
function kindFromMime(mime: string): AssetKind {
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  return 'video'
}

/**
 * Precomputed timeline eye-candy for one asset (filmstrip on video clips,
 * waveform on audio clips), generated once per asset by
 * app/mediaVisualsController. Both images span the asset's FULL source
 * duration. ClipView maps waveform time with CSS and repeats fixed-aspect
 * sprite frames inside integer-frame SVG buckets, so trim, slip and zoom stay
 * aligned without stretching thumbnails. The URLs are object
 * URLs OWNED by this store: revoked when the asset is removed (or when a
 * result arrives for an already-removed asset).
 */
export interface AssetVisuals {
  /** Horizontal strip of evenly spaced video frames, or null (no video). */
  filmstrip: {
    url: string
    tiles: number
    tileWidth: number
    tileHeight: number
  } | null
  /** Rendered waveform image, or null (no audio). */
  waveform: { url: string; width: number; height: number } | null
}

/** Every object URL inside a visuals record (for revocation). */
function visualUrls(visuals: AssetVisuals): string[] {
  const urls: string[] = []
  if (visuals.filmstrip) urls.push(visuals.filmstrip.url)
  if (visuals.waveform) urls.push(visuals.waveform.url)
  return urls
}

export interface MediaState {
  /** All imported assets, keyed by asset id. Treated as immutable. */
  assets: Map<string, MediaAsset>
  /** Generated clip visuals, keyed by asset id. Session-scoped like assets. */
  visuals: Map<string, AssetVisuals>

  /**
   * Register a file as a placeholder MediaAsset (id + object URL only —
   * duration/dimensions/decoder config arrive with Phase 2 demuxing).
   * Returns the created asset so callers can reference its id.
   */
  addAsset: (file: File) => MediaAsset
  /** Remove an asset and revoke its object URL (frees the Blob reference). */
  removeAsset: (id: string) => void
  /**
   * Merge real metadata into a placeholder asset (the preview controller
   * calls this after demuxing). Unknown ids are a safe no-op. The id and
   * original source-file identity fields are not patchable.
   */
  updateAsset: (
    id: string,
    patch: Partial<
      Omit<
        MediaAsset,
        'id' | 'fileName' | 'mimeType' | 'size' | 'lastModified' | 'objectUrl'
      >
    >,
  ) => void
  /**
   * Attach generated visuals to an asset. If the asset vanished while its
   * visuals were being generated, the images' URLs are revoked on the spot
   * and nothing is stored — the store owns the URLs either way, so callers
   * never leak them.
   */
  setAssetVisuals: (id: string, visuals: AssetVisuals) => void
}

export const useMediaStore = create<MediaState>()((set) => ({
  assets: new Map(),
  visuals: new Map(),

  addAsset: (file) => {
    const asset: MediaAsset = {
      id: `asset_${crypto.randomUUID()}`,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      lastModified: file.lastModified,
      objectUrl: URL.createObjectURL(file),
      kind: kindFromMime(file.type),
      durationFrames: 0, // placeholder until Phase 2 demux
      durationMicroseconds: 0,
      frameRate: null,
      width: null,
      height: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      decoderConfigB64: null,
    }
    set((state) => {
      const assets = new Map(state.assets)
      assets.set(asset.id, asset)
      return { assets }
    })
    return asset
  },

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

  updateAsset: (id, patch) =>
    set((state) => {
      const existing = state.assets.get(id)
      if (!existing) return state
      const assets = new Map(state.assets)
      assets.set(id, {
        ...existing,
        ...patch,
        id,
        fileName: existing.fileName,
        mimeType: existing.mimeType,
        size: existing.size,
        lastModified: existing.lastModified,
        objectUrl: existing.objectUrl,
      })
      return { assets }
    }),

  setAssetVisuals: (id, next) =>
    set((state) => {
      if (!state.assets.has(id)) {
        // Asset removed mid-generation: dispose the late result, store nothing.
        for (const url of visualUrls(next)) URL.revokeObjectURL(url)
        return state
      }
      // Replacing earlier visuals (regeneration) frees the old images.
      const previous = state.visuals.get(id)
      if (previous) {
        for (const url of visualUrls(previous)) URL.revokeObjectURL(url)
      }
      const visuals = new Map(state.visuals)
      visuals.set(id, next)
      return { visuals }
    }),
}))
