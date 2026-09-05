/** Test-only composition root loaded explicitly by the source-bound runner. */
import { mediaAssetDecoderBudget } from '../../src/codecs/mediaCodecFallbacks'
import { useDocumentStore } from '../../src/state/documentStore'
import { useMediaStore } from '../../src/state/mediaStore'
import { useTransportStore } from '../../src/state/transportStore'
import { useProxyStore } from '../../src/state/proxyStore'
import { getProxyPreviewSource, requestProxyGeneration, waitForProxyIdle, previewRepresentationDecision, removeProxy } from '../../src/app/proxyController'
import { waitForMediaVisualsIdle } from '../../src/app/mediaVisualsController'
import { capturePreviewRuntimeTelemetry, setPreviewRuntimeTelemetryEnabled, subscribePreviewRenderCompletions, renderPreviewFrameForDevBenchmark } from '../../src/app/previewController'
import { getAudioPlaybackDiagnostics, getPlaybackClockContext, pauseAndDrainPlayback, play } from '../../src/app/transportController'
import type { LaneSource, Ledger, Response } from './protocol'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let candidate: 'owned-native-v3' | 'finite-seek-v2' = 'owned-native-v3'
export function setCandidate(value: typeof candidate) { candidate = value }
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}
function summary(values: number[]) {
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null }
}
export async function prepare(count: number) {
  await waitForMediaVisualsIdle()
  const assets = [...useMediaStore.getState().assets.values()]
  if (assets.length < count) throw new Error('Insufficient imported angles')
  const state = useDocumentStore.getState(), doc = state.doc
  const result = state.createMulticam({ name: 'Issue 195 research cameras', startFrame: 0,
    videoTrackId: doc.tracks.find((t) => t.kind === 'video')!.id,
    audioTrackId: doc.tracks.find((t) => t.kind === 'audio')!.id,
    angles: assets.slice(0, count).map((asset) => ({ assetId: asset.id, name: asset.fileName, durationFrames: 240, syncFrame: 0 })),
    audioPolicy: { kind: 'fixed', angleIndex: 0 } })
  await wait(300)
  return { result, project: useDocumentStore.getState().project }
}
export async function generateProxies() {
  const result = []
  for (const asset of useMediaStore.getState().assets.values()) {
    for (let i = 0; i < 100 && useProxyStore.getState().assets.get(asset.id)?.phase === 'checking'; i++) await wait(50)
    if (!requestProxyGeneration(asset.id)) throw new Error(`Proxy refused: ${JSON.stringify(useProxyStore.getState().assets.get(asset.id))}`)
    await waitForProxyIdle()
    const source = await getProxyPreviewSource(asset.id)
    if (!source) throw new Error(`Proxy unavailable: ${JSON.stringify(useProxyStore.getState().assets.get(asset.id))}`)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await source.blob.arrayBuffer()))
    result.push({ assetId: asset.id, entry: source.entry, sourceKey: source.sourceKey,
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') })
  }
  return result
}

