import test from 'node:test';
import assert from 'node:assert/strict';
import {GpuOwner as OriginalGpuOwner} from './r3-gpu.mjs';
import {GpuOwner} from './r3-gpu-completed.mjs';
import {ImageLedger} from './r3-ledger.mjs';

function fake(owner, {failReadback = false} = {}) {
  const trace = [], state = {pending: false, reads: []};
  owner.drawWorking = () => { state.pending = true; trace.push('working'); };
  owner.drawView = () => { trace.push('view'); };
  owner.checkError = label => { trace.push(label); };
  owner.gl = {RGBA: 6408, UNSIGNED_BYTE: 5121,
    finish: () => { trace.push('flush-only'); },
    readPixels: (x, y, width, height, format, type, buffer) => {
      trace.push('readback');
      assert.deepEqual([x, y, format, type], [0, 0, 6408, 5121]);
      assert.equal(buffer.byteLength, width * height * 4);
      if (failReadback) throw new Error('simulated native readback failure');
      state.pending = false; state.reads.push({width, height, bytes: buffer.byteLength});
    }};
  return {trace, state};
}

test('negative control leaves finish-only work pending; corrected preview returns after one-pixel readback', async () => {
  const before = new OriginalGpuOwner(new ImageLedger(), 8, 1, 'preview');
  const old = fake(before); await before.render(59);
  assert.equal(old.state.pending, true); assert.deepEqual(old.state.reads, []);
  const ledger = new ImageLedger(), owner = new GpuOwner(ledger, 8, 1, 'preview'), corrected = fake(owner);
  owner.completionProbe = owner.allocate('gpu.completionProbe', 4, 'rgba8-completion-probe', () => new Uint8Array(4), () => {});
  try {
    await owner.render(59);
    assert.equal(corrected.state.pending, false);
    assert.deepEqual(corrected.state.reads, [{width: 1, height: 1, bytes: 4}]);
    assert.ok(corrected.trace.indexOf('readback') > corrected.trace.indexOf('view'));
    assert.equal(ledger.liveBytes, 4);
  } finally { owner.dispose(); }
  assert.equal(ledger.liveBytes, 0); assert.equal(owner.completionProbe, null);
});

test('readback failure rejects the frame and owned cleanup releases the charged probe', async () => {
  const ledger = new ImageLedger(), owner = new GpuOwner(ledger, 8, 1, 'preview'); fake(owner, {failReadback: true});
  owner.completionProbe = owner.allocate('gpu.completionProbe', 4, 'rgba8-completion-probe', () => new Uint8Array(4), () => {});
  try { await assert.rejects(owner.render(59), /simulated native readback failure/); }
  finally { owner.dispose(); }
  assert.equal(ledger.liveBytes, 0); assert.equal(ledger.snapshot().live.length, 0);
});

test('setup waits for an initial returned composition and charges the preview probe before use', async t => {
  t.mock.method(OriginalGpuOwner.prototype, 'init', async function () { this.support = {}; this.setupMs = 0; });
  const ledger = new ImageLedger(), owner = new GpuOwner(ledger, 3840, 2160, 'preview'), {state} = fake(owner);
  try {
    await owner.init({});
    assert.equal(state.pending, false); assert.equal(state.reads.length, 1);
    assert.equal(ledger.snapshot().live[0].bytes, 4);
    assert.match(owner.support.completion.setup, /returned through readPixels/);
    assert.ok(owner.setupMs >= 0);
  } finally { owner.dispose(); }
  assert.equal(ledger.liveBytes, 0);
});

test('export setup reuses its existing full readback without adding another probe buffer', async t => {
  t.mock.method(OriginalGpuOwner.prototype, 'init', async function () {
    this.support = {}; this.setupMs = 0;
    this.readback = this.allocate('gpu.readback', 32, 'rgba8-readback', () => new Uint8Array(32), () => {});
  });
  const ledger = new ImageLedger(), owner = new GpuOwner(ledger, 8, 1, 'export'), {state} = fake(owner);
  try {
    await owner.init({});
    assert.deepEqual(state.reads, [{width: 8, height: 1, bytes: 32}]);
    assert.equal(owner.completionProbe, undefined); assert.equal(ledger.liveBytes, 32);
  } finally { owner.dispose(); }
  assert.equal(ledger.liveBytes, 0);
});
