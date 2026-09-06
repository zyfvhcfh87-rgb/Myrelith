/** App composition for the disposable monitor. UI registers surfaces through this facade. */
import { monitorSourceReservation } from '../domain/multicamMonitor'
import type { MulticamMonitorSource } from '../pipeline/multicamMonitorProtocol'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { INITIAL_MULTICAM_MONITOR, useMulticamMonitorStore } from '../state/multicamMonitorStore'
import { useProxyStore } from '../state/proxyStore'
import { useTransportStore } from '../state/transportStore'
import { derivedDataIsClearing, registerDerivedDataOwner } from './derivedDataOwners'
import { mediaResourceAdmission } from './mediaResourceAdmission'
import { createMulticamMonitorSession, type MonitorContext } from './multicamMonitorSession'
import { subscribePreviewRenderCompletions } from './previewController'
import { getProxyPreviewSource } from './proxyController'
import { getAudioPlaybackDiagnostics, getPlaybackClockContext } from './transportController'

function readContext(instanceId: string): MonitorContext | null {
  const { project, doc } = useDocumentStore.getState()
  const selected = doc.tracks.flatMap((track) => track.multicamInstances ?? []).find((item) => item.id === instanceId)
  if (!selected) return null
  const instance = doc.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.multicamInstances ?? [])
    .find((item) => item.id === selected.id || (!!selected.linkGroupId && item.linkGroupId === selected.linkGroupId))
  if (!instance) return null
  const definition = project.multicams?.find((item) => item.id === instance.multicamId)
  if (!definition) return null
  const transport = useTransportStore.getState()
  const audio = getAudioPlaybackDiagnostics()
  const audioTime = transport.isPlaying ? getPlaybackClockContext().currentTime : 0
  const sourceIdentity = JSON.stringify(definition.angles.map((angle) => {
    const asset = useMediaStore.getState().assets.get(angle.assetId)
    const proxy = useProxyStore.getState().assets.get(angle.assetId)
    return [angle.assetId, asset?.objectUrl, asset?.sourceBounds, proxy?.phase, proxy?.entry?.cacheKey]
  }))
  return { projectId: project.id, sequenceId: doc.id, definition, instance, rate: doc.frameRate, sourceIdentity,
    frame: transport.playheadFrame, playing: transport.isPlaying, scrubbing: transport.isScrubbing, audioTime,
    audioHealthy: !audio || audio.scheduledThroughContextTime >= audioTime - .05 }
}

async function prepareSources(context: MonitorContext, ids: readonly string[], signal: AbortSignal): Promise<readonly MulticamMonitorSource[]> {
  const sources: MulticamMonitorSource[] = []
  for (const id of ids) {
    signal.throwIfAborted()
    const angle = context.definition.angles.find((item) => item.id === id)!
    const proxyState = useProxyStore.getState().assets.get(angle.assetId)
    if (proxyState?.phase === 'ready' && proxyState.entry) {
      const source = await getProxyPreviewSource(angle.assetId)
      signal.throwIfAborted()
      const current = useProxyStore.getState().assets.get(angle.assetId)
      if (!source || current?.phase !== 'ready' || current.entry?.cacheKey !== proxyState.entry.cacheKey
        || source.entry.cacheKey !== proxyState.entry.cacheKey) throw new Error(`${angle.name}: the editing proxy changed. Retry with fresh proxies.`)
      if (source.entry.width > 1280 || source.entry.height > 720) throw new Error(`${angle.name}: live previews require a proxy no larger than 720p.`)
      sources.push({ id, blob: source.blob, representation: 'proxy', width: source.entry.width, height: source.entry.height,
        firstTimestampUs: 0, endTimestampUs: source.entry.durationMicroseconds })
      continue
    }
    const asset = useMediaStore.getState().assets.get(angle.assetId)
    const bounds = asset?.sourceBounds.video
    if (!asset || !bounds || bounds.status !== 'exact' || asset.width === null || asset.height === null) throw new Error(`${angle.name}: reconnect the original or generate a fresh editing proxy.`)
    if (context.definition.angles.length > 4) throw new Error('Five to eight angles require fresh 720p editing proxies.')
    monitorSourceReservation(asset.width, asset.height)
    const response = await fetch(asset.objectUrl, { signal })
    if (!response.ok) throw new Error(`${angle.name}: the original could not be read.`)
    const blob = await response.blob()
    signal.throwIfAborted()
    if (useMediaStore.getState().assets.get(angle.assetId) !== asset) throw new Error(`${angle.name}: the original changed while preparing previews.`)
    sources.push({ id, blob, representation: 'original', width: asset.width, height: asset.height,
      firstTimestampUs: bounds.firstTimestampUs, endTimestampUs: bounds.endTimestampUs })
  }
  return sources
}

