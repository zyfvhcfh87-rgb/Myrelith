import { beginSpeechRetirement } from './speechRetirement'
/**
 * app/sourceMonitorPreviewController.ts — composition root for Source
 * Monitor pixels.
 *
 * Owns one render worker and canvas for the open Media Pool asset. The
 * review TimelineDoc is worker protocol only: it never enters
 * documentStore, recovery, or undo. UI does not fetch Blobs.
 */

import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import {
  resolvePresentationProfile,
  type PresentationProfile,
  type PresentationViewport,
} from '../domain/presentationProfile'
import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import type { SourceMonitorSession } from '../domain/sourceMonitor'
import {
  createVideoCompositionPlanner,
  type VideoCompositionPlanner,
} from '../domain/videoCompositionPlan'
import {
  RenderAssetOpenError,
  RenderWorkerBridge,
  createRenderWorker,
  type RenderFrameResult,
} from '../engine/render-bridge'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import type { RenderMode } from '../workers/render-protocol'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
  type MediaRuntimeGuard,
} from './mediaCompatibilityController'
import { mediaResourceAdmission, type MediaResourceLease } from './mediaResourceAdmission'
import { createMediaBlobFetcher } from './playbackAudioShared'
import { sourceReviewDocument } from './sourceReviewDocument'
import { registerLoadedEditorRuntime } from './editorRuntimeLifecycle'

export interface SourcePreviewBridge {
  setDoc(doc: TimelineDoc): void
  setPresentationProfile(profile: PresentationProfile): void
  openAsset(
    assetId: AssetId,
    blob: Blob,
    rate: TimelineDoc['frameRate'],
    budget: ReturnType<typeof mediaAssetDecoderBudget>,
    runtimeToken: object,
  ): Promise<void>
  openImage(assetId: AssetId, blob: Blob, runtimeToken: object): Promise<void>
  releaseAsset(assetId: AssetId): void
  renderFrame(plan: ReturnType<VideoCompositionPlanner['planFrame']>, mode: RenderMode): Promise<RenderFrameResult>
  dispose(): void | Promise<void>
  onWorkerError: ((message: string) => void) | null
  onAssetError: ((
    assetId: AssetId,
    runtimeToken: object,
    trackKind: 'video' | null,
    message: string,
  ) => void) | null
  onAssetReady: ((assetId: AssetId) => void) | null
}

export interface SourcePreviewDeps {
  createBridge(): SourcePreviewBridge
  createVisualPlanner(
    doc: TimelineDoc,
    catalog: SourceBoundsCatalog,
  ): VideoCompositionPlanner
  transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas
  init(bridge: SourcePreviewBridge, canvas: OffscreenCanvas): void
  fetchBlob(url: string): Promise<Blob>
}

const realDeps: SourcePreviewDeps = {
  createBridge: () => new RenderWorkerBridge(createRenderWorker(), null),
  createVisualPlanner: (doc, catalog) => createVideoCompositionPlanner(doc, catalog),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => {
    if (bridge instanceof RenderWorkerBridge) bridge.init(offscreen)
  },
  fetchBlob: createMediaBlobFetcher('source preview media'),
}

interface ControllerState {
  resourceLease: MediaResourceLease | null
  canvas: HTMLCanvasElement | null
  bridge: SourcePreviewBridge | null
  deps: SourcePreviewDeps | null
  viewport: PresentationViewport | null
  visualPlanner: VideoCompositionPlanner | null
  reviewDoc: TimelineDoc | null
  openedAssetId: AssetId | null
  loadingAssetId: AssetId | null
  sourceKey: string | null
  unsubscribes: Array<() => void>
  rafHandle: number | null
  renderGeneration: number
  sourceLoadGeneration: number
  suspended: boolean
}

