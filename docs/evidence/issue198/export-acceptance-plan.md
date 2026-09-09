# Remaining export acceptance: proposed control and lifecycle gates

Status: **plan for review, not a replacement predicate or execution grant**.
Production remains `d9759917d202c39b1faa0df91ea90adad3603218`. The parent accepted
the complete immutable diagnostic in `45118dfaa1b3d9be9ee7886d21849ff939fc4ec5`.
Its actual tested source was `1ae6baedf4e9788836e566cd58541fc459d702ee`.

The [original export](export-attempt1/results.md) remains failed/incomplete:
maximum RGB error 19 exceeds its frozen limit 12. Its mean error
0.06854926215277778 meets the unchanged mean limit 2. Neither that record nor
the original runner, profile or tolerance constants will be rewritten.

The [diagnostic](diagnostic-attempt2/results.md) establishes exact source
selection and exact unencoded compositor RGB at frame 127. Its 45 channels
above 12 occur outside mask coverage in the saved encoded output. This supports
a codec-sensitive explanation but does not isolate encoder versus decoder or
prove quality at other frames. Raising 12 to the observed 19 would merely fit
the failed observation; it is not the proposed remedy.

## A. One independent codec control, before further production exports

Prepare a separate bounded control driver and obtain exact-source review before
requesting one native grant. It may encode **one 300-frame control video**.
It uses only the existing pinned `source.mp4` and `export-complete-0.mp4`; their
sizes and hashes remain those in the immutable diagnostic protocol. It must not
regenerate the source fixture or run the application export controller.

Decode all 300 saved source samples in ordinal order. Select each static mask
path independently as `paths[min(frame, 255) % 2]`; do not resolve an animated
clip or call the production compositor. Apply the unchanged canonical static
mask raster to those decoded pixels. Multiply RGB by coverage over black, then
set output alpha to 255 before putting that ImageData into the control canvas.
Keep coverage only in the separate comparison oracle. This avoids inadvertently
applying alpha twice or encoding a coverage-label buffer.

Send those opaque canvas frames directly to Mediabunny `CanvasSource` and
`Output`. Match the actual production sink configuration: MP4, AVC, 2,000,000
bits/s, variable bitrate, keyframe interval 2 seconds, 1280×720, exact 30 fps,
frame timestamp `n/30`, duration `1/30`, no audio, and sRGB main context. Record
requested settings and observable actual stream/codec/color metadata. The
original *source generator's* one-second keyframe interval is not the output
sink's two-second interval and must not be copied accidentally.

Record the opaque pre-encode RGBA hash for all 300 control frames. Decode the
control and original saved output ordinally through their 300 samples, retaining
pixels only at 0/127/255/299. Record exact ordinal timestamps/durations and full
RGBA hashes; use the same decoded-source/static oracle for both outputs. Report
maximum/mean error, full histograms, coverage regions and capped coordinates.
Preserve both the original max-12 outcome and the control's max-12 outcome.

The strongest classification result is exact decoded RGB equality between the
independent control and the original output at all four target frames, with
the frame-127 error signature reproduced. If it differs, retain the observations
and stop for review. No automatic relative tolerance, retries, alternative
encoder settings, fallback codec or expansion of target frames is allowed.
This is a falsifiable control comparison, not a promise that encoding is
deterministic. A control that itself exceeds mean 2 cannot establish acceptable
output quality even if it resembles the production result.

Proposed bounds: one encoding/300 submitted frames, 900 public ordinal sample
requests (three 300-frame reads), four targets per stream, no sparse reads,
no production composite. Consume frames with backpressure and close every
sample/selected VideoFrame. At most 64 MiB of caller-owned RGBA arrays; mask
scratch, native canvas/codec storage and encoded target memory remain explicitly
separate. Use the existing 128 MiB binary evidence limit and at most 1,024 JSON
records of at most 2 MiB, reserving terminal records. The binary evidence cap is
not a claim about private encoder memory. Browser evaluation 120 seconds, host
evaluation 150 seconds, each decode/hash/add/finalize wait bounded explicitly
in reviewed source; setup and cleanup keep their existing separate bounds.
Stop at the first structural, owner, quality-mean, console, deadline or control
identity failure after recording it. No automatic native retry.

