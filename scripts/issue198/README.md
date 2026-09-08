# Issue 198 resource measurement harness

Source preparation only. Parent review of the exact harness commit and an
exclusive grant for one segment are required before either command below runs.
The resource implementation checkpoint `d9759917d202c39b1faa0df91ea90adad3603218`
was accepted separately. This harness does not modify those production files.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-resource-gate.mjs --segment raster --expected-sha <reviewed-full-sha>
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-resource-gate.mjs --segment export --expected-sha <reviewed-full-sha>
```

Each command checks a clean exact SHA, refuses an occupied strict port (5198 by
default), creates a fresh owned `.tmp` output directory, and launches one muted
Chromium browser. The Mac runner owns a scoped `caffeinate -i -w <runner PID>`
child; it never changes power settings or developer selection. There is no
retry loop for a candidate run. The reusable process sampler may retry a
changing CDP process table internally, without rerunning a raster/export trial.

## Executable scope

- Raster: exactly 180 cells, six timed raster calls per cell, three exact
  full-RGBA comparisons at frames 0/127/255, and canonical path selection checks
  for every key 0..255. Each of three samples per variant retains its actual
  order and first/later classification. p95 is the maximum, not a stable tail
  estimate. The 10-second 4K check is applied after an invocation returns; the
  independent 90-second host cell deadline bounds a hung browser call.
- Resolver: 1,000 warmups and 5,000 timed calls through the canonical resolver,
  including defensive cache checks. All raw values survive a p95 ≥1 ms failure.
- Export: a production-imported 1280×720, 30 fps, silent 300-frame AVC fixture,
  whose uniform gray value is `128 + frame % 64`. Its mask has eight cubics,
  256 alternating held paths, feather 0.05, no inversion and full placement.
  The ordinary compatibility MP4/AVC profile uses 2 Mbps and audio off.
  Three cycles each run complete → cancel → retry. Cancellation is requested
  from the first production progress callback for 60 completed frames. The
  current generator publishes N/301, so the harness converts that exact
  contract, rather than treating progress as N/300.
- Complete outputs must contain 300 added frames, 1280×720 video, no audio and
  duration within one frame of 10 seconds. Actual decoded frames 0/127/255/299
  are compared over every RGB channel against a separately selected static
  mask applied to the decoded source frame and composited over black. Maximum
  channel delta ≤12 and mean channel delta ≤2 are preregistered lossy AVC
  tolerances for this grayscale fixture. Values are written before assertion.
  Each attempt includes a 120-second browser deadline and a 150-second host
  deadline. These thresholds require exact harness review before execution.

## Evidence and resource meaning

`evidenceStore.mjs` writes each event to an exclusive numbered JSON file and
fsyncs before acknowledging it. Writes serialize; close drains pending work
before producing the manifest. Every successful source/export is transferred in
bounded 64 KiB chunks, fsynced, finalized with an exact SHA-256 and retained as
an actual MP4. Failed partial binary files survive as `.part` with actual and
expected byte counts. A fresh run cannot overwrite an earlier run directory.
Each record is capped at 2 MiB, each binary at 128 MiB and the event stream at
20,000 records. Nonfinite failure values have an explicit JSON representation.

The export observer delegates to `startExport`, `exportTimeline` and the real
Mediabunny adapters. It counts actual source requests, opened/closed media and
frame leases, sink finalization/cancellation, completed frames, native canvas
extents, actual ImageData readback bytes between get/put (or composite failure),
and the real grading cache ledger. It does not replace pixel algorithms or
codecs. Logical scratch estimates from `videoPixelWorkBudget` carry a distinct
`modeledPixelWorkBytesPeak` field. Production media-source interfaces do not
expose private decoder allocation counters; these are explicitly unavailable,
not invented or inferred from a successful close callback. Closed sink canvases
are expected to be the actual 1×1 backing retained by their existing owner until
the harness releases its references. Peak live leases must equal one, actual
sink/transition surface bytes may not exceed three full RGBA surfaces, and peak
readback must equal exactly one full RGBA image. Composite and lease counts
must match completed encoded frames. These are the fixed single-clip fixture's
observable owner bounds, separate from hidden codec/driver storage.

The raster path records metrics emitted by the actual scratch allocator and
accounts separately for the harness's two input buffers. Those buffers end at
each cell. Temporary cached geometry follows the production WeakMap lifecycle;
no forced GC or duration-indexed retained geometry table is introduced.

Browser CDP and host OS process sampling record renderer/GPU provenance plus
sampled process memory at baseline, roughly one-second intervals, and export
boundaries. Missing/unstable native samples are marked unavailable. Sampled
peaks do not prove an exact allocation peak; browser/GPU process footprint is
not compared with the separate 256 MiB logical render allowance. No native leak
or real-time playback result is claimed by preparing this source.

## Bounded setup, teardown and source checks

Vite creation/listening, Chromium connection, CDP/context/page creation, evidence
bindings, initial navigation, timer provenance and cell enumeration each have a
30-second host deadline. Chromium connect also receives an explicit 30-second
Playwright timeout. Context action/navigation defaults and each of the five
export setup actions are bounded at 30 seconds. The existing raster/resolver,
fixture preparation and export measurement deadlines are unchanged. Export
fixture handle release has a 10-second deadline.

The driver records browser/descendant/CDP PIDs at launch, while sampling and
before close. Every owner close has a 10-second deadline. A stuck owned browser
server gets a separate 10-second forced close through Playwright's process
owner; unrelated captured PIDs are never killed. Both failures are recorded,
the first failure is preserved even if forced close succeeds, and later owners
still get their cleanup attempt. Signal-triggered forced close is also bounded
at 10 seconds and its rejection is handled.
The scoped awake child is terminated and awaited. Actual PID liveness and the
strict port must be clear within five seconds. The parent independently verifies
runner exit and physical slot release. After durable teardown and manifest
closure, a failed command explicitly exits with code 1 so leftover owner handles
cannot hold Node open. That exit does not certify descendant termination: any
remaining PID/port is retained as a teardown failure for parent verification.
Raw failures and a manifest remain even
when the candidate fails. `--expected-sha` is checked before launch and between
cells/attempts; browser console warnings/errors and page errors fail the segment.

Small source checks, which do not launch a browser or encode video:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx tsc -p scripts/issue198/tsconfig.json
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config scripts/issue198/vitest.config.ts --maxWorkers=2
DEVELOPER_DIR=/Library/Developer/CommandLineTools node --test scripts/issue198/evidenceStore.test.mjs scripts/issue198/runnerLifecycle.test.mjs
```

The first fixture gate passed 11 checks, including 32×32 actual raster equality
and durable ordering of an intentionally invalid clock sample. Initial driver
validation caught a missing closing brace before any tests/browser ran; after
correction the Node checks passed, including raw/partial evidence, exact hashes,
limits, source options and deadlines. Subsequent added concurrent-close proof
brings the original Node gate to eight checks. The runner correction adds two
owner lifecycle checks. One inert Node child stalls both close and forced close
while retaining a live interval: later cleanup completes, the command exits
itself with code 1, and raw JSON, partial binary bytes and exact manifest hashes
remain intact. Its 5 ms injected close deadlines are test-only; the actual
runner retains the deadlines above. All ten Node checks passed (306 ms), with
typecheck and lint passing. Full native execution remains pending.
