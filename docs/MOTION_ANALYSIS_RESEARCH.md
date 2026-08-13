# Motion analysis, stabilization, tracking, and lens-correction research

Issue: [#44](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/44)
Date: 2026-08-11
Status: research complete; product behavior and portable schemas unchanged

## Decision summary

| Track | Decision | Boundary / next issue |
|---|---|---|
| Shared analysis jobs + disposable cache | Go | [#108](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/108) implements the decoded-frame, worker, scheduler, provenance, OPFS, and stale-result foundation. |
| Similarity stabilization | Go, bounded | [#109](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/109) may implement translation + rotation + uniform-scale stabilization with visible strength/crop trade-offs. Affine, perspective, mesh, rolling-shutter, depth, and AI methods remain out. |
| Point tracking | Go, bounded | [#110](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/110) may implement forward/backward patch tracking with explicit confidence and loss. |
| Similarity-box tracking | Go, bounded | #110 may add box translation + uniform scale from consistent interior patches. Rotation/deformation and semantic tracking remain out. |
| Manual lens parameter model | Model validated; renderer not yet authorized | [#111](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/111) must prove source-space preview/export parity and performance before any implementation issue is opened. |
| Camera/lens profile catalog | No-go now | Identity ambiguity, licensing, update provenance, offline behavior, and silent-download policy are unresolved. No catalog or profile download is proposed. |

The umbrella deliberately does not ship an editor button, document field,
effect descriptor, production analysis cache, or renderer. The executable code
is a build-unreferenced feasibility harness, pure bounded numeric contracts,
and deterministic fixtures.

## Evidence basis

The runtime boundary follows the [W3C WebCodecs specification](https://w3c.github.io/webcodecs/):
decoded frames may retain scarce system resources, RGBA extraction is available
through `VideoFrame.copyTo()`, and ownership ends with `close()`. Disposable
persistence uses the origin bucket reached through
`navigator.storage.getDirectory()`, as defined by the
[WHATWG File System Standard](https://fs.spec.whatwg.org/).

The experiment is intentionally classical and explainable:

- the local registration/search shape is grounded in
  [Lucas and Kanade's image-registration paper](https://idl.uw.edu/living-papers-paper/lucas-kanade/);
- feature selection uses a bounded minimum-eigenvalue score based on
  [Shi and Tomasi's *Good Features to Track*](https://users.cs.duke.edu/~tomasi/papers/shi/TR_93-1399_Cornell.pdf);
- inconsistent matches are rejected by deterministic hypotheses/refinement in
  the spirit of [Fischler and Bolles' RANSAC](https://doi.org/10.1145/358669.358692);
- the selected similarity model is one of the explicit global-motion families
  documented by [OpenCV's video-stabilization module](https://docs.opencv.org/4.12.0/d4/d2c/group__videostab__motion.html);
- the lens vocabulary and monotonic/bijective warning follow
  [OpenCV's camera-calibration model](https://docs.opencv.org/master/d9/d0c/group__calib3d.html).

No third-party runtime library, model, WASM payload, network request, or media
upload was added.

## Shared job and ownership model

```text
UI status/control
      │ serializable facts only
      ▼
app analysis controller ── MediaJobScheduler (1 job / 1 decoder)
      │                              │
      │ generation + AbortSignal     └─ bounded diagnostics only
      ▼
dedicated analysis worker ── pure grayscale analysis
      │
      └─ staged OPFS sidecar (future #108; never project truth)
```

### Reviewed resource envelope

| Resource | Limit | Rationale |
|---|---:|---|
| Active motion jobs | 1 | Expensive analysis must not compete with another motion job. Existing selected/visible/background ordering and aging remain reusable. |
| Reserved decoders | 1 | A motion job opens at most one sequential visual decoder. |
| Live decoded `VideoFrame`s | 1 | Extract bounded grayscale data, then close immediately in `finally`; no decoded frame crosses into React, Zustand, or OPFS. |
| Analysis dimensions | 320 × 180 | Fixed CPU/memory envelope; source/project coordinates are carried separately. |
| Frames per retained window | 300 | At most 17,280,000 grayscale bytes at the maximum geometry. Longer work advances overlapping bounded windows. |
| Retained analysis buffers | 32 MiB | Each grayscale view starts at offset zero and covers its complete backing buffer, so accounting cannot hide a larger pinned allocation; typed result paths are much smaller. |
| Features per frame | 64 | Deterministic corner selection with minimum spacing. |
| Patch/search radii | 2 / 6 px | A 5×5 patch and ±6 px bounded search at analysis resolution. |
| Robust hypotheses | 256 per pair | Algorithm v3 spreads the deterministic cap across the complete unordered-pair rank space, followed by inlier refinement. |
| Cache entries/result | 1,024 / 256 MiB | Strict manifest and per-entry denial-of-service bound. |
| Cache target/headroom | 512 MiB / 128 MiB | LRU aims below 70% origin usage when estimates exist; unavailable estimates never become false quota promises. |

The feasibility worker is terminated for cancellation; this makes cancellation
observable even while synchronous numeric code owns its worker event loop. The
controller acquires its single shared admission slot before any support probe or
scheduler construction and rejects an overlapping invocation with the typed
`resource-unavailable` result. Separate callers therefore cannot each create a
private one-job scheduler and exceed the controller-wide worker/decoder envelope.
Dedicated module-worker support is declared only after the loaded worker answers
an explicit version-local `probe` request with its matching `ready` reply. An
asynchronous module-load error, message failure, synchronous post failure, or
five-second timeout reports the worker unsupported and terminates the probe.
An admitted run also threads cancellation through readiness probing, so abort
terminates a pending probe immediately and releases the shared admission slot.
The disposable `VideoFrame.copyTo()` readback uses the same bounded five-second
support-step deadline and races the admitted run's signal. Abort or timeout uses
one idempotent owner to close the frame before the caller settles and admission
is released. The original readback promise stays observed after that boundary,
so a late resolve or rejection cannot create an unhandled promise, re-close the
frame, or change successful diagnostics. Grayscale frames are accepted only as
zero-offset `Uint8Array` views over their complete backing allocation; oversized
zero-offset and nonzero-offset views reject before retained-byte accounting.
The admitted research worker treats both runtime `error` and response
`messageerror` events as typed `unexpected` failures. Both events converge on
the same idempotent terminal owner, which removes every worker/signal listener,
terminates and balances diagnostics before settlement, and releases scheduler
and controller-wide admission for a retry. Late competing worker events cannot
settle or mutate diagnostics again.
OPFS capability probing also treats removal of its temporary file as part of the
support contract: a failed `removeEntry()` resolves to a cleanup-specific
unsupported result rather than escaping the probe, starting analysis, or being
counted as a successful removal. The injected failure regression preserves the
created-versus-removed diagnostic mismatch so cleanup uncertainty stays visible.
Every invocation owns a distinct origin-wide temporary name with a 128-bit
Web Crypto nonce, so overlapping calls or tabs cannot remove, overwrite, or
invalidate another probe's file. Each invocation removes only its owned name.
The complete OPFS chain is raced against both the admitted run's `AbortSignal`
and one non-resetting five-second deadline, including when a caller supplies no
signal. A signal that wins first returns `AbortError`; a deadline that wins first
reports a distinct timed-out support failure and releases shared admission
through the normal typed `resource-unavailable` path. Neither terminal result
waits for a stalled `getDirectory`, `getFileHandle`, `createWritable`, `write`,
`close`, `getFile`, or `removeEntry`, and normal completion clears the same timer
and optional abort listener. The abandoned operation remains privately observed,
checks its terminal reason between steps, closes any writer that arrives late,
and removes only its owned name when the pending browser promise settles. That
late continuation cannot publish successful created/removed diagnostics after
its caller has settled. A non-aborted removal failure still produces the named
cleanup-specific unsupported result; cancellation or deadline expiry never
reclassifies uncertain cleanup as support.
The product child must also abort the decoder/source/storage owner and await
scheduler/storage quiescence. Queued pre-abort, active abort, typed failure,
successful completion, replacement, source removal, clip removal, project
replacement, and final disposal all converge on the same rules:

1. invalidate the generation before awaiting;
2. abort or terminate the active owner;
3. close the current frame and decoder/input;
4. remove any staged uncommitted cache file;
5. release the scheduler slot;
6. reject every late progress/result/store mutation;
7. recheck source, clip, generation, and controller lifecycle after any cache
   commit and roll it back if one changed.

### Typed terminal results

The shared product vocabulary must distinguish `unsupported-runtime`,
`unsupported-codec`, `source-offline`, `source-replaced`, `resource-limit`,
`decode-readback`, `low-confidence`, `scene-cut`, `target-lost`,
`storage-unavailable`, `storage-quota`, `storage-corrupt`, `cancelled`, and
`unexpected`. Cancellation is not a failure toast; low confidence and scene
cuts are expected footage outcomes and must explain the last accepted frame.

## Analysis-cache provenance

The proposed schema-1 root is `myrelith-derived/analysis-cache-v1`. An entry is
fresh only when every field below still matches:

- opaque local-project binding and stable asset id;
- sampled SHA-256 original fingerprint (same byte-sampling authority as the
  proxy workflow), original size, and last-modified value;
- exact video-stream index, dimensions, reduced rational rate, signed source
  range, and sampling interval;
- clip id plus hashes of canonical source mapping and project-space projection
  inputs;
- analysis kind, algorithm id/version, and parameter hash.

The current `similarity-block-ransac-v3` identity records the complete-pair-
space hypothesis schedule below. A cached v2 result is stale even when every
source and parameter field still matches, because its prefix-biased schedule
could select a different transform. The browser runner independently pins
fixture `issue-44-synthetic-v2` and algorithm v3, and refuses to publish an
artifact if the worker evidence reports either stale identity. Artifact schema
4 remains current because the JSON shape did not change.

Any individual mismatch returns a named stale reason. The clip id is an
attachment lookup, not a durable reference from `TimelineDoc`. Cache keys,
files, progress, confidence, failures, and result samples stay out of
`.myrelith`, recovery, remembered handles, undo/redo, and export preferences.

The strict parser rejects unknown keys, future versions, unbounded strings,
unsafe numbers, invalid rates, duplicate keys/files, and unsafe aggregate byte
arithmetic. #108 owns staged result writes, atomic manifest replacement, late
commit rollback, serialized remove/clear, and LRU eviction.

## Stabilization experiment

### Method

The deterministic fixture contains 32 transformed 176×100 grayscale frames
with a slow pan plus high-frequency translation, rotation, and uniform-scale
jitter. Each pair:

1. selects spaced minimum-eigenvalue features;
2. performs bounded forward/backward 5×5 patch matching;
3. rejects discontinuities unless at least half of the textured features retain
   distinct forward/backward-consistent patch matches;
4. fits `q = [a -b; b a]p + t` from deterministic two-point hypotheses; v3
   enumerates every unordered pair when it fits the cap, otherwise selects the
   exact cap as unique, evenly spaced lexicographic ranks across the complete
   pair space (including both endpoints, or the middle rank for a one-pair cap)
   and un-ranks each selection without allocating all pairs;
5. admits only finite transforms with scale in the inclusive `[0.85, 1.15]`
   interval and absolute rotation at most `pi / 12` radians;
6. accepts inliers within 1.75 analysis pixels, refines the similarity fit, and
   reapplies that same envelope before final-inlier filtering;
7. accumulates the camera path, smooths translation/angle/log-scale over a
   four-frame radius, and blends the correction by strength.

A second independently seeded textured scene is the negative hard-cut fixture.
It is rejected on match coverage instead of allowing either a coincidental
similarity fit or an insufficient-texture shortcut to satisfy the scene-cut gate.

The least-squares refinement is never clamped back into the research envelope.
If refinement produces a non-finite field, a scale outside `[0.85, 1.15]`, or
an absolute rotation above `pi / 12`, the complete estimate fails. Stabilization
and similarity-box tracking both consume this shared estimator: stabilization
reports the failed frame pair, while box tracking reports explicit loss before
applying the rejected transform to its box.

### Chromium result

| Metric | Result | Research gate |
|---|---:|---:|
| Mean pair transform error | 0.207 px | ≤ 1.5 px |
| p95 pair transform error | 0.364 px | ≤ 2.5 px |
| Mean confidence | 0.848 | ≥ 0.35 |
| Scene cut rejected | yes | required |
| 50% strength jitter reduction | 48.3% | trade-off evidence |
| 50% conservative safe zoom | 1.028× | visible trade-off |
| 100% strength jitter reduction | 92.4% | ≥ 45% |
| 100% conservative safe zoom | 1.057× | ≤ 1.35× |

The safe-zoom number is a conservative research estimate derived from maximum
correction-corner displacement. #109 must replace it with exact transformed
source coverage across crop, anchor, flip, rotation, project aspect, and every
retained correction. Footage with parallax, rolling shutter, a scene cut,
insufficient texture, or excessive crop may still fail; the synthetic result is
not generalized beyond its fixture.

The crop estimate is a discriminated result rather than an always-present
number. A centered finite zoom exists only while the required inset is strictly
below half the frame's shorter dimension. The feasibility check deliberately
uses the exact half-open `[0, 0.5)` geometric interval with no epsilon band:
every representable value below one half still has a positive finite
denominator. A requirement at or above one half returns
`finite-centered-zoom-unavailable`, retains the path/correction diagnostics, and
cannot satisfy the stabilization `go` gate or a future Apply decision. It is
never clamped to a smaller, falsely safe ratio. Corner displacement uses the
direct similarity delta to avoid cancellation at the boundary, and non-finite
accumulation, geometry, denominator, or zoom fails before evidence is emitted.

This incompatible crop-result shape advances the current browser artifact
contract to schema 4 / `issue-44-motion-analysis-v4`. Earlier schema 3 / v3
entries below remain the exact historical record of the clean commits they
describe; the next source-bound browser run must emit the v4 contract.

## Point/box tracking experiment

The point fixture moves a discriminative texture by bounded whole analysis
pixels. The point tracker accepts only safe-integer analysis-pixel seed
coordinates and rejects a fractional seed with a distinct `RangeError` before
bounds checking; callers must quantize deliberately rather than receiving an
implicit truncation or an accidental zero-valued typed-array lookup. Its bounded
search adds only integer offsets, and the box tracker rounds every regenerated
interior seed, so internal patch lookup coordinates remain integral. The box
fixture translates and grows a textured 44×32 object over 34 frames. Point
matching is sequential and forward/backward checked. Point tracking retains its
valid one-feature budget. Box tracking requires at least eight features and
tracks up to sixteen interior points: reduced budgets from 8 through 15 select
exactly that many spatially distributed corner, center, and edge seeds, while
the default budget preserves the original sixteen-seed order. Every accepted
box estimate still retains only a consistent similarity model.
At frame 18 the object disappears in the negative fixture. The occlusion gate
requires failure on that exact first fully occluded frame, with every accepted
sample strictly before it; accepting even one recovery frame is a failure.

| Metric | Result | Research gate |
|---|---:|---:|
| Point mean error | 0.000 px | ≤ 2 px |
| Point maximum error | 0.000 px | ≤ 4 px |
| Box center mean error | 2.534 px | ≤ 3 px |
| Box mean relative scale error | 2.9% | ≤ 8% |
| Full occlusion rejected | yes | required |
| Occlusion loss latency | 0 frames (failure 18, accepted through 17) | required |
| Complete worker experiment | 237.2 ms | descriptive, host-specific |

The zero point error is intentionally narrow: it is the exact integer-motion
positive fixture, not a subpixel or real-footage claim. #110 adds textured,
low-texture, distractor, partial/full occlusion, scale, scene-cut, and object-
exit footage before product acceptance.

Accepted samples do not mutate a document. A later confirmed Apply may project
point motion to ordinary Position X/Y tracks and box motion to Position X/Y +
Scale X/Y on a separately selected overlapping visual target. The source clip's
resolved crop/flip/anchor/transform maps each full-source sample into project
space, including rotation/flip cross-axis terms and per-sample source-transform
changes. Box width and height are transformed by each sample's anisotropic source
scale and expressed in the target's rotation-local Scale X/Y axes. The absolute
sine/cosine support extents at the source-minus-target relative angle swap axes
at quarter turns, mix them at arbitrary angles, and make source or target mirror
signs size-invariant. Ratios against the first sample retain the target's authored
base scale exactly. Normalized 0/90/180/270-degree cases use semantic zero/one
coefficients rather than floating approximations. Every other sample divides its
extent by the first before multiplying by base scale; a non-positive or non-finite
extent or derived scale fails closed. At non-quarter-turn relative angles this is
the deterministic enclosing envelope representable by fixed target rotation plus
Scale X/Y; exact rotated-box shape following would require a Rotation track and is
outside this four-track contract. Position X/Y compensates around the target's
cropped visible center using its dimensions, flip, rotation, and authored anchor,
so scaling cannot pull the attachment away from the tracked project point. The
canonical `SourceTimeMap` supplies strict clip-local integer frames. A duplicate/
non-monotonic projection rejects rather than dropping samples. Before returning,
every generated Position X/Y and Scale X/Y track passes the canonical animation
validator. A mapped frame beyond the keyframe ceiling, a derived position beyond
the finite project bound, or a box scale outside the clip-scale range fails closed
instead of reaching a future Apply or portable document validator.

Point and box quality decisions are independent: point thresholds alone decide
point feasibility, while box geometry, scale, and prompt occlusion loss decide
box feasibility. The aggregate tracking result remains a convenience summary,
not an input to either public go/no-go decision.

The child tolerance is at most 0.5 project pixels for position and 0.5% for
scale at every analyzed integer frame after bounded simplification. Preview and
export both read the resulting ordinary keys through
`resolveClipAnimationAtFrame`; there is no tracking evaluator in either path.

## Manual lens-correction model

Version 1 is a normalized Brown-Conrady-style manual model with principal point
`(cx, cy)`, focal fractions `(fx, fy)`, radial coefficients `(k1, k2, k3)`,
tangential coefficients `(p1, p2)`, strength, and explicit output scale.

For camera coordinates `(x, y)` and `r² = x² + y²`:

```text
radial = 1 + k1*r² + k2*r⁴ + k3*r⁶
xd = x*radial + 2*p1*x*y + p2*(r² + 2*x²)
yd = y*radial + p1*(r² + 2*y²) + 2*p2*x*y
```

Each output coordinate is unscaled about the principal point, converted through
the focal fractions, mapped forward to the distorted source coordinate, and
bilinearly sampled. Strength blends identity and distorted camera coordinates.
Undefined source edges stay explicit; output scale is the user's crop choice.

The pure validator bounds every parameter and samples a fixed 33×33 grid. It
rejects non-finite/explosive coordinates and a blended Jacobian determinant
below 0.05, preventing obvious foldovers/non-bijective mappings. The neutral
model is identity; coverage sampling exposes overscan and demonstrates that an
explicit crop can reduce it.

This validates the model, not a product renderer. Lens remapping is source-space
camera geometry before crop, transform, project-space masks/effects, opacity,
and blending. Current Canvas2D effect execution does not automatically provide
that ordering or an acceptable geometric remap. #111 must prove a bounded CPU
or parity-safe WebGL2 backend at 720p/1080p/4K, context loss, transparency,
preview/export tolerances, and unsupported fallbacks. Until then, lens
implementation and every profile catalog remain no-go.

## Real Chromium support and lifecycle evidence

The strict-port command was:

```text
npm run qa:issue44:research -- --port 41844
```

Chromium 151.0.7922.34 on the recorded Windows host passed dedicated module
worker creation, OffscreenCanvas 2D readback, RGBA `VideoFrame.copyTo()`,
observable `VideoFrame.close()`, OPFS create/write/read/remove, SubtleCrypto
digest, and native `scheduler.yield()`. Active cancellation completed with
`AbortError` in 50.4 ms. The cancelled worker and successful worker both
terminated; final active workers were zero. One support `VideoFrame` was
created/closed and one OPFS probe file was created/removed. Console warnings and
errors were zero, and strict port 41844 was released.

Ignored raw and visual evidence:

- `output/playwright/issue-44-motion-analysis/motion-analysis.json`
- `output/playwright/issue-44-motion-analysis/motion-analysis.png`

The captured source identity was clean commit
`a2275d6381611a912de1f0c0f0e03f2617099223` on branch
`zyfvhcfh87-rgb/part-10a-research-motion-analysis-stabilization`, with
fingerprint
`sha256:73ceabbad37fca6b739c1376c157c924445c73bed8f2f0e5566abc6a0c20e39b`.
The evidence runner refuses source drift while measuring.

The review-hardening rerun captured exact clean implementation commit
`9f45e44a514d7540637ab466d48516593b59a404` with fingerprint
`sha256:14cde3fa5a470a15cdc1f5b18835eb2b0ac6284990b16e2baceeb8adc4addc5c`.
Fixture `issue-44-synthetic-v2` and algorithm
`similarity-block-ransac-v2` rejected the independently textured hard cut. The
controller rejected an overlapping invocation as
`MediaJobExecutionError/resource-unavailable` while creating exactly one worker
for the admitted run. Successful analysis completed in 217.7 ms, cancellation
settled with `AbortError` in 47.8 ms, workers drained 2/2, support frames closed
1/1, OPFS probes removed 1/1, console problems remained zero, and port 41844 was
released. The visual evidence SHA-256 is
`AF04F0EDD9044183700263D102740C19C0D1368F8570A6AAA35BEDB358D13AF6`.

The five-group completion rerun advanced the artifact to schema 3 /
`issue-44-motion-analysis-v3` and captured exact clean implementation commit
`3e632ab6dd0b24cc26ff61e38cf812ef4764f470` with fingerprint
`sha256:0d12c3d9a76f3a4c6c5b922d57b2e5612a76fb8c217d3e6abb45667ba14a6af1`.
Point and box independently reported `go`; the occlusion fixture failed exactly
on frame 18 after accepting through frame 17. Analysis completed in 237.2 ms,
cancellation settled in 52.8 ms, workers drained 2/2, support frames closed 1/1,
OPFS probes removed 1/1, console problems remained zero, and port 41844 was
released. The visual evidence SHA-256 is
`2018D6738F26D35FD4E0DB23B8649AD49C96EE9412D4452A6CEED56BBDAEFDEF`.

The follow-up review-hardening rerun retained artifact schema 3 /
`issue-44-motion-analysis-v3` and captured exact clean implementation commit
`3632e47c4cd3bf136b6c35d698ffa6ebcc009e76` with fingerprint
`sha256:33df94dc420d8dc97422108473f7b89298557fe9ae72453bc9b6f092315fad67`.
Point and box independently reported `go`; occlusion failed exactly on frame 18
after accepting through frame 17. Analysis completed in 226.9 ms, cancellation
settled in 51.9 ms, and overlapping admission remained typed
`resource-unavailable`. Workers drained 2/2, support frames closed 1/1, OPFS
probes removed 1/1, console problems remained zero, and port 41844 was released.
The cleanup-failure and canonical-bound negative paths are covered by the 28
focused tests. The visual evidence SHA-256 is
`7B35B9668FE5096F570C868FAAB3CF3BDDBC200B078E2909462107F5A57B03D5`.

The worker-readiness review rerun retained artifact schema 3 /
`issue-44-motion-analysis-v3` and captured exact clean implementation commit
`ac555ca6a085f4093b9490107cddfaa79b961c71` with fingerprint
`sha256:c8ca431438e60d0bae33cdd3df7dc23a2dfd10865284410953c07f60b7455e52`.
The real module worker completed its explicit readiness handshake before the
support result became true. Point, box, and stabilization independently reported
`go`; occlusion failed on frame 18 after frame 17. Analysis completed in 207.5
ms, cancellation settled in 46.3 ms, and overlapping admission remained typed
`resource-unavailable`. Workers drained 2/2, support frames closed 1/1, OPFS
probes removed 1/1, console problems remained zero, and port 41844 was released.
Async load failure, bounded timeout, late-event single settlement, and
abort-during-readiness are covered by the 32 focused tests. The visual evidence
SHA-256 is
`202AD63A8E7F035D87C826874D6FB2CCAA4D73F73BB1F1E4932A4BBB9115F07F`.

The OPFS-cancellation review regression defers each of the seven browser storage
steps independently. While the chosen step remains unresolved, abort returns a
typed `AbortError` and a second research run is admitted. A concurrent support
probe uses a different deterministic 128-bit name and removes it first; once the
abandoned step is released, the late continuation drains its own file without
cross-removal, unhandled rejection, or post-settlement diagnostic drift. The
controller, matcher, and tracking group passes 36/36 tests, plus all 16
benchmark-runner checks.

The crop-feasibility review regression pins the immediately representable value
below one half, exactly one half, and the immediately representable value above
one half. It also covers a sustained 240-step pan at the maximum 120-frame
smoothing radius, non-finite accumulated geometry, unchanged finite crop
metrics, non-finite derived path metrics, JSON-safe result shapes, and downstream
stabilization gate refusal. The headed report renders an unavailable crop's
stable reason instead of formatting a missing zoom value.

The full-pair schedule review regression orders 29 coherently translated
foreground matches before 35 stationary background matches. The old capped
lexicographic prefix chose the minority; v3 samples 46 foreground-only, 134
cross-group, and 76 background-only hypotheses across all 2,016 pair ranks, so
the 35-match motion wins in both the original and a deterministic permutation.
The companion box regression covers every valid reduced budget from 8 through
15, the explicit box-only lower boundary, the unchanged sixteen-seed default,
and point tracking at `maxFeatures: 1`.

## Final boundaries

- Browser-local means no upload, account, cloud job, remote model, or silent
  runtime/code download.
- Analysis results are proposals. Only an explicit, latest-state-revalidated
  Apply may create one normal document history entry.
- Stabilization and tracking reuse existing scalar animation; they do not add a
  second preview/export evaluator.
- Lens correction remains research-only until #111 proves source-space
  compositor ordering and performance.
- Every quality threshold is a bounded fixture gate, not a promise that all
  footage is trackable or stabilizable.