const state: ControllerState = {
  resourceLease: null,
  canvas: null,
  bridge: null,
  deps: null,
  viewport: null,
  visualPlanner: null,
  reviewDoc: null,
  openedAssetId: null,
  loadingAssetId: null,
  sourceKey: null,
  unsubscribes: [],
  rafHandle: null,
  renderGeneration: 0,
  sourceLoadGeneration: 0,
  suspended: false,
}

function catalogFor(asset: MediaAsset | undefined): SourceBoundsCatalog {
  if (!asset) return createSourceBoundsCatalog([])
  return createSourceBoundsCatalog([{
    id: asset.id,
    sourceBounds: asset.sourceBounds,
  }])
}

function currentAsset(session: SourceMonitorSession | null): MediaAsset | undefined {
  if (!session) return undefined
  return useMediaStore.getState().assets.get(session.source.assetId)
}

function cancelScheduledRender(): void {
  if (state.rafHandle === null) return
  cancelAnimationFrame(state.rafHandle)
  state.rafHandle = null
}

function renderMode(session: SourceMonitorSession): RenderMode {
  return session.shuttleStep === 0 ? 'seek' : 'playback'
}

function syncPresentationProfile(bridge: SourcePreviewBridge, doc: TimelineDoc): void {
  const session = useSourceMonitorStore.getState().session
  const profile = resolvePresentationProfile(doc, {
    qualityMode: 'auto',
    reason: session && session.shuttleStep !== 0 ? 'playing' : 'paused',
    viewport: state.viewport,
  })
  bridge.setPresentationProfile(profile)
}

function scheduleRender(): void {
  const bridge = state.bridge
  const planner = state.visualPlanner
  if (state.rafHandle !== null || !bridge || !planner) return
  const generation = state.renderGeneration
  const handle = requestAnimationFrame(() => {
    if (state.rafHandle === handle) state.rafHandle = null
    if (state.renderGeneration !== generation || state.bridge !== bridge) return
    const session = useSourceMonitorStore.getState().session
    if (!session) return
    void bridge.renderFrame(
      planner.planFrame(session.playheadFrame),
      renderMode(session),
    ).then((result) => {
      if (!isCurrentOwner(bridge, generation) || result.status !== 'error') return
      console.warn(
        '[sourceMonitorPreviewController] render failed:',
        result.message ?? 'Unknown render error',
      )
    }, (cause) => {
      if (!isCurrentOwner(bridge, generation)) return
      console.warn(
        '[sourceMonitorPreviewController] render failed:',
        cause instanceof Error ? cause.message : cause,
      )
    })
  })
  state.rafHandle = handle
}

function releaseOpenedSource(bridge: SourcePreviewBridge): void {
  state.sourceLoadGeneration++
  const assetIds = new Set<AssetId>()
  if (state.openedAssetId) assetIds.add(state.openedAssetId)
  if (state.loadingAssetId) assetIds.add(state.loadingAssetId)
  for (const assetId of assetIds) {
    bridge.releaseAsset(assetId)
  }
  state.openedAssetId = null
  state.loadingAssetId = null
  state.sourceKey = null
}

function isCurrentSourceLoad(
  bridge: SourcePreviewBridge,
  sourceKey: string,
  generation: number,
): boolean {
  return state.bridge === bridge
    && state.sourceKey === sourceKey
    && state.sourceLoadGeneration === generation
}

