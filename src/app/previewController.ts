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
 * canvas. Watches mediaStore and gives every analyzed video Blob plus every
 * document-referenced image Blob to the bridge once (one worker-owned source
 * per asset), releasing images after their final document reference disappears
 * and every source when its connected asset disappears;
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

import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { AssetId, FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import { updateClipVisualAtFrame } from '../domain/operations'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
  type VideoCompositionPlanner,
} from '../domain/videoCompositionPlan'
import {
  mediaAssetDecoderBudget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type { RenderFrameResult } from '../engine/render-bridge'
import {
  RenderAssetOpenError,
  RenderWorkerBridge,
  createRenderWorker,
} from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import {
  useTransportStore,
  type ClipVisualPreview,
  type TextOverlayPreview,
} from '../state/transportStore'
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
  setSourceBoundsCatalog(catalog: SourceBoundsCatalog): void
  openAsset(
    assetId: AssetId,
    blob: Blob,
    rate: FrameRate,
    budget: LocalDecoderBudget,
    runtimeToken: object,
  ): Promise<void>
  openImage(
    assetId: AssetId,
    blob: Blob,
    runtimeToken: object,
  ): Promise<void>
  releaseAsset(assetId: AssetId): void
  renderFrame(frame: number, mode: RenderMode): Promise<RenderFrameResult>
  dispose(): void
  onWorkerError: ((message: string) => void) | null
  onAssetError: ((
    assetId: AssetId,
    runtimeToken: object,
    trackKind: 'video' | null,
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
  now(): number
  /** Resolve only after a paint opportunity following the completed draw. */
  afterPresentationBoundary(): Promise<number>
}

/** Passive timing evidence for dev tools; absent listeners add no clock reads. */
export interface PreviewRenderDiagnostic {
  readonly frame: number
  readonly mode: RenderMode
  readonly requestedAt: number
  readonly presentedAt: number
  readonly result: RenderFrameResult
}

export type PreviewRenderDiagnosticListener = (
  diagnostic: PreviewRenderDiagnostic,
) => void

const renderDiagnosticListeners = new Set<PreviewRenderDiagnosticListener>()

/** Subscribe without putting benchmark data in project or Zustand state. */
export function subscribePreviewRenderDiagnostics(
  listener: PreviewRenderDiagnosticListener,
): () => void {
  renderDiagnosticListeners.add(listener)
  return () => renderDiagnosticListeners.delete(listener)
}

function publishRenderDiagnostic(
  diagnostic: PreviewRenderDiagnostic,
): void {
  for (const listener of renderDiagnosticListeners) {
    try {
      listener(diagnostic)
    } catch {
      // Diagnostics are observational and must never disturb presentation.
    }
  }
}

const realDeps: PreviewDeps = {
  createBridge: () => new RenderWorkerBridge(createRenderWorker()),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => (bridge as RenderWorkerBridge).init(offscreen),
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
  now: () => performance.now(),
  afterPresentationBoundary: () => new Promise((resolve) => {
    // The worker draw may resolve between browser frames. The first callback
    // queues behind that completion; by the second callback, the browser has
    // crossed the intervening paint/compositor opportunity for the canvas.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(performance.now()))
    })
  }),
}

interface ControllerState {
  canvas: HTMLCanvasElement | null
  bridge: BridgeLike | null
  visualPlanner: VideoCompositionPlanner | null
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
  /** Invalidates presentation evidence when a newer render is dispatched. */
  presentationGeneration: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  visualPlanner: null,
  assetStates: new Map(),
  unsubscribes: [],
  rafPending: false,
  renderGeneration: 0,
  presentationGeneration: 0,
}

function modeForTransport(transport: {
  isPlaying: boolean
  isScrubbing: boolean
}): RenderMode {
  return transport.isPlaying && !transport.isScrubbing ? 'playback' : 'seek'
}

function currentSourceBoundsCatalog(): SourceBoundsCatalog {
  return createSourceBoundsCatalog(
    useMediaStore.getState().descriptors.values(),
  )
}

