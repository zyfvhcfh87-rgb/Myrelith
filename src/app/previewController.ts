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
 * canvas. Watches mediaStore and gives every analyzed video Blob to the
 * bridge once (one worker-owned source per asset),
 * releasing assets that disappear;
 * watches documentStore and posts each new doc snapshot; watches
 * transportStore and renders its latest frame + playback/seek mode,
 * coalesced to one renderFrame per animation frame (the bridge further
 * dedupes latest-wins). Re-renders when a doc changes or an asset source
 * becomes ready — that is the whole retry policy for clips the worker
 * reported missing (the worker never self-recomposites; see PLAN 4.1b).
 *
 * StrictMode note: a canvas can be transferred to a worker exactly once,
 * so initPreview is idempotent per canvas element and survives React's
 * dev-mode double-mount; nothing is torn down on effect cleanup. dispose()
 * exists for tests and real teardown.
 */

import type { AssetId, FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import { visibleVideoLayersAtFrame } from '../domain/selectors'
import type { RenderFrameResult } from '../engine/render-bridge'
import {
  RenderAssetOpenError,
  RenderWorkerBridge,
  createRenderWorker,
} from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { useTransportStore } from '../state/transportStore'
import type { RenderMode } from '../workers/render-protocol'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
  type MediaRuntimeGuard,
} from './mediaCompatibilityController'

/** The bridge surface the controller drives (real or test fake). */
export interface BridgeLike {
  setDoc(doc: TimelineDoc): void
  openAsset(
    assetId: AssetId,
    blob: Blob,
    rate: FrameRate,
    runtimeToken: object,
  ): Promise<void>
  releaseAsset(assetId: AssetId): void
  renderFrame(frame: number, mode: RenderMode): Promise<RenderFrameResult>
  dispose(): void
  onWorkerError: ((message: string) => void) | null
  onAssetError: ((
    assetId: AssetId,
    runtimeToken: object,
    message: string,
  ) => void) | null
  onAssetReady: ((assetId: AssetId) => void) | null
}

/** Injection points so tests can run without Worker/OffscreenCanvas/fetch. */
export interface PreviewDeps {
  createBridge(): BridgeLike
  transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas
  init(bridge: BridgeLike, canvas: OffscreenCanvas): void
  fetchBlob(url: string): Promise<Blob>
}

const realDeps: PreviewDeps = {
  createBridge: () => new RenderWorkerBridge(createRenderWorker()),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => (bridge as RenderWorkerBridge).init(offscreen),
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
}

interface ControllerState {
  canvas: HTMLCanvasElement | null
  bridge: BridgeLike | null
  /** Per-asset pipeline status. Absent = not started (or failed: retried
   * on the next mediaStore change). Removal releases the worker source. */
  assetStates: Map<AssetId, {
    objectUrl: string
    status: 'loading' | 'ready' | 'failed'
  }>
  unsubscribes: Array<() => void>
  rafPending: boolean
  /** Invalidates callbacks queued for a disposed/replaced bridge. */
  renderGeneration: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  assetStates: new Map(),
  unsubscribes: [],
  rafPending: false,
  renderGeneration: 0,
}

function modeForTransport(transport: {
  isPlaying: boolean
  isScrubbing: boolean
}): RenderMode {
  return transport.isPlaying && !transport.isScrubbing ? 'playback' : 'seek'
}

function scheduleRender(): void {
  const bridge = state.bridge
  if (state.rafPending || !bridge) return
  const generation = state.renderGeneration
  state.rafPending = true
  requestAnimationFrame(() => {
    if (state.renderGeneration !== generation || state.bridge !== bridge) return
    state.rafPending = false
    // Document frames go straight through — per-asset rescaling happens
    // inside the bridge; source cursor policy belongs to the worker.
    const transport = useTransportStore.getState()
    const document = useDocumentStore.getState().doc
    const media = useMediaStore.getState()
    const offlineIds: AssetId[] = []
    const seen = new Set<AssetId>()
    for (const layer of visibleVideoLayersAtFrame(
      document,
      transport.playheadFrame,
    )) {
      const id = layer.clip.assetId
      if (
        !seen.has(id)
        && media.descriptors.has(id)
        && !media.assets.has(id)
      ) {
        seen.add(id)
        offlineIds.push(id)
      }
    }
    usePreviewStatusStore.getState().setOfflineVideoAssetIds(offlineIds)
    void bridge
      .renderFrame(transport.playheadFrame, modeForTransport(transport))
      .then((result) => {
        if (
          state.renderGeneration === generation
          && state.bridge === bridge
          && result.status === 'error'
        ) {
          console.warn(
            '[previewController] render failed:',
            result.message ?? 'unknown render error',
          )
        }
      }, (cause) => {
        if (state.renderGeneration !== generation || state.bridge !== bridge) return
        console.warn(
          '[previewController] render failed:',
          cause instanceof Error ? cause.message : cause,
        )
      })
  })
}

