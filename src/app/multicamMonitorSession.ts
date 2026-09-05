/** Injectable lifetime owner. It samples the existing playhead; it never advances it. */
import { createMulticamMonitorPlan, monitorHealthDecision, monitorSourceReservation, monitorSurfaceReservation, MULTICAM_MONITOR_QUALITIES as QUALITIES, MULTICAM_MONITOR_LIMITS as LIMITS, type MulticamMonitorQuality } from '../domain/multicamMonitor'
import type { FrameRate, MulticamDefinition, MulticamInstance } from '../domain/schema'
import { framesToMicroseconds } from '../domain/time'
import type { MulticamMonitorSource } from '../pipeline/multicamMonitorProtocol'
import { INITIAL_MULTICAM_MONITOR, type MulticamMonitorPresentation } from '../state/multicamMonitorStore'
import type { MediaResourceAdmission } from './mediaResourceAdmission'
import { createMulticamMonitorWorkerBridge, type MulticamMonitorWorkerBridge, type MulticamMonitorCleanup } from './multicamMonitorWorkerBridge'

export interface MonitorContext {
  readonly projectId: string
  readonly sequenceId: string
  readonly definition: MulticamDefinition
  readonly instance: MulticamInstance
  readonly rate: FrameRate
  readonly sourceIdentity: string
  readonly frame: number
  readonly playing: boolean
  readonly scrubbing: boolean
  readonly audioTime: number
  readonly audioHealthy: boolean
}
export interface MonitorSessionDeps {
  readonly admission: MediaResourceAdmission
  read(): MonitorContext | null
  visible(): boolean
  available(): boolean
  now(): number
  prepare(context: MonitorContext, inactiveIds: readonly string[], signal: AbortSignal): Promise<readonly MulticamMonitorSource[]>
  publish(presentation: MulticamMonitorPresentation): void
  createBridge?: typeof createMulticamMonitorWorkerBridge
}
interface Attempt {
  readonly abort: AbortController
  readonly context: MonitorContext
  readonly activeId: string
  readonly quality: MulticamMonitorQuality
  release: (() => void) | null
  bridge: MulticamMonitorWorkerBridge | null
  nextUs: number
  requestId: number
  live: boolean
  sourceDurations: ReadonlyMap<string, number>
}
interface WindowSamples {
  at: number
  program: number[]
  errors: number
  tiles: Map<string, number>
  expected: Map<string, number>
  latencies: number[]
  longTaskMs: number
  longestTaskMs: number
  lastProgramFrame: number | null
}
function p95(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * .95) - 1]!
}
function sameContext(a: MonitorContext, b: MonitorContext | null): boolean {
  return !!b && a.projectId === b.projectId && a.sequenceId === b.sequenceId
    && a.definition === b.definition && a.instance === b.instance && a.sourceIdentity === b.sourceIdentity
    && a.rate.num === b.rate.num && a.rate.den === b.rate.den
}

