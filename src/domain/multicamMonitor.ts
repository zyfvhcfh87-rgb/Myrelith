/** Disposable monitoring policy; no authored cuts, resource handles or clock. */
import { createMulticamPlanner, multicamAngleSourceFrame } from './multicam'
import type { FrameRate, MulticamDefinition, MulticamInstance } from './schema'
import { framesToMicroseconds, rangeContains } from './time'

export const MULTICAM_MONITOR_LIMITS = Object.freeze({
  maxLanes: 7, maxFrameBytes: 64 * 1024 * 1024,
  maxPackets: 60, maxPacketBytes: 2 * 1024 * 1024, maxRequestBytes: 8 * 1024 * 1024,
  maxReadBytes: 8 * 1024 * 1024, maxReadWorkBytes: 32 * 1024 * 1024,
  maxReadCalls: 2048, sourceCacheBytes: 1024 * 1024,
  requestDeadlineMs: 750, openDeadlineMs: 5000, closeDeadlineMs: 100,
  sampleWindowMs: 2000,
})
export const MULTICAM_MONITOR_QUALITIES = Object.freeze({
  normal: Object.freeze({ width: 320, height: 180, fps: 10 }),
  reduced: Object.freeze({ width: 160, height: 90, fps: 5 }),
})
export type MulticamMonitorQuality = keyof typeof MULTICAM_MONITOR_QUALITIES

export function monitorSourceReservation(width: number, height: number): number {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1920)) {
    throw new RangeError('Live previews require sources no larger than 1080p; use editing proxies.')
  }
  if (width * height > 1920 * 1080) throw new RangeError('Use editing proxies for larger sources.')
  // AVC may pad its coded frame to macroblock dimensions, including 1080→1088.
  return Math.ceil(width / 16) * 16 * Math.ceil(height / 16) * 16 * 4 * 2
}

export function monitorSurfaceReservation(frameBytes: readonly number[], quality: MulticamMonitorQuality): number {
  const { width, height } = MULTICAM_MONITOR_QUALITIES[quality]
  return frameBytes.reduce((sum, bytes) => sum + bytes, 0) + (frameBytes.length * 2 + 1) * width * height * 4
}

export function createMulticamMonitorPlan(definition: MulticamDefinition, instance: MulticamInstance, rate: FrameRate) {
  const planner = createMulticamPlanner(definition)
  return (projectFrame: number) => {
    if (!Number.isSafeInteger(projectFrame) || !rangeContains(instance.timelineRange, projectFrame)) return null
    const frame = instance.sourceStartFrame + projectFrame - instance.timelineRange.startFrame
    const activeAngleId = planner.select(frame).video.angleId
    return {
      frame, activeAngleId,
      angles: definition.angles.map((angle) => {
        const sourceFrame = multicamAngleSourceFrame(angle, frame)
        return { angleId: angle.id, assetId: angle.assetId, sourceFrame,
          sourceTimeUs: sourceFrame === null ? null : framesToMicroseconds(sourceFrame, rate) }
      }),
    }
  }
}

export interface MonitorHealthWindow {
  readonly durationMs: number
  readonly programFrames: number
  readonly programLatencyP95: number
  readonly programErrors: number
  readonly tileFrames: readonly number[]
  /** Attempts while covered; gaps and the active Program angle need no tile. */
  readonly tileExpectedFrames?: readonly number[]
  readonly tileLatencyP95: number
  readonly longTaskMs: number
  readonly longestTaskMs: number
  readonly audioHealthy: boolean
}
export function monitorHealthDecision(window: MonitorHealthWindow, baselineFps: number, baselineP95: number, projectFps: number, quality: MulticamMonitorQuality): 'continue' | 'reduce' | 'pause' {
  const fps = window.programFrames * 1000 / window.durationMs
  if (window.durationMs < 1000 || !Number.isFinite(baselineFps) || !Number.isFinite(baselineP95)
    || !Number.isFinite(fps) || !Number.isFinite(window.programLatencyP95)
    || baselineFps < Math.min(projectFps, 60) * .9
    || fps < baselineFps * .95 || window.programLatencyP95 > Math.min(50, baselineP95 + 8)
    || window.programErrors > 0 || !window.audioHealthy
    || window.longTaskMs > window.durationMs * .02 || window.longestTaskMs > 100) return 'pause'
  const target = MULTICAM_MONITOR_QUALITIES[quality].fps * .8
  if (!Number.isFinite(window.tileLatencyP95) || window.tileLatencyP95 > 200
    || window.tileFrames.some((frames, index) => window.tileExpectedFrames
      ? frames < (window.tileExpectedFrames[index] ?? Infinity) * .8
      : frames * 1000 / window.durationMs < target)) {
    return quality === 'normal' ? 'reduce' : 'pause'
  }
  return 'continue'
}
