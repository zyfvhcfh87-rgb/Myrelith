import {GpuOwner} from './r3-gpu.mjs';
import {BaselineOwner} from './r3-baseline.mjs';
import {ImageLedger, WARMUP_FRAMES, MEASURED_FRAMES, FRAME_PERIOD_MS, earlyFailure} from './r3-ledger.mjs';
import {qualificationRow, timingDecision} from './r3-decisions.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let busy = false, cancelled = false;
const post = message => self.postMessage(message);
function checkCancel() {
  if (cancelled) { const error = new Error('Cooperative cancellation observed'); error.name = 'AbortError'; throw error; }
}

async function owned(kind, width, height, phase, fixture, ledger, body) {
  const owner = kind === 'candidate' ? new GpuOwner(ledger, width, height, phase) : new BaselineOwner(ledger, width, height, phase);
  const result = {kind, width, height, phase, outcome: 'running', plan: owner.plan};
  try {
    checkCancel(); await owner.init(fixture); checkCancel();
    result.setupMs = owner.setupMs; result.support = owner.support;
    post({type: 'owner-ready', setupMs: result.setupMs, support: result.support, plan: result.plan});
    await body(owner, result);
    result.outcome = 'completed';
  } catch (error) {
    result.outcome = error.name === 'AbortError' ? 'cancelled' : 'failed';
    result.error = {name: error.name, message: String(error), stack: error.stack};
    result.support ??= owner.support;
  } finally {
    try { owner.dispose(); } catch (error) { result.cleanupError = String(error); }
    result.ledger = ledger.snapshot();
    result.cleanupPassed = !result.cleanupError && result.ledger.liveBytes === 0 && result.ledger.live.length === 0;
    if (!result.cleanupPassed) result.outcome = 'failed-cleanup';
  }
  return result;
}

function qualify(owner, result, fixture) {
  result.rows = [];
  for (const frame of [0, 1, 59, 118, 119]) {
    checkCancel();
    const actual = owner.qualify(frame);
    for (const expected of fixture.rows.filter(row => row.frame === frame)) {
      result.rows.push(qualificationRow(expected, actual.working[expected.patch], actual.view[expected.patch]));
    }
  }
  result.numericPassed = result.rows.length === 40 && result.rows.every(row => row.passed);
  result.maximumWorkingRgbError = Math.max(...result.rows.map(row => row.maximumWorkingRgbError));
  result.maximumViewCodeError = Math.max(...result.rows.map(row => row.maximumViewCodeError));
}

async function measure(owner, result) {
  result.warmupFrames = 0; result.rows = [];
  for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
    checkCancel(); await owner.render(frame); result.warmupFrames++;
    if (frame % 10 === 0) post({type: 'progress', stage: 'warmup', frame});
    await delay(0);
  }
  const origin = performance.now();
  for (let frame = 0; frame < MEASURED_FRAMES; frame++) {
    const scheduled = origin + frame * FRAME_PERIOD_MS;
    if (result.phase === 'preview') {
      while (performance.now() < scheduled) { checkCancel(); await delay(scheduled - performance.now()); }
    }
    checkCancel(); post({type: 'frame-start', frame});
    const start = performance.now();
    const parts = await owner.render(frame);
    const complete = performance.now();
    const row = {frame, totalMs: complete - start, parts,
      startRelativeMs: start - origin, completionRelativeMs: complete - origin,
      scheduledStartMs: result.phase === 'preview' ? scheduled - origin : null,
      deadlineMs: result.phase === 'preview' ? scheduled + FRAME_PERIOD_MS - origin : null,
      deadlineMissed: result.phase === 'preview' && complete > scheduled + FRAME_PERIOD_MS};
    result.rows.push(row); post({type: 'sample', row});
    const certificate = earlyFailure(result.phase, result.width, result.rows);
    if (certificate) { result.certificate = certificate; break; }
    if (frame % 10 === 0) post({type: 'progress', stage: 'measurement', frame});
    await delay(0);
  }
  result.timing = timingDecision(result.phase, result.width, result.rows, result.certificate);
}

async function run(job, fixture) {
  const ledger = new ImageLedger(snapshot => post({type: 'ledger', snapshot}));
  if (job.type === 'qualify') return owned('candidate', 8, 1, 'qualification', fixture, ledger,
    (owner, result) => qualify(owner, result, fixture));
  if (job.type === 'measure') return owned(job.kind, job.width, job.height, job.phase, fixture, ledger, measure);
  if (job.type === 'cycles') {
    const cycles = [];
    for (let index = 0; index < 10; index++) {
      const cycle = await owned('candidate', 1920, 1080, 'preview', fixture, ledger, async (owner, result) => {
        result.parts = await owner.render(59);
      });
      cycles.push(cycle); post({type: 'progress', stage: 'lifecycle-cycle', index, outcome: cycle.outcome});
      if (!cycle.cleanupPassed || cycle.outcome !== 'completed') break;
      await delay(0);
    }
    return {cycles, ledger: ledger.snapshot(), cleanupPassed: ledger.snapshot().live.length === 0,
      outcome: cycles.length === 10 && cycles.every(cycle => cycle.outcome === 'completed') ? 'completed' : 'failed'};
  }
  if (job.type === 'cancel') return owned('candidate', 1920, 1080, 'export', fixture, ledger, async (owner, result) => {
    result.rows = [];
    for (let frame = 0; frame < MEASURED_FRAMES; frame++) {
      checkCancel(); post({type: 'frame-start', frame});
      const start = performance.now(), parts = await owner.render(frame);
      const row = {frame, totalMs: performance.now() - start, parts};
      result.rows.push(row); post({type: 'sample', row});
      await delay(0); checkCancel();
    }
    throw new Error('Cancellation request was not observed during the bounded draw loop');
  });
  if (job.type === 'context-loss') {
    const loss = await owned('candidate', 1920, 1080, 'preview', fixture, ledger, async (owner, result) => {
      await owner.render(59); owner.loseForTest(); await delay(0);
      try { await owner.render(60); result.rejectedAfterLoss = false; }
      catch (error) { result.rejectedAfterLoss = true; result.lossError = String(error); }
    });
    let retry = null;
    if (loss.cleanupPassed && loss.outcome === 'completed' && loss.rejectedAfterLoss) {
      retry = await owned('candidate', 8, 1, 'qualification', fixture, ledger,
        (owner, result) => qualify(owner, result, fixture));
    }
    return {loss, retry, ledger: ledger.snapshot(), cleanupPassed: ledger.snapshot().live.length === 0,
      outcome: loss.cleanupPassed && loss.rejectedAfterLoss && retry?.numericPassed && retry.cleanupPassed ? 'completed' : 'failed'};
  }
  throw new Error('Unreviewed R3 job');
}

self.onmessage = async event => {
  if (event.data.type === 'cancel') { cancelled = true; return; }
  if (event.data.type !== 'run' || busy) return;
  busy = true;
  try { post({type: 'done', result: await run(event.data.job, event.data.fixture)}); }
  catch (error) { post({type: 'fatal', error: {message: String(error), stack: error.stack}}); }
};