After that one result, commit its original bytes and exact hashes. Parent review
must accept both the interpretation and the proposed predicate below before
source preparation promotes the control artifact into a pinned input.

## B. Proposed acceptance predicate, conditional on A and explicit review

| Concern | Proposed evidence and predicate |
| --- | --- |
| Mask correctness | Every completed production composite must have exact RGB equality with the static oracle built from the same borrowed decoded input, before `sink.addFrame`. Record integer source/plan frame and selected held path. |
| Codec-sensitive quality | Completed production outputs must match the accepted independent control's decoded RGB exactly at 0/127/255/299, with correct ordinal times, dimensions, duration and no audio. Retain the existing absolute mean-error limit 2 against the unencoded oracle. |
| Historical max-12 check | Continue computing and reporting it as a separate legacy result. A failed legacy maximum is never relabelled passed; the replacement does not claim that maximum-12 quality was achieved. |
| Ownership and cancellation | Preserve every existing production lease/sink/readback/surface/grading/project/history requirement and the real progress-driven cancellation boundary. |

The rationale for the proposed encoded comparison is zero additional error
against a separately constructed, accepted codec control, coupled with exact
pixels *before* the codec. It does not derive a larger absolute error allowance
from the failed export. Black/missing output or wrong paths cannot pass the
pre-encode equality and control comparison. Encoder nondeterminism that breaks
exact control equality remains a failure needing review; it is not grounds to
introduce a tolerance during execution. These are proposed criteria only.

## C. Actual production completion, cancellation and retry

Use a successor harness so the original failed runner remains reproducible.
Reuse the original saved source and the reviewed control; do not create another
source video. Prepare the same 300-frame scene with 256 alternating held paths,
8-cubic mask, feather 0.05, full placement and unchanged production profile.

Run the original three cycles of **complete → cancel at 60 → complete retry**:
six finalized 300-frame outputs, three cancellations after exactly 60 frames,
and 1,980 completed composites/source leases in total. A retry is an explicit
member of that frozen lifecycle sequence, not an automatic retry of a failure.
Cancellation is requested from the first production progress event representing
60 completed frames using the actual `n/(300+1)` convention. No sleeps.

Wrap the existing public production dependency seams to borrow the actual
decoded input and inspect the actual completed sink canvas before encoding.
The matching-input oracle and its temporary arrays must finish and release
inside that frame's lease. They do not issue another decode/source request,
alter the sink pixels or mutate the document. A pre-encode mismatch is recorded
before it prevents `addFrame`. Preserve first-failure cleanup in that case.

Record all progress and real resource owners. Complete/cancelled frames,
composites and opened/closed leases must agree; peak live lease equals one.
Exactly one sink finalization or cancellation occurs as appropriate. Every
attempt awaits cleanup before the next starts; actual canvases reach 1×1,
live readback/sink/composite/lease and grading bytes/ports settle to zero,
and project/history identity is unchanged. The extra oracle/readback owner is
reported separately from the production sink's existing one-frame readback
and three observed canvas envelope, and must be zero after every frame.

Decode each complete output ordinally through 300 frames for exact metadata
and the four pinned target comparisons. This replaces ambiguous sparse lookup;
it does not increase the number of quality targets. Read the accepted control
once through 300 frames and retain its four target images. The proposed public
work cap is 4,080 source/sample requests: 1,980 production source requests,
1,800 completed-output ordinal samples and 300 control samples. Internal
decoder prefetch and application import/metadata work are distinct and must
not be represented as those public requests. Keep a 64 MiB aggregate cap on
all caller-owned oracle/comparison RGBA arrays, including retained control
targets; wipe frame-local arrays before releasing their source lease.
Keep existing 120-second browser/150-second host bounds per attempt and a
1,500-second whole-run host evaluation ceiling. Setup and teardown remain
separately bounded. Preserve the shared store's 20,000-record/
2 MiB-record/128 MiB-binary limits and the diagnostic's bounded record/closure
and stdout-partial handling. Private codec queues are never equated with the
logical surface ledger or process RSS.

Required before any encoding: source-only fixture/guard/cleanup tests, exact
command and count manifest, immutable input/control pins, explicit observer
array cap, typecheck/lint, parent source/protocol approval and a fresh exclusive
grant. No product rendering change is justified by the current evidence.
