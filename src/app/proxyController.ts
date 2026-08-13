import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  DEFAULT_PROXY_PARAMETERS,
  PROXY_GENERATOR_VERSION,
  estimateProxyBytes,
  proxyDescriptorCouldMatch,
  proxyFingerprintMatches,
  selectMediaRepresentation,
  type MediaRepresentationDecision,
  type ProxyCacheEntry,
  type ProxyOriginalFingerprint,
} from '../domain/proxyCache'
import type { MediaAsset } from '../domain/schema'
import {
  generateEditingProxy,
  probeProxyEncoderSupport,
  probeProxyInputSupport,
} from '../pipeline/proxyGeneration'
import { useMediaStore } from '../state/mediaStore'
import { useProxyStore, type ProxyAssetState } from '../state/proxyStore'
import {
  MediaJobExecutionError,
  MediaJobScheduler,
  type MediaJobContext,
  type MediaJobSchedulerSnapshot,
} from './mediaJobScheduler'
import {
  ProxyQuotaError,
  ProxyStorage,
  ProxyStorageUnavailableError,
  proxyStorage,
} from './proxyStorage'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { fingerprintLocalMediaSource, sha256Hex } from './sourceFingerprint'

const PROXY_JOB_PREFIX = 'proxy:'

export interface ProxyPreviewSource {
  readonly blob: File
  readonly entry: ProxyCacheEntry
  readonly sourceKey: string
  readonly runtimeToken: object
}

export interface ProxyControllerDeps {
  readonly storage: ProxyStorage
  fetchBlob(url: string, signal?: AbortSignal): Promise<Blob>
  now(): number
  probeEncoderSupport: typeof probeProxyEncoderSupport
  probeInputSupport: typeof probeProxyInputSupport
  generateProxy: typeof generateEditingProxy
}