let mounted: ReturnType<typeof createMountedMonitor> | null = null
function createMountedMonitor(instanceId: string) {
  const session = createMulticamMonitorSession({ admission: mediaResourceAdmission,
    read: () => readContext(instanceId), visible: () => document.visibilityState === 'visible',
    available: () => !derivedDataIsClearing(), now: () => performance.now(), prepare: prepareSources,
    publish: (value) => useMulticamMonitorStore.setState(value),
  })
  const projectId = useDocumentStore.getState().project.id, sequenceId = useDocumentStore.getState().doc.id
  const check = () => {
    const { project, doc } = useDocumentStore.getState()
    if (project.id !== projectId || doc.id !== sequenceId) session.disable()
    else session.tick()
  }
  const cleanups = [useDocumentStore.subscribe(check), useMediaStore.subscribe((next, prev) => {
    if (next.assets !== prev.assets || next.descriptors !== prev.descriptors) check()
  }), useProxyStore.subscribe(check), useTransportStore.subscribe(check),
  subscribePreviewRenderCompletions((diagnostic) => {
    if (diagnostic.mode === 'playback' && diagnostic.result.status !== 'superseded') {
      session.recordProgram(diagnostic.completedAt - diagnostic.requestedAt,
        diagnostic.result.status === 'error' || diagnostic.result.missingClipIds.length > 0, diagnostic.frame)
    }
  }), registerDerivedDataOwner(async () => session.interrupt('Live previews paused while derived media is cleared.'))]
  const hidden = () => { if (document.visibilityState !== 'visible') session.interrupt('Live previews paused while the page is hidden. Retry when ready.') }
  const frozen = () => session.interrupt('Live previews paused because the page was suspended. Retry when ready.')
  document.addEventListener('visibilitychange', hidden)
  document.addEventListener('freeze', frozen)
  window.addEventListener('pagehide', frozen)
  const timer = setInterval(check, 100)
  let observer: PerformanceObserver | null = null
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) session.recordLongTask(entry.duration) })
    observer.observe({ type: 'longtask' })
  }
  return { session, dispose() {
    session.dispose(); clearInterval(timer); observer?.disconnect(); cleanups.forEach((cleanup) => cleanup())
    document.removeEventListener('visibilitychange', hidden); document.removeEventListener('freeze', frozen); window.removeEventListener('pagehide', frozen)
  } }
}

export function mountMulticamMonitor(instanceId: string): () => void {
  disposeMulticamMonitor()
  const owner = createMountedMonitor(instanceId); mounted = owner
  return () => { if (mounted === owner) disposeMulticamMonitor() }
}
export function disposeMulticamMonitor(): void {
  const owner = mounted; mounted = null; owner?.dispose()
  useMulticamMonitorStore.setState({ ...INITIAL_MULTICAM_MONITOR })
}
export function setMulticamMonitorEnabled(enabled: boolean): void {
  if (enabled) mounted?.session.enable()
  else mounted?.session.disable()
}
export function registerMulticamMonitorCanvas(id: string, canvas: HTMLCanvasElement): () => void {
  return mounted?.session.registerCanvas(id, canvas) ?? (() => undefined)
}
/** Bounded numeric ownership evidence. No pixels, Blobs, URLs or cache keys. */
export function getMulticamMonitorDiagnostics() { return mounted?.session.snapshot() ?? null }