async function loadVisualSource(
  deps: SourcePreviewDeps,
  session: SourceMonitorSession,
  asset: MediaAsset,
): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const sourceKey = `original:${asset.objectUrl}`
  if (state.sourceKey === sourceKey) return
  releaseOpenedSource(bridge)
  const loadGeneration = state.sourceLoadGeneration
  state.sourceKey = sourceKey
  state.loadingAssetId = asset.id
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) {
    state.sourceKey = null
    state.loadingAssetId = null
    return
  }
  let failureReason: MediaRuntimeFailure['reason'] = 'resource-unavailable'
  let failureTrackKind: 'video' | null = session.source.kind === 'video' ? 'video' : null
  try {
    const speechDrain = beginSpeechRetirement('Source selection')
    if (speechDrain) await speechDrain
    if (!isCurrentSourceLoad(bridge, sourceKey, loadGeneration)) return
    const blob = await deps.fetchBlob(asset.objectUrl)
    if (!isCurrentSourceLoad(bridge, sourceKey, loadGeneration)) return
    failureReason = 'decode-failed'
    if (session.source.kind === 'image') {
      await bridge.openImage(asset.id, blob, guard)
    } else {
      await bridge.openAsset(
        asset.id,
        blob,
        session.source.rate,
        mediaAssetDecoderBudget(asset, blob.size),
        guard,
      )
    }
    if (!isCurrentSourceLoad(bridge, sourceKey, loadGeneration)) return
    state.loadingAssetId = null
    state.openedAssetId = asset.id
  } catch (cause) {
    if (!isCurrentSourceLoad(bridge, sourceKey, loadGeneration)) return
    state.sourceKey = null
    state.loadingAssetId = null
    state.openedAssetId = null
    if (cause instanceof RenderAssetOpenError) {
      failureReason = cause.failure.reason
      failureTrackKind = cause.failure.trackKind
    }
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', failureTrackKind, cause, failureReason),
    )
  }
}

function syncReview(deps: SourcePreviewDeps): void {
  const bridge = state.bridge
  if (!bridge) return
  const session = useSourceMonitorStore.getState().session
  if (!session || state.suspended) {
    releaseOpenedSource(bridge)
    state.reviewDoc = null
    state.visualPlanner = null
    return
  }
  const asset = currentAsset(session)
  const doc = sourceReviewDocument(session, asset, 'video')
  state.reviewDoc = doc
  state.visualPlanner = deps.createVisualPlanner(doc, catalogFor(asset))
  bridge.setDoc(doc)
  syncPresentationProfile(bridge, doc)
  if (
    asset
    && (session.source.kind === 'video' || session.source.kind === 'image')
  ) {
    void loadVisualSource(deps, session, asset)
  } else {
    releaseOpenedSource(bridge)
  }
  scheduleRender()
}

function isCurrentOwner(
  bridge: SourcePreviewBridge,
  generation: number,
): boolean {
  return state.bridge === bridge && state.renderGeneration === generation
}

export function setSourcePreviewViewport(viewport: PresentationViewport | null): void {
  state.viewport = viewport
  const doc = state.reviewDoc
  const bridge = state.bridge
  if (!doc || !bridge) return
  syncPresentationProfile(bridge, doc)
  scheduleRender()
}

/** Retire any Source playback lane before another decoder owner starts. */
export async function drainSourcePreviewPlayback(): Promise<void> {
  while (true) {
    cancelScheduledRender()
    const bridge = state.bridge
    const planner = state.visualPlanner
    if (!bridge || !planner) return
    const generation = state.renderGeneration
    const session = useSourceMonitorStore.getState().session
    if (!session) return
    const result = await bridge.renderFrame(
      planner.planFrame(session.playheadFrame),
      'seek',
    )
    if (state.bridge !== bridge || state.renderGeneration !== generation) continue
    if (result.status === 'superseded') continue
    cancelScheduledRender()
    if (result.status === 'error') {
      throw new Error(result.message ?? 'Source preview decoder teardown failed')
    }
    return
  }
}

/** Release Source preview resources while the editor is backgrounded. */
export function suspendSourcePreview(): void {
  if (state.suspended) return
  state.suspended = true
  cancelScheduledRender()
  if (state.bridge) releaseOpenedSource(state.bridge)
  state.reviewDoc = null
  state.visualPlanner = null
}

/** Re-open the current Source preview after the editor becomes visible. */
export function resumeSourcePreview(): void {
  if (!state.suspended) return
  state.suspended = false
  if (state.deps) syncReview(state.deps)
}

