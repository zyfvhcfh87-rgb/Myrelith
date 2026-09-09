import { bounded } from './runnerLifecycle.mjs'

const errorText = (cause) => cause?.stack ?? String(cause)
async function stdoutReceipt(value) {
  const json = JSON.stringify(value)
  const line = Buffer.byteLength(json) <= 32_768 ? json : JSON.stringify({ kind: 'diagnostic-partial-receipt', truncated: true,
    prefix: Buffer.from(json).subarray(0, 15_000).toString('utf8') })
  await new Promise((accept) => process.stdout.write(line + '\n', accept))
}

/** Diagnostic-only deadlines; the accepted shared fsync store remains unchanged. */
export function diagnosticEvidence(store, { directory, writeMs = 5000, closeMs = 10_000, fallbackMs = 1000, emitFallback = stdoutReceipt } = {}) {
  let failure, acknowledged = 0, fallbackReceipts = 0, closed = false
  const snapshot = () => ({ directory, acknowledgedRecords: acknowledged, fallbackReceipts, closed,
    partial: failure !== undefined, error: failure === undefined ? null : errorText(failure) })
  const fallback = async (receipt) => {
    fallbackReceipts++
    await bounded(Promise.resolve().then(() => emitFallback({ kind: 'diagnostic-partial-receipt', ...snapshot(), receipt })), fallbackMs, 'Diagnostic stdout fallback').catch(() => {})
  }
  const record = async (value) => {
    if (failure !== undefined) throw failure
    try {
      await bounded(Promise.resolve().then(() => store.record(value)), writeMs, 'Diagnostic durable record')
      acknowledged++
    } catch (cause) {
      failure = cause
      await fallback({ kind: 'evidence-write-failed', attemptedRecord: value, error: errorText(cause) })
      throw cause
    }
  }
  const receipt = async (value) => {
    try { await record(value) }
    catch { await fallback(value) }
  }
  const close = async () => {
    try { await bounded(Promise.resolve().then(() => store.close()), closeMs, 'Diagnostic evidence closure'); closed = true }
    catch (cause) {
      failure ??= cause
      await fallback({ kind: 'evidence-close-failed', outcome: 'failed-incomplete', error: errorText(cause) })
      throw cause
    }
  }
  return { record, receipt, close, snapshot, get failure() { return failure } }
}

/** A failed or stalled record must still reach the actual owner cleanup callback. */
export async function runWithDiagnosticEvidence(evidence, work, cleanup) {
  let failure, teardown = {}
  try { await work() }
  catch (cause) {
    failure = cause
    await evidence.receipt({ kind: 'diagnostic-run-failed', error: errorText(cause) })
  }
  try { teardown = await cleanup(failure) }
  catch (cause) { failure ??= cause; teardown = { cleanupError: errorText(cause), physicalReleaseUnverified: true } }
  failure ??= teardown.failure ?? evidence.failure
  const { failure: _cleanupFailure, ...details } = teardown
  await evidence.receipt({ ...details, kind: 'diagnostic-run-teardown',
    outcome: failure !== undefined ? 'failed-incomplete' : 'observations-collected', error: failure === undefined ? null : errorText(failure), evidence: evidence.snapshot() })
  failure ??= evidence.failure
  try { await evidence.close() } catch (cause) { failure ??= cause }
  return { failure, evidence: evidence.snapshot() }
}
