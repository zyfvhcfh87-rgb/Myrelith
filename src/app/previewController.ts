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
import {
  presentationSurfacesMatch,
  resolvePresentationProfile,
  type PresentationProfile,
  type PresentationReason,
  type PresentationViewport,
} from '../domain/presentationProfile'
import type { AssetId, FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import type { VideoScopeAnalysis } from '../domain/videoScopes'
import { updateClipVisualAtFrame } from '../domain/operations'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
  type VideoCompositionPlan,
  type VideoCompositionPlanner,
} from '../domain/videoCompositionPlan'
import type {
  PluginVideoEffectContributionSnapshot,
} from '../domain/pluginVideoEffectStagePlan'
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
import { useProxyStore } from '../state/proxyStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { usePreviewQualityStore } from '../state/previewQualityStore'
import { useVideoScopesStore } from '../state/videoScopesStore'
import {
  useTransportStore,
  type ClipVisualPreview,
  type TextOverlayPreview,
} from '../state/transportStore'
import type {
  PluginEffectBridgeHandler,
  PluginEffectBridgeHandlerRequest,
  PluginEffectBridgeHandlerResult,
} from '../workers/plugin-effect-bridge-protocol'
import type {
  RenderMode,
  RenderWorkerCapabilities,
  RenderWorkerRuntimeTelemetrySnapshot,
} from '../workers/render-protocol'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
  type MediaRuntimeGuard,
} from './mediaCompatibilityController'
import {
  createPreviewEffectStatusIndex,
  projectIndexedPreviewEffectStatuses,
  refreshAnimatedPreviewEffectStatuses,
  type PreviewEffectStatusIndex,
} from './previewEffectStatus'
import {
  getProxyPreviewSource,
  isProxyPreviewToken,
  previewRepresentationDecision,
  reportProxyPreviewFailure,
} from './proxyController'

/** The bridge surface the controller drives (real or test fake). */
export interface BridgeLike {
  setDoc(doc: TimelineDoc): void
  setPresentationProfile(profile: PresentationProfile): void
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
  renderFrame(plan: VideoCompositionPlan, mode: RenderMode): Promise<RenderFrameResult>
  setRuntimeTelemetryEnabled?(enabled: boolean): void
  requestRuntimeTelemetry?(): Promise<RenderWorkerRuntimeTelemetrySnapshot>
  setVideoScopesEnabled?(enabled: boolean, generation: number): void
  dispose(): void | Promise<void>
  onWorkerError: ((message: string) => void) | null
  onAssetError: ((
    assetId: AssetId,
    runtimeToken: object,
    trackKind: 'video' | null,
    message: string,
  ) => void) | null
  onAssetReady: ((assetId: AssetId) => void) | null
  onRendererCapabilities: ((capabilities: RenderWorkerCapabilities) => void) | null
  onVideoScopes?: ((
    generation: number,
    frame: number,
    analyzedAt: number,
    analysis: VideoScopeAnalysis,
  ) => void) | null
}

/** Injection points so tests can run without Worker/OffscreenCanvas/fetch. */
export interface PreviewDeps {
  createBridge(pluginEffectHandler: PluginEffectBridgeHandler): BridgeLike
  createVisualPlanner(
    doc: TimelineDoc,
    catalog: SourceBoundsCatalog,
    pluginContributions?: PluginVideoEffectContributionSnapshot,
  ): VideoCompositionPlanner
  transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas
  init(bridge: BridgeLike, canvas: OffscreenCanvas): void
  fetchBlob(url: string): Promise<Blob>
  now(): number
  /** Resolve only after a paint opportunity following the completed draw. */
  afterPresentationBoundary(): Promise<number>
}

/**
 * App-owned plugin seam. The preview keeps only a serializable declaration
 * snapshot plus a stable request facade; runtime owners never enter stores.
 */
export interface PreviewPluginBinding {
  getContributionSnapshot(): PluginVideoEffectContributionSnapshot | undefined
  getEffectBridgeHandler(): PluginEffectBridgeHandler
  subscribe(listener: () => void): () => void
}

/** Passive timing evidence for dev tools; absent listeners add no clock reads. */
export interface PreviewRenderDiagnostic {
  readonly frame: number
  readonly mode: RenderMode
  readonly requestedAt: number
  readonly presentedAt: number
  readonly result: RenderFrameResult
}

