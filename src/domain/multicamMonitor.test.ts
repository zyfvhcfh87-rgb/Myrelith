import { describe, expect, test } from 'vitest'
import { createMulticamMonitorPlan, monitorHealthDecision, monitorSourceReservation, monitorSurfaceReservation, type MonitorHealthWindow } from './multicamMonitor'
import type { MulticamDefinition, MulticamInstance } from './schema'
import { framesToMicroseconds } from './time'

const definition: MulticamDefinition = { id: 'multicam', name: 'Cameras', durationFrames: 1000,
  angles: [
    { id: 'one', assetId: 'a', name: 'One', sourceStartFrame: 30, coverage: { startFrame: 0, durationFrames: 1000 } },
    { id: 'two', assetId: 'b', name: 'Two', sourceStartFrame: 0, coverage: { startFrame: 10, durationFrames: 900 } },
  ], switches: [{ frame: 0, videoAngleId: 'one' }, { frame: 90, videoAngleId: 'two' }], audioPolicy: { kind: 'fixed', angleId: 'one' } }
const instance = { id: 'instance', multicamId: 'multicam', sourceStartFrame: 0, timelineRange: { startFrame: 100, durationFrames: 1000 } } as MulticamInstance
const healthy: MonitorHealthWindow = { durationMs: 2000, programFrames: 60, programLatencyP95: 2, programErrors: 0,
  tileFrames: [20, 20, 20], tileLatencyP95: 60, longTaskMs: 0, longestTaskMs: 0, audioHealthy: true }

describe('multicam monitor policy', () => {
  test('reads exact cuts and half-open gaps from authored geometry without writing it', () => {
    const before = JSON.stringify(definition)
    const plan = createMulticamMonitorPlan(definition, instance, { num: 30, den: 1 })
    expect(plan(99)).toBeNull(); expect(plan(1100)).toBeNull()
    expect(plan(100)?.angles[1]?.sourceTimeUs).toBeNull()
    expect(plan(110)?.angles[1]?.sourceTimeUs).toBe(0)
    expect(plan(189)?.activeAngleId).toBe('one')
    expect(plan(190)?.activeAngleId).toBe('two')
    expect(plan(190)?.angles[1]?.sourceFrame).toBe(80)
    expect(JSON.stringify(definition)).toBe(before)
  })
  test('preserves exact NTSC frame mapping through a trimmed instance', () => {
    const rate = { num: 30000, den: 1001 }
    const plan = createMulticamMonitorPlan(definition, { ...instance, sourceStartFrame: 30, timelineRange: { startFrame: 100, durationFrames: 900 } }, rate)
    expect(plan(100)?.angles[0]?.sourceTimeUs).toBe(framesToMicroseconds(60, rate))
    expect(plan(160)?.activeAngleId).toBe('two')
  })
  test('reserves padded AVC source frames plus output, transfer and scratch surfaces', () => {
    expect(monitorSourceReservation(1920, 1080)).toBe(1920 * 1088 * 8)
    expect(monitorSurfaceReservation(Array(7).fill(monitorSourceReservation(1280, 720)), 'normal')).toBe(55_065_600)
    expect(() => monitorSourceReservation(3840, 2160)).toThrow('proxies')
    expect(() => monitorSourceReservation(NaN, 720)).toThrow(RangeError)
  })
  test('protects Program and audio before considering a lower tile cadence', () => {
    expect(monitorHealthDecision(healthy, 30, 2, 30, 'normal')).toBe('continue')
    for (const change of [{ programFrames: 54 }, { programLatencyP95: 12 }, { programErrors: 1 }, { audioHealthy: false }, { longestTaskMs: 101 }, { longTaskMs: 41 }]) {
      expect(monitorHealthDecision({ ...healthy, ...change }, 30, 2, 30, 'normal')).toBe('pause')
    }
    expect(monitorHealthDecision(healthy, 20, 2, 30, 'normal')).toBe('pause')
    expect(monitorHealthDecision(healthy, 30, NaN, 30, 'normal')).toBe('pause')
  })
  test('one starved angle reduces cadence, then pauses if reduced cadence also fails; source gaps are exempt', () => {
    expect(monitorHealthDecision({ ...healthy, tileFrames: [20, 20, 0] }, 30, 2, 30, 'normal')).toBe('reduce')
    expect(monitorHealthDecision({ ...healthy, tileFrames: [10, 10, 7] }, 30, 2, 30, 'reduced')).toBe('pause')
    expect(monitorHealthDecision({ ...healthy, tileFrames: [20, 0], tileExpectedFrames: [20, 0] }, 30, 2, 30, 'normal')).toBe('continue')
  })
})
