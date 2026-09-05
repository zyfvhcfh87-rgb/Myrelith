import { describe, expect, test, vi } from 'vitest'
import { createMulticamMonitorSession, type MonitorContext } from './multicamMonitorSession'
import { MediaResourceAdmission } from './mediaResourceAdmission'
import type { MulticamMonitorBridgeOptions, MulticamMonitorCleanup } from './multicamMonitorWorkerBridge'
import type { MulticamMonitorSource } from '../pipeline/multicamMonitorProtocol'

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((r) => { resolve = r }), resolve } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function harness(count = 2) {
  let now = 0, visible = true, available = true
  let context: MonitorContext = {
    projectId: 'p', sequenceId: 's', sourceIdentity: 'fresh', rate: { num: 30, den: 1 }, frame: 0, playing: true,
    scrubbing: false, audioTime: 0, audioHealthy: true,
    instance: { id: 'i', kind: 'multicam', name: 'Cameras', multicamId: 'd', sourceStartFrame: 0, timelineRange: { startFrame: 0, durationFrames: 30000 } },
    definition: { id: 'd', name: 'Cameras', durationFrames: 30000, audioPolicy: { kind: 'fixed', angleId: 'a0' },
      switches: [{ frame: 0, videoAngleId: 'a0' }], angles: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, assetId: `m${i}`, name: `Camera ${i}`, sourceStartFrame: 0, coverage: { startFrame: 0, durationFrames: 30000 } })) },
  }
  const admission = new MediaResourceAdmission()
  admission.reserve({ kind: 'program', decoderSlots: 4, surfaceBytes: 10_000_000, monitorCompatible: true })
  const sources = (ids: readonly string[]): MulticamMonitorSource[] => ids.map((id) => ({ id, blob: new Blob(['local']), representation: 'proxy', width: 1280, height: 720, firstTimestampUs: 0, endTimestampUs: 1_000_000_000 }))
  const prepare = vi.fn(async (_context: MonitorContext, ids: readonly string[], _signal: AbortSignal) => sources(ids))
  const bridges: { options: MulticamMonitorBridgeOptions; terminate: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; ready: ReturnType<typeof deferred<void>> }[] = []
  let holdOpen = false
  let closeGate: ReturnType<typeof deferred<MulticamMonitorCleanup>> | null = null
  const createBridge = vi.fn((options: MulticamMonitorBridgeOptions) => {
    const ready = deferred<void>()
    const terminate = vi.fn(() => ({ forced: true, reason: 'stopped', ledger: null, workers: 0, pending: 0, unclosedReceivedBitmaps: 0 }))
    const request = vi.fn(() => true)
    bridges.push({ options, terminate, request, ready })
    if (!holdOpen) ready.resolve()
    return { ready: ready.promise, request, terminate, close: () => closeGate?.promise ?? Promise.resolve(terminate()),
      snapshot: () => ({ state: 'ready' as const, ledger: null, workers: 1, pending: 0, received: 0, closedBitmaps: 0 }) }
  })
  const publish = vi.fn()
  const session = createMulticamMonitorSession({ read: () => context, now: () => now, visible: () => visible,
    available: () => available, admission, prepare, createBridge, publish })
  const draw = vi.fn()
  for (const angle of context.definition.angles) {
    const canvas = document.createElement('canvas')
    canvas.getContext = vi.fn(() => ({ drawImage: draw, isContextLost: () => false })) as unknown as typeof canvas.getContext
    session.registerCanvas(angle.id, canvas)
  }
  function advance(frames = 60, tiles = false, programFrame?: number) {
    for (let i = 0; i < frames; i++) {
      now += 1000 / 30; context = { ...context, frame: context.frame + 1, audioTime: now / 1000 }
      session.recordProgram(2, false, programFrame)
      session.tick()
      if (tiles && i % 3 === 0) {
        const bridge = bridges.at(-1)!
        for (const source of bridge.options.sources) bridge.options.onFrame(source.id, i, 0, {} as ImageBitmap, 10)
      }
    }
  }
  return { session, admission, prepare, createBridge, bridges, sources, draw, advance,
    setVisible: (value: boolean) => { visible = value }, setAvailable: (value: boolean) => { available = value },
    setContext: (patch: Partial<MonitorContext>) => { context = { ...context, ...patch } },
    context: () => context, setHoldOpen: () => { holdOpen = true },
    holdClose: () => { closeGate = deferred<MulticamMonitorCleanup>(); return closeGate },
  }
}

