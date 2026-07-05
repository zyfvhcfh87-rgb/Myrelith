/**
 * app/previewController.ts — Composition root for the preview pipeline.
 * Phase 3.4.
 *
 * This is deliberately NOT a React component and NOT part of engine/:
 * - ui/Preview.tsx stays a dumb canvas that reads state and calls
 *   initPreview(canvas) once (rule: components never touch engine/pipeline
 *   directly — this controller is their sanctioned facade, see
 *   ARCHITECTURE.md "composition root");
 * - engine/ and pipeline/ stay React-free and store-free (deps injected);
 * - this file is where stores and machinery are ALLOWED to meet.
 *
 * What it does: owns one decode worker + bridge for the lifetime of the
 * canvas; watches mediaStore and demuxes the newest video asset into the
 * bridge; watches transportStore.playheadFrame and renders it, coalesced
 * to one renderFrameAt per animation frame (which the bridge further
 * dedupes latest-wins). Phase 4 swaps the single-asset source for the
 * timeline compositor in render.worker.
 *
 * StrictMode note: a canvas can be transferred to a worker exactly once,
 * so initPreview is idempotent per canvas element and survives React's
 * dev-mode double-mount; nothing is torn down on effect cleanup. dispose()
 * exists for tests and real teardown.
 */

import type { FrameRate, MediaAsset } from '../domain/schema'
import { rescaleFrames } from '../domain/time'
import type { ChunkProvider, RenderResult } from '../engine/worker-bridge'
import { createDecodeWorker, DecodeWorkerBridge } from '../engine/worker-bridge'
import { createChunkSource } from '../pipeline/decode'
import { deserializeDecoderConfig, loadAsset } from '../pipeline/demux'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'

/** The bridge surface the controller drives (real or test fake). */
export interface BridgeLike {
  setSource(rate: FrameRate, chunkProvider: ChunkProvider): void
  configure(config: VideoDecoderConfig): Promise<void>
  renderFrameAt(frame: number): Promise<RenderResult>
  dispose(): void
  onWorkerError: ((message: string) => void) | null
}

/** Injection points so tests can run without Worker/OffscreenCanvas/fetch. */
export interface PreviewDeps {
  createBridge(): BridgeLike
  transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas
  init(bridge: BridgeLike, canvas: OffscreenCanvas): void
  fetchBlob(url: string): Promise<Blob>
  demux(file: File): Promise<{
    asset: MediaAsset
    videoTrack: unknown
    chunkProvider: ChunkProvider
  }>
}

const realDeps: PreviewDeps = {
  createBridge: () => new DecodeWorkerBridge(createDecodeWorker()),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => (bridge as DecodeWorkerBridge).init(offscreen),
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
  demux: async (file) => {
    const loaded = await loadAsset(file)
    if (!loaded.videoTrack || !loaded.asset.frameRate) {
      throw new Error(`"${file.name}" has no decodable video track`)
    }
    return {
      asset: loaded.asset,
      videoTrack: loaded.videoTrack,
      chunkProvider: createChunkSource(loaded.videoTrack, loaded.asset.frameRate),
    }
  },
}

interface ControllerState {
  canvas: HTMLCanvasElement | null
  bridge: BridgeLike | null
  /** Rate of the asset currently in the bridge (playhead frames rescale to it). */
  assetRate: FrameRate | null
  loadedForAssetId: string | null
  loadSequence: number
  unsubscribes: Array<() => void>
  rafPending: boolean
  latestFrame: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  assetRate: null,
  loadedForAssetId: null,
  loadSequence: 0,
  unsubscribes: [],
  rafPending: false,
  latestFrame: 0,
}

/** Newest imported video asset, or null. (Map preserves insertion order.) */
function newestVideoAsset(assets: Map<string, MediaAsset>): MediaAsset | null {
  let newest: MediaAsset | null = null
  for (const asset of assets.values()) {
    if (asset.kind === 'video') newest = asset
  }
  return newest
}

function scheduleRender(frame: number): void {
  state.latestFrame = frame
  if (state.rafPending || !state.bridge || !state.assetRate) return
  state.rafPending = true
  requestAnimationFrame(() => {
    state.rafPending = false
    const { bridge, assetRate } = state
    if (!bridge || !assetRate) return
    const docRate = useDocumentStore.getState().doc.frameRate
    const assetFrame = rescaleFrames(state.latestFrame, docRate, assetRate)
    void bridge.renderFrameAt(assetFrame)
  })
}

async function loadNewestAsset(deps: PreviewDeps): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const asset = newestVideoAsset(useMediaStore.getState().assets)
  if (!asset || asset.id === state.loadedForAssetId) return

  const sequence = ++state.loadSequence
  state.loadedForAssetId = asset.id
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    const file = new File([blob], asset.fileName, { type: blob.type })
    const demuxed = await deps.demux(file)
    if (sequence !== state.loadSequence) return // superseded by a newer import

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
    await bridge.configure(deserializeDecoderConfig(demuxed.asset.decoderConfigB64))
    if (sequence !== state.loadSequence) return
    bridge.setSource(demuxed.asset.frameRate, demuxed.chunkProvider)
    state.assetRate = demuxed.asset.frameRate
    scheduleRender(useTransportStore.getState().playheadFrame)
  } catch (e) {
    if (sequence === state.loadSequence) state.loadedForAssetId = null
    console.warn(
      `[previewController] loading "${asset.fileName}" failed:`,
      e instanceof Error ? e.message : e,
    )
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
  state.canvas = canvas
  state.bridge = bridge

  state.unsubscribes.push(
    useTransportStore.subscribe((s, prev) => {
      if (s.playheadFrame !== prev.playheadFrame) scheduleRender(s.playheadFrame)
    }),
    useMediaStore.subscribe(() => {
      void loadNewestAsset(deps)
    }),
  )
  // An asset may already be waiting (import before mount, HMR, tests).
  void loadNewestAsset(deps)
}

/** Tear everything down (tests / real app teardown, not StrictMode churn). */
export function disposePreview(): void {
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.bridge?.dispose()
  state.bridge = null
  state.canvas = null
  state.assetRate = null
  state.loadedForAssetId = null
  state.loadSequence++
  state.rafPending = false
}
