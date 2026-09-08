import {MEASURED_FRAMES, nearestRank} from './r3-ledger.mjs';

export function qualificationRow(expected, actualWorking, actualView) {
  const working = expected.working.map(Number), view = expected.viewCode10.map(Number);
  const finite = actualWorking.length === 4 && actualView.length === 3
    && [...actualWorking, ...actualView].every(Number.isFinite);
  const workingErrors = working.map((value, i) => Math.abs(value - actualWorking[i]));
  const viewErrors = view.map((value, i) => Math.abs(value - actualView[i] * 1023));
  return {frame: expected.frame, patch: expected.patch, expectedWorking: working, actualWorking,
    expectedViewCode10: view, actualViewCode10: actualView.map(value => value * 1023), finite,
    maximumWorkingRgbError: Math.max(...workingErrors.slice(0, 3)), alphaError: workingErrors[3],
    maximumViewCodeError: Math.max(...viewErrors),
    passed: finite && workingErrors[3] <= 1 / 1023 && viewErrors.every(error => error <= 1)};
}

export function timingDecision(phase, width, rows, certificate = null) {
  const complete = rows.length === MEASURED_FRAMES;
  const valid = rows.every(row => Number.isFinite(row.totalMs) && row.totalMs >= 0);
  const total = rows.map(row => row.totalMs);
  const p95Ms = complete && valid ? nearestRank(total, .95) : null;
  const p50Ms = complete && valid ? nearestRank(total, .5) : null;
  const maximumMs = rows.length && valid ? Math.max(...total) : null;
  const deadlineMisses = rows.filter(row => row.deadlineMissed).length;
  const absoluteLimitMs = phase === 'preview' ? 33.33 : width === 1920 ? 250 : 1000;
  const withinAbsoluteLimits = complete && valid && p95Ms <= absoluteLimitMs
    && (phase !== 'preview' || (maximumMs <= 100 && deadlineMisses / MEASURED_FRAMES <= .01));
  return {complete, measuredFrames: rows.length, p50Ms, p95Ms, maximumMs, deadlineMisses, absoluteLimitMs,
    certificate, absoluteDecision: certificate ? 'no-go-certificate' : !complete || !valid ? 'unqualified'
      : withinAbsoluteLimits ? 'pass-necessary-stage-only' : 'no-go'};
}

export function pairedDecision(baseline, candidate, phase) {
  const b = baseline?.timing, c = candidate?.timing;
  if (!baseline?.cleanupPassed || !candidate?.cleanupPassed || baseline.outcome !== 'completed' || candidate.outcome !== 'completed'
      || !b?.complete || !c?.complete || b.p95Ms === null || c.p95Ms === null || b.p95Ms <= 0) {
    return {ratio: null, decision: 'unqualified-incomplete-pair'};
  }
  const ratio = c.p95Ms / b.p95Ms;
  return {ratio, ratioLimit: phase === 'export' ? 4 : null,
    decision: c.absoluteDecision !== 'pass-necessary-stage-only' || (phase === 'export' && ratio > 4)
      ? 'no-go' : 'pass-necessary-stage-only'};
}
