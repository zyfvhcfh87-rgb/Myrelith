import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCell, terminalIsZero } from './decision.mjs'

function valid() {
  return { count: 2, durationMs: 5000, admission: { admitted: true },
    program: { fps: 30, latencyMs: { p95: 4 }, completions: 150, missing: 0, errors: 0 },
    startFrame: 30, endFrame: 180, audioClockSeconds: 5,
    audio: { rms: .02, scheduledThroughContextTime: 7, contextTime: 6 },
    tiles: { tiles: [{ fps: 10 }], latencyMs: { p95: 20 }, errors: [], events: [],
      peakWorker: { decoders: 1, estimatedFrameBytes: 1024, scratchBytes: 1024 }, peakPending: 1, surfaceBytes: 1024 },
    longTasks: { totalMs: 0, maxMs: 0 },
    cleanup: { durationMs: 10, forcedTermination: false,
      worker: { inputs: 0, lanes: 0, nativeDecoders: 0, nativeFrames: 0, createdNativeDecoders: 60, closedNativeDecoders: 60, estimatedFrameBytes: 0, scratchSurfaces: 0, scratchBytes: 0 },
      main: { workers: 0, pending: 0, canvasesWithPixels: 0, unclosedReceivedBitmaps: 0 } } }
}
test('requires an independently healthy paired baseline and complete evidence', () => {
  assert.equal(evaluateCell(valid(), valid()).passed, true)
  assert.equal(evaluateCell(valid(), null).passed, false)
  const baseline = valid(); baseline.program.fps = 20
  assert.equal(evaluateCell(valid(), baseline).passed, false)
  const cell = valid(); cell.program.latencyMs.p95 = null
  assert.equal(evaluateCell(cell, valid()).passed, false)
})
test('silent audio is valid, but missing or non-finite audio evidence is not', () => {
  const cell = valid(), baseline = valid()
  cell.audio.rms = 0; baseline.audio.rms = 0
  assert.equal(evaluateCell(cell, baseline).passed, true)
  cell.audio.rms = NaN
  assert.equal(evaluateCell(cell, baseline).passed, false)
})
test('fast average cannot conceal one stalled angle or missing audio scheduling', () => {
  const cell = valid(); cell.count = 4; cell.tiles.tiles = [{ fps: 12 }, { fps: 12 }, { fps: 0 }]
  assert.ok(evaluateCell(cell, valid()).failures.includes('tile-cadence'))
  cell.audio = null
  assert.ok(evaluateCell(cell, valid()).failures.includes('audio-underrun-or-missing'))
})
test('termination without acknowledgement cannot masquerade as observed zero ownership', () => {
  const cell = valid(); cell.cleanup.forcedTermination = true
  assert.equal(terminalIsZero(cell.cleanup), false)
  cell.cleanup.forcedTermination = false; cell.cleanup.worker.nativeFrames = 1
  assert.equal(terminalIsZero(cell.cleanup), false)
  assert.equal(terminalIsZero({ main: cell.cleanup.main }), false)
})
test('rejects drift, stale retirement, lost transfers and over-budget peaks', () => {
  for (const mutate of [
    (cell) => { cell.endFrame = 185 },
    (cell) => { cell.tiles.events.push('accounted-pressure') },
    (cell) => { cell.cleanup.main.unclosedReceivedBitmaps = 1 },
    (cell) => { cell.tiles.peakWorker.estimatedFrameBytes = 64 * 1024 * 1024 },
  ]) {
    const cell = valid(); mutate(cell)
    assert.equal(evaluateCell(cell, valid()).passed, false)
  }
})
