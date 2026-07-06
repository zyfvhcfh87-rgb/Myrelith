/**
 * app/previewController.ts — Composition root for the preview pipeline.
 * Phase 3.4; swapped to the timeline compositor in Phase 4.1c.
 *
 * This is deliberately NOT a React component and NOT part of engine/:
 * - ui/Preview.tsx stays a dumb canvas that reads state and calls
 *   initPreview(canvas) once (rule: components never touch engine/pipeline
 *   directly — this controller is their sanctioned facade, see
 *   ARCHITECTURE.md "composition root");
 * - engine/ and pipeline/ stay React-free and store-free (deps injected);
 * - this file is where stores and machinery are ALLOWED to meet.
 *
 * What it does: owns one render worker + bridge for the lifetime of the
 * canvas. Watches mediaStore and demuxes EVERY video asset into the bridge
 * (one worker-side decoder per asset), releasing assets that disappear;
 * watches documentStore and posts each new doc snapshot; watches
 * transportStore.playheadFrame and renders it, coalesced to one
 * renderFrame per animation frame (the bridge further dedupes
 * latest-wins). Re-renders when a doc changes or an asset's decoder
 * becomes ready — that is the whole retry policy for clips the worker
 * reported missing (the worker never self-recomposites; see PLAN 4.1b).
 *
 * StrictMode note: a canvas can be transferred to a worker exactly once,
 * so initPreview is idempotent per canvas element and survives React's
 * dev-mode double-mount; nothing is torn down on effect cleanup. dispose()
 * exists for tests and real teardown.
 */

import type { AssetId, FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import type { ChunkProvider } from '../engine/worker-bridge'
import type { RenderFrameResult } from '../engine/render-bridge'
import { createRenderWorker, RenderWorkerBridge } from '../engine/render-bridge'
import { createChunkSource } from '../pipeline/decode'
import { deserializeDecoderConfig, loadAsset } from '../pipeline/demux'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'

/** The bridge surface the controller drives (real or test fake). */
export interface BridgeLike {
  setDoc(doc: TimelineDoc): void
  configureAsset(
    assetId: AssetId,
    config: VideoDecoderConfig,
    rate: FrameRate,
    chunkProvider: ChunkProvider,
  ): Promise<void>
  releaseAsset(assetId: AssetId): void
  renderFrame(frame: number): Promise<RenderFrameResult>
  dispose(): void
  onWorkerError: ((message: string) => void) | null
  onAssetReady: ((assetId: AssetId) => void) | null
}

/** Injection points so tests can run without Worker/OffscreenCanvas/fetch. */
export interface PreviewDeps {
  createBridge(): BridgeLike
  transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas
  init(bridge: BridgeLike, canvas: OffscreenCanvas): void
  fetchBlob(url: string): Promise<Blob>
  demux(file: File): Promise<{
    asset: MediaAsset
    chunkProvider: ChunkProvider
  }>
}

const realDeps: PreviewDeps = {
  createBridge: () => new RenderWorkerBridge(createRenderWorker()),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => (bridge as RenderWorkerBridge).init(offscreen),
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
  demux: async (file) => {
    const loaded = await loadAsset(file)
    if (!loaded.videoTrack || !loaded.asset.frameRate) {
      throw new Error(`"${file.name}" has no decodable video track`)
    }
    return {
      asset: loaded.asset,
      chunkProvider: createChunkSource(loaded.videoTrack, loaded.asset.frameRate),
    }
  },
}

interface ControllerState {
  canvas: HTMLCanvasElement | null
  bridge: BridgeLike | null
  /** Per-asset pipeline status. Absent = not started (or failed: retried
   * on the next mediaStore change). Removal releases the worker decoder. */
  assetStates: Map<AssetId, 'loading' | 'ready'>
  unsubscribes: Array<() => void>
  rafPending: boolean
  latestFrame: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  assetStates: new Map(),
  unsubscribes: [],
  rafPending: false,
  latestFrame: 0,
}

function scheduleRender(frame: number): void {
  state.latestFrame = frame
  if (state.rafPending || !state.bridge) return
  state.rafPending = true
  requestAnimationFrame(() => {
    state.rafPending = false
    const bridge = state.bridge
    if (!bridge) return
    // Document frames go straight through — per-asset rescaling happens
    // inside the bridge, per configured asset.
    void bridge.renderFrame(state.latestFrame)
  })
}

/** Demux one placeholder asset and hand its decoder+chunks to the worker. */
async function loadOneAsset(deps: PreviewDeps, asset: MediaAsset): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  state.assetStates.set(asset.id, 'loading')
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    const file = new File([blob], asset.fileName, { type: blob.type })
    const demuxed = await deps.demux(file)
    // Disposed, re-inited, or the asset was removed while we demuxed?
    if (state.bridge !== bridge || !state.assetStates.has(asset.id)) return

    useMediaStore.getState().updateAsset(asset.id, {
      kind: demuxed.asset.kind,
      durationFrames: demuxed.asset.durationFrames,
      frameRate: demuxed.asset.frameRate,
      width: demuxed.asset.width,
      height: demuxed.asset.height,
      hasAudio: demuxed.asset.hasAudio,
      audioSampleRate: demuxed.asset.audioSampleRate,
      audioChannels: demuxed.asset.audioChannels,
      decoderConfigB64: demuxed.asset.decoderConfigB64,
    })

    if (!demuxed.asset.decoderConfigB64 || !demuxed.asset.frameRate) {
      throw new Error(`"${asset.fileName}": missing decoder config or frame rate`)
    }
    await bridge.configureAsset(
      asset.id,
      deserializeDecoderConfig(demuxed.asset.decoderConfigB64),
      demuxed.asset.frameRate,
      demuxed.chunkProvider,
    )
    if (state.bridge !== bridge || !state.assetStates.has(asset.id)) return
    state.assetStates.set(asset.id, 'ready')
  } catch (e) {
    if (state.bridge === bridge) state.assetStates.delete(asset.id) // retriable
    console.warn(
      `[previewController] loading "${asset.fileName}" failed:`,
      e instanceof Error ? e.message : e,
    )
  }
}

