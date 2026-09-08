# R3 harness prepared for review

No R3 browser, shader, performance or native lifecycle experiment has run.
This commit makes the bounded experiment reviewable; execution still requires
a fresh exclusive slot. The prior readback slot is released.

## Frozen reference and exact scope

Reference/protocol commit: `d6f5c36b3fbefd24fc756520b5ad0eb3f4a7c5d0`.
Its five-file `r3-reference-freeze-v1.json` predates shader authorship and locks
40 independent Decimal reference compositions/views. Neither the shader nor
the baseline imports expected values. `r3-harness-manifest.json` binds the
prepared sources, compiled baseline source closure, dependency manifests and
preparation evidence. The runner requires an unchanged, clean committed branch
and verifies these identities before opening a browser.

One resident two-image dissolve is repeated at 1920×1080 and 3840×2160. The
candidate has two associated RGBA16F inputs, one RGBA16F working target and one
SDR output. Explicit highp samplers/arithmetic and Float32 uniforms are authored
but await real shader compilation/readback qualification. The baseline uses
unchanged `compositeFrame`, pure document/clip factories, one explicit crossfade
plan and retained SDR ImageBitmaps. It measures the public compositor at matching
topology; it does not exercise project transition planning or ordinary playback.
The baseline keeps the existing `{colorSpace: 'srgb'}` Canvas2D settings.

The eight source patches repeat on a 64-pixel grid. Upload/bitmap setup completes
before timing and is recorded separately. Full video decode/upload, actual
display delivery, audio, effects, scopes, plugins, lens/spatial filtering,
text rasterization, buses, nested sequences and HDR codecs remain outside this
lower-bound experiment. Baseline and candidate colors have different intentional
render versions; no pixel equality or new SDR regression claim is made.

## Admission and terminal ownership

`r3-ledger.mjs` reserves storage before allocation. All allocation keys have one
owner. The upload tile is released after completed upload before admitting an
export readback. The 4K candidate's planned peak is **265,420,836 bytes**
(253.125 MiB plus 36 uniform bytes); baseline peak is **199,065,600 bytes**
(189.84375 MiB), under the unchanged 268,435,456-byte ceiling.

The ledger covers API-format images and reachable client buffers. It does not
measure opaque driver/browser copies, GC timing, native process memory or RSS.
Zero ledger means successful owned-resource release calls and dropped owned
buffers. Worker termination and awaited browser teardown are distinct evidence.
No immediate native reclamation is asserted. The rejected seven-surface 4K16F
layout remains 464,486,400 bytes and is never allocated.

Candidate export reuses one byte readback; Canvas2D returns a new request-scoped
ImageData each time. Both are charged. Admission/notification overhead during a
baseline readback is inside its total completion time. Intermediate GL submission
durations are CPU submission measures; the total includes `finish` or full byte
readback. Preview deadlines are a synthetic 30 fps worker schedule, separate
from the application's audio clock and physical presentation.

`r3-worker.mjs` drains each awaited draw before its `finally` cleanup. Partial
initialization also reaches cleanup. The controller records each sample and
last known ledger; a forced worker termination preserves unknown terminal
ownership and stops further jobs. It never substitutes a zero ledger for an
unacknowledged drain. Browser/server close is awaited before the runner returns.
Native cleanup, cancellation response and context recovery have not been tested.

## Prepared execution bounds

1. One tiny 8×1 shader qualification: all 40 frozen cases, working/view readback,
   finite values, view error ≤1 continuous 10-bit code and alpha error ≤1/1023.
   Any failed prerequisite stops full-size work. Working RGB error is recorded.
2. At most 24 serial timing runs: two sizes × preview/export × three alternating
   baseline/candidate pairs, each with 30 warm-up and 120 measured frames.
3. If qualification and cleanup allow: ten 1080p start/draw/stop cycles, five
   1080p export-stage cancellations, one context-loss rejection and a fresh-owner
   tiny qualification retry. Cancellation acknowledgement must be within 250 ms
   with zero owned ledger; otherwise retain a no-go or unknown terminal result.

Unchanged timing thresholds: preview p95 ≤33.33 ms, no measured >100 ms stall,
≤1% synthetic deadline misses; export-stage p95 ≤250 ms at 1080p or ≤1000 ms at
4K, and ≤4× its complete paired SDR baseline. Only full 120-frame runs receive
a complete nearest-rank p95. Early preview stall/two-miss and seven-over-limit
export certificates mathematically disprove a limit; they do not invent p95.
Three complete repetitions are needed for a passing necessary-stage result.
The result always keeps full-product qualification separate.

Hard watchdogs: 180 seconds per job, 600 seconds for the controller experiment,
650 seconds for the page evaluation. Setup/launch and awaited teardown are
additional. A hard timeout is incomplete evidence, never a performance estimate.
No other owner is started after a failed drain or forced termination. Timing
rows are retained in the controlling page; if the entire page becomes unavailable,
the runner can retain console progress only and explicitly reports a session
failure. No exact unreported terminal ledger is inferred.

The prepared command below is **not authorization**. It may be invoked only after
the orchestrator grants this committed harness a fresh slot, using a fresh output
filename inside this evidence directory. Port 5202 is exclusive; Chromium uses
headless mode and the additional `--mute-audio` flag. The runner records actual
GPU/backend, browser version and available command-line information. It disables
automatic dependency discovery and serves only for the isolated laboratory.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE202_R3_SLOT=granted \
  node docs/evidence/issue202/run-r3.mjs \
  /Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue202/docs/evidence/issue202/r3-run-1.json
```

## Preparation evidence and retained exclusions

`r3-preparation-check-1.json` records **10/10 pure Node tests**, independent
reference reproduction (40 cases / 21,601 bytes), rejection of an ungranted
runner invocation before launch, and Vite 8.1.2 static compilation of the
controller plus worker. The compiled production closure is 72 files, all in
domain/pipeline; their hashes are recorded. The build writes no bundle to disk
and executes no browser/GPU code. Scoped oxlint, JavaScript syntax, evidence
integrity and diff checks pass. Product build/full suites were not repeated;
their earlier evidence remains separate.

These checks do not make the shader numerically correct. They do not validate
native allocations, resources after context loss, cancellation, timings or
physical HDR. The measured R2 backend was ANGLE/SwiftShader, not native M5 GPU
qualification. The exact binary16 scope-bin failure, P3 float16 canvas transfer
changes, absent WebGPU adapter, and incomplete mastering/independent decoder
evidence remain explicit prerequisites. No threshold, old golden, production
source, dependency, schema, plugin ABI, UI or SDR behavior is changed.

R4 will map all six issue criteria to actual evidence, explicit no-go, unsupported
or unmeasured status. Passing this narrower stage cannot remove those exclusions.
