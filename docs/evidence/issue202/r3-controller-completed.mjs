import {REPETITIONS} from './r3-ledger.mjs';
import {pairedDecision} from './r3-decisions.mjs';

export async function runR3() {
  const fixture = await (await fetch('./r3-reference-v1.json')).json();
  if (fixture.contract !== 'issue202-r3-resident-dissolve-v1' || fixture.rows.length !== 40) throw new Error('Unexpected fixture');
  const started = performance.now(), deadline = started + 600000;
  const counts = {created: 0, terminated: 0, active: 0};
  const result = {contract: fixture.contract, started: new Date().toISOString(), counts, jobs: [], pairs: [],
    qualification: 'Resident composition and SDR readback only; native GPU, complete renderer, HDR presentation, RSS and codecs unqualified.'};
  let abort = false;
  const progress = detail => console.log(`ISSUE202_R3 ${JSON.stringify(detail)}`);
  async function runJob(job) {
    if (abort || performance.now() >= deadline) { abort = true; return null; }
    const record = {job, startedRelativeMs: performance.now() - started, partialRows: []};
    result.jobs.push(record); progress({job, event: 'start'});
    let worker;
    try { worker = new Worker(new URL('./r3-worker-completed.mjs', import.meta.url), {type: 'module'}); }
    catch (error) { record.outcome = 'failed-worker-create'; record.error = String(error); abort = true; return record; }
    counts.created++; counts.active++;
    await new Promise(resolve => {
      let lastLedger = null, cancelSentAt = null, cancelTimer, settled = false;
      const finish = (message, forced = false) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(cancelTimer);
        Object.assign(record, message, {forcedTermination: forced, finishedRelativeMs: performance.now() - started});
        if (cancelSentAt !== null) {
          record.cancellationAckMs = performance.now() - cancelSentAt;
          record.cancellationPassed = !forced && record.result?.outcome === 'cancelled'
            && record.result.cleanupPassed && record.cancellationAckMs <= 250;
        }
        if (forced) { record.terminalOwnership = 'unknown'; record.lastKnownLedger = lastLedger; abort = true; }
        else if (!record.result?.cleanupPassed) { record.terminalOwnership = 'failed-drain'; abort = true; }
        else record.terminalOwnership = 'zero-owned-api-resources';
        // Termination is separate from an acknowledged owner drain.
        worker.terminate(); counts.terminated++; counts.active--; resolve();
      };
      const timer = setTimeout(() => finish({outcome: 'unqualified-run-timeout'}, true),
        Math.min(180000, Math.max(1, deadline - performance.now())));
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ledger') lastLedger = message.snapshot;
        if (message.type === 'owner-ready') record.preparedOwner = message;
        if (message.type === 'sample') record.partialRows.push(message.row);
        if (message.type === 'progress') progress({job, ...message});
        if (message.type === 'frame-start' && job.type === 'cancel' && cancelSentAt === null) {
          cancelSentAt = performance.now(); worker.postMessage({type: 'cancel'});
          cancelTimer = setTimeout(() => finish({outcome: 'no-go-cancel-timeout'}, true), 250);
        }
        if (message.type === 'done') finish({outcome: message.result.outcome, result: message.result});
        if (message.type === 'fatal') finish({outcome: 'failed-worker', error: message.error}, true);
      };
      worker.onerror = event => finish({outcome: 'failed-worker', error: event.message}, true);
      worker.onmessageerror = () => finish({outcome: 'failed-worker-message'}, true);
      worker.postMessage({type: 'run', job, fixture});
    });
    progress({job, event: 'terminal', outcome: record.outcome, terminalOwnership: record.terminalOwnership,
      measuredFrames: record.result?.rows?.length, timing: record.result?.timing, cancellationPassed: record.cancellationPassed});
    if (record.outcome === 'failed' || record.outcome === 'failed-cleanup') abort = true;
    return record;
  }
  const qualification = await runJob({type: 'qualify'});
  result.numericPassed = qualification?.result?.numericPassed === true && qualification.result.cleanupPassed;
  if (!result.numericPassed) {
    result.remaining = 'Skipped: Float32 shader and stored-view prerequisite did not qualify';
  } else {
    for (const [width, height] of [[1920, 1080], [3840, 2160]]) {
      for (const phase of ['preview']) for (let repetition = 0; repetition < REPETITIONS; repetition++) {
        if (abort) break;
        const pair = {width, height, phase, repetition, members: {}};
        result.pairs.push(pair);
        for (const kind of repetition % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
          const record = await runJob({type: 'measure', kind, width, height, phase, repetition});
          if (record) pair.members[kind] = result.jobs.indexOf(record);
          if (abort) break;
        }
        const member = kind => result.jobs[pair.members[kind]]?.result;
        pair.comparison = pairedDecision(member('baseline'), member('candidate'), phase);
      }
    }
    if (!abort) await runJob({type: 'cycles'});
    for (let repetition = 0; repetition < 5 && !abort; repetition++) await runJob({type: 'cancel', repetition});
    if (!abort) await runJob({type: 'context-loss'});
    result.remaining = abort ? 'Stopped after timeout, failure or incomplete drain; remaining work unmeasured'
      : 'All bounded jobs attempted; inspect individual no-go and unqualified cells';
  }
  result.elapsedMs = performance.now() - started;
  result.aborted = abort; result.fullProductDecision = 'not-qualified';
  return result;
}