/** Worker completion evidence captured before browser paint scheduling. */
export interface PreviewRenderCompletionDiagnostic {
  readonly frame: number
  readonly mode: RenderMode
  readonly requestedAt: number
  readonly completedAt: number
  readonly result: RenderFrameResult
}

export type PreviewRenderDiagnosticListener = (
  diagnostic: PreviewRenderDiagnostic,
) => void

const renderDiagnosticListeners = new Set<PreviewRenderDiagnosticListener>()
const renderCompletionListeners = new Set<(
  diagnostic: PreviewRenderCompletionDiagnostic,
) => void>()

/** Subscribe without putting benchmark data in project or Zustand state. */
export function subscribePreviewRenderDiagnostics(
  listener: PreviewRenderDiagnosticListener,
): () => void {
  renderDiagnosticListeners.add(listener)
  return () => renderDiagnosticListeners.delete(listener)
}

/** Subscribe to selected-source worker completion without touching app state. */
export function subscribePreviewRenderCompletions(
  listener: (diagnostic: PreviewRenderCompletionDiagnostic) => void,
): () => void {
  renderCompletionListeners.add(listener)
  return () => renderCompletionListeners.delete(listener)
}

/** Enable/reset or disable the opt-in worker counters, if preview is live. */
export function setPreviewRuntimeTelemetryEnabled(enabled: boolean): boolean {
  const method = state.bridge?.setRuntimeTelemetryEnabled
  if (!method) return false
  method.call(state.bridge, enabled)
  return true
}

/** Capture local benchmark evidence without putting it in application state. */
export function capturePreviewRuntimeTelemetry(): Promise<
  RenderWorkerRuntimeTelemetrySnapshot | null
> {
  const method = state.bridge?.requestRuntimeTelemetry
  if (!method) return Promise.resolve(null)
  return method.call(state.bridge)
}

/**
 * Dev-benchmark boundary: one serialized request through the live bridge and
 * its currently selected original/proxy sources, without browser paint time.
 */
export function renderPreviewFrameForDevBenchmark(
  frame: number,
): Promise<RenderFrameResult> {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    return Promise.reject(new RangeError('Benchmark preview frame must be a non-negative integer'))
  }
  const bridge = state.bridge
  if (!bridge) return Promise.reject(new Error('Preview is not initialized'))
  const plan = state.visualPlanner?.planFrame(frame)
  if (!plan) return Promise.reject(new Error('Preview planner is not initialized'))
  return bridge.renderFrame(plan, 'seek')
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
  createBridge: (pluginEffectHandler) => (
    new RenderWorkerBridge(createRenderWorker(), pluginEffectHandler)
  ),
  createVisualPlanner: (doc, catalog, pluginContributions) => (
    createVideoCompositionPlanner(doc, catalog, pluginContributions)
  ),
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
  deps: PreviewDeps | null
  viewport: PresentationViewport | null
  presentationProfile: PresentationProfile | null
  visualPlanner: VideoCompositionPlanner | null
  pluginCatalogGeneration: number | null
  pluginUnsubscribe: (() => void) | null
  effectStatusIndex: PreviewEffectStatusIndex | null
  /** Per-asset pipeline status. Absent = not started (or failed: retried
   * on the next mediaStore change). Removal releases the worker source. */
  assetStates: Map<AssetId, {
    sourceKey: string
    status: 'loading' | 'ready' | 'failed'
  }>
  unsubscribes: Array<() => void>
  rafPending: boolean
  /** Invalidates callbacks queued for a disposed/replaced bridge. */
  renderGeneration: number
  /** Invalidates presentation evidence when a newer render is dispatched. */
  presentationGeneration: number
  /** Guards disabled/re-enabled scope results against stale worker work. */
  scopeGeneration: number
}

const state: ControllerState = {
  canvas: null,
  bridge: null,
  deps: null,
  viewport: null,
  presentationProfile: null,
  visualPlanner: null,
  pluginCatalogGeneration: null,
  pluginUnsubscribe: null,
  effectStatusIndex: null,
  assetStates: new Map(),
  unsubscribes: [],
  rafPending: false,
  renderGeneration: 0,
  presentationGeneration: 0,
  scopeGeneration: 0,
}

let pluginBinding: PreviewPluginBinding | null = null

const pluginEffectHandler: PluginEffectBridgeHandler = Object.freeze({
  apply(
    request: PluginEffectBridgeHandlerRequest,
    signal: AbortSignal,
  ): Promise<PluginEffectBridgeHandlerResult> {
    const handler = pluginBinding?.getEffectBridgeHandler()
    if (!handler) return Promise.resolve(Object.freeze({ status: 'bypassed' }))
    return handler.apply(request, signal)
  },
})

