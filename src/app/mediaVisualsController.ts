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
import {
  mediaAssetDecoderBudget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type { FilmstripResult, WaveformResult } from '../pipeline/visuals'
import {
  MediaVisualDecodeError,
  MediaVisualSourceError,
  generateFilmstrip,
  generateWaveform,
} from '../pipeline/visuals'
import { useMediaStore } from '../state/mediaStore'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
} from './mediaCompatibilityController'

export interface VisualsDeps {
  fetchBlob: (url: string) => Promise<Blob>
  generateFilmstrip: (
    file: Blob,
    options: { sourceId?: string; budget: LocalDecoderBudget },
  ) => Promise<FilmstripResult | null>
  generateWaveform: (
    file: Blob,
    options: { sourceId?: string; budget: LocalDecoderBudget },
  ) => Promise<WaveformResult | null>
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
  generation: number
}

const state: ControllerState = {
  started: new Set(),
  unsubscribe: null,
  generation: 0,
}

function revokeGenerated(
  filmstrip: FilmstripResult | null,
  waveform: WaveformResult | null,
): void {
  if (filmstrip) URL.revokeObjectURL(filmstrip.url)
  if (waveform) URL.revokeObjectURL(waveform.url)
}

async function process(
  asset: MediaAsset,
  deps: VisualsDeps,
  generation: number,
): Promise<void> {
  if (asset.kind === 'image') return // images get neither strip nor waveform
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) return

  let blob: Blob
  try {
    blob = await deps.fetchBlob(asset.objectUrl)
  } catch (err) {
    if (generation !== state.generation) return
    console.warn(`[mediaVisuals] generation failed for "${asset.fileName}"`, err)
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure(
        asset.kind === 'video' ? 'filmstrip' : 'waveform',
        null,
        err,
        'resource-unavailable',
      ),
    )
    return
  }

  const current = useMediaStore.getState().assets.get(asset.id)
  if (
    generation !== state.generation
    || current?.objectUrl !== asset.objectUrl
  ) return

  const decodeOptions = {
    sourceId: asset.id,
    budget: mediaAssetDecoderBudget(asset, blob.size),
  }

  const [filmstripResult, waveformResult] = await Promise.allSettled([
    asset.kind === 'video'
      ? deps.generateFilmstrip(blob, decodeOptions)
      : Promise.resolve(null),
    asset.hasAudio
      ? deps.generateWaveform(blob, decodeOptions)
      : Promise.resolve(null),
  ])
  const filmstrip = filmstripResult.status === 'fulfilled'
    ? filmstripResult.value
    : null
  const waveform = waveformResult.status === 'fulfilled'
    ? waveformResult.value
    : null

  const failure = filmstripResult.status === 'rejected'
    ? {
        surface: 'filmstrip' as const,
        trackKind: 'video' as const,
        cause: filmstripResult.reason,
      }
    : waveformResult.status === 'rejected'
      ? {
          surface: 'waveform' as const,
          trackKind: 'audio' as const,
          cause: waveformResult.reason,
        }
      : null
  if (failure) {
    // allSettled preserves a successful sibling long enough to release it.
    revokeGenerated(filmstrip, waveform)
    if (generation !== state.generation) return
    console.warn(
      `[mediaVisuals] generation failed for "${asset.fileName}"`,
      failure.cause,
    )
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure(
        failure.surface,
        failure.cause instanceof MediaVisualSourceError
          ? null
          : failure.trackKind,
        failure.cause,
        failure.cause instanceof MediaVisualSourceError
          ? 'resource-unavailable'
          : failure.cause instanceof MediaVisualDecodeError
            ? failure.cause.failure.reason
            : 'decode-failed',
      ),
    )
    return
  }

  if (!filmstrip && !waveform) return
  const latest = useMediaStore.getState().assets.get(asset.id)
  if (
    generation !== state.generation
    || latest?.objectUrl !== asset.objectUrl
  ) {
    revokeGenerated(filmstrip, waveform)
    return
  }
  // The store takes URL ownership; disconnected late results are revoked.
  useMediaStore.getState().setAssetVisuals(asset.id, { filmstrip, waveform })
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
    void process(asset, deps, state.generation)
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
  state.generation++
  state.unsubscribe?.()
  state.unsubscribe = null
  state.started.clear()
}