/** Hand one already-analyzed asset's Blob to the render worker. */
async function loadOneAsset(deps: PreviewDeps, asset: MediaAsset): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) return
  const pipelineState = {
    objectUrl: asset.objectUrl,
    status: 'loading' as const,
  }
  state.assetStates.set(asset.id, pipelineState)
  let failureReason: 'decode-failed' | 'resource-unavailable' =
    'resource-unavailable'
  let failureTrackKind: 'video' | null = null
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) {
      return
    }
    failureReason = 'decode-failed'
    failureTrackKind = 'video'
    if (!asset.frameRate) {
      throw new Error(`"${asset.fileName}": missing frame rate`)
    }
    await bridge.openAsset(asset.id, blob, asset.frameRate, guard)
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) {
      return
    }
    state.assetStates.set(asset.id, {
      objectUrl: asset.objectUrl,
      status: 'ready',
    })
  } catch (e) {
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) {
      return
    }
    state.assetStates.set(asset.id, {
      objectUrl: asset.objectUrl,
      status: 'failed',
    })
    if (e instanceof RenderAssetOpenError) {
      failureReason = e.failure.reason
      failureTrackKind = e.failure.trackKind
    }
    console.warn(
      `[previewController] loading "${asset.fileName}" failed:`,
      e instanceof Error ? e.message : e,
    )
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', failureTrackKind, e, failureReason),
    )
  }
}

/** Reconcile worker-owned sources with the media pool (adds + removals). */
function syncAssets(deps: PreviewDeps): void {
  const bridge = state.bridge
  if (!bridge) return
  const assets = useMediaStore.getState().assets

  for (const asset of assets.values()) {
    if (asset.kind !== 'video') continue // audio/images never reach the preview
    const current = state.assetStates.get(asset.id)
    if (current?.objectUrl === asset.objectUrl) continue
    if (current) {
      state.assetStates.delete(asset.id)
      bridge.releaseAsset(asset.id)
    }
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
  bridge.onAssetError = (assetId, runtimeToken, message) => {
    const guard = runtimeToken as MediaRuntimeGuard
    if (guard.assetId !== assetId) return
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', 'video', message),
    )
  }
  // A source came online: repaint so its clips fill in (retry policy).
  bridge.onAssetReady = () =>
    scheduleRender()
  state.canvas = canvas
  state.bridge = bridge

  bridge.setDoc(useDocumentStore.getState().doc)

  state.unsubscribes.push(
    useDocumentStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) {
        bridge.setDoc(s.doc)
        scheduleRender()
      }
    }),
    useTransportStore.subscribe((s, prev) => {
      if (
        s.playheadFrame !== prev.playheadFrame
        || modeForTransport(s) !== modeForTransport(prev)
      ) scheduleRender()
    }),
    useMediaStore.subscribe(() => {
      syncAssets(deps)
      scheduleRender()
    }),
  )
  // Assets may already be waiting (import before mount, HMR, tests) and an
  // empty timeline still paints its background.
  syncAssets(deps)
  scheduleRender()
}

/** Tear everything down (tests / real app teardown, not StrictMode churn). */
export function disposePreview(): void {
  state.renderGeneration++
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.bridge?.dispose()
  state.bridge = null
  state.canvas = null
  state.assetStates = new Map()
  state.rafPending = false
  usePreviewStatusStore.getState().resetPreviewStatus()
}
