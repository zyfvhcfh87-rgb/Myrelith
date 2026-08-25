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
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import type {
  AssetId,
  Clip,
  MediaAsset,
  TimelineDoc,
  Track,
} from '../domain/schema'
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

const IDENTITY_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
})

const realDeps: SourcePreviewDeps = {
  createBridge: () => new RenderWorkerBridge(createRenderWorker(), null),
  createVisualPlanner: (doc, catalog) => createVideoCompositionPlanner(doc, catalog),
  transferCanvas: (canvas) => canvas.transferControlToOffscreen(),
  init: (bridge, offscreen) => {
    if (bridge instanceof RenderWorkerBridge) bridge.init(offscreen)
  },
  fetchBlob: (url) => fetch(url).then((response) => response.blob()),
}

interface ControllerState {
  canvas: HTMLCanvasElement | null
  bridge: SourcePreviewBridge | null
  deps: SourcePreviewDeps | null
  viewport: PresentationViewport | null
  visualPlanner: VideoCompositionPlanner | null
  reviewDoc: TimelineDoc | null
  openedAssetId: AssetId | null
  sourceKey: string | null
  unsubscribes: Array<() => void>
  rafHandle: number | null
  renderGeneration: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  deps: null,
  viewport: null,
  visualPlanner: null,
  reviewDoc: null,
  openedAssetId: null,
  sourceKey: null,
  unsubscribes: [],
  rafHandle: null,
  renderGeneration: 0,
}

function emptyReviewDoc(session: SourceMonitorSession): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: `source-review:${session.source.assetId}`,
    name: session.source.fileName,
    frameRate: session.source.rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

function reviewClip(session: SourceMonitorSession): Clip {
  const still = session.source.kind === 'image'
  return {
    id: 'source-review-clip',
    assetId: session.source.assetId,
    name: session.source.fileName,
    sourceMode: still ? 'still' : 'timed',
    sourceRange: still
      ? { startFrame: 0, durationFrames: 1 }
      : { startFrame: 0, durationFrames: session.source.durationFrames },
    timelineRange: {
      startFrame: 0,
      durationFrames: session.source.durationFrames,
    },
    transform: { ...IDENTITY_TRANSFORM },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function reviewTrack(session: SourceMonitorSession): Track {
  return {
    id: 'source-review-V1',
    kind: 'video',
    name: 'Source',
    clips: [reviewClip(session)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function buildSourceReviewDocument(
  session: SourceMonitorSession,
  asset: MediaAsset | undefined,
): TimelineDoc {
  const visual = session.source.kind === 'video' || session.source.kind === 'image'
  const width = Math.max(1, asset?.width ?? 1920)
  const height = Math.max(1, asset?.height ?? 1080)
  return {
    ...emptyReviewDoc(session),
    width,
    height,
    tracks: visual ? [reviewTrack(session)] : [],
  }
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
    )
  })
  state.rafHandle = handle
}

function releaseOpenedSource(bridge: SourcePreviewBridge): void {
  if (state.openedAssetId) {
    bridge.releaseAsset(state.openedAssetId)
  }
  state.openedAssetId = null
  state.sourceKey = null
}

async function loadVisualSource(
  deps: SourcePreviewDeps,
  session: SourceMonitorSession,
  asset: MediaAsset,
): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const sourceKey = `original:${asset.objectUrl}`
  if (state.openedAssetId === asset.id && state.sourceKey === sourceKey) return
  if (state.openedAssetId && state.openedAssetId !== asset.id) {
    bridge.releaseAsset(state.openedAssetId)
  }
  state.openedAssetId = asset.id
  state.sourceKey = sourceKey
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) return
  let failureReason: MediaRuntimeFailure['reason'] = 'resource-unavailable'
  let failureTrackKind: 'video' | null = session.source.kind === 'video' ? 'video' : null
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    if (state.bridge !== bridge || state.sourceKey !== sourceKey) return
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
  } catch (cause) {
    if (state.bridge !== bridge || state.sourceKey !== sourceKey) return
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
  if (!session) {
    releaseOpenedSource(bridge)
    state.reviewDoc = null
    state.visualPlanner = null
    return
  }
  const asset = currentAsset(session)
  const doc = buildSourceReviewDocument(session, asset)
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

export function initSourcePreview(
  canvas: HTMLCanvasElement,
  deps: SourcePreviewDeps = realDeps,
): void {
  if (state.canvas === canvas) return
  void disposeSourcePreviewState()

  let bridge: SourcePreviewBridge
  try {
    bridge = deps.createBridge()
    deps.init(bridge, deps.transferCanvas(canvas))
  } catch (cause) {
    console.warn(
      '[sourceMonitorPreviewController] preview disabled:',
      cause instanceof Error ? cause.message : cause,
    )
    return
  }

  state.canvas = canvas
  state.bridge = bridge
  state.deps = deps
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
        scheduleRender()
      }
    }),
    useMediaStore.subscribe(() => {
      if (state.bridge !== bridge || state.deps !== deps) return
      syncReview(deps)
    }),
  )
  syncReview(deps)
}

async function disposeSourcePreviewState(): Promise<void> {
  cancelScheduledRender()
  state.renderGeneration++
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  const close = state.bridge?.dispose()
  state.bridge = null
  state.deps = null
  state.viewport = null
  state.visualPlanner = null
  state.reviewDoc = null
  state.openedAssetId = null
  state.sourceKey = null
  state.canvas = null
  state.rafHandle = null
  await close
}

export function disposeSourcePreview(): Promise<void> {
  return disposeSourcePreviewState()
}