function currentPluginContributions(): PluginVideoEffectContributionSnapshot | undefined {
  return pluginBinding?.getContributionSnapshot()
}

function createCurrentVisualPlanner(
  deps: PreviewDeps,
  doc = currentPreviewDocument(),
  catalog = currentSourceBoundsCatalog(),
  pluginContributions = currentPluginContributions(),
): VideoCompositionPlanner {
  state.pluginCatalogGeneration = pluginContributions?.catalogGeneration ?? null
  return deps.createVisualPlanner(doc, catalog, pluginContributions)
}

function subscribePluginBinding(bridge: BridgeLike, deps: PreviewDeps): void {
  const binding = pluginBinding
  if (!binding) return
  state.pluginUnsubscribe = binding.subscribe(() => {
    if (state.bridge !== bridge || state.deps !== deps || pluginBinding !== binding) return
    const snapshot = binding.getContributionSnapshot()
    const catalogGeneration = snapshot?.catalogGeneration ?? null
    if (catalogGeneration === state.pluginCatalogGeneration) return
    state.visualPlanner = createCurrentVisualPlanner(
      deps,
      currentPreviewDocument(),
      currentSourceBoundsCatalog(),
      snapshot,
    )
    scheduleRender(deps)
  })
}

/** Replace the app-owned binding without putting plugin state in Zustand. */
export function setPreviewPluginBinding(binding: PreviewPluginBinding | null): void {
  if (pluginBinding === binding) return
  pluginBinding = binding
  const bridge = state.bridge
  const deps = state.deps
  if (!bridge || !deps) return
  state.pluginUnsubscribe?.()
  state.pluginUnsubscribe = null
  state.visualPlanner = createCurrentVisualPlanner(deps)
  subscribePluginBinding(bridge, deps)
  scheduleRender(deps)
}

/** Enable/disable preview scopes without making their state project truth. */
export function setVideoScopesEnabled(enabled: boolean): boolean {
  state.scopeGeneration++
  if (!Number.isSafeInteger(state.scopeGeneration)) {
    throw new RangeError('Video scope generation overflow')
  }
  const generation = state.scopeGeneration
  useVideoScopesStore.getState().setEnabled(enabled, generation)
  const method = state.bridge?.setVideoScopesEnabled
  if (!method) return false
  method.call(state.bridge, enabled, generation)
  if (enabled && state.deps) scheduleRender(state.deps)
  return true
}

function modeForTransport(transport: {
  isPlaying: boolean
  isScrubbing: boolean
}): RenderMode {
  return transport.isPlaying && !transport.isScrubbing ? 'playback' : 'seek'
}

function presentationReasonForTransport(transport: {
  isPlaying: boolean
  isScrubbing: boolean
}): PresentationReason {
  if (transport.isScrubbing) return 'scrubbing'
  return transport.isPlaying ? 'playing' : 'paused'
}

function syncPresentationProfile(
  bridge: BridgeLike,
  doc = currentPreviewDocument(),
): void {
  const profile = resolvePresentationProfile(doc, {
    qualityMode: usePreviewQualityStore.getState().qualityMode,
    reason: presentationReasonForTransport(useTransportStore.getState()),
    viewport: state.viewport,
  })
  const surfacesMatch = presentationSurfacesMatch(state.presentationProfile, profile)
  state.presentationProfile = profile
  if (surfacesMatch) return
  bridge.setPresentationProfile(profile)
}

/** Publish the exact displayed monitor size without putting DOM facts in state. */
export function setPreviewViewport(viewport: PresentationViewport | null): void {
  const normalized = viewport
    && Number.isFinite(viewport.widthCssPx)
    && viewport.widthCssPx > 0
    && Number.isFinite(viewport.heightCssPx)
    && viewport.heightCssPx > 0
    && Number.isFinite(viewport.devicePixelRatio)
    && viewport.devicePixelRatio > 0
    ? {
        widthCssPx: viewport.widthCssPx,
        heightCssPx: viewport.heightCssPx,
        devicePixelRatio: viewport.devicePixelRatio,
      }
    : null
  const current = state.viewport
  if (
    current?.widthCssPx === normalized?.widthCssPx
    && current?.heightCssPx === normalized?.heightCssPx
    && current?.devicePixelRatio === normalized?.devicePixelRatio
  ) return
  state.viewport = normalized
  if (state.bridge && state.deps) {
    syncPresentationProfile(state.bridge)
    scheduleRender(state.deps)
  }
}

