import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {qualificationRow, timingDecision, pairedDecision} from './r3-decisions.mjs';

test('frozen references compare without importing or executing the shader; hostile readbacks fail', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./r3-reference-v1.json', import.meta.url)));
  assert.equal(fixture.rows.length, 40);
  for (const row of fixture.rows) {
    const working = row.working.map(Number), view = row.viewCode10.map(v => Number(v) / 1023);
    assert.equal(qualificationRow(row, working, view).passed, true);
    assert.equal(qualificationRow(row, [...working.slice(0, 3), working[3] + .01], view).passed, false);
    assert.equal(qualificationRow(row, working, view.map(v => v + 2 / 1023)).passed, false);
    assert.equal(qualificationRow(row, working, [NaN, ...view.slice(1)]).passed, false);
  }
});

test('an incomplete or nonfinite timing cannot produce a full p95 or pass', () => {
  const rows = Array.from({length: 119}, () => ({totalMs: 1, deadlineMissed: false}));
  assert.equal(timingDecision('export', 1920, rows).p95Ms, null);
  assert.equal(timingDecision('export', 1920, rows).absoluteDecision, 'unqualified');
  rows.push({totalMs: NaN});
  assert.equal(timingDecision('preview', 1920, rows).absoluteDecision, 'unqualified');
});

test('fixed nearest-rank budgets retain failure and do not fabricate complete early p95', () => {
  const rows = Array.from({length: 120}, () => ({totalMs: 250, deadlineMissed: false}));
  assert.equal(timingDecision('export', 1920, rows).absoluteDecision, 'pass-necessary-stage-only');
  for (let i = 0; i < 7; i++) rows[i].totalMs = 251;
  assert.equal(timingDecision('export', 1920, rows).p95Ms, 251);
  const early = timingDecision('export', 1920, rows.slice(0, 7), 'seven-over-limit-samples-disprove-120-frame-p95');
  assert.equal(early.absoluteDecision, 'no-go-certificate'); assert.equal(early.p95Ms, null);
  const preview = Array.from({length: 120}, (_, i) => ({totalMs: 10, deadlineMissed: i < 2}));
  assert.equal(timingDecision('preview', 1920, preview).absoluteDecision, 'no-go');
});

test('paired ratio requires complete evidence and clean owners; passing a lower bound is qualified', () => {
  const member = time => ({outcome: 'completed', cleanupPassed: true,
    timing: timingDecision('export', 1920, Array.from({length: 120}, () => ({totalMs: time})))});
  assert.equal(pairedDecision(member(10), member(40), 'export').decision, 'pass-necessary-stage-only');
  assert.equal(pairedDecision(member(10), member(41), 'export').decision, 'no-go');
  assert.equal(pairedDecision(null, member(10), 'export').decision, 'unqualified-incomplete-pair');
  assert.equal(pairedDecision({...member(10), cleanupPassed: false}, member(10), 'export').decision, 'unqualified-incomplete-pair');
});
