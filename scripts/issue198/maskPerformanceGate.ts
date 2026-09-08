/** Disposable source-only harness. Launch requires an exact reviewed commit. */
import { applyOrderedPixelEffectsToRgba, type PixelEffectWorkMetrics } from '../../src/domain/effectPixels'
import { createMaskEffect, maskParams } from '../../src/domain/effectStack'
import { resolveClipAnimationAtFrame } from '../../src/domain/clipAnimation'
import { parseMaskBezierPath } from '../../src/domain/maskPath'
import { defaultSourceTimeMap } from '../../src/domain/sourceTimeMap'
import { defaultClipTransform, defaultClipVisualSettings } from '../../src/domain/clipInspector'
import type { Clip } from '../../src/domain/schema'

type Shape = 'rectangle' | 'ellipse' | 1 | 4 | 8
export interface Cell {
  width: number; height: number; shape: Shape; feather: 0 | 0.05 | 1
  invert: boolean; offCanvas: boolean
}
export const cells: Cell[] = [
  [1280, 720], [1920, 1080], [3840, 2160],
].flatMap(([width, height]) => (['rectangle', 'ellipse', 1, 4, 8] as const).flatMap((shape) =>
  ([0, 0.05, 1] as const).flatMap((feather) => [false, true].flatMap((invert) =>
    [false, true].map((offCanvas) => ({ width, height, shape, feather, invert, offCanvas }))))))

export function matrixPath(segments: 1 | 4 | 8, inset: number): string {
  if (segments === 1) return `M ${inset} 0.5 C ${1 - inset} ${inset} ${1 - inset} ${1 - inset} ${inset} 0.5 Z`
  const radius = 0.5 - inset, step = Math.PI * 2 / segments, handle = 4 / 3 * Math.tan(step / 4)
  const number = (value: number) => Number(value.toFixed(6))
  const start = [number(0.5 + radius), 0.5]
  let value = `M ${start.join(' ')}`
  for (let index = 0; index < segments; index++) {
    const a = index * step, b = (index + 1) * step
    const p = [0.5 + radius * Math.cos(a), 0.5 + radius * Math.sin(a)]
    const q = index === segments - 1 ? start : [0.5 + radius * Math.cos(b), 0.5 + radius * Math.sin(b)]
    value += ` C ${[p[0] - radius * handle * Math.sin(a), p[1] + radius * handle * Math.cos(a), q[0] + radius * handle * Math.sin(b), q[1] - radius * handle * Math.cos(b), ...q].map(number).join(' ')}`
  }
  value += ' Z'
  if (parseMaskBezierPath(value)?.segments.length !== segments) throw new Error('Invalid matrix path')
  return value
}

export function matrixFixture(cell: Cell) {
  const paths = [matrixPath(typeof cell.shape === 'number' ? cell.shape : 4, 0), matrixPath(typeof cell.shape === 'number' ? cell.shape : 4, 0.02)]
  const effect = createMaskEffect('matrix-mask', typeof cell.shape === 'number' ? 'bezier' : cell.shape)
  Object.assign(effect.params, { path: paths[0], x: cell.offCanvas ? -0.35 : 0, y: cell.offCanvas ? -0.2 : 0,
    width: cell.offCanvas ? 1.3 : 1, height: cell.offCanvas ? 1.1 : 1, feather: cell.feather, invert: cell.invert })
  const clip: Clip = { id: 'matrix-clip', name: 'Matrix', assetId: 'matrix-asset', sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 300 }, timelineRange: { startFrame: 0, durationFrames: 300 },
    sourceTimeMap: defaultSourceTimeMap(0, 300), transform: defaultClipTransform(), visual: defaultClipVisualSettings(),
    opacity: 1, volume: 1, effects: [] }
  clip.effects = [effect]
  clip.animation = { tracks: [], effectTracks: [], effectPathTracks: [{ effectId: effect.id, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1,
    keyframes: Array.from({ length: 256 }, (_, frame) => ({ frame, sourceTimeTicks: frame * 1_000_000, value: paths[frame % 2], easing: { type: 'hold' as const } })),
  }] }
  return { clip, paths }
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!
}
function fill(rgba: Uint8ClampedArray): void {
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = (offset / 4) % 251
    rgba[offset + 1] = (offset / 4 * 7) % 253
    rgba[offset + 2] = 173; rgba[offset + 3] = 255
  }
}

export type EvidenceRecord = Readonly<Record<string, unknown>>
export type RecordEvidence = (record: EvidenceRecord) => Promise<void>
export const RASTER_FRAMES = [0, 127, 255] as const
export const RASTER_ABORT_MS = 10_000
export const HELD_SELECTION_P95_MS = 1

export function selectedPath(clip: Clip, paths: readonly string[], cell: Cell, frame: number): string {
  const resolved = resolveClipAnimationAtFrame(clip, frame)
  const expected = typeof cell.shape === 'number' ? paths[Math.min(255, Math.max(0, frame)) % 2]! : paths[0]!
  if (resolved.effects[0]!.params.path !== expected) throw new Error(`Held key mismatch at ${frame}`)
  return expected
}

