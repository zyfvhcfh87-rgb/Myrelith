# R3 resident dissolve prototype protocol

Preparation authorized after the parent accepted R1 and bounded R2 as partial
evidence. **No R3 browser/shader/timing/lifecycle execution is authorized until
the concrete harness is committed and a fresh exclusive slot is granted.**
Existing equations, goldens, numeric thresholds and 256 MiB ceiling stay fixed.

## Narrow question and excluded prerequisites

Can a two-input, preinterpreted linear BT.2020 dissolve plus the frozen technical
SDR view meet the original stage budgets at 1920×1080 and 3840×2160, using a
bounded owned-image layout? This is a lower-complexity resident-buffer prototype,
not an implementation of the product's managed renderer. A failed necessary
stage can justify a bounded no-go. A passing lower-bound stage does not qualify
full playback/export or every feature that remains excluded below.

The paired SDR baseline calls the unchanged public `pipeline/render.ts`
`compositeFrame` facade with one explicit two-leg crossfade plan, two retained
SDR ImageBitmaps and caller-owned Canvas2D destination/leg/group surfaces. It
uses domain project/clip factories, no application/store/UI state. Static source
frames are borrowed across the awaited composite and closed only by their owner.
It is a cost baseline with matching composition topology, not pixel equality
between intentionally different color versions or a new SDR regression oracle.

Candidate inputs are already-associated linear BT.2020 RGBA16F buffers. A highp
GLSL ES3 shader evaluates complementary integer-frame weights; a second shader
reads the associated result over black and applies the unchanged R1 shoulder,
BT.2020→709 matrix and sRGB encoding. RGB sign/headroom survives through the
working target; the presentation is deliberately SDR. No old effect/ABI intent
is reinterpreted, and no production file imports this laboratory.

Retain as rejected/unqualified prerequisites, not silently completed features:
exact pre-view scopes fail after half storage; P3 canvas transfer changes pixels;
native GPU/WebGPU and physical HDR are unqualified on the observed SwiftShader
backend; complete source decode/chroma reconstruction/transfer conversion,
metadata/mastering and independent external codec validation are absent.
Lens/spatial filtering, real font rasterization, effects/LUTs, buses, nested
sequences, plugin execution and actual audio-master playback are not benchmarked.
The R1 fixed-mask/geometry math remains separate evidence. This session does no
codec work, source upload per video frame, HDR encode or media-file export.

## Reference before shader

`r3-make-reference.py` imports only the already-frozen independent Python
oracle. It freezes eight exact binary16-associated input patches from each
source, with alpha 0/.25/.5/1, signed channels and headroom through 8 working
units, and 40 exact expected compositions/views at frames 0/1/59/118/119.
The shader is authored after this reference commit and does not import the
oracle or expected values. It may use the independently implemented R1 candidate
matrix conversion to construct its uniform. Full-size inputs repeat the eight
patches on a 64-pixel checker grid; image upload precedes timing and is separately
recorded as setup cost. The baseline's SDR input swatches are frozen in the same
reference, with independent straight-RGB SDR-view mapping and 8-bit alpha.

Tiny 8×1 qualification tests all 40 cases before full-size timing. Require
fragment highp range/precision consistent with Float32, successful RGBA16F
framebuffer creation, no GL errors, and actual working/view Float32 readback.
View qualification uses a tiny RGBA16F view target, avoiding an 8-bit readback
that could hide the original 10-bit-code limit. Maximum continuous view error
must be ≤1 code on a 10-bit scale and alpha error ≤1/1023; working RGB error is
recorded separately. Any failing case blocks candidate timing and remains in
the result. This does not relax the prior binary16 scope failure.

## Pre-allocation ledger and static exclusions

Every owned image reservation precedes the corresponding allocation; rejection
must happen before creating the buffer/texture/canvas/bitmap. Named allocations
have exactly one owner; release is idempotent. The ledger records reservations,
rejected requests, peak/live bytes, object counts and terminal state. It tracks
API-format image storage and client buffers; opaque browser/driver duplication,
native codec/process memory and JS metadata are additional/unmeasured. Zero
owned bytes is not a claim of immediate native reclamation or measured RSS.

