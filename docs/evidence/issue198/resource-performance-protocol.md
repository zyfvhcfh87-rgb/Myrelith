# Proposed resource and performance measurement protocol

Status: **executable harness review checkpoint, not an execution grant or completed
measurement**. Parent accepted resource source `d9759917d202c39b1faa0df91ea90adad3603218`
after independent review and the unchanged three-case spatial reproduction.
The separate harness and precise executable thresholds are described in
[scripts/issue198/README.md](../../../scripts/issue198/README.md). Its exact
commit still requires review before launch. The ignored staging draft remains
historical; focused fixture tests do not qualify a native run.

## Source and run identity

Use one muted Chromium worker, one owned strict port, no retries, and a scoped
awake assertion only for the command's lifetime. The parent owns the exclusive
heavy slot and any launch permission. Before launch record UTC/monotonic time,
clean source SHA, source/config/fixture hashes, Node/Chromium/OS/architecture,
viewport/output dimensions, browser launch arguments and timer granularity.
Reject source drift and dirty source not explicitly frozen in the grant.

Capture browser/renderer/GPU process identity and supported memory provenance.
Missing native fields receive an explicit unavailable reason. Logical buffer
accounting is a separate field; do not substitute it for process/native memory,
force garbage collection or monkeypatch typed-array allocation.

Write actual JSON files for every sample/cell immediately, including incomplete
or failed cells, before moving on. Preserve first failures and every raw timing;
successful attachment metadata is insufficient. Final summaries must reference
those bytes and their hashes. Stop on first numeric, pixel, owner, console or
timeout failure. Keep the original run directory on every outcome.

## Raster matrix and held selection

Proposed matrix: 180 unique cells, from three outputs (1280×720, 1920×1080,
3840×2160), five shapes (rectangle, ellipse, 1/4/8 cubic Bezier), three feather
values (0, 0.05, 1), inversion off/on and on-canvas/partly off-canvas placement.
Two valid paths alternate through all 256 held keys. Rectangle/ellipse preserve
those dormant path keys. Canonical source ticks and the real public resolver
select frames 0, 127 and 255.

For each frame compare every RGBA byte from the canonical held result against
an independently selected static path. Alternate pair order. Input filling and
buffer allocation occur outside timed raster calls. Retain six raw trials per
cell, their execution order and allocation metrics, with separate static/held
statistics. Three samples per variant do not establish stable tail latency:
nearest-rank p95 is the maximum. Label first versus subsequent samples without
claiming a fresh BrowserContext for either one.

The confirmed safety ceiling is 10 seconds per 4K raster invocation, checked
after that synchronous call returns. A separate 90-second host cell deadline
closes a hung candidate. This is an abort ceiling, not a real-time playback
promise. All 256 canonical held selections are checked for every cell; the
parent confirmed that raster parity remains at 0/127/255, rather than expanding
to 256 full raster pairs per cell. Raw trials and failures are durably written
before a threshold throws.
The harness itself owns two RGBA inputs, separately reported from renderer
surfaces and actual mask scratch.

Held resolution uses the actual `resolveClipAnimationAtFrame`, including its
defensive validation/cache checks: 1,000 warmups and 5,000 deterministic seeks
over frames 0..299, raw per-call timings and checksum. Proposed acceptance is
p95 below 1 ms, without subtracting estimated timer overhead. Validate cell
uniqueness, cubic counts, 256 keys, known static selection and durable failure
recording with small focused fixtures before requesting the heavy slot.

## Production export, cancellation and retry

Proposed scene: silent 300-frame 1280×720 source, one 8-cubic Bezier mask with
256 alternating held paths, feather 0.05, full-canvas placement, no inversion.
Use the production export path with actual decoded output checks. Run complete
export → cancel at the first production progress event at or above frame 60 →
complete retry, three times. Expected outcomes: six complete outputs and three
observed cancellations. The progress event and actual last completed frame are
recorded separately; cancellation timing must not be inferred from sleep.

Await export resource cleanup before starting the next attempt. Record real
owner baseline/peak/settled snapshots, actual progress, cancellation result,
decoder/worker/lease closure and elapsed time. Preserve project/history equality.
Decode completed outputs at held-key boundaries 0/127/255 and the final frame;
persist bytes/hashes and actual pixel/error values. A byte-length-only output
check cannot qualify the result. The executable profile is compatibility
MP4/AVC, 2 Mbps, 30 fps, audio off. Decoded-source/static-mask reference parity
requires maximum RGB delta ≤12 and mean RGB delta ≤2 for the grayscale fixture.
The browser attempt deadline is 120 seconds, host deadline 150 seconds. Sink
canvases must reach their real 1×1 released extents, leases/media must close
exactly, live sink/composite/readback counters and grading bytes/ports must be
zero. Complete attempts add exactly 300 frames; cancellation adds exactly 60.
Peak live leases must equal one, peak observed canvases stay within three full
RGBA surfaces, and peak readback equals one full RGBA image. Completed-frame,
composite and opened-lease counts must agree.
Private decoder allocation counters remain explicitly unavailable through the
current production interface; actual process snapshots are separate evidence.

The later renderer admission exercise must also cover full versus small clipped
4K masks, no lens versus differing lens source sizes, retained source growth and
shrink, mask-before-spatial/reverse order, grading within versus outside a stack,
plugins, nested masks, exact cap and one byte above, cancellation and retry. The
current small recording-provider tests already establish logical boundaries;
they are not the native measurement result.

## Teardown and qualification

Close the browser and server, await child exit and release the scoped awake
assertion. Preserve process tables and prove every captured PID plus the strict
port is gone. Report timings, functional parity, logical ownership and measured
native memory as distinct findings. Parent independently verifies physical slot
release. Any unrun segment remains open; the accepted seven-flow tracking gate
does not qualify these later source changes or resource measurements.