export function createMulticamMonitorSession(deps: MonitorSessionDeps) {
  let presentation = { ...INITIAL_MULTICAM_MONITOR }
  let disposed = false
  let attempt: Attempt | null = null
  let baseline: { fps: number; p95: number } | null = null
  let baselineWindows = 0
  let lastHealth: { stage: 'baseline' | 'live'; fps: number; latencyP95: number; errors: number; audioHealthy: boolean; decision: string } | null = null
  let previous: MonitorContext | null = null
  let samples: WindowSamples = newWindow()
  let lastCleanup: MulticamMonitorCleanup | null = null
  const canvases = new Map<string, { canvas: HTMLCanvasElement; lost: () => void }>()

  function newWindow(): WindowSamples {
    return { at: deps.now(), program: [], errors: 0, tiles: new Map(), expected: new Map(), latencies: [], longTaskMs: 0, longestTaskMs: 0, lastProgramFrame: null }
  }
  function publish(change: Partial<MulticamMonitorPresentation>) {
    presentation = { ...presentation, ...change }
    deps.publish(presentation)
  }
  function clearSurfaces() {
    for (const { canvas } of canvases.values()) { canvas.width = 0; canvas.height = 0 }
  }
  function forceRetire(owner: Attempt, reason: string) {
    owner.abort.abort()
    if (owner.bridge) lastCleanup = owner.bridge.terminate(reason)
    clearSurfaces()
    owner.release?.(); owner.release = null
    if (attempt === owner) attempt = null
  }
  function stop(reason: string, phase: MulticamMonitorPresentation['phase'] = 'paused') {
    if (attempt) forceRetire(attempt, reason)
    else clearSurfaces()
    baseline = null; baselineWindows = 0; samples = newWindow()
    publish({ phase, detail: reason, angles: {} })
  }
  function valid(owner: Attempt): boolean {
    return !disposed && presentation.enabled && attempt === owner && !owner.abort.signal.aborted
      && deps.visible() && deps.available() && sameContext(owner.context, deps.read())
  }
  async function start(context: MonitorContext, activeId: string) {
    const owner: Attempt = { abort: new AbortController(), context, activeId, quality: presentation.quality,
      release: null, bridge: null, nextUs: framesToMicroseconds(context.frame, context.rate), requestId: 0, live: false, sourceDurations: new Map() }
    attempt = owner
    publish({ phase: 'starting', detail: 'Preparing bounded angle previews…' })
    try {
      const ids = context.definition.angles.filter((angle) => angle.id !== activeId).map((angle) => angle.id)
      const sources = await deps.prepare(context, ids, owner.abort.signal)
      if (!valid(owner)) return
      if (sources.length !== ids.length || !ids.every((id) => sources.some((source) => source.id === id))) throw new Error('An angle source is unavailable. Reconnect it or generate fresh editing proxies.')
      if (context.definition.angles.length > 4 && sources.some((source) => source.representation !== 'proxy')) throw new Error('Five to eight angles require fresh 720p editing proxies.')
      owner.sourceDurations = new Map(sources.map((source) => [source.id, source.endTimestampUs - source.firstTimestampUs]))
      const reservation = { decoderSlots: sources.length,
        surfaceBytes: monitorSurfaceReservation(sources.map((source) => monitorSourceReservation(source.width, source.height)), owner.quality) }
      const admission = deps.admission.tryMonitor(reservation, (reason) => {
        forceRetire(owner, reason)
        if (!presentation.enabled) return
        if (reason === 'program-changed' || reason === 'program-resized') {
          stop('Checking Program playback after the edit…', 'waiting')
        } else stop(reason === 'source-priority' ? 'Close Source Monitor, then retry live previews.' : `Live previews paused for ${reason}. Retry when playback is ready.`)
      })
      if (!admission.admitted) throw new Error(admission.reason)
      owner.release = admission.release
      if (!valid(owner)) { forceRetire(owner, 'cancelled-before-worker'); return }
      const { width, height } = QUALITIES[owner.quality]
      owner.bridge = (deps.createBridge ?? createMulticamMonitorWorkerBridge)({ sources, width, height,
        onFailure: (reason) => { if (attempt === owner) stop(reason) },
        onFrame: (id, _requestId, _timestampUs, bitmap, latencyMs) => {
          if (!valid(owner) || !owner.live) return
          const current = deps.read()!
          const plan = createMulticamMonitorPlan(current.definition, current.instance, current.rate)(current.frame)
          const timeUs = plan?.angles.find((angle) => angle.angleId === id)?.sourceTimeUs
          if (!plan || plan.activeAngleId === id || timeUs == null || timeUs >= (owner.sourceDurations.get(id) ?? 0)) return
          const canvas = canvases.get(id)?.canvas
          if (!canvas) throw new Error('An angle preview surface was removed.')
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
          const ctx = canvas.getContext('2d', { alpha: false })
          if (!ctx || ctx.isContextLost?.()) throw new Error('An angle preview surface lost its graphics context.')
          ctx.drawImage(bitmap, 0, 0, width, height)
          samples.tiles.set(id, (samples.tiles.get(id) ?? 0) + 1)
          if (samples.latencies.length < 256) samples.latencies.push(latencyMs)
          if (presentation.angles[id] !== 'live') publish({ angles: { ...presentation.angles, [id]: 'live' } })
        },
      })
      await owner.bridge.ready
      if (!valid(owner)) { forceRetire(owner, 'cancelled-after-open'); return }
      owner.live = true; samples = newWindow()
      publish({ phase: owner.quality === 'normal' ? 'live' : 'reduced',
        detail: `${QUALITIES[owner.quality].fps} fps angle previews · active angle in Program Monitor.` })
      tick()
    } catch (cause) {
      if (attempt === owner) stop(cause instanceof Error ? cause.message : 'Live previews could not start.')
    } finally {
      if (attempt !== owner) {
        owner.abort.abort()
        if (owner.bridge) lastCleanup = owner.bridge.terminate('stale-startup')
        owner.release?.(); owner.release = null
      }
    }
  }
  function tick() {
    if (disposed || !presentation.enabled || presentation.phase === 'paused') return
    const current = deps.read()
    if (!deps.visible() || !deps.available()) { stop('Live previews paused while this page is hidden or media is being cleared. Retry when ready.'); return }
    if (!current || (previous && (previous.projectId !== current.projectId || previous.sequenceId !== current.sequenceId))) {
      disable(); previous = current; return
    }
    if (attempt && attempt.context.sourceIdentity !== current.sourceIdentity) {
      stop('Angle sources or proxy freshness changed. Retry with the current media.'); previous = current; return
    }
    const plan = createMulticamMonitorPlan(current.definition, current.instance, current.rate)(current.frame)
    const seek = previous?.playing && current.playing && Math.abs(current.frame - previous.frame
      - (current.audioTime - previous.audioTime) * current.rate.num / current.rate.den) > 2
    const changed = attempt && (!sameContext(attempt.context, current) || attempt.activeId !== plan?.activeAngleId)
    previous = current
    if (!current.playing || current.scrubbing || !plan || seek || changed) {
      stop(!current.playing ? 'Press Play to check Program playback and start live previews.'
        : !plan ? 'Place the playhead inside this multicam item.' : 'Checking Program playback after the edit or seek…', 'waiting')
      return
    }
    if (!attempt) {
      if (presentation.phase !== 'waiting') publish({ phase: 'waiting', detail: 'Checking Program playback before starting live previews…' })
      if (deps.now() - samples.at < LIMITS.sampleWindowMs) return
      const fps = samples.program.length * 1000 / (deps.now() - samples.at)
      const latency = p95(samples.program)
      lastHealth = { stage: 'baseline', fps, latencyP95: latency, errors: samples.errors, audioHealthy: current.audioHealthy, decision: 'admit' }
      if (fps < Math.min(current.rate.num / current.rate.den, 60) * .9 || latency > 50 || samples.errors || !current.audioHealthy) {
        lastHealth.decision = 'wait'
        // Cold Program initialization may consume its first window. Admit only
        // after a complete healthy window; at most six seconds, with no wall.
        if (++baselineWindows < 3) { samples = newWindow(); return }
        lastHealth.decision = 'pause'
        stop('Program playback needs the available resources. Use editing proxies or paused previews, then retry.'); return
      }
      baseline = { fps, p95: latency }
      void start(current, plan.activeAngleId)
      return
    }
    const owner = attempt
    if (!owner.live) return
    if (deps.now() - samples.at >= LIMITS.sampleWindowMs && baseline) {
      const ids = current.definition.angles.filter((angle) => angle.id !== owner.activeId).map((angle) => angle.id)
      const decision = monitorHealthDecision({ durationMs: deps.now() - samples.at, programFrames: samples.program.length,
        programLatencyP95: p95(samples.program), programErrors: samples.errors,
        tileFrames: ids.map((id) => samples.tiles.get(id) ?? 0), tileExpectedFrames: ids.map((id) => samples.expected.get(id) ?? 0),
        tileLatencyP95: p95(samples.latencies), longTaskMs: samples.longTaskMs, longestTaskMs: samples.longestTaskMs,
        audioHealthy: current.audioHealthy }, baseline.fps, baseline.p95, current.rate.num / current.rate.den, owner.quality)
      lastHealth = { stage: 'live', fps: samples.program.length * 1000 / (deps.now() - samples.at), latencyP95: p95(samples.program),
        errors: samples.errors, audioHealthy: current.audioHealthy, decision }
      samples = newWindow()
      if (decision === 'pause') { stop('Live previews paused to protect Program playback and audio. Use editing proxies or retry.'); return }
      if (decision === 'reduce') {
        forceRetire(owner, 'reduce-quality')
        publish({ quality: 'reduced' }); void start(current, plan.activeAngleId); return
      }
    }
    const timeUs = framesToMicroseconds(current.frame, current.rate)
    if (timeUs < owner.nextUs) return
    const period = 1_000_000 / QUALITIES[owner.quality].fps
    owner.nextUs += (Math.floor((timeUs - owner.nextUs) / period) + 1) * period
    const angles = { ...presentation.angles }
    for (const angle of plan.angles) {
      if (angle.angleId === owner.activeId || angle.sourceTimeUs === null
        || angle.sourceTimeUs >= (owner.sourceDurations.get(angle.angleId) ?? 0)) {
        angles[angle.angleId] = angle.angleId === owner.activeId ? 'program' : 'gap'
        const canvas = canvases.get(angle.angleId)?.canvas
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      } else {
        angles[angle.angleId] ??= 'waiting'
        samples.expected.set(angle.angleId, (samples.expected.get(angle.angleId) ?? 0) + 1)
        owner.bridge?.request(angle.angleId, ++owner.requestId, angle.sourceTimeUs)
      }
    }
    if (JSON.stringify(angles) !== JSON.stringify(presentation.angles)) publish({ angles })
  }
  function disable() {
    const owner = attempt
    if (owner?.live && owner.bridge) {
      // An ordinary off request can acknowledge explicit native closes. Keep
      // admission held until that acknowledgement or the bridge's deadline;
      // essential work or a new enable can still force-retire this exact owner.
      owner.abort.abort(); owner.live = false; clearSurfaces()
      void owner.bridge.close().then((cleanup) => {
        if (attempt !== owner) return
        lastCleanup = cleanup; owner.release?.(); owner.release = null; attempt = null
      })
      baseline = null; baselineWindows = 0; samples = newWindow()
    } else stop(INITIAL_MULTICAM_MONITOR.detail, 'off')
    publish({ ...INITIAL_MULTICAM_MONITOR }); previous = null
  }
  return {
    tick,
    enable() {
      if (disposed) return
      stop('Checking Program playback before starting live previews…', 'waiting')
      previous = deps.read(); publish({ enabled: true, quality: 'normal' }); tick()
    },
    disable,
    interrupt: (reason: string) => { if (!disposed && presentation.enabled) stop(reason) },
    recordProgram(latencyMs: number, failed: boolean, frame?: number) {
      if (!presentation.enabled || presentation.phase === 'paused' || !deps.read()?.playing) return
      if (failed) samples.errors++
      if (frame !== undefined && samples.lastProgramFrame === frame) return
      if (frame !== undefined) samples.lastProgramFrame = frame
      if (Number.isFinite(latencyMs) && samples.program.length < 256) samples.program.push(latencyMs)
    },
    recordLongTask(durationMs: number) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      samples.longTaskMs += durationMs; samples.longestTaskMs = Math.max(samples.longestTaskMs, durationMs)
    },
    registerCanvas(id: string, canvas: HTMLCanvasElement): () => void {
      const old = canvases.get(id)
      if (old) { old.canvas.removeEventListener('contextlost', old.lost); old.canvas.width = old.canvas.height = 0 }
      if (!old && canvases.size >= 8) throw new Error('Too many multicam preview surfaces')
      canvas.width = canvas.height = 0
      const lost = () => stop('The graphics context was lost. Retry live previews when Program is ready.')
      const entry = { canvas, lost }; canvases.set(id, entry); canvas.addEventListener('contextlost', lost)
      return () => {
        if (canvases.get(id) !== entry) return
        if (attempt) stop('An angle preview surface was removed.')
        canvas.removeEventListener('contextlost', lost); canvas.width = canvas.height = 0; canvases.delete(id)
      }
    },
    dispose() {
      if (disposed) return
      if (attempt) forceRetire(attempt, 'disposed')
      disable(); disposed = true
      for (const { canvas, lost } of canvases.values()) canvas.removeEventListener('contextlost', lost)
      canvases.clear()
    },
    snapshot: () => ({ presentation, pendingSetup: !!attempt && !attempt.live, worker: attempt?.bridge?.snapshot() ?? null,
      canvases: canvases.size, surfacePixels: [...canvases.values()].reduce((sum, { canvas }) => sum + canvas.width * canvas.height, 0), lastCleanup, lastHealth }),
  }
}
export type MulticamMonitorSession = ReturnType<typeof createMulticamMonitorSession>