| Owner/phase | Admitted simultaneous image storage |
| --- | --- |
| Candidate resident | Two RGBA16F input textures + one RGBA16F working texture + one RGBA8 canvas output =28 bytes/pixel |
| Candidate setup upload | Resident storage + one reused full-width Float32 tile of at most 16 rows (≤1 MiB); release tile after completed upload |
| Candidate export-stage diagnostic | Resident storage + one reused full-frame RGBA8 readback =32 bytes/pixel; tiny uniform/probe buffers charged separately |
| Candidate tiny qualification | Tiny resident targets + one RGBA16F view target + Float32 working/view readback buffers, all explicitly charged |
| SDR baseline resident | Two RGBA8 ImageBitmaps + destination/leg/group Canvas2D surfaces =20 bytes/pixel |
| SDR baseline setup/export peak | Resident storage + either one source-paint canvas or one request-scoped RGBA8 readback =24 bytes/pixel |

At 4K, 32 bytes/pixel is 265,420,800 bytes (253.125 MiB), leaving a small fixed
allowance for separately charged tiny buffers; the upload tile is not live at
the same time as the full output readback. Baseline 24 bytes/pixel is 199,065,600
bytes (189.84375 MiB). No extra full-size ping-pong surface may be added implicitly.
The original seven-surface RGBA16F swap remains rejected at 464,486,400 bytes.
HDR/Float32 full-frame readback and full pipeline surface variants that exceed
the cap are recorded as no-go before allocation, not benchmarked over budget.

## Timing procedure and decisions

One representative scene: two associated image layers in a linear dissolve,
with transparent, signed and highlight patches, then opaque SDR view. At each
size, preview-stage and export-stage are distinct runs; compare SDR baseline
and candidate for three alternating repetitions, 30 warm-up and 120 measured
frames each. Use frames 0..119 and weight frame/119, restarting after warm-up.
No concurrent owners or benchmarks. Record every measured frame and setup cost.

Preview-stage timing includes composition/view plus a completion barrier (GL
finish for candidate; a tiny Canvas2D readback for baseline). Export-stage adds
full-frame final SDR byte readback; there is no codec or file output. GPU submit
times are distinguished from completion waits; only total completion time is
used for stage decisions. These are worker-stage timings and synthetic 30 fps
schedule deadlines, not physical monitor presentation or audio playback timing.

Original limits: preview p95 ≤33.33 ms, no >100 ms measured stall and ≤1% missed
synthetic deadlines; export-stage p95 ≤250 ms at 1080p or≤1000 ms at 4K, and ≤4×
paired SDR stage p95. Complete 120-frame runs use nearest-rank p95. A pass needs
all required samples, all three repetitions, paired evidence and prior numeric
qualification. An unqualified/incomplete row cannot become a pass.

To bound already-disproved cells, stop a preview run after one measured >100 ms
stall or two missed deadlines (even if all remaining frames met their deadlines,
2/120 exceeds 1%). For export, seven samples above the fixed absolute limit
mathematically disprove the 120-frame nearest-rank p95; record that early no-go
certificate rather than claiming a measured complete p95. Baseline evidence
must exist before evaluating a candidate's 4× ratio; alternating order may defer
that decision until its paired baseline finishes. No warm-up sample is used as
an acceptance failure. Hard per-run/whole-session timeouts produce partial rows
and explicit unqualified/forced termination, never accepted timing estimates.

## Lifecycle and cleanup evidence

After numeric qualification, use 1080p candidate owners for ten start/draw/stop
cycles, five export-stage cancellation requests, and context-loss rejection plus
a fresh-owner retry. No app audio or user media is created. Cancellation stops
new submissions at cooperative boundaries. The controlling page sends cancel
after a frame-start notice, measures time to terminal acknowledgement and
requires ≤250 ms with zero owned ledger. If the worker cannot acknowledge/drain,
terminate it, retain its last known ledger as unknown terminal ownership and
record cancellation no-go; never fabricate a zero ledger after forced teardown.

Any incomplete owner drain, nonzero terminal ledger or context failure stops
later operations until that worker/browser is closed. Context loss must reject
the current owner without fallback; a fresh separately admitted owner must pass
the tiny correctness check before reuse is claimed. Worker creation/termination
counts and browser/server teardown are recorded. The slot is released promptly
after teardown, before documentation/commit work.