describe('multicam monitor lifetime', () => {
  test('normal off holds admission until close acknowledgement; priority work still preempts synchronously', async () => {
    const h = harness(); h.session.enable(); h.advance(61); await flush()
    const close = h.holdClose(); h.session.disable()
    expect(h.session.snapshot().presentation.phase).toBe('off')
    expect(h.session.snapshot().surfacePixels).toBe(0)
    expect(h.admission.snapshot().monitorOwners).toBe(1)
    expect(h.bridges[0]!.terminate).not.toHaveBeenCalled()
    const lease = h.admission.reserve({ kind: 'export', decoderSlots: 1, surfaceBytes: 0, monitorCompatible: false })
    expect(h.bridges[0]!.terminate).toHaveBeenCalledOnce()
    expect(h.admission.snapshot().monitorOwners).toBe(0)
    lease.release(); h.session.enable(); h.advance(61); await flush()
    expect(h.admission.snapshot().monitorOwners).toBe(1)
    close.resolve({ forced: false, reason: 'closed', ledger: null, workers: 0, pending: 0, unclosedReceivedBitmaps: 0 })
    await flush()
    expect(h.admission.snapshot().monitorOwners).toBe(1)
    h.session.dispose()
  })
  test('repeated completions of one Program frame cannot qualify a healthy baseline', async () => {
    const h = harness(); h.session.enable()
    h.advance(185, false, 1)
    await flush()
    expect(h.createBridge).not.toHaveBeenCalled()
    expect(h.session.snapshot().presentation.phase).toBe('paused')
    h.session.dispose()
  })
  test('requires a complete healthy baseline after a cold window, and bounds waiting without allocating', async () => {
    const h = harness(); h.setContext({ audioHealthy: false }); h.session.enable()
    h.advance(61); await flush(); expect(h.createBridge).not.toHaveBeenCalled()
    expect(h.session.snapshot().presentation.phase).toBe('waiting')
    h.setContext({ audioHealthy: true }); h.advance(61); await flush()
    expect(h.session.snapshot().presentation.phase).toBe('live'); h.session.dispose()
    const bad = harness(); bad.setContext({ audioHealthy: false }); bad.session.enable(); bad.advance(185); await flush()
    expect(bad.session.snapshot().presentation.phase).toBe('paused'); expect(bad.createBridge).not.toHaveBeenCalled(); bad.session.dispose()
  })
  test('video ending before authored audio coverage is a gap, never an out-of-range decode', async () => {
    const h = harness(); h.prepare.mockImplementation(async (_context, ids) => h.sources(ids).map((source) => ({ ...source, endTimestampUs: 1_000_000 })))
    h.session.enable(); h.advance(61); await flush()
    expect(h.bridges[0]!.request).not.toHaveBeenCalled()
    expect(h.session.snapshot().presentation.angles.a1).toBe('gap'); h.session.dispose()
  })
  test('ordinary Program refresh drains before admission and preserves the enabled choice', async () => {
    const h = harness(); h.session.enable(); h.advance(61); await flush()
    h.admission.interrupt('program-changed')
    expect(h.session.snapshot().presentation).toMatchObject({ enabled: true, phase: 'waiting' })
    expect(h.admission.snapshot().monitorOwners).toBe(0)
    h.advance(61); await flush(); expect(h.createBridge).toHaveBeenCalledTimes(2); h.session.dispose()
  })
  test('checks initial visibility before any read or allocation, and requires explicit retry', async () => {
    const h = harness(); h.setVisible(false); h.session.enable(); h.advance(90); await flush()
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.createBridge).not.toHaveBeenCalled()
    expect(h.session.snapshot().presentation.phase).toBe('paused')
    h.setVisible(true); h.session.tick(); expect(h.createBridge).not.toHaveBeenCalled()
    h.session.enable(); h.advance(61); await flush()
    expect(h.session.snapshot().presentation.phase).toBe('live'); h.session.dispose()
  })
  test.each([2, 4, 8])('admits %i angles after baseline and leaves the authored active angle in Program', async (count) => {
    const h = harness(count); const before = JSON.stringify(h.context().definition)
    h.session.enable(); h.advance(61); await flush()
    expect(h.bridges[0]!.options.sources).toHaveLength(count - 1)
    expect(h.bridges[0]!.options.sources.some((source) => source.id === 'a0')).toBe(false)
    h.advance(61, true); await flush()
    expect(h.session.snapshot().presentation.phase).toBe('live')
    expect(h.draw).toHaveBeenCalled(); expect(JSON.stringify(h.context().definition)).toBe(before)
    h.session.dispose(); expect(h.admission.snapshot().monitorOwners).toBe(0)
    expect(h.session.snapshot().surfacePixels).toBe(0)
  })
  test.each(['hidden', 'source', 'project', 'clear', 'disable', 'dispose'])('retires during delayed preparation: %s', async (action) => {
    const h = harness(); const gate = deferred<MulticamMonitorSource[]>()
    h.prepare.mockImplementation(() => gate.promise)
    h.session.enable(); h.advance(61); expect(h.prepare).toHaveBeenCalledOnce()
    if (action === 'hidden') h.setVisible(false)
    if (action === 'source') h.setContext({ sourceIdentity: 'stale' })
    if (action === 'project') h.setContext({ projectId: 'replacement' })
    if (action === 'clear') h.setAvailable(false)
    if (action === 'disable') h.session.disable()
    if (action === 'dispose') h.session.dispose()
    h.session.tick(); gate.resolve(h.sources(['a1'])); await flush()
    expect(h.createBridge).not.toHaveBeenCalled(); expect(h.admission.snapshot().monitorOwners).toBe(0)
    h.session.dispose()
  })
  test('preempts a worker opening before essential work is admitted; a late ready cannot revive it', async () => {
    const h = harness(); h.setHoldOpen(); h.session.enable(); h.advance(61); await flush()
    expect(h.admission.snapshot().monitorOwners).toBe(1)
    const exportLease = h.admission.reserve({ kind: 'export', decoderSlots: 1, surfaceBytes: 0, monitorCompatible: false })
    expect(h.bridges[0]!.terminate).toHaveBeenCalled(); expect(h.admission.snapshot().monitorOwners).toBe(0)
    h.bridges[0]!.ready.resolve(); await flush()
    expect(h.session.snapshot().presentation.phase).toBe('paused'); exportLease.release(); h.session.dispose()
  })
  test('releases the old worker on seek storms and restarts only after a healthy baseline', async () => {
    const h = harness(); h.session.enable(); h.advance(61); await flush()
    for (const frame of [800, 20, 1000, 50]) { h.setContext({ frame }); h.session.tick() }
    expect(h.bridges[0]!.terminate).toHaveBeenCalledOnce(); expect(h.admission.snapshot().monitorOwners).toBe(0)
    h.advance(61); await flush(); expect(h.createBridge).toHaveBeenCalledTimes(2); h.session.dispose()
  })
  test('reduced cadence has one retry, then stops a starved wall', async () => {
    const h = harness(4); h.session.enable(); h.advance(61); await flush()
    h.advance(61); await flush()
    expect(h.session.snapshot().presentation.quality).toBe('reduced')
    expect(h.bridges[1]!.options.width).toBe(160)
    h.advance(61); await flush()
    expect(h.session.snapshot().presentation.phase).toBe('paused')
    expect(h.admission.snapshot().monitorOwners).toBe(0); h.session.dispose()
  })
  test.each(['audio', 'error', 'longtask', 'source', 'hidden', 'freeze'])('releases live surfaces on %s without changing cuts', async (action) => {
    const h = harness(); h.session.enable(); h.advance(61); await flush(); h.advance(3, true)
    expect(h.session.snapshot().surfacePixels).toBeGreaterThan(0)
    if (action === 'audio') h.setContext({ audioHealthy: false })
    if (action === 'error') h.session.recordProgram(1, true)
    if (action === 'longtask') h.session.recordLongTask(200)
    if (action === 'source') h.setContext({ sourceIdentity: 'changed' })
    if (action === 'hidden') h.setVisible(false)
    if (action === 'freeze') h.session.interrupt('frozen')
    h.advance(61, true); await flush()
    expect(h.admission.snapshot().monitorOwners).toBe(0); expect(h.session.snapshot().surfacePixels).toBe(0)
    expect(h.session.snapshot().presentation.phase).toBe('paused'); h.session.dispose()
  })
})
