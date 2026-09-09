import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_LIMIT, ImageLedger, imagePlan, nearestRank, earlyFailure} from './r3-ledger.mjs';

test('4K resident prototype fits only its declared surfaces and buffers', () => {
  assert.equal(imagePlan('candidate', 3840, 2160, 'export').peakBytes, 265420836);
  assert.equal(imagePlan('baseline', 3840, 2160, 'export').peakBytes, 199065600);
  assert.equal(imagePlan('candidate', 3840, 2160, 'export').allowed, true);
  const ledger = new ImageLedger();
  ledger.reserve('declared-candidate', 265420836, 'image');
  let allocationCalled = false;
  assert.throws(() => { ledger.reserve('extra-ping-pong', 3840 * 2160 * 8, 'texture'); allocationCalled = true; });
  assert.equal(allocationCalled, false);
  assert.equal(ledger.snapshot().liveBytes, 265420836);
  ledger.release('declared-candidate');
  assert.equal(ledger.snapshot().liveBytes, 0);
});

test('direct seven-surface float16 swap rejects without creating a resource', () => {
  const ledger = new ImageLedger();
  assert.equal(3840 * 2160 * 8 * 7, 464486400);
  assert.throws(() => ledger.reserve('direct-swap', 464486400, 'images'));
  assert.equal(ledger.snapshot().reservations, 0);
  assert.equal(ledger.snapshot().rejected.length, 1);
});

test('reservation identity, invalid counts and repeated cleanup cannot hide ownership', () => {
  const ledger = new ImageLedger();
  for (const bytes of [-1, NaN, Infinity, .5]) assert.throws(() => ledger.reserve('bad', bytes, 'image'));
  ledger.reserve('frame', 16, 'buffer');
  assert.throws(() => ledger.reserve('frame', 8, 'buffer'));
  assert.equal(ledger.release('frame'), true);
  assert.equal(ledger.release('frame'), false);
  assert.equal(ledger.snapshot().releases, 1);
  assert.equal(ledger.snapshot().liveBytes, 0);
});

test('upload allowance stays below1MiB and is not hidden beside export readback', () => {
  const plan = imagePlan('candidate', 3840, 2160, 'export');
  assert.equal(plan.setupExtraBytes, 983040);
  assert.ok(plan.setupExtraBytes <= 1024 * 1024);
  const ledger = new ImageLedger();
  ledger.reserve('resident', plan.residentBytes + plan.uniformBytes, 'images');
  ledger.reserve('upload', plan.setupExtraBytes, 'staging');
  ledger.release('upload');
  ledger.reserve('readback', plan.frameExtraBytes, 'buffer');
  assert.equal(ledger.snapshot().peakBytes, plan.peakBytes);
  assert.ok(ledger.snapshot().peakBytes <= IMAGE_LIMIT);
});

test('image plans reject malformed, oversized or unreviewed shapes', () => {
  for (const dimensions of [[0, 1], [NaN, 1], [1.5, 2], [20000, 1], [8192, 8192]]) {
    assert.throws(() => imagePlan('candidate', ...dimensions, 'preview'));
  }
  assert.throws(() => imagePlan('future', 1920, 1080, 'preview'));
});

test('early failure certificates cannot turn an incomplete run into measured p95', () => {
  const fast = {totalMs: 1, deadlineMissed: false};
  assert.equal(earlyFailure('preview', 1920, [{totalMs: 101, deadlineMissed: true}]), 'measured-preview-stall-over-100ms');
  assert.equal(earlyFailure('preview', 1920, [{...fast, deadlineMissed: true}]), null);
  assert.ok(earlyFailure('preview', 1920, Array(2).fill({...fast, deadlineMissed: true})));
  assert.equal(earlyFailure('export', 3840, Array(6).fill({totalMs: 1001})), null);
  assert.ok(earlyFailure('export', 3840, Array(7).fill({totalMs: 1001})));
  assert.equal(nearestRank([...Array(114).fill(1), ...Array(6).fill(1001)], .95), 1);
  assert.equal(nearestRank([...Array(113).fill(1), ...Array(7).fill(1001)], .95), 1001);
  assert.equal(nearestRank([], .95), null);
});