/** Apply a transport-owned draft without touching document history. */
export function documentWithTextOverlayPreview(
  doc: TimelineDoc,
  preview: TextOverlayPreview | null,
): TimelineDoc {
  if (!preview) return doc
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex]
    const clipIndex = track.clips.findIndex((clip) => clip.id === preview.clipId)
    if (clipIndex < 0) continue
    const clip = track.clips[clipIndex]
    if (!clip.text) return doc
    const clips = track.clips.slice()
    clips[clipIndex] = {
      ...clip,
      transform: preview.transform
        ? { ...preview.transform }
        : clip.transform,
      text: preview.text ? { ...preview.text } : clip.text,
    }
    const tracks = doc.tracks.slice()
    tracks[trackIndex] = { ...track, clips }
    return { ...doc, tracks }
  }
  return doc
}

/** Apply a media geometry draft without touching the durable document. */
export function documentWithClipVisualPreview(
  doc: TimelineDoc,
  preview: ClipVisualPreview | null,
  timelineFrame = 0,
): TimelineDoc {
  if (!preview) return doc
  return updateClipVisualAtFrame(doc, preview.clipId, timelineFrame, {
    transform: { ...preview.transform },
    visual: {
      ...preview.visual,
      crop: { ...preview.visual.crop },
    },
  })
}

function currentPreviewDocument(): TimelineDoc {
  const transport = useTransportStore.getState()
  return documentWithClipVisualPreview(
    documentWithTextOverlayPreview(
      useDocumentStore.getState().doc,
      transport.textOverlayPreview,
    ),
    transport.clipVisualPreview,
    transport.playheadFrame,
  )
}

function syncPreviewDocument(bridge: BridgeLike): void {
  const doc = currentPreviewDocument()
  state.visualPlanner = createVideoCompositionPlanner(
    doc,
    currentSourceBoundsCatalog(),
  )
  bridge.setDoc(doc)
}

function scheduleRender(deps: PreviewDeps): void {
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
    const media = useMediaStore.getState()
    const offlineIds: AssetId[] = []
    const seen = new Set<AssetId>()
    const visualPlan = state.visualPlanner?.planFrame(transport.playheadFrame)
    if (!visualPlan) return
    for (const request of videoCompositionRequests(visualPlan)) {
      const id = request.clip.assetId
      if (
        !seen.has(id)
        && media.descriptors.has(id)
        && !media.assets.has(id)
      ) {
        seen.add(id)
        offlineIds.push(id)
      }
    }
    usePreviewStatusStore.getState().setOfflineVisualAssetIds(offlineIds)
    const frame = transport.playheadFrame
    const mode = modeForTransport(transport)
    const diagnosticsEnabled = renderDiagnosticListeners.size > 0
    const requestedAt = diagnosticsEnabled ? deps.now() : 0
    const presentationGeneration = ++state.presentationGeneration
    void bridge
      .renderFrame(frame, mode)
      .then((result) => {
        if (diagnosticsEnabled && result.status !== 'superseded') {
          // Presentation evidence is deliberately passive: ordinary preview
          // completion/error handling below is not held behind browser paint.
          void deps.afterPresentationBoundary().then((presentedAt) => {
            if (
              renderDiagnosticListeners.size === 0
              || state.renderGeneration !== generation
              || state.bridge !== bridge
              || state.presentationGeneration !== presentationGeneration
            ) return
            publishRenderDiagnostic({
              frame,
              mode,
              requestedAt,
              presentedAt,
              result,
            })
          }).catch(() => {
            // Diagnostics must never disturb presentation or app behavior.
          })
        }
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
  let failureReason: MediaRuntimeFailure['reason'] = 'resource-unavailable'
  let failureTrackKind: 'video' | null = null
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) {
      return
    }
    failureReason = 'decode-failed'
    if (asset.kind === 'image') {
      await bridge.openImage(asset.id, blob, guard)
    } else {
      failureTrackKind = 'video'
      if (!asset.frameRate) {
        throw new Error(`"${asset.fileName}": missing frame rate`)
      }
      await bridge.openAsset(
        asset.id,
        blob,
        asset.frameRate,
        mediaAssetDecoderBudget(asset, blob.size),
        guard,
      )
    }
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

function documentAssetIds(doc: TimelineDoc): Set<AssetId> {
  const ids = new Set<AssetId>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      // Text clips render procedurally and never sample their backing asset.
      // Legacy projects may validly carry image-backed text clips, so treating
      // every clip id as a still-source reference would decode unused pixels.
      if (clip.text === undefined) ids.add(clip.assetId)
    }
  }
  return ids
}

