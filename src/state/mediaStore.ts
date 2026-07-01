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

export interface MediaState {
  /** All imported assets, keyed by asset id. Treated as immutable. */
  assets: Map<string, MediaAsset>

  /**
   * Register a file as a placeholder MediaAsset (id + object URL only —
   * duration/dimensions/decoder config arrive with Phase 2 demuxing).
   * Returns the created asset so callers can reference its id.
   */
  addAsset: (file: File) => MediaAsset
  /** Remove an asset and revoke its object URL (frees the Blob reference). */
  removeAsset: (id: string) => void
}

export const useMediaStore = create<MediaState>()((set) => ({
  assets: new Map(),

  addAsset: (file) => {
    const asset: MediaAsset = {
      id: `asset_${crypto.randomUUID()}`,
      fileName: file.name,
      objectUrl: URL.createObjectURL(file),
      kind: kindFromMime(file.type),
      durationFrames: 0, // placeholder until Phase 2 demux
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
      return { assets }
    }),
}))
