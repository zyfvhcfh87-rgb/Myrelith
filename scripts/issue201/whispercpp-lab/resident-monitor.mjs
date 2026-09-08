import { createResidentCoverage, RSS_DELTA_CAP, RSS_MAX_GAP_MS } from '../whispercpp/resident-coverage.mjs'

/** Pure receipt owner. Browser epochs are separated only by a verified absence
 * receipt; model work must occur inside an active, continuously sampled epoch.
 */
export function createRuntimeResidentMonitor() {
  const memory = [], epochs = [], failures = []
  let current = null, firstBaseline = null, recordBudgetFailure = null
  const fail = (reason, detail) => {
    const failure = { reason, ...detail }
    failures.push(failure)
    return failure
  }
  return {
    memory, epochs, failures,
    begin(label, at) {
      if (current) throw new Error('A browser memory epoch is already active')
      current = { id: epochs.length + 1, label, openedAt: at, coverage: createResidentCoverage(), closed: null }
      epochs.push(current)
    },
    observe(sample, label = 'periodic') {
      if (!current) throw new Error('No active browser memory epoch')
      if (recordBudgetFailure) return recordBudgetFailure
      const report = current.coverage.observe(sample)
      const complete = !report.failures.includes('incomplete-process-coverage')
        && !report.failures.includes('invalid-rss') && !sample.error
      const bytes = complete ? sample.rss.reduce((sum, row) => sum + row[1], 0) : null
      const row = { ...sample, label, epoch: current.id, rssUnit: 'bytes', complete, bytes, coverage: report }
      memory.push(row)
      if (memory.length > 40_000) {
        recordBudgetFailure = fail('sample-record-budget', { at: sample.at })
        return recordBudgetFailure
      }
      if (firstBaseline === null && complete) firstBaseline = bytes
      if (report.failures.length) return fail(report.failures[0], { at: sample.at, epoch: current.id, coverage: report })
      if (sample.error) return fail('capture-error', { at: sample.at, epoch: current.id, error: sample.error })
      if (complete && bytes - firstBaseline > RSS_DELTA_CAP) {
        return fail('resident-ceiling-original-baseline', { at: sample.at, epoch: current.id, bytes, firstBaseline })
      }
      return null
    },
    close(receipt) {
      if (!current) return null
      const coverage = current.coverage.checkGap(receipt.at)
      current.closed = { ...receipt, coverage }
      const epoch = current.id
      current = null
      if (!Array.isArray(receipt.remaining) || receipt.remaining.length || receipt.verifiedAbsent !== true) {
        return fail('browser-absence-unverified', { at: receipt.at, epoch, receipt })
      }
      if (receipt.elapsedMs > RSS_MAX_GAP_MS || coverage.failures.length) {
        return fail('shutdown-sampling-gap', { at: receipt.at, epoch, receipt, coverage })
      }
      return null
    },
    snapshot() {
      return { firstBaseline, peak: Math.max(0, ...memory.filter(row => row.complete).map(row => row.bytes)),
        samples: memory.length, failures: failures.slice(),
        epochs: epochs.map(({ coverage, ...epoch }) => ({ ...epoch, coverage: coverage.snapshot() })),
        maximumActiveEpochGapMs: Math.max(0, ...epochs.map(epoch => epoch.coverage.snapshot().maxGap)),
        qualified: epochs.length > 0 && current === null && failures.length === 0
          && epochs.every(epoch => epoch.coverage.snapshot().qualified && epoch.closed?.verifiedAbsent),
        scope: 'Candidate work inside browser epochs. Browser launch and verified-absent reopen intervals are disclosed separately; no RSS or cadence claim for those intervals.' }
    },
  }
}