/** Reconcile worker-owned sources with connected media + document references. */
function syncAssets(deps: PreviewDeps): void {
  const bridge = state.bridge
  if (!bridge) return
  const assets = useMediaStore.getState().assets
  const referencedIds = documentAssetIds(useDocumentStore.getState().doc)
  const desiredIds = new Set<AssetId>()

  for (const asset of assets.values()) {
    if (asset.kind !== 'video' && asset.kind !== 'image') continue
    // Timed-video behavior stays unchanged: connected videos are kept warm.
    // A still owns a retained worker source only while the document uses it.
    if (asset.kind === 'image' && !referencedIds.has(asset.id)) continue
    desiredIds.add(asset.id)
    const current = state.assetStates.get(asset.id)
    if (current?.objectUrl === asset.objectUrl) continue
    if (current) {
      state.assetStates.delete(asset.id)
      bridge.releaseAsset(asset.id)
    }
    void loadOneAsset(deps, asset)
  }

  for (const id of [...state.assetStates.keys()]) {
    if (!desiredIds.has(id)) {
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
  bridge.onAssetError = (assetId, runtimeToken, trackKind, message) => {
    const guard = runtimeToken as MediaRuntimeGuard
    if (guard.assetId !== assetId) return
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', trackKind, message),
    )
  }
  // A source came online: repaint so its clips fill in (retry policy).
  bridge.onAssetReady = () =>
    scheduleRender(deps)
  state.canvas = canvas
  state.bridge = bridge

  const initialDoc = currentPreviewDocument()
  const initialBounds = currentSourceBoundsCatalog()
  state.visualPlanner = createVideoCompositionPlanner(initialDoc, initialBounds)
  bridge.setSourceBoundsCatalog(initialBounds)
  bridge.setDoc(initialDoc)

  state.unsubscribes.push(
    useDocumentStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) {
        syncPreviewDocument(bridge)
        syncAssets(deps)
        scheduleRender(deps)
      }
    }),
    useTransportStore.subscribe((s, prev) => {
      if (
        s.textOverlayPreview !== prev.textOverlayPreview
        || s.clipVisualPreview !== prev.clipVisualPreview
      ) {
        syncPreviewDocument(bridge)
      }
      if (
        s.playheadFrame !== prev.playheadFrame
        || modeForTransport(s) !== modeForTransport(prev)
        || s.textOverlayPreview !== prev.textOverlayPreview
        || s.clipVisualPreview !== prev.clipVisualPreview
      ) scheduleRender(deps)
    }),
    useMediaStore.subscribe(() => {
      const bounds = currentSourceBoundsCatalog()
      state.visualPlanner = createVideoCompositionPlanner(
        currentPreviewDocument(),
        bounds,
      )
      bridge.setSourceBoundsCatalog(bounds)
      syncAssets(deps)
      scheduleRender(deps)
    }),
  )
  // Assets may already be waiting (import before mount, HMR, tests) and an
  // empty timeline still paints its background.
  syncAssets(deps)
  scheduleRender(deps)
}

/** Tear everything down (tests / real app teardown, not StrictMode churn). */
export function disposePreview(): void {
  state.renderGeneration++
  state.presentationGeneration++
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.bridge?.dispose()
  state.bridge = null
  state.visualPlanner = null
  state.canvas = null
  state.assetStates = new Map()
  state.rafPending = false
  usePreviewStatusStore.getState().resetPreviewStatus()
}