function currentSourceBoundsCatalog(): SourceBoundsCatalog {
  const catalog = new Map(createSourceBoundsCatalog(
    useMediaStore.getState().descriptors.values(),
  ))
  for (const [assetId, proxy] of useProxyStore.getState().assets) {
    if (
      proxy.phase !== 'ready'
      || !proxy.entry
      || previewRepresentationDecision(assetId).representation !== 'proxy'
    ) continue
    const original = catalog.get(assetId)
    catalog.set(assetId, {
      video: {
        status: 'exact',
        firstTimestampUs: 0,
        endTimestampUs: proxy.entry.durationMicroseconds,
      },
      audio: original?.audio ?? null,
    })
  }
  return catalog
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

function publishPreviewEffectStatuses(
  capabilities = usePreviewStatusStore.getState().rendererCapabilities,
  timelineFrame = useTransportStore.getState().playheadFrame,
): void {
  const index = state.effectStatusIndex
  if (!index) return
  usePreviewStatusStore.getState().setEffectProjection(
    capabilities,
    projectIndexedPreviewEffectStatuses(index, capabilities, timelineFrame),
  )
}

function rebuildPreviewEffectStatusIndex(doc: TimelineDoc): void {
  state.effectStatusIndex = createPreviewEffectStatusIndex(doc)
  publishPreviewEffectStatuses()
}

function syncPreviewDocument(bridge: BridgeLike, deps: PreviewDeps): void {
  const doc = currentPreviewDocument()
  state.visualPlanner = createCurrentVisualPlanner(deps, doc)
  bridge.setDoc(doc)
  rebuildPreviewEffectStatusIndex(doc)
  syncPresentationProfile(bridge, doc)
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
    const previewStatus = usePreviewStatusStore.getState()
    const effectStatusIndex = state.effectStatusIndex
    if (effectStatusIndex?.animatedEffectClips.length) {
      const refreshed = refreshAnimatedPreviewEffectStatuses(
        effectStatusIndex,
        previewStatus.rendererCapabilities,
        transport.playheadFrame,
        previewStatus.effectStatuses,
      )
      if (refreshed !== previewStatus.effectStatuses) {
        previewStatus.setEffectProjection(
          previewStatus.rendererCapabilities,
          refreshed,
        )
      }
    }
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
        && previewRepresentationDecision(id).representation !== 'proxy'
      ) {
        seen.add(id)
        offlineIds.push(id)
      }
    }
    usePreviewStatusStore.getState().setOfflineVisualAssetIds(offlineIds)
    const frame = transport.playheadFrame
    const mode = modeForTransport(transport)
    const diagnosticsEnabled = (
      renderDiagnosticListeners.size > 0 || renderCompletionListeners.size > 0
    )
    const requestedAt = diagnosticsEnabled ? deps.now() : 0
    const presentationGeneration = ++state.presentationGeneration
    void bridge
      .renderFrame(visualPlan, mode)
      .then((result) => {
        if (diagnosticsEnabled) {
          publishRenderCompletion({
            frame,
            mode,
            requestedAt,
            completedAt: deps.now(),
            result,
          })
        }
        if (renderDiagnosticListeners.size > 0 && result.status !== 'superseded') {
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

function desiredVideoSourceKey(assetId: AssetId, asset: MediaAsset | undefined): string | null {
  const decision = previewRepresentationDecision(assetId)
  if (decision.representation === 'proxy') {
    const entry = useProxyStore.getState().assets.get(assetId)?.entry
    return entry ? `proxy:${entry.cacheKey}` : null
  }
  return decision.representation === 'original' && asset
    ? `original:${asset.objectUrl}`
    : null
}

/** Hand one selected original-or-proxy Blob to the render worker. */
async function loadOneVideoAsset(
  deps: PreviewDeps,
  assetId: AssetId,
  asset: MediaAsset | undefined,
  sourceKey: string,
): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const pipelineState = {
    sourceKey,
    status: 'loading' as const,
  }
  state.assetStates.set(assetId, pipelineState)
  let failureReason: MediaRuntimeFailure['reason'] = 'resource-unavailable'
  let failureTrackKind: 'video' | null = null
  let proxySelected = false
  let guard: MediaRuntimeGuard | null = null
  try {
    const proxy = sourceKey.startsWith('proxy:')
      ? await getProxyPreviewSource(assetId)
      : null
    proxySelected = proxy !== null
    let blob: Blob
    let rate: FrameRate
    let budget: LocalDecoderBudget
    let runtimeToken: object
    if (proxy) {
      blob = proxy.blob
      rate = proxy.entry.frameRate
      budget = mediaAssetDecoderBudget({
        size: proxy.entry.byteSize,
        durationMicroseconds: proxy.entry.durationMicroseconds,
        frameRate: proxy.entry.frameRate,
        width: proxy.entry.width,
        height: proxy.entry.height,
        audioSampleRate: null,
        audioChannels: null,
      }, proxy.blob.size)
      runtimeToken = proxy.runtimeToken
    } else {
      if (!asset) throw new Error('The original source is offline and the proxy is unavailable')
      guard = captureMediaRuntimeGuard(asset.id)
      if (!guard || guard.objectUrl !== asset.objectUrl) return
      blob = await deps.fetchBlob(asset.objectUrl)
      if (!asset.frameRate) throw new Error(`"${asset.fileName}": missing frame rate`)
      rate = asset.frameRate
      budget = mediaAssetDecoderBudget(asset, blob.size)
      runtimeToken = guard
    }
    if (state.bridge !== bridge || state.assetStates.get(assetId) !== pipelineState) {
      return
    }
    failureReason = 'decode-failed'
    failureTrackKind = 'video'
    await bridge.openAsset(assetId, blob, rate, budget, runtimeToken)
    if (state.bridge !== bridge || state.assetStates.get(assetId) !== pipelineState) {
      return
    }
    state.assetStates.set(assetId, {
      sourceKey,
      status: 'ready',
    })
  } catch (e) {
    if (state.bridge !== bridge || state.assetStates.get(assetId) !== pipelineState) {
      return
    }
    state.assetStates.set(assetId, {
      sourceKey,
      status: 'failed',
    })
    if (e instanceof RenderAssetOpenError) {
      failureReason = e.failure.reason
      failureTrackKind = e.failure.trackKind
    }
    console.warn(
      `[previewController] loading "${asset?.fileName ?? assetId}" failed:`,
      e instanceof Error ? e.message : e,
    )
    if (proxySelected) {
      reportProxyPreviewFailure(assetId, e)
    } else if (guard) {
      reportMediaRuntimeFailure(
        guard,
        mediaRuntimeFailure('preview', failureTrackKind, e, failureReason),
      )
    }
  }
}

function publishRenderCompletion(
  diagnostic: PreviewRenderCompletionDiagnostic,
): void {
  for (const listener of renderCompletionListeners) {
    try {
      listener(diagnostic)
    } catch {
      // Diagnostics are observational and must never disturb rendering.
    }
  }
}

async function loadOneImage(deps: PreviewDeps, asset: MediaAsset): Promise<void> {
  const bridge = state.bridge
  if (!bridge) return
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) return
  const sourceKey = `original:${asset.objectUrl}`
  const pipelineState = { sourceKey, status: 'loading' as const }
  state.assetStates.set(asset.id, pipelineState)
  let failureReason: MediaRuntimeFailure['reason'] = 'resource-unavailable'
  try {
    const blob = await deps.fetchBlob(asset.objectUrl)
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) return
    failureReason = 'decode-failed'
    await bridge.openImage(asset.id, blob, guard)
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) return
    state.assetStates.set(asset.id, { sourceKey, status: 'ready' })
  } catch (cause) {
    if (state.bridge !== bridge || state.assetStates.get(asset.id) !== pipelineState) return
    state.assetStates.set(asset.id, { sourceKey, status: 'failed' })
    if (cause instanceof RenderAssetOpenError) failureReason = cause.failure.reason
    reportMediaRuntimeFailure(
      guard,
      mediaRuntimeFailure('preview', null, cause, failureReason),
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
  const media = useMediaStore.getState()
  const assets = media.assets
  const referencedIds = documentAssetIds(useDocumentStore.getState().doc)
  const desiredIds = new Set<AssetId>()

  for (const [assetId, descriptor] of media.descriptors) {
    if (descriptor.kind !== 'video') continue
    const asset = assets.get(assetId)
    const sourceKey = desiredVideoSourceKey(assetId, asset)
    if (!sourceKey) continue
    desiredIds.add(assetId)
    const current = state.assetStates.get(assetId)
    if (current?.sourceKey === sourceKey) continue
    if (current) {
      state.assetStates.delete(assetId)
      bridge.releaseAsset(assetId)
    }
    void loadOneVideoAsset(deps, assetId, asset, sourceKey)
  }

  for (const asset of assets.values()) {
    if (asset.kind !== 'image' || !referencedIds.has(asset.id)) continue
    desiredIds.add(asset.id)
    const sourceKey = `original:${asset.objectUrl}`
    const current = state.assetStates.get(asset.id)
    if (current?.sourceKey === sourceKey) continue
    if (current) {
      state.assetStates.delete(asset.id)
      bridge.releaseAsset(asset.id)
    }
    void loadOneImage(deps, asset)
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
  void disposePreviewState(false)

  let bridge: BridgeLike
  try {
    bridge = deps.createBridge(pluginEffectHandler)
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
    if (isProxyPreviewToken(assetId, runtimeToken)) {
      reportProxyPreviewFailure(assetId, message)
      return
    }
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
  bridge.onRendererCapabilities = (capabilities) => {
    publishPreviewEffectStatuses(capabilities)
    useVideoScopesStore.getState().setRendererSupported(capabilities.canvasPixelAccess)
  }
  bridge.onVideoScopes = (generation, frame, analyzedAt, analysis) => {
    useVideoScopesStore.getState().acceptAnalysis(
      generation,
      frame,
      analyzedAt,
      analysis,
    )
  }
  state.canvas = canvas
  state.bridge = bridge
  state.deps = deps

  const initialDoc = currentPreviewDocument()
  const initialBounds = currentSourceBoundsCatalog()
  state.visualPlanner = createCurrentVisualPlanner(deps, initialDoc, initialBounds)
  state.effectStatusIndex = createPreviewEffectStatusIndex(initialDoc)
  bridge.setDoc(initialDoc)
  publishPreviewEffectStatuses(null)
  syncPresentationProfile(bridge, initialDoc)
  const scopes = useVideoScopesStore.getState()
  bridge.setVideoScopesEnabled?.(scopes.enabled, scopes.generation)

  state.unsubscribes.push(
    useDocumentStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) {
        syncPreviewDocument(bridge, deps)
        syncAssets(deps)
        scheduleRender(deps)
      }
    }),
    useTransportStore.subscribe((s, prev) => {
      if (
        s.textOverlayPreview !== prev.textOverlayPreview
        || s.clipVisualPreview !== prev.clipVisualPreview
      ) {
        syncPreviewDocument(bridge, deps)
      }
      if (
        presentationReasonForTransport(s) !== presentationReasonForTransport(prev)
      ) {
        syncPresentationProfile(bridge)
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
      state.visualPlanner = createCurrentVisualPlanner(deps, undefined, bounds)
      syncAssets(deps)
      scheduleRender(deps)
    }),
    useProxyStore.subscribe((current, previous) => {
      if (current.assets === previous.assets) return
      const bounds = currentSourceBoundsCatalog()
      state.visualPlanner = createCurrentVisualPlanner(deps, undefined, bounds)
      syncAssets(deps)
      scheduleRender(deps)
    }),
    usePreviewQualityStore.subscribe((s, prev) => {
      if (s.qualityMode === prev.qualityMode) return
      syncPresentationProfile(bridge)
      scheduleRender(deps)
    }),
  )
  subscribePluginBinding(bridge, deps)
  // Assets may already be waiting (import before mount, HMR, tests) and an
  // empty timeline still paints its background.
  syncAssets(deps)
  scheduleRender(deps)
}

async function disposePreviewState(clearPluginBinding: boolean): Promise<void> {
  state.renderGeneration++
  state.presentationGeneration++
  state.scopeGeneration++
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.pluginUnsubscribe?.()
  state.pluginUnsubscribe = null
  const close = state.bridge?.dispose()
  state.bridge = null
  state.deps = null
  state.viewport = null
  state.presentationProfile = null
  state.visualPlanner = null
  state.pluginCatalogGeneration = null
  state.effectStatusIndex = null
  state.canvas = null
  state.assetStates = new Map()
  state.rafPending = false
  if (clearPluginBinding) pluginBinding = null
  usePreviewStatusStore.getState().resetPreviewStatus()
  useVideoScopesStore.getState().reset()
  await close
}

/** Tear everything down (tests / real app teardown, not StrictMode churn). */
export function disposePreview(): Promise<void> {
  return disposePreviewState(true)
}
