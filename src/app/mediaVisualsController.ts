/**
 * app/mediaVisualsController.ts — third composition root (same pattern as
 * previewController/transportController): the ONLY place mediaStore meets
 * pipeline/visuals. Watches the media pool and generates each asset's
 * filmstrip + waveform images exactly once, in the background.
 *
 * Flow: asset appears → fetch its blob → run the generators for its kind
 * (video → filmstrip; anything non-image MAY carry audio → waveform; the
 * generators return null when the track type isn't there) → hand the
 * result to mediaStore.setAssetVisuals, which OWNS the object URLs from
 * that moment (including the asset-removed-mid-generation case, where it
 * revokes the late result on the spot).
 *
 * Failures are logged and the asset stays visuals-less — eye candy is
 * optional, a corrupt file must not wedge the pool in a retry loop.
 * Dependency-injected like the other controllers so tests drive it with
 * fakes; `initMediaVisuals` is idempotent (StrictMode double-mount safe).
 */

import type { AssetId, MediaAsset } from '../domain/schema'
import type { FilmstripResult, WaveformResult } from '../pipeline/visuals'
import { generateFilmstrip, generateWaveform } from '../pipeline/visuals'
import { useMediaStore } from '../state/mediaStore'

export interface VisualsDeps {
  fetchBlob: (url: string) => Promise<Blob>
  generateFilmstrip: (file: Blob) => Promise<FilmstripResult | null>
  generateWaveform: (file: Blob) => Promise<WaveformResult | null>
}

const realDeps: VisualsDeps = {
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
  generateFilmstrip,
  generateWaveform,
}

interface ControllerState {
  /** Assets already picked up (in flight, done, or failed — no retries). */
  started: Set<AssetId>
  unsubscribe: (() => void) | null
}

const state: ControllerState = { started: new Set(), unsubscribe: null }

async function process(asset: MediaAsset, deps: VisualsDeps): Promise<void> {
  if (asset.kind === 'image') return // images get neither strip nor waveform
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    const [filmstrip, waveform] = await Promise.all([
      asset.kind === 'video' ? deps.generateFilmstrip(blob) : Promise.resolve(null),
      // video OR audio may carry an audio track; the generator returns
      // null by itself when there is none.
      deps.generateWaveform(blob),
    ])
    if (!filmstrip && !waveform) return
    // The store takes URL ownership — it also handles the case where the
    // asset was removed while we were decoding (revokes, stores nothing).
    useMediaStore.getState().setAssetVisuals(asset.id, { filmstrip, waveform })
  } catch (err) {
    console.warn(`[mediaVisuals] generation failed for "${asset.fileName}"`, err)
  }
}

function scan(deps: VisualsDeps): void {
  const assets = useMediaStore.getState().assets
  // Forget removed assets (their stored visuals died with removeAsset).
  for (const id of state.started) {
    if (!assets.has(id)) state.started.delete(id)
  }
  for (const [id, asset] of assets) {
    if (state.started.has(id)) continue
    state.started.add(id)
    void process(asset, deps)
  }
}

/** Start watching the media pool. Idempotent; returns immediately. */
export function initMediaVisuals(deps: VisualsDeps = realDeps): void {
  if (state.unsubscribe) return
  state.unsubscribe = useMediaStore.subscribe((s, prev) => {
    if (s.assets !== prev.assets) scan(deps)
  })
  scan(deps)
}

/** Tear down (tests). In-flight generations resolve into the store guard. */
export function disposeMediaVisuals(): void {
  state.unsubscribe?.()
  state.unsubscribe = null
  state.started.clear()
}
