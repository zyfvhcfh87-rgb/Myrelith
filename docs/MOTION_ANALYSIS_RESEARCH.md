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
| Retained analysis buffers | 32 MiB | Includes grayscale windows and scratch; typed result paths are much smaller. |
| Features per frame | 64 | Deterministic corner selection with minimum spacing. |
| Patch/search radii | 2 / 6 px | A 5×5 patch and ±6 px bounded search at analysis resolution. |
| Robust hypotheses | 256 per pair | Deterministic upper bound, followed by inlier refinement. |
| Cache entries/result | 1,024 / 256 MiB | Strict manifest and per-entry denial-of-service bound. |
| Cache target/headroom | 512 MiB / 128 MiB | LRU aims below 70% origin usage when estimates exist; unavailable estimates never become false quota promises. |

The feasibility worker is terminated for cancellation; this makes cancellation
observable even while synchronous numeric code owns its worker event loop. The
controller acquires its single shared admission slot before any support probe or
scheduler construction and rejects an overlapping invocation with the typed
`resource-unavailable` result. Separate callers therefore cannot each create a
private one-job scheduler and exceed the controller-wide worker/decoder envelope.
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
4. fits `q = [a -b; b a]p + t` from deterministic two-point hypotheses;
5. accepts inliers within 1.75 analysis pixels and refines the similarity fit;
6. accumulates the camera path, smooths translation/angle/log-scale over a
   four-frame radius, and blends the correction by strength.

A second independently seeded textured scene is the negative hard-cut fixture.
It is rejected on match coverage instead of allowing either a coincidental
similarity fit or an insufficient-texture shortcut to satisfy the scene-cut gate.

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

## Point/box tracking experiment

The point fixture moves a discriminative texture by bounded whole analysis
pixels. The box fixture translates and grows a textured 44×32 object over 34
frames. Point matching is sequential and forward/backward checked. The box
tracks sixteen interior points and retains only a consistent similarity model.
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
changes. When box scale changes, Position X/Y compensates around the target's
cropped visible center using its dimensions, flip, rotation, and authored anchor,
so scaling cannot pull the attachment away from the tracked project point. The
canonical `SourceTimeMap` supplies strict clip-local integer frames. A duplicate/
non-monotonic projection rejects rather than dropping samples.

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