/** One cell, with durable observation boundaries between every timed invocation. */
export async function measureCell(cell: Cell, record: RecordEvidence) {
  const { clip, paths } = matrixFixture(cell), pixels = cell.width * cell.height
  const trials: { frame: number; held: boolean; order: number; milliseconds: number; metrics: PixelEffectWorkMetrics }[] = []
  const buffers = [new Uint8ClampedArray(pixels * 4), new Uint8ClampedArray(pixels * 4)]
  const geometry = { surfaceWidth: cell.width, surfaceHeight: cell.height, projectWidth: cell.width, projectHeight: cell.height }
  let scratchBytesPeak = 0
  try {
    const selections = Array.from({ length: 256 }, (_, frame) => ({ frame, path: selectedPath(clip, paths, cell, frame) }))
    await record({ kind: 'cell-start', cell, keyCount: clip.animation!.effectPathTracks![0]!.keyframes.length,
      selections, inputBytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0) })
    for (const [index, frame] of RASTER_FRAMES.entries()) {
      const resolved = resolveClipAnimationAtFrame(clip, frame)
      const expected = { ...clip.effects[0]!, params: { ...clip.effects[0]!.params, path: selectedPath(clip, paths, cell, frame) } }
      for (const variant of index % 2 ? [1, 0] : [0, 1]) {
        const buffer = buffers[variant]!, effect = variant ? resolved.effects[0]! : expected
        fill(buffer)
        const metrics: PixelEffectWorkMetrics = { maskScanlineEdgeTests: 0, maskDistanceSamples: 0 }
        const began = performance.now()
        applyOrderedPixelEffectsToRgba(buffer, [{ kind: 'mask', params: maskParams(effect) }], geometry, metrics)
        const milliseconds = performance.now() - began
        const trial = { frame, held: variant === 1, order: trials.length, variantSample: index,
          sampleClass: index === 0 ? 'first-variant-call' : 'later-variant-call', milliseconds, metrics }
        trials.push(trial)
        scratchBytesPeak = Math.max(scratchBytesPeak, metrics.ownedScratchBytesPeak ?? 0)
        // Persist the raw failing sample before checking its threshold.
        await record({ kind: 'raster-trial', cell, ...trial,
          inputBytes: buffers.reduce((sum, value) => sum + value.byteLength, 0), scratchBytesPeak })
        if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid raster clock sample')
        if (cell.width === 3840 && milliseconds > RASTER_ABORT_MS) throw new Error('4K raster exceeded the 10-second abort ceiling')
        if ((metrics.maskInsideScratchPixelsPeak ?? 0) > pixels || (metrics.maskDistanceScratchPixelsPeak ?? 0) > pixels) throw new Error('Mask scratch exceeded surface area')
      }
      let mismatches = 0, maximumChannelDelta = 0, firstMismatch: number | null = null
      for (let offset = 0; offset < buffers[0]!.length; offset++) {
        const delta = Math.abs(buffers[0]![offset]! - buffers[1]![offset]!)
        if (delta) { mismatches++; firstMismatch ??= offset; maximumChannelDelta = Math.max(maximumChannelDelta, delta) }
      }
      await record({ kind: 'raster-parity', cell, frame, comparedBytes: buffers[0]!.byteLength,
        mismatches, maximumChannelDelta, firstMismatch })
      if (mismatches) throw new Error(`RGBA mismatch at ${firstMismatch}`)
    }
    const perVariant = [false, true].map((held) => {
      const values = trials.filter((trial) => trial.held === held).map((trial) => trial.milliseconds)
      return { held, samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) }
    })
    const result = { cell, trials, perVariant, scratchBytesPeak,
      harnessOwnedBufferBytes: pixels * 8, harnessPeakAccountedBytes: pixels * 8 + scratchBytesPeak }
    await record({ kind: 'cell-complete', ...result })
    return result
  } catch (cause) {
    await record({ kind: 'cell-failed', cell, trials, error: cause instanceof Error ? cause.message : String(cause) })
    throw cause
  } finally {
    // The harness owns these input bytes; no module-level buffer/cache survives a cell.
    buffers.forEach((buffer) => buffer.fill(0))
    buffers.length = 0
    await record({ kind: 'cell-released', cell, retainedInputBytes: 0,
      maskScratchLifetime: 'Call scoped; actual allocation peaks are in each raster trial.' })
  }
}

/** Canonical resolver including defensive cache checks, with all raw timings. */
export async function measureHeldSelection(record: RecordEvidence) {
  const { clip, paths } = matrixFixture({ width: 1280, height: 720, shape: 8, feather: 0.05, invert: false, offCanvas: false })
  for (let index = 0; index < 1_000; index++) resolveClipAnimationAtFrame(clip, index * 73 % 300)
  const milliseconds: number[] = []
  let checksum = 0
  try {
    for (let index = 0; index < 5_000; index++) {
      const frame = index * 73 % 300
      const began = performance.now(), resolved = resolveClipAnimationAtFrame(clip, frame)
      milliseconds.push(performance.now() - began)
      const expected = paths[Math.min(255, frame) % 2]!
      if (resolved.effects[0]!.params.path !== expected) throw new Error(`Resolver changed at ${frame}`)
      checksum += expected.length
    }
  } catch (cause) {
    await record({ kind: 'held-selection-failed', calls: milliseconds.length, milliseconds, checksum,
      error: cause instanceof Error ? cause.message : String(cause) })
    throw cause
  }
  const result = { calls: milliseconds.length, warmups: 1_000, milliseconds,
    p50: quantile(milliseconds, 0.5), p95: quantile(milliseconds, 0.95), checksum }
  await record({ kind: 'held-selection', ...result })
  if (milliseconds.some((value) => !Number.isFinite(value) || value < 0) || result.p95 >= HELD_SELECTION_P95_MS) throw new Error('Canonical held selection p95 is not below 1 ms')
  return result
}