class ResearchWall {
  worker: Worker | null = null
  readonly canvases = new Map<string, HTMLCanvasElement>()
  readonly pending = new Set<string>()
  readonly times = new Map<string, number[]>()
  readonly ages: { time: number; age: number }[] = []
  readonly errors: string[] = []
  readonly ledgerSamples: Ledger[] = []
  readonly root = document.createElement('aside')
  private readonly width: number
  private readonly height: number
  private readonly step: number
  private closing = false
  private readyResolve: (() => void) | null = null
  private closedResolve: ((ledger: Ledger) => void) | null = null
  private closePromise: Promise<unknown> | null = null
  private unsubscribe: (() => void) | null = null
  private lastFrame = -1
  private lastRequestedFrame = -1
  private events: string[] = []
  private identities = new Map<string, { url: string; key: string }>()
  private removeListeners: (() => void)[] = []
  reservedBytes = 0
  missedRequests = 0
  staleFrames = 0
  receivedBitmaps = 0
  closedBitmaps = 0
  peakPending = 0
  startedAt = performance.now()
  get retired() { return this.closing }
  constructor(width: number, height: number, fps: number) {
    this.width = width; this.height = height; this.step = 30 / fps
  }
  async start(count: number, representation: 'original' | 'proxy') {
    if (![2, 4, 8].includes(count)) throw new Error('Unsupported angle admission')
    const projectAtStart = useDocumentStore.getState().project
    const assets = [...useMediaStore.getState().assets.values()].slice(1, count)
    if (assets.length !== count - 1) throw new Error('Angle count does not match connected source count')
    const sources: LaneSource[] = []
    for (const asset of assets) {
      const proxy = representation === 'proxy' ? await getProxyPreviewSource(asset.id) : null
      if (representation === 'proxy' && !proxy) throw new Error('Fresh production proxy required for this cell')
      const blob = proxy?.blob ?? await (await fetch(asset.objectUrl)).blob()
      if (useDocumentStore.getState().project !== projectAtStart || useMediaStore.getState().assets.get(asset.id) !== asset
        || (proxy && (useProxyStore.getState().assets.get(asset.id)?.entry?.cacheKey !== proxy.entry.cacheKey
          || previewRepresentationDecision(asset.id).representation !== 'proxy'))) throw new Error('Source changed during wall preparation')
      // Reserve two application-visible full-source frame references per lane,
      // plus one output and one in-flight bitmap. This excludes opaque native
      // decoder buffers; the ledger and browser observations remain additional gates.
      this.reservedBytes += 2 * (proxy?.entry.width ?? asset.width!) * (proxy?.entry.height ?? asset.height!) * 4
        + 2 * this.width * this.height * 4
      sources.push({ id: asset.id, blob, budget: mediaAssetDecoderBudget(asset, blob.size) })
      this.identities.set(asset.id, { url: asset.objectUrl, key: proxy?.sourceKey ?? 'original' })
      const canvas = document.createElement('canvas')
      canvas.width = this.width; canvas.height = this.height
      canvas.style.cssText = 'width:160px;height:90px;border:1px solid #9c9'
      canvas.setAttribute('aria-label', `Research camera ${sources.length + 1}`)
      this.root.append(canvas); this.canvases.set(asset.id, canvas); this.times.set(asset.id, [])
    }
    this.reservedBytes += this.width * this.height * 4
    if (!Number.isSafeInteger(this.reservedBytes) || this.reservedBytes > 64 * 1024 * 1024) {
      for (const canvas of this.canvases.values()) { canvas.width = 0; canvas.height = 0 }
      this.root.replaceChildren(); this.canvases.clear(); this.identities.clear()
      return { admitted: false, reason: '64 MiB candidate reservation exceeded', reservedBytes: this.reservedBytes }
    }
    this.root.setAttribute('aria-label', 'Isolated Issue 195 research monitor')
    this.root.style.cssText = 'position:fixed;left:0;bottom:0;background:#111;display:flex;z-index:1000;pointer-events:none'
    document.body.append(this.root)
    this.worker = candidate === 'finite-seek-v2'
      ? new Worker(new URL('./cursor-candidate.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./monitor.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<Response>) => {
      const message = event.data
      if (this.ledgerSamples.length < 4096) this.ledgerSamples.push(message.ledger)
      if (message.type === 'ready') { this.readyResolve?.(); return }
      if (message.type === 'closed') { this.closedResolve?.(message.ledger); return }
      if (message.type === 'error') { this.errors.push(message.detail); void this.stop('worker-error'); return }
      this.pending.delete(message.id); this.receivedBitmaps++
      try {
        if (this.closing) { this.staleFrames++; return }
        const now = performance.now()
        this.canvases.get(message.id)?.getContext('2d')?.drawImage(message.bitmap, 0, 0)
        this.times.get(message.id)?.push(now)
        this.ages.push({ time: now, age: now - message.requestedAt })
      } finally { message.bitmap.close(); this.closedBitmaps++ }
      const visibleAndTransferredBytes = (this.canvases.size * 2 + 1) * this.width * this.height * 4
      if (message.ledger.estimatedFrameBytes + visibleAndTransferredBytes > 64 * 1024 * 1024) void this.stop('accounted-pressure')
    }
    this.worker.onerror = (event) => { this.errors.push(event.message); void this.stop('worker-error') }
    const ready = new Promise<void>((resolve) => { this.readyResolve = resolve })
    this.worker.postMessage({ type: 'open', sources, width: this.width, height: this.height, startUs: 0 })
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Wall startup deadline')), 5000) })]) }
    catch (cause) { await this.stop('startup-failed'); throw cause }
    finally { clearTimeout(timer) }
    if (useDocumentStore.getState().project !== projectAtStart) { await this.stop('stale-startup'); throw new Error('Project changed during wall startup') }
    for (const [id, identity] of this.identities) {
      if (useMediaStore.getState().assets.get(id)?.objectUrl !== identity.url
        || (representation === 'proxy' && (previewRepresentationDecision(id).representation !== 'proxy'
          || `proxy:${useProxyStore.getState().assets.get(id)?.entry?.cacheKey}` !== identity.key))) {
        await this.stop('stale-source-startup'); throw new Error('Source changed during wall startup')
      }
    }
    const project = useDocumentStore.getState().project
    this.unsubscribe = useTransportStore.subscribe((state) => this.tick(state.playheadFrame, state.isPlaying))
    this.removeListeners.push(useDocumentStore.subscribe((state) => {
      if (state.project !== project) void this.stop('project-or-authored-intent-changed')
    }))
    this.removeListeners.push(useMediaStore.subscribe((state) => {
      for (const [id, identity] of this.identities) {
        if (state.assets.get(id)?.objectUrl !== identity.url) { void this.stop('source-removed-or-replaced'); return }
      }
    }))
    this.removeListeners.push(useProxyStore.subscribe(() => {
      if (representation === 'proxy') for (const id of this.identities.keys()) {
        const key = useProxyStore.getState().assets.get(id)?.entry?.cacheKey
        if (previewRepresentationDecision(id).representation !== 'proxy' || this.identities.get(id)?.key !== `proxy:${key}`) { void this.stop('proxy-invalidated'); return }
      }
    }))
    const hidden = () => { if (document.visibilityState === 'hidden') void this.stop('background') }
    const freeze = () => { void this.stop('freeze') }
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('freeze', freeze)
    this.removeListeners.push(() => document.removeEventListener('visibilitychange', hidden), () => document.removeEventListener('freeze', freeze))
    for (const canvas of this.canvases.values()) {
      const lost = () => { void this.stop('context-loss') }
      canvas.addEventListener('contextlost', lost)
      this.removeListeners.push(() => canvas.removeEventListener('contextlost', lost))
    }
    return { admitted: true, reason: 'Bounded research reservation', reservedBytes: this.reservedBytes }
  }
  tick(frame: number, playing: boolean) {
    if (this.closing || !this.worker || !playing) return
    if (this.lastFrame >= 0 && (frame < this.lastFrame || frame - this.lastFrame > 30)) {
      void this.stop('seek-discontinuity'); return
    }
    this.lastFrame = frame
    if (frame - this.lastRequestedFrame < this.step) return
    this.lastRequestedFrame = frame
    for (const id of this.canvases.keys()) {
      if (this.pending.has(id)) { this.missedRequests++; continue }
      this.pending.add(id)
      this.peakPending = Math.max(this.peakPending, this.pending.size)
      this.worker.postMessage({ type: 'frame', id, frame, targetUs: Math.round(frame * 1_000_000 / 30), requestedAt: performance.now() })
    }
  }
  stats(from: number, until: number) {
    const duration = (until - from) / 1000
    return {
      requestedFps: 30 / this.step, width: this.width, height: this.height,
      reservedBytes: this.reservedBytes,
      tiles: [...this.times].map(([id, times]) => ({ id, frames: times.filter((time) => time >= from && time <= until).length,
        fps: times.filter((time) => time >= from && time <= until).length / duration })),
      latencyMs: summary(this.ages.filter((item) => item.time >= from && item.time <= until).map((item) => item.age)), missedRequests: this.missedRequests, peakPending: this.peakPending,
      receivedBitmaps: this.receivedBitmaps, closedBitmaps: this.closedBitmaps, staleFrames: this.staleFrames,
      surfaceBytes: this.canvases.size * this.width * this.height * 4,
      peakWorker: this.ledgerSamples.reduce((peak, item) => ({
        decoders: Math.max(peak.decoders, item.peakNativeDecoders),
        frames: Math.max(peak.frames, item.peakNativeFrames),
        estimatedFrameBytes: Math.max(peak.estimatedFrameBytes, item.peakEstimatedFrameBytes),
        decodeQueue: Math.max(peak.decodeQueue, item.peakDecodeQueue),
        scratchBytes: Math.max(peak.scratchBytes, item.scratchBytes),
      }), { decoders: 0, frames: 0, estimatedFrameBytes: 0, decodeQueue: 0, scratchBytes: 0 }),
      errors: [...this.errors], events: [...this.events],
    }
  }
  stop(reason: string): Promise<unknown> {
    if (this.closePromise) return this.closePromise
    this.closing = true; this.events.push(reason)
    this.unsubscribe?.(); this.unsubscribe = null
    for (const remove of this.removeListeners.splice(0)) remove()
    const worker = this.worker, started = performance.now()
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let terminal: Ledger | null = null
      try {
        const closed = new Promise<Ledger>((resolve) => { this.closedResolve = resolve })
        worker?.postMessage({ type: 'close' })
        terminal = worker ? await Promise.race([closed, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000) })]) : null
      } finally {
        clearTimeout(timer); worker?.terminate(); this.worker = null
        for (const canvas of this.canvases.values()) { canvas.width = 0; canvas.height = 0 }
        this.root.replaceChildren(); this.root.remove(); this.canvases.clear(); this.pending.clear(); this.identities.clear()
      }
      return { reason, durationMs: performance.now() - started, forcedTermination: terminal === null,
        worker: terminal, main: { workers: 0, pending: this.pending.size,
          canvasesWithPixels: [...this.canvases.values()].filter((canvas) => canvas.width * canvas.height > 0).length,
          unclosedReceivedBitmaps: this.receivedBitmaps - this.closedBitmaps } }
    })()
    return this.closePromise
  }
}
let wall: ResearchWall | null = null
export async function startWall(count: number, representation: 'original' | 'proxy', fallback = false) {
  await wall?.stop('replaced')
  wall = new ResearchWall(fallback ? 160 : 320, fallback ? 90 : 180, fallback ? 5 : 10)
  try { return await wall.start(count, representation) }
  catch (cause) { await wall.stop('startup-failed'); throw cause }
}
export async function stopWall(reason = 'cancel') { return wall?.stop(reason) ?? null }
export function wallStats() { return wall?.stats(wall.startedAt, performance.now()) ?? null }
export async function armFault(count: number, representation: 'original' | 'proxy') {
  await pauseAndDrainPlayback(); useTransportStore.getState().setPlayheadFrame(0); await wait(150)
  const admission = await startWall(count, representation)
  if (!admission.admitted) throw new Error('Fault cell was not admitted')
  play(); await wait(180)
  return wallStats()
}
export async function fault(kind: string) {
  if (!wall) throw new Error('No fault owner')
  const projectBefore = useDocumentStore.getState().project
  const before = wallStats()
  let evidence: unknown = null
  if (kind === 'cancel') await stopWall('cancel')
  else if (kind === 'seek-storm') {
    for (let i = 0; i < 50; i++) useTransportStore.getState().setPlayheadFrame(i % 2 ? 150 : 10)
  } else if (kind === 'switch') {
    const definition = projectBefore.multicams![0]!
    const applied = useDocumentStore.getState().editMulticamDefinition({ kind: 'cut', definitionId: definition.id,
      angleId: definition.angles[1]!.id, frame: 90 })
    await pauseAndDrainPlayback()
    const frames = []
    for (const target of [89, 90]) {
      useTransportStore.getState().setPlayheadFrame(target)
      await wait(150)
      let rendered = await renderPreviewFrameForDevBenchmark(target)
      for (let attempt = 0; attempt < 3 && rendered.status === 'superseded'; attempt++) { await wait(50); rendered = await renderPreviewFrameForDevBenchmark(target) }
      const expectedAngleId = definition.angles[target === 89 ? 0 : 1]!.id
      frames.push({ frame: target, expectedAngleId, rendered,
        correctAngle: rendered.status === 'drawn' && rendered.missingClipIds.length === 0 && rendered.drawnClipIds.some((id) => id.includes(expectedAngleId)) })
    }
    evidence = { applied, frames, switches: useDocumentStore.getState().project.multicams![0]!.switches,
      thumbnailsRetiredBeforeRender: wall.retired }
  } else if (kind === 'source-removal') {
    useMediaStore.getState().disconnectAsset([...useMediaStore.getState().assets.keys()][1]!)
  } else if (kind === 'proxy-invalidation') {
    const assetId = [...useMediaStore.getState().assets.keys()][1]!
    await removeProxy(assetId)
    evidence = { assetId, decision: previewRepresentationDecision(assetId) }
  } else if (kind === 'context-loss-injected') {
    const canvas = wall.canvases.values().next().value!
    canvas.dispatchEvent(new Event('contextlost'))
    evidence = { injection: 'Canvas2D contextlost event; not a physical GPU reset' }
  } else if (kind === 'pressure-policy') {
    // The platform exposes no reliable page memory-pressure event. Exercise the
    // owner retirement separately from CDP's real browser pressure notification.
    await stopWall('memory-pressure-policy')
    evidence = { injection: 'explicit admission-owner pressure signal' }
  } else if (kind === 'project-replacement') {
    useDocumentStore.getState().setProject({ ...projectBefore, id: `research-replacement-${crypto.randomUUID()}` })
    evidence = { oldProjectId: projectBefore.id, newProjectId: useDocumentStore.getState().project.id,
      injection: 'complete project replacement through existing load/recovery store action; media-controller teardown measured separately' }
  } else throw new Error('Unknown fault')
  await wait(50)
  const automaticallyRetired = wall.retired
  const cleanup = await stopWall('fault-observation-cleanup')
  await pauseAndDrainPlayback()
  return { kind, before, automaticallyRetired, evidence, stats: wallStats(), cleanup,
    projectUnchanged: useDocumentStore.getState().project === projectBefore,
    audioAfterPause: getAudioPlaybackDiagnostics() }
}
export async function observedFault(kind: string) {
  await wait(50)
  const automaticallyRetired = wall?.retired ?? false
  const cleanup = await stopWall('fault-observation-cleanup')
  await pauseAndDrainPlayback()
  return { kind, automaticallyRetired, cleanup, stats: wallStats(), visibility: document.visibilityState,
    audioAfterPause: getAudioPlaybackDiagnostics() }
}
export async function benchmark(count: number, representation: 'original' | 'proxy', fallback = false) {
  await pauseAndDrainPlayback()
  useTransportStore.getState().setPlayheadFrame(0)
  await wait(350)
  setPreviewRuntimeTelemetryEnabled(true)
  const admission = count ? await startWall(count, representation, fallback) : null
  const completions: { frame: number; time: number; latency: number; missing: number; stale: boolean; error: boolean }[] = []
  // The existing two-rAF diagnostic drops samples when a newer 30 fps render
  // starts. Observe changing rendered pixels instead; apply identical readback
  // overhead to baseline and wall cells. This is a cadence probe, not VSYNC proof.
  const presentationTimes: number[] = []
  const probe = new OffscreenCanvas(16, 9), probeContext = probe.getContext('2d', { willReadFrequently: true })!
  const programCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')!
  let probeRequest = 0, previousHash = 0
  const samplePaint = () => {
    probeContext.drawImage(programCanvas, 0, 0, 16, 9)
    const bytes = probeContext.getImageData(0, 0, 16, 9).data
    let hash = 2166136261
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
    if (hash !== previousHash) presentationTimes.push(performance.now())
    previousHash = hash
    probeRequest = requestAnimationFrame(samplePaint)
  }
  probeRequest = requestAnimationFrame(samplePaint)
  const unsubscribe = subscribePreviewRenderCompletions((event) => {
    completions.push({ frame: event.frame, time: event.completedAt, latency: event.completedAt - event.requestedAt,
      missing: event.result.missingClipIds.length, stale: event.result.status === 'superseded', error: event.result.status === 'error' })
  })
  const tasks: PerformanceEntry[] = []
  const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries()))
  observer.observe({ entryTypes: ['longtask'] })
  let cleanup: unknown
  try {
    play()
    for (let i = 0; i < 100 && useTransportStore.getState().playheadFrame < 30; i++) await wait(25)
    if (useTransportStore.getState().playheadFrame < 30) throw new Error('Program did not pass warm-up')
    const from = performance.now(), startFrame = useTransportStore.getState().playheadFrame
    const startClock = getPlaybackClockContext().currentTime
    await wait(5000)
    const until = performance.now(), endFrame = useTransportStore.getState().playheadFrame
    const endClock = getPlaybackClockContext().currentTime
    const audio = getAudioPlaybackDiagnostics()
    const telemetry = await capturePreviewRuntimeTelemetry()
    const measured = completions.filter((sample) => sample.time >= from && sample.time <= until)
    const distinct = new Set(measured.filter((sample) => !sample.stale && !sample.missing && !sample.error).map((sample) => sample.frame))
    const changedPaints = presentationTimes.filter((time) => time >= from && time <= until).length
    const longTasks = tasks.filter((task) => task.startTime >= from && task.startTime <= until)
    const tiles = count ? wall!.stats(from, until) : null
    await pauseAndDrainPlayback()
    cleanup = count ? await stopWall('measurement-complete') : null
    const drainedProgram = await capturePreviewRuntimeTelemetry()
    return { candidate, count, representation, fallback, admission, from, until, durationMs: until - from, startFrame, endFrame,
      audioClockSeconds: endClock - startClock, audio,
      program: { fps: changedPaints / ((until - from) / 1000), completedFps: distinct.size / ((until - from) / 1000), completions: measured.length,
        latencyMs: summary(measured.map((sample) => sample.latency)), missing: measured.filter((sample) => sample.missing).length,
        stale: measured.filter((sample) => sample.stale).length, errors: measured.filter((sample) => sample.error).length, telemetry, drained: drainedProgram },
      longTasks: { count: longTasks.length, totalMs: longTasks.reduce((n, task) => n + task.duration, 0), maxMs: Math.max(0, ...longTasks.map((task) => task.duration)) },
      tiles, cleanup,
      jsHeap: heapSnapshot() }
  } finally {
    cancelAnimationFrame(probeRequest); probe.width = 0; probe.height = 0
    unsubscribe(); observer.disconnect(); await pauseAndDrainPlayback()
    if (count && !cleanup) await stopWall('measurement-finally')
  }
}
function heapSnapshot() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null
}