/** Reconcile the worker's decoders with the media pool (adds + removals). */
function syncAssets(deps: PreviewDeps): void {
  const bridge = state.bridge
  if (!bridge) return
  const assets = useMediaStore.getState().assets

  for (const asset of assets.values()) {
    if (asset.kind !== 'video') continue // audio/images never reach the preview
    if (state.assetStates.has(asset.id)) continue
    void loadOneAsset(deps, asset)
  }

  for (const id of [...state.assetStates.keys()]) {
    if (!assets.has(id)) {
      state.assetStates.delete(id)
      bridge.releaseAsset(id)
    }
  }
}

/**
 * Attach the preview pipeline to the visible canvas. Idempotent per canvas
 * element (safe under StrictMode double-mount). Failures (e.g. environments
 * without OffscreenCanvas) log and leave the preview disabled — the app
 * must keep working.
 */
export function initPreview(
  canvas: HTMLCanvasElement,
  deps: PreviewDeps = realDeps,
): void {
  if (state.canvas === canvas) return
  disposePreview()

  let bridge: BridgeLike
  try {
    bridge = deps.createBridge()
    deps.init(bridge, deps.transferCanvas(canvas))
  } catch (e) {
    console.warn(
      '[previewController] preview disabled:',
      e instanceof Error ? e.message : e,
    )
    return
  }
  bridge.onWorkerError = (message) =>
    console.warn('[previewController] worker error:', message)
  // A decoder came online: repaint so its clips fill in (retry policy).
  bridge.onAssetReady = () =>
    scheduleRender(useTransportStore.getState().playheadFrame)
  state.canvas = canvas
  state.bridge = bridge

  bridge.setDoc(useDocumentStore.getState().doc)

  state.unsubscribes.push(
    useDocumentStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) {
        bridge.setDoc(s.doc)
        scheduleRender(useTransportStore.getState().playheadFrame)
      }
    }),
    useTransportStore.subscribe((s, prev) => {
      if (s.playheadFrame !== prev.playheadFrame) scheduleRender(s.playheadFrame)
    }),
    useMediaStore.subscribe(() => {
      syncAssets(deps)
    }),
  )
  // Assets may already be waiting (import before mount, HMR, tests) and an
  // empty timeline still paints its background.
  syncAssets(deps)
  scheduleRender(useTransportStore.getState().playheadFrame)
}

/** Tear everything down (tests / real app teardown, not StrictMode churn). */
export function disposePreview(): void {
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.bridge?.dispose()
  state.bridge = null
  state.canvas = null
  state.assetStates = new Map()
  state.rafPending = false
}