const realDeps: ProxyControllerDeps = {
  storage: proxyStorage,
  fetchBlob: async (url, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Media source returned HTTP ${response.status}`)
    return response.blob()
  },
  now: () => Date.now(),
  probeEncoderSupport: probeProxyEncoderSupport,
  probeInputSupport: probeProxyInputSupport,
  generateProxy: generateEditingProxy,
}

interface ControllerState {
  deps: ProxyControllerDeps
  scheduler: MediaJobScheduler | null
  entries: Map<string, ProxyCacheEntry>
  unownedEntries: Map<string, ProxyCacheEntry>
  previewTokens: Map<string, { cacheKey: string; token: object }>
  activeSources: Map<string, { objectUrl: string; generation: number }>
  probeGenerations: Map<string, number>
  unsubscribeMedia: (() => void) | null
  nextGeneration: number
  lifecycleGeneration: number
  initialized: boolean
  quiescingAssets: Set<string>
  clearing: boolean
}

const state: ControllerState = {
  deps: realDeps,
  scheduler: null,
  entries: new Map(),
  unownedEntries: new Map(),
  previewTokens: new Map(),
  activeSources: new Map(),
  probeGenerations: new Map(),
  unsubscribeMedia: null,
  nextGeneration: 0,
  lifecycleGeneration: 0,
  initialized: false,
  quiescingAssets: new Set(),
  clearing: false,
}

const controllerLeases = new Set<object>()
let initializationPromise: Promise<void> | null = null
let disposalPromise: Promise<void> | null = null
let cacheMutationTail: Promise<void> = Promise.resolve()
let pendingClearCount = 0
const pendingAssetMutationCounts = new Map<string, number>()

function serializeCacheMutation(operation: () => Promise<void>): Promise<void> {
  const run = cacheMutationTail.then(operation)
  cacheMutationTail = run.then(() => undefined, () => undefined)
  return run
}

function beginAssetMutation(assetId: string): void {
  const count = (pendingAssetMutationCounts.get(assetId) ?? 0) + 1
  pendingAssetMutationCounts.set(assetId, count)
  state.quiescingAssets.add(assetId)
}

function endAssetMutation(assetId: string): void {
  const count = (pendingAssetMutationCounts.get(assetId) ?? 1) - 1
  if (count > 0) {
    pendingAssetMutationCounts.set(assetId, count)
    return
  }
  pendingAssetMutationCounts.delete(assetId)
  state.quiescingAssets.delete(assetId)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export async function fingerprintProxyOriginal(
  blob: Blob,
  identity: Pick<MediaAsset, 'fileName' | 'size' | 'lastModified'>,
): Promise<ProxyOriginalFingerprint> {
  return fingerprintLocalMediaSource(blob, identity)
}

async function proxyCacheKey(
  projectBindingId: string,
  assetId: string,
  fingerprint: ProxyOriginalFingerprint,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({
    projectBindingId,
    assetId,
    fingerprint,
    parameters: DEFAULT_PROXY_PARAMETERS,
    generatorVersion: PROXY_GENERATOR_VERSION,
  })))
}

function jobId(assetId: string): string {
  return `${PROXY_JOB_PREFIX}${assetId}`
}

function entryKey(projectBindingId: string, assetId: string): string {
  return JSON.stringify([projectBindingId, assetId])
}

function currentEntry(assetId: string): ProxyCacheEntry | null {
  const projectBindingId = getActiveLocalProjectBindingId()
  return projectBindingId
    ? state.entries.get(entryKey(projectBindingId, assetId)) ?? null
    : null
}

function exactVideoBounds(asset: MediaAsset): {
  readonly firstTimestampUs: number
  readonly endTimestampUs: number
} | null {
  const bounds = asset.sourceBounds.video
  return bounds?.status === 'exact'
    ? {
        firstTimestampUs: bounds.firstTimestampUs,
        endTimestampUs: bounds.endTimestampUs,
      }
    : null
}

function generationIsCurrent(
  asset: MediaAsset,
  projectBindingId: string,
  generation: number,
  lifecycleGeneration: number,
  signal: AbortSignal,
): boolean {
  const active = state.activeSources.get(asset.id)
  return !signal.aborted
    && state.lifecycleGeneration === lifecycleGeneration
    && active?.generation === generation
    && active.objectUrl === asset.objectUrl
    && getActiveLocalProjectBindingId() === projectBindingId
    && useMediaStore.getState().assets.get(asset.id)?.objectUrl === asset.objectUrl
}

function publish(item: ProxyAssetState): void {
  useProxyStore.getState().setAsset(item)
}

function entryFreshForDescriptor(
  entry: ProxyCacheEntry | null,
  descriptor: { fileName: string; size: number; lastModified: number },
): boolean {
  return entry !== null && proxyDescriptorCouldMatch(entry, descriptor)
}

async function refreshStorageState(lifecycleGeneration = state.lifecycleGeneration): Promise<void> {
  try {
    const estimate = await state.deps.storage.estimate()
    if (state.lifecycleGeneration !== lifecycleGeneration) return
    useProxyStore.getState().setStorage({
      supported: true,
      ...estimate,
      error: null,
    })
  } catch (cause) {
    if (state.lifecycleGeneration !== lifecycleGeneration) return
    useProxyStore.getState().setStorage({
      supported: false,
      cacheBytes: 0,
      itemCount: 0,
      originUsageBytes: null,
      originQuotaBytes: null,
      persisted: null,
      error: errorMessage(cause),
    })
  }
}

function offlineItem(assetId: string): ProxyAssetState {
  const descriptor = useMediaStore.getState().descriptors.get(assetId)
  const entry = currentEntry(assetId)
  const fresh = descriptor ? entryFreshForDescriptor(entry, descriptor) : false
  return {
    assetId,
    phase: entry ? (fresh ? 'ready' : 'stale') : 'unavailable',
    progress: 0,
    detail: entry
      ? (fresh
          ? 'Proxy ready for preview. Original offline; final export is unavailable until relinked.'
          : 'Cached proxy is stale and the original is offline. Relink before regenerating or exporting.')
      : 'Original offline. Relink it before generating a proxy.',
    canGenerate: false,
    originalAvailable: false,
    entry,
  }
}

async function probeConnectedAsset(asset: MediaAsset, generation: number): Promise<void> {
  let entry = currentEntry(asset.id)
  if (
    asset.kind !== 'video'
    || !asset.frameRate
    || !asset.width
    || !asset.height
    || !exactVideoBounds(asset)
  ) {
    publish({
      assetId: asset.id,
      phase: 'unavailable',
      progress: 0,
      detail: 'Editing proxies require a connected video track with exact timestamp bounds, dimensions, and frame rate.',
      canGenerate: false,
      originalAvailable: true,
      entry,
    })
    return
  }
  publish({
    assetId: asset.id,
    phase: 'checking',
    progress: 0,
    detail: 'Checking the browser AVC encoder and cached provenance…',
    canGenerate: false,
    originalAvailable: true,
    entry,
  })
  try {
    const [encoder, blob] = await Promise.all([
      state.deps.probeEncoderSupport(asset.width, asset.height, asset.frameRate),
      state.deps.fetchBlob(asset.objectUrl),
    ])
    if (
      state.probeGenerations.get(asset.id) !== generation
      || useMediaStore.getState().assets.get(asset.id)?.objectUrl !== asset.objectUrl
    ) return
    if (!encoder.supported) {
      publish({
        assetId: asset.id,
        phase: entry ? 'stale' : 'unavailable',
        progress: 0,
        detail: encoder.reason,
        canGenerate: false,
        originalAvailable: true,
        entry,
      })
      return
    }
    const input = await state.deps.probeInputSupport(
      blob,
      asset.id,
      mediaAssetDecoderBudget(asset, blob.size),
    )
    if (
      state.probeGenerations.get(asset.id) !== generation
      || useMediaStore.getState().assets.get(asset.id)?.objectUrl !== asset.objectUrl
    ) return
    if (!input.supported) {
      publish({
        assetId: asset.id,
        phase: entry ? 'stale' : 'unavailable',
        progress: 0,
        detail: input.reason,
        canGenerate: false,
        originalAvailable: true,
        entry,
      })
      return
    }
    const fingerprint = await fingerprintProxyOriginal(blob, asset)
    if (state.probeGenerations.get(asset.id) !== generation) return
    const projectBindingId = getActiveLocalProjectBindingId()
    const legacy = entry ? null : state.unownedEntries.get(asset.id) ?? null
    if (
      projectBindingId
      && legacy
      && proxyFingerprintMatches(legacy, fingerprint)
    ) {
      const adopted: ProxyCacheEntry = {
        ...legacy,
        projectBindingId,
      }
      const transaction = await state.deps.storage.commitEntry(adopted)
      if (
        state.probeGenerations.get(asset.id) !== generation
        || getActiveLocalProjectBindingId() !== projectBindingId
      ) {
        await transaction.rollback()
        return
      }
      await transaction.finalize()
      state.unownedEntries.delete(asset.id)
      state.entries.set(entryKey(projectBindingId, asset.id), adopted)
      entry = adopted
      await refreshStorageState()
    }
    const fresh = entry ? proxyFingerprintMatches(entry, fingerprint) : false
    publish({
      assetId: asset.id,
      phase: entry ? (fresh ? 'ready' : 'stale') : 'available',
      progress: 0,
      detail: entry
        ? (fresh
            ? `Proxy ready · ${entry.width}×${entry.height} AVC MP4 · original verified.`
            : 'The original fingerprint changed. Preview uses the original until regeneration finishes.')
        : `${input.reason} ${encoder.reason} Generate a disposable local editing proxy.`,
      canGenerate: true,
      originalAvailable: true,
      entry,
    })
  } catch (cause) {
    if (state.probeGenerations.get(asset.id) !== generation) return
    publish({
      assetId: asset.id,
      phase: 'error',
      progress: 0,
      detail: `Proxy capability check failed: ${errorMessage(cause)}`,
      canGenerate: true,
      originalAvailable: true,
      entry,
    })
  }
}

function scan(): void {
  const media = useMediaStore.getState()
  const ids = new Set(media.descriptors.keys())
  for (const assetId of [...useProxyStore.getState().assets.keys()]) {
    if (!ids.has(assetId)) useProxyStore.getState().removeAsset(assetId)
  }
  for (const [assetId, descriptor] of media.descriptors) {
    if (descriptor.kind !== 'video') {
      useProxyStore.getState().removeAsset(assetId)
      continue
    }
    const asset = media.assets.get(assetId)
    if (!asset) {
      state.probeGenerations.set(assetId, ++state.nextGeneration)
      publish(offlineItem(assetId))
      continue
    }
    const existing = useProxyStore.getState().assets.get(assetId)
    if (
      (existing?.phase === 'queued' || existing?.phase === 'generating')
      && state.activeSources.has(assetId)
    ) continue
    const generation = ++state.nextGeneration
    state.probeGenerations.set(assetId, generation)
    void probeConnectedAsset(asset, generation)
  }
}

async function runGeneration(
  asset: MediaAsset,
  projectBindingId: string,
  generation: number,
  lifecycleGeneration: number,
  context: MediaJobContext,
): Promise<void> {
  let pendingCacheKey: string | null = null
  let pendingFileName: string | null = null
  let committedTransaction: Awaited<ReturnType<ProxyStorage['commitEntry']>> | null = null
  const previousEntry = currentEntry(asset.id)
  try {
    publish({
      assetId: asset.id,
      phase: 'generating',
      progress: 0,
      detail: 'Verifying the original and preparing a browser-native proxy…',
      canGenerate: false,
      originalAvailable: true,
      entry: previousEntry,
    })
    const blob = await state.deps.fetchBlob(asset.objectUrl, context.signal)
    const fingerprint = await fingerprintProxyOriginal(blob, asset)
    pendingCacheKey = await proxyCacheKey(projectBindingId, asset.id, fingerprint)
    const videoBounds = exactVideoBounds(asset)
    if (!videoBounds) {
      throw new Error('The connected video is missing exact source timestamp bounds')
    }
    const videoDurationMicroseconds = videoBounds.endTimestampUs - videoBounds.firstTimestampUs
    await state.deps.storage.ensureCapacity(
      estimateProxyBytes(videoDurationMicroseconds),
      { projectBindingId, assetId: asset.id },
    )
    if (!asset.frameRate || !asset.width || !asset.height) {
      throw new Error('The connected video is missing proxy timing or geometry facts')
    }
    const result = await state.deps.generateProxy({
      source: blob,
      asset: {
        id: asset.id,
        fileName: asset.fileName,
        size: asset.size,
        videoBounds,
        frameRate: asset.frameRate,
        width: asset.width,
        height: asset.height,
      },
      budget: mediaAssetDecoderBudget(asset, blob.size),
      parameters: DEFAULT_PROXY_PARAMETERS,
      signal: context.signal,
      openDestination: async () => {
        const capability = await state.deps.storage.prepareFileCapability(pendingCacheKey!)
        pendingFileName = capability.fileName
        return capability
      },
      onProgress: (progress) => {
        context.reportProgress(progress)
        if (state.lifecycleGeneration !== lifecycleGeneration) return
        const current = useProxyStore.getState().assets.get(asset.id)
        if (current?.phase !== 'generating') return
        publish({
          ...current,
          progress: Math.max(current.progress, Math.min(1, progress)),
          detail: `Generating proxy… ${Math.round(progress * 100)}%`,
        })
      },
      onDecoderCount: context.setActiveDecoderCount,
    })
    if (!generationIsCurrent(
      asset,
      projectBindingId,
      generation,
      lifecycleGeneration,
      context.signal,
    )) {
      throw new Error('Proxy generation was superseded by a source replacement')
    }
    const now = state.deps.now()
    const entry: ProxyCacheEntry = {
      cacheKey: pendingCacheKey,
      projectBindingId,
      assetId: asset.id,
      original: fingerprint,
      parameters: DEFAULT_PROXY_PARAMETERS,
      generatorVersion: PROXY_GENERATOR_VERSION,
      fileName: result.fileName,
      mimeType: 'video/mp4',
      byteSize: result.byteLength,
      width: result.width,
      height: result.height,
      frameRate: result.frameRate,
      durationMicroseconds: result.durationMicroseconds,
      createdAt: now,
      lastUsedAt: now,
    }
    committedTransaction = await state.deps.storage.commitEntry(entry)
    if (!generationIsCurrent(
      asset,
      projectBindingId,
      generation,
      lifecycleGeneration,
      context.signal,
    )) {
      await committedTransaction.rollback()
      committedTransaction = null
      pendingFileName = null
      throw new Error('Proxy generation was canceled before its cache commit became visible')
    }
    pendingFileName = null
    state.entries.set(entryKey(projectBindingId, asset.id), entry)
    state.previewTokens.delete(entryKey(projectBindingId, asset.id))
    publish({
      assetId: asset.id,
      phase: 'ready',
      progress: 1,
      detail: `Proxy ready · ${entry.width}×${entry.height} AVC MP4 · ${formatBytes(entry.byteSize)}.`,
      canGenerate: true,
      originalAvailable: true,
      entry,
    })
    await committedTransaction.finalize()
    committedTransaction = null
    await refreshStorageState()
  } catch (cause) {
    if (pendingFileName && committedTransaction === null) {
      try {
        await state.deps.storage.discardFile(pendingFileName)
      } catch {
        // The staged output was never added to the manifest; orphan cleanup can retry later.
      }
    }
    if (state.lifecycleGeneration !== lifecycleGeneration) throw cause
    if (context.signal.aborted) {
      publish(previousEntry
        ? {
            assetId: asset.id,
            phase: 'ready',
            progress: 0,
            detail: 'Proxy generation canceled. The previous proxy is still available.',
            canGenerate: true,
            originalAvailable: true,
            entry: previousEntry,
          }
        : {
            assetId: asset.id,
            phase: 'available',
            progress: 0,
            detail: 'Proxy generation canceled cleanly. No proxy bytes were kept.',
            canGenerate: true,
            originalAvailable: true,
            entry: null,
          })
      throw cause
    }
    const detail = cause instanceof ProxyQuotaError
      ? cause.message
      : `Proxy generation failed: ${errorMessage(cause)}. Retry is safe.`
    publish({
      assetId: asset.id,
      phase: 'error',
      progress: 0,
      detail,
      canGenerate: true,
      originalAvailable: true,
      entry: previousEntry,
    })
    throw new MediaJobExecutionError(
      cause instanceof ProxyQuotaError ? 'resource-limit' : 'decode-failed',
      detail,
      cause,
    )
  } finally {
    if (state.activeSources.get(asset.id)?.generation === generation) {
      state.activeSources.delete(asset.id)
    }
    if (state.probeGenerations.get(asset.id) === generation) {
      state.probeGenerations.delete(asset.id)
    }
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

async function initializeProxyController(deps: ProxyControllerDeps): Promise<void> {
  if (state.initialized) return
  state.initialized = true
  const lifecycleGeneration = ++state.lifecycleGeneration
  state.deps = deps
  state.scheduler = new MediaJobScheduler({
    budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
  })
  try {
    const manifest = await deps.storage.readManifest()
    if (state.lifecycleGeneration !== lifecycleGeneration) return
    state.entries = new Map(manifest.entries.flatMap((entry) => (
      entry.projectBindingId
        ? [[entryKey(entry.projectBindingId, entry.assetId), entry] as const]
        : []
    )))
    state.unownedEntries = new Map(manifest.entries.flatMap((entry) => (
      entry.projectBindingId === null
        ? [[entry.assetId, entry] as const]
        : []
    )))
  } catch (cause) {
    if (state.lifecycleGeneration !== lifecycleGeneration) return
    if (!(cause instanceof ProxyStorageUnavailableError)) {
      useProxyStore.getState().setStorage({
        supported: false,
        cacheBytes: 0,
        itemCount: 0,
        originUsageBytes: null,
        originQuotaBytes: null,
        persisted: null,
        error: errorMessage(cause),
      })
    }
    state.entries = new Map()
    state.unownedEntries = new Map()
  }
  if (state.lifecycleGeneration !== lifecycleGeneration) return
  await refreshStorageState(lifecycleGeneration)
  if (state.lifecycleGeneration !== lifecycleGeneration) return
  state.unsubscribeMedia = useMediaStore.subscribe((current, previous) => {
    if (current.assets !== previous.assets || current.descriptors !== previous.descriptors) {
      for (const [assetId, source] of state.activeSources) {
        if (current.assets.get(assetId)?.objectUrl === source.objectUrl) continue
        state.scheduler?.cancel(jobId(assetId), current.assets.has(assetId) ? 'replaced' : 'removed')
        state.activeSources.delete(assetId)
      }
      scan()
    }
  })
  scan()
}

/**
 * Acquire one editor lifecycle lease. Each async caller receives its own
 * release function, so a StrictMode unmount cannot dispose a newer mount.
 */
export async function initProxyController(
  deps: ProxyControllerDeps = realDeps,
): Promise<() => Promise<void>> {
  const lease = {}
  controllerLeases.add(lease)
  try {
    if (disposalPromise) await disposalPromise
    if (initializationPromise) {
      await initializationPromise
    } else if (!state.initialized) {
      initializationPromise ??= initializeProxyController(deps)
        .finally(() => {
          initializationPromise = null
        })
      await initializationPromise
    }
  } catch (cause) {
    controllerLeases.delete(lease)
    if (controllerLeases.size === 0) await disposeControllerRuntime()
    throw cause
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    controllerLeases.delete(lease)
    if (controllerLeases.size === 0) await disposeControllerRuntime()
  }
}

export function requestProxyGeneration(assetId: string): boolean {
  const scheduler = state.scheduler
  const asset = useMediaStore.getState().assets.get(assetId)
  const item = useProxyStore.getState().assets.get(assetId)
  const projectBindingId = getActiveLocalProjectBindingId()
  if (
    !scheduler
    || !asset
    || !projectBindingId
    || state.clearing
    || state.quiescingAssets.has(assetId)
  ) {
    if (item) {
      publish({
        ...item,
        phase: 'error',
        detail: scheduler
          ? (asset
              ? 'Proxy cache cleanup is still finishing. Retry when it completes.'
              : 'The original source went offline before proxy generation could start.')
          : 'The proxy scheduler is unavailable. Reopen the editor and retry.',
        canGenerate: false,
        originalAvailable: asset !== undefined,
      })
    }
    return false
  }
  if (asset.kind !== 'video' || !item?.canGenerate) return false
  const generation = ++state.nextGeneration
  const lifecycleGeneration = state.lifecycleGeneration
  state.probeGenerations.set(assetId, generation)
  state.activeSources.set(assetId, { objectUrl: asset.objectUrl, generation })
  publish({
    ...item,
    phase: 'queued',
    progress: 0,
    detail: 'Proxy queued. One decoder and one generator may run at a time.',
    canGenerate: false,
  })
  scheduler.enqueue({
    id: jobId(assetId),
    generation,
    priority: 'selected',
    resources: { decoderSlots: 1 },
    run: (context) => runGeneration(
      asset,
      projectBindingId,
      generation,
      lifecycleGeneration,
      context,
    ),
  })
  return true
}

export function cancelProxyGeneration(assetId: string): boolean {
  state.activeSources.delete(assetId)
  const canceled = state.scheduler?.cancel(jobId(assetId), 'aborted') ?? false
  if (canceled) {
    const item = useProxyStore.getState().assets.get(assetId)
    if (item?.phase === 'queued') {
      publish(item.entry
        ? {
            ...item,
            phase: 'ready',
            detail: 'Proxy generation canceled before it started. The previous proxy is still available.',
            canGenerate: item.originalAvailable,
          }
        : {
            ...item,
            phase: 'available',
            detail: 'Proxy generation canceled before it started. No proxy bytes were created.',
            canGenerate: item.originalAvailable,
          })
    }
  }
  return canceled
}

export async function removeProxy(assetId: string): Promise<void> {
  const projectBindingId = getActiveLocalProjectBindingId()
  if (!projectBindingId) return
  beginAssetMutation(assetId)
  state.probeGenerations.set(assetId, ++state.nextGeneration)
  state.activeSources.delete(assetId)
  const scheduler = state.scheduler
  scheduler?.cancel(jobId(assetId), 'removed')
  await serializeCacheMutation(async () => {
    try {
      await scheduler?.whenIdle()
      await state.deps.storage.removeAsset(projectBindingId, assetId)
      state.entries.delete(entryKey(projectBindingId, assetId))
      state.previewTokens.delete(entryKey(projectBindingId, assetId))
    } finally {
      endAssetMutation(assetId)
    }
    const asset = useMediaStore.getState().assets.get(assetId)
    if (asset) {
      const generation = ++state.nextGeneration
      state.probeGenerations.set(assetId, generation)
      await probeConnectedAsset(asset, generation)
    } else publish(offlineItem(assetId))
    await refreshStorageState()
  })
}

export async function clearAllProxies(): Promise<void> {
  pendingClearCount++
  state.clearing = true
  const scheduler = state.scheduler
  for (const assetId of state.activeSources.keys()) {
    state.probeGenerations.set(assetId, ++state.nextGeneration)
  }
  state.activeSources.clear()
  scheduler?.cancelAll('removed')
  await serializeCacheMutation(async () => {
    try {
      await scheduler?.whenIdle()
      await state.deps.storage.clear()
      state.entries.clear()
      state.unownedEntries.clear()
      state.previewTokens.clear()
    } finally {
      pendingClearCount--
      state.clearing = pendingClearCount > 0
    }
    scan()
    await refreshStorageState()
  })
}

export function previewRepresentationDecision(assetId: string): MediaRepresentationDecision {
  const item = useProxyStore.getState().assets.get(assetId)
  return selectMediaRepresentation({
    purpose: 'preview',
    originalAvailable: useMediaStore.getState().assets.has(assetId),
    proxy: item?.entry
      ? (item.phase === 'ready' ? 'fresh' : 'stale')
      : 'missing',
  })
}

export async function getProxyPreviewSource(assetId: string): Promise<ProxyPreviewSource | null> {
  if (previewRepresentationDecision(assetId).representation !== 'proxy') return null
  const projectBindingId = getActiveLocalProjectBindingId()
  if (!projectBindingId) return null
  const entry = currentEntry(assetId)
  if (!entry) return null
  try {
    const blob = await state.deps.storage.readEntryFile(entry)
    const tokenKey = entryKey(projectBindingId, assetId)
    const currentToken = state.previewTokens.get(tokenKey)
    const token = currentToken?.cacheKey === entry.cacheKey
      ? currentToken.token
      : {}
    state.previewTokens.set(tokenKey, { cacheKey: entry.cacheKey, token })
    void state.deps.storage.touch(entry.cacheKey).catch(() => undefined)
    return {
      blob,
      entry,
      sourceKey: `proxy:${entry.cacheKey}`,
      runtimeToken: token,
    }
  } catch (cause) {
    publish({
      assetId,
      phase: 'error',
      progress: 0,
      detail: `Cached proxy is unavailable: ${errorMessage(cause)}. Regenerate it from the original.`,
      canGenerate: useMediaStore.getState().assets.has(assetId),
      originalAvailable: useMediaStore.getState().assets.has(assetId),
      entry,
    })
    return null
  }
}

export function reportProxyPreviewFailure(assetId: string, cause: unknown): void {
  const item = useProxyStore.getState().assets.get(assetId)
  if (!item?.entry) return
  publish({
    ...item,
    phase: 'error',
    progress: 0,
    detail: `Proxy preview failed: ${errorMessage(cause)}. Preview fell back to the original when available.`,
    canGenerate: item.originalAvailable,
  })
}

export function isProxyPreviewToken(assetId: string, token: object): boolean {
  const projectBindingId = getActiveLocalProjectBindingId()
  return projectBindingId
    ? state.previewTokens.get(entryKey(projectBindingId, assetId))?.token === token
    : false
}

export function getProxySchedulerSnapshot(): MediaJobSchedulerSnapshot | null {
  return state.scheduler?.snapshot() ?? null
}

export function waitForProxyIdle(): Promise<MediaJobSchedulerSnapshot | null> {
  return state.scheduler?.whenIdle() ?? Promise.resolve(null)
}

async function disposeControllerRuntime(): Promise<void> {
  if (disposalPromise) return disposalPromise
  disposalPromise = (async () => {
    if (initializationPromise) await initializationPromise.catch(() => undefined)
    state.lifecycleGeneration++
    state.unsubscribeMedia?.()
    state.unsubscribeMedia = null
    const scheduler = state.scheduler
    state.scheduler = null
    scheduler?.dispose()
    await scheduler?.whenIdle()
    await cacheMutationTail
    state.entries.clear()
    state.unownedEntries.clear()
    state.previewTokens.clear()
    state.probeGenerations.clear()
    state.activeSources.clear()
    state.quiescingAssets.clear()
    pendingAssetMutationCounts.clear()
    state.clearing = false
    pendingClearCount = 0
    state.initialized = false
    state.deps = realDeps
    useProxyStore.getState().reset()
  })().finally(() => {
    disposalPromise = null
  })
  return disposalPromise
}

/** Force-release all leases; tests and real application teardown only. */
export async function disposeProxyController(): Promise<void> {
  controllerLeases.clear()
  await disposeControllerRuntime()
}
