# Tracking Inspector, portable file, export and resource protocol

Status: **preregistered, not executed**. Parent accepted the corrected controller
`8cc1fe997688f541df0a19a9be41ddf5657550ed` and integrated it at
`08805c570fb60f739e3414e4d76eff861cc89343`. This document and the browser tests
belong to the subsequent Inspector slice. They are not evidence of browser
acceptance. The exact committed source will be recorded in the run evidence.

## First bounded browser run

The orchestrator must grant the exclusive slot before starting Chromium, a
server or export. Use this issue's private dependencies, one muted headless
Chromium, one Playwright worker, no retries, and strict port 5198. No external
windows, speakers or native file dialogs. No background benchmark or full suite.

From the issue198 worktree, after a clean source commit and focused checks:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --list
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts
```

The first command only discovers tests and can run before the slot. The second
runs exactly seven checks: the unchanged five static/open/held mask checks and
the following two tracking checks. Existing assertions, fixtures, no-retry
policy and pixel thresholds remain intact. Each new test has a 90-second ceiling.

| Flow | Required observations |
| --- | --- |
| Forward point | Real Inspector point picking at frame 0; production decoder/worker analysis of 32 video frames; 18 accepted samples followed by loss at frame 18; exact stop shown; same-source mask target; temporary actual Program pixels and unchanged project/history; preview exits/reenters accepted range; Apply adds only x/y with all 18 canonical local frames/source ticks; exactly one undo entry; exact undo/redo; old session disabled. |
| Portable file and export, in the point flow | Actual Save button download, production file parse, unchanged ordinary mask tracks, no runtime/cache identifiers; Projects/Open file input opens with missing media; history resets; actual Media Pool relink reconnects identical fixture bytes; Program pixels return; production export produces 1280x720 AVC with no audio, 32/30-second duration, decoded visible/masked probes at frames 0/17/31; output samples/VideoFrames/input/export are released. |
| Backward box | Real Inspector box picking at frame 17 and backward decoder analysis to frame 0; all 18 samples sorted only for ordinary key output, with exact target ticks; project-axis size/no rotation disclosure; four owned lanes; reference-frame box preserved; one Apply and exact undo/redo; fresh analysis after same-source Apply; complete-lane replacement consent; turning off size clears consent and names only x/y; abandoning review by changing attachment kind releases only tracking preview without changing the project. |

The source is a deterministic 160x90, 30 fps, silent AVC video with one-pixel
horizontal motion per frame and a full occlusion from frame 18. Its generator
is in `src/dev/issue198/maskTrackingFixture.ts`, outside production imports,
and uses the accepted issue-110 texture. Fixture creation calls the real media
import controller and document insertion operation; mask editing, source picking,
analysis, preview, Apply, Save, Open and relink use their actual UI. Undo/redo,
seeking, state inspection and export use existing app/store test interfaces.
Analysis, review, serialization, decoding and rendering are not mocked.

The probe at project pixel (584,350) lies inside the static mask and safely
outside its translated frame-17 left edge. Program RGB sum must exceed 30 when
visible and stay below 8 when masked. AVC RGB sum at the masked export probe
must stay below 36 (at most 12 average per channel), accounting for codec edge
noise. Export dimensions, duration, absence of audio and visible-frame probe
are checked independently. This is focused motion/mask parity, not a claim of
lossless codec output or whole-frame identity.

Native remembered file handles are deliberately unavailable in these tests.
The save/reopen result therefore qualifies the portable download/file-input path.
The portable file opens offline before explicit relink; it must not silently
depend on a live object URL. Native handle permission/persistence remains a
separate qualification.

## Resource evidence and teardown

After actual analysis and at each flow's end, the production analysis scheduler
must be idle with zero active jobs/decoder reservations; observed maxima must
remain within one job and one decoder. Worker diagnostics must show at least
one created worker, zero active workers and equal created/terminated counts.
The tests attach raw scheduler/worker snapshots and point/export pixel results.
These counters qualify scheduler and worker lifetimes. They do not measure
native decoder memory or prove absence of every native allocation.

The fixture closes its CanvasSource, finalizes or cancels Output and releases
both scratch canvases. Export inspection closes every VideoFrame and video
sample in finally blocks, disposes its Input and export controller, and releases
its sample canvas. Playwright closes each isolated page/context. The operator
must verify that Playwright exits and no issue5198 Vite listener or matching
Chromium child remains, then explicitly release the slot before editing.

Preserve the exact command, SHA, full output, trace/failure context, three new
tracking screenshots and all existing mask screenshots under a SHA-named
`.tmp/issue198-<sha>/` directory before another run. Inspect every produced
screenshot and record any UI overlap, clipping, console/page warning or error.
Never overwrite a failed run. A failed assertion stays a failure until traced
to source or independently demonstrated fixture error; no baseline claim
without unchanged-baseline reproduction where applicable.

## Later exclusive rendering and retention gate

The seven checks above do not close the issue's performance/retention criteria.
After their source/evidence review, request a separate slot for the matrix
already accepted in `docs/ISSUE_198_PLAN.md`:

- 720p, 1080p and 4K; rectangle, ellipse and Bezier paths with 1/4/8 cubics;
  feather 0, 5% and maximum; normal/inverse masks and partially off-canvas boxes.
- Static paths versus 256-key held paths at identical resolved values. Compare
  exact RGBA before encoding. Record cold/warm raw samples, p50/p95, dimensions,
  shape, vertices, feather, inverse and chosen key. Use deterministic repeated
  frame order and report held-key selection separately from mask pixel cost.
- Existing acceptance: 256-key held selection overhead below 1 ms p95; no 4K
  frame above the 10-second safety ceiling; exact retained scratch byte ledger
  below 256 MiB. These are boundedness checks, not a 4K realtime promise.
- A silent 300-frame held-path export, explicit cancel and retry, repeated
  under a quiet slot, with bounded geometry cache/scratch accounting and no
  retained growth after cleanup. Record every cancellation, terminal resource
  state and retry result; distinguish JS-owned counters from native memory.

Commit that executable measurement harness and its sampling/counting protocol
before running it. Do not infer this matrix from the two short tracking tests.
Full suite, production audit, generic animation-workspace integration and final
cross-feature acceptance also remain open under parent coordination.
