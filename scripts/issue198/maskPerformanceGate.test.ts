import { describe, expect, test, vi } from 'vitest'
import { parseMaskBezierPath } from '../../src/domain/maskPath'
import { cells, matrixFixture, matrixPath, measureCell, selectedPath, type EvidenceRecord } from './maskPerformanceGate'

describe('source-only measurement fixtures', () => {
  test('the fixed matrix has exactly 180 unique cells and all preregistered dimensions', () => {
    expect(cells).toHaveLength(180)
    expect(new Set(cells.map((cell) => JSON.stringify(cell))).size).toBe(180)
    expect([...new Set(cells.map(({ width, height }) => `${width}x${height}`))]).toEqual(['1280x720', '1920x1080', '3840x2160'])
  })
  test.each([1, 4, 8] as const)('%s-cubic fixtures are valid bounded closed paths', (segments) => {
    for (const inset of [0, 0.02]) {
      const path = matrixPath(segments, inset)
      expect(path.length).toBeLessThanOrEqual(2048)
      expect(parseMaskBezierPath(path)?.segments).toHaveLength(segments)
    }
  })
  test.each(['rectangle', 'ellipse', 1, 4, 8] as const)('all 256 keys select exact known values for %s', (shape) => {
    const cell = { width: 32, height: 32, shape, feather: 0.05, invert: false, offCanvas: false } as const
    const { clip, paths } = matrixFixture(cell), before = JSON.stringify(clip)
    expect(clip.animation!.effectPathTracks![0]!.keyframes).toHaveLength(256)
    for (let frame = 0; frame < 256; frame++) {
      expect(selectedPath(clip, paths, cell, frame)).toBe(typeof shape === 'number' ? paths[frame % 2] : paths[0])
      expect(clip.animation!.effectPathTracks![0]!.keyframes[frame]!.sourceTimeTicks).toBe(frame * 1_000_000)
    }
    expect(selectedPath(clip, paths, cell, 299)).toBe(typeof shape === 'number' ? paths[1] : paths[0])
    expect(JSON.stringify(clip)).toBe(before)
  })
  test('tiny actual raster pairs preserve every byte and publish owner release', async () => {
    const records: EvidenceRecord[] = []
    const result = await measureCell({ width: 32, height: 32, shape: 8, feather: 0.05, invert: true, offCanvas: true }, async (entry) => { records.push(entry) })
    expect(result.trials.map(({ frame, held }) => [frame, held])).toEqual([[0, false], [0, true], [127, true], [127, false], [255, false], [255, true]])
    const parity = records.filter((entry) => entry.kind === 'raster-parity')
    expect(parity).toHaveLength(3)
    expect(parity.every((entry) => entry.mismatches === 0 && entry.comparedBytes === 4096)).toBe(true)
    expect(result.perVariant.every((variant) => variant.samples === 3 && variant.p95 === Math.max(...result.trials.filter((trial) => trial.held === variant.held).map((trial) => trial.milliseconds)))).toBe(true)
    expect(records.at(-1)).toMatchObject({ kind: 'cell-released', retainedInputBytes: 0 })
  })
  test('a failing raw trial is emitted before failure and release rather than being discarded', async () => {
    const records: EvidenceRecord[] = []
    const timer = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(99)
    try {
      await expect(measureCell({ width: 32, height: 32, shape: 8, feather: 0, invert: false, offCanvas: false }, async (entry) => { records.push(entry) })).rejects.toThrow('Invalid raster clock')
      expect(records.map((entry) => entry.kind)).toEqual(['cell-start', 'raster-trial', 'cell-failed', 'cell-released'])
      expect(records[1]).toMatchObject({ milliseconds: -1, frame: 0 })
    } finally { timer.mockRestore() }
  })
})
