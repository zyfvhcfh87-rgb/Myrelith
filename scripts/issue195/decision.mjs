/** Fixed research thresholds. These decisions never enter product imports. */
export function terminalIsZero(cleanup) {
  const worker = cleanup?.worker, main = cleanup?.main
  return Boolean(worker && main && !cleanup.forcedTermination
    && Number.isSafeInteger(worker.createdNativeDecoders) && worker.createdNativeDecoders >= 0
    && worker.createdNativeDecoders === worker.closedNativeDecoders
    && ['inputs', 'lanes', 'nativeDecoders', 'nativeFrames', 'estimatedFrameBytes', 'scratchSurfaces', 'scratchBytes'].every((key) => worker[key] === 0)
    && ['workers', 'pending', 'canvasesWithPixels', 'unclosedReceivedBitmaps'].every((key) => main[key] === 0))
}
export function evaluateCell(cell, baseline) {
  const failures = []
  const require = (condition, reason) => { if (!condition) failures.push(reason) }
  require(Boolean(baseline) && baseline.program.fps >= 27, 'unhealthy-or-missing-baseline')
  require(cell.durationMs >= 5000, 'measurement-too-short')
  require(cell.admission?.admitted === true, 'not-admitted')
  require(cell.program.fps >= (baseline?.program.fps ?? Infinity) * .95, 'program-cadence')
  const latency = cell.program.latencyMs.p95, baselineLatency = baseline?.program.latencyMs.p95
  require(Number.isFinite(latency) && Number.isFinite(baselineLatency) && latency <= 50 && latency <= baselineLatency + 8, 'program-latency')
  require(cell.program.completions > 0 && cell.program.missing / cell.program.completions <= .01 && cell.program.errors === 0, 'program-errors-or-missing')
  require(Number.isFinite(cell.audioClockSeconds) && Math.abs(cell.endFrame - cell.startFrame - cell.audioClockSeconds * 30) <= 2, 'audio-clock-progress')
  require(Boolean(cell.audio) && cell.audio.rms > .001 && cell.audio.scheduledThroughContextTime >= cell.audio.contextTime, 'audio-underrun-or-missing')
  require(cell.tiles?.tiles.length === cell.count - 1 && cell.tiles.tiles.every((tile) => tile.fps >= (cell.fallback ? 4 : 8)), 'tile-cadence')
  require(Number.isFinite(cell.tiles?.latencyMs.p95) && cell.tiles.latencyMs.p95 <= 200, 'tile-age')
  require(cell.longTasks.totalMs <= cell.durationMs * .02 && cell.longTasks.maxMs <= 100, 'responsiveness')
  require(cell.tiles?.errors.length === 0 && cell.tiles.events.length === 0, 'wall-error-or-retirement')
  require(cell.tiles?.peakWorker.decoders <= cell.count - 1 && cell.tiles.peakPending <= cell.count - 1, 'decoder-or-queue-budget')
  require(cell.tiles?.peakWorker.estimatedFrameBytes + cell.tiles.surfaceBytes * 2 + cell.tiles.peakWorker.scratchBytes <= 64 * 1024 * 1024, 'accounted-memory')
  require(terminalIsZero(cell.cleanup) && cell.cleanup.durationMs <= 1000, 'terminal-cleanup')
  return { passed: failures.length === 0, failures }
}