export function initSourcePreview(
  canvas: HTMLCanvasElement,
  deps: SourcePreviewDeps = realDeps,
): void {
  if (state.canvas === canvas) return
  void disposeSourcePreviewState()

  let bridge: SourcePreviewBridge | undefined
  const resourceLease = mediaResourceAdmission.reserve({ kind: 'source', decoderSlots: 2, surfaceBytes: 0, monitorCompatible: false })
  try {
    bridge = deps.createBridge()
    deps.init(bridge, deps.transferCanvas(canvas))
  } catch (cause) {
    const failedBridge = bridge
    void (async () => {
      try { await failedBridge?.dispose() }
      catch (error) { console.warn('[sourceMonitorPreviewController] failed initialization cleanup:', error) }
      finally { resourceLease.release() }
    })()
    console.warn(
      '[sourceMonitorPreviewController] preview disabled:',
      cause instanceof Error ? cause.message : cause,
    )
    return
  }

  state.canvas = canvas
  state.resourceLease = resourceLease
  state.bridge = bridge
  state.deps = deps
  state.suspended = false
  const ownerGeneration = state.renderGeneration
  bridge.onWorkerError = (message) => {
    if (!isCurrentOwner(bridge, ownerGeneration)) return
    console.warn('[sourceMonitorPreviewController] worker error:', message)
  }
  bridge.onAssetError = (assetId, runtimeToken, trackKind, message) => {
    if (!isCurrentOwner(bridge, ownerGeneration)) return
    const guard = runtimeToken as MediaRuntimeGuard
    if (guard.assetId !== assetId) return
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', trackKind, message),
    )
  }
  bridge.onAssetReady = () => {
    if (!isCurrentOwner(bridge, ownerGeneration)) return
    scheduleRender()
  }

  state.unsubscribes.push(
    useSourceMonitorStore.subscribe((current, previous) => {
      if (state.bridge !== bridge || state.deps !== deps) return
      const sessionChanged = current.session?.source.assetId
        !== previous.session?.source.assetId
        || (current.session === null) !== (previous.session === null)
        || current.session?.source.durationFrames
          !== previous.session?.source.durationFrames
        || current.session?.source.kind !== previous.session?.source.kind
      if (sessionChanged) syncReview(deps)
      else if (
        current.session
        && (
          current.session.playheadFrame !== previous.session?.playheadFrame
          || current.session.shuttleStep !== previous.session.shuttleStep
        )
      ) {
        // Auto quality scales down only while the Source is playing.
        if (
          state.reviewDoc
          && (current.session.shuttleStep !== 0) !== (previous.session?.shuttleStep !== 0)
        ) syncPresentationProfile(bridge, state.reviewDoc)
        scheduleRender()
      }
    }),
    useMediaStore.subscribe((current, previous) => {
      if (state.bridge !== bridge || state.deps !== deps) return
      // The review document reads only the open session's connected asset;
      // rebuilding it for unrelated media changes would supersede playback.
      const assetId = useSourceMonitorStore.getState().session?.source.assetId
      if (
        assetId === undefined
        || current.assets.get(assetId) === previous.assets.get(assetId)
      ) return
      syncReview(deps)
    }),
  )
  syncReview(deps)
}

async function disposeSourcePreviewState(): Promise<void> {
  const resourceLease = state.resourceLease
  state.resourceLease = null
  cancelScheduledRender()
  state.renderGeneration++
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  if (state.bridge) releaseOpenedSource(state.bridge)
  let close: void | Promise<void>
  try { close = state.bridge?.dispose() } catch (cause) { close = Promise.reject(cause) }
  state.bridge = null
  state.deps = null
  state.viewport = null
  state.visualPlanner = null
  state.reviewDoc = null
  state.openedAssetId = null
  state.loadingAssetId = null
  state.sourceKey = null
  state.suspended = false
  state.canvas = null
  state.rafHandle = null
  try { await close } finally { resourceLease?.release() }
}

export function disposeSourcePreview(): Promise<void> {
  return disposeSourcePreviewState()
}
registerLoadedEditorRuntime('sourcePreview', disposeSourcePreview)
