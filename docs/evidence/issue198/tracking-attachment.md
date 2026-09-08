# Issue #198 tracking attachment implementation

## Scope and provenance

This separate slice starts from clean held-path evidence `1254007` and implements
the pure domain boundary of accepted contract `e30c27f`. The parent accepted and
integrated held-path evidence as `f091560`; no product-source synchronization was
needed. The earlier five-flow browser pass does not qualify tracking.

`domain/maskTracking.ts` admits an explicit mask-effect target, re-resolves source
geometry at every accepted sample, and maps its raw point or all box corners
through the accepted source-to-project mapper. It validates the original analysis
direction before sorting output keys, requires the exact selection-frame reference,
and rejects the whole attachment at the first crop/geometry/output failure.

Point and position-only box attachment author x/y. Box size additionally authors
width/height from projected axis-aligned extents. The selected mask rectangle is
resolved at the exact reference frame. Target transforms never rebase it. Each
accepted sample survives as an ordinary linear scalar key with canonical target
source ticks. Clip-transform planning and operations are unchanged; self-transform
attachment remains forbidden.

`domain/operations/maskTracking.ts` checks the current mask, exact target snapshot,
effect identity/version, complete expected track set, accepted frame range,
target ticks, scalar values, full animation validity and document aggregate budget.
Replacement consent binds the candidate and every existing owned key, including
off-range keys. It returns one immutable document edit and preserves unrelated
tracks, static fallback and source timing. It does not itself write history.

The canonical architecture amendment is limited to the accepted wording that
distinguishes mask-effect attachment from clip-transform attachment. Schema 22
collections, timing, declaration identities, path resolution and retention remain
the shared authorities. The pending schema 23 title predicate seam remains owned
by #200 integration; no uncommitted title API is imported here.

## Pure source gate validation

The initial focused run passed 50/51 checks. Its downsample fixture incorrectly
declared 640×360 analysis dimensions, exceeding the existing tracker budget of
320×180. The fixture now uses the admitted 320×180 dimensions with the same
independent source-pixel motion expectations. No production bound was weakened.
The corrected run passed 51 tests in four files plus 17 runner checks.

Additional animated-crop and apply-time budget regression checks were then added.
The final focused run passed **94 tests across 10 files plus 17 runner checks**:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/maskTracking.test.ts src/domain/motionTracking.test.ts src/domain/motionTrackingOperations.test.ts src/domain/maskGeometry.test.ts src/domain/maskPathAnimation.test.ts src/domain/animationFoundation.test.ts src/domain/animationLifecycle.test.ts src/state/motionTrackingDocumentStore.test.ts src/app/motionTrackingController.test.ts src/test/architecture.test.ts --maxWorkers=2
```

Build/typecheck, lint and diff hygiene passed. Only the existing large-chunk
advisory appeared during build. Exact logs remain in the owned worktree at
`.tmp/issue198-tracking-core-final-tests.log`, `-final-build.log` and
`-final-lint.log`; the initial failed and corrected narrow runs remain separate.

The new 22 tests cover same-clip mask versus forbidden self-transform attachment,
backward reference values, independent projection and box extent expectations,
target-transform independence, canonical target ticks, unchanged analysis loss,
first/interior/final animated crop rejection in both directions, invalid direction
and reference, half-open overlap, lens/future/unsafe geometry, preserved competing
intent, exact replacement consent, stale/tampered operation inputs, 1,024 retained
equal-valued samples versus 1,025, and the actual 100,000-key document edge including
budget growth after planning. These are domain checks; they do not qualify app
session freshness, portable file/history admission or real-browser tracking.

## App review and preview slice

The next source slice adds dispatch and a disposable review to the existing
`app/motionTrackingController.ts`. Transform dispatch retains its existing API
and restrictions. Mask dispatch reuses the exact analysis admission predicate
for decoded dimensions, direction, selection reference, requested frame/tick
schedule and first-loss position. The original analysis/cache admission condition
was extracted unchanged; no tracker, decoder, estimator or source snapshot was
replaced.

The review binds the immutable project, generation, active sequence, complete
timeline selection, tracker selection, transport reset and both connected source
and target media facts. It owns subscriptions and the named `mask-tracking`
effect-document preview. The ordinary renderer resolves that candidate document.
The preview clears outside both accepted endpoints, reappears on range reentry,
and disposes on staleness/cancel. Preview arbitration preserves older sibling
owners and does not let background frame updates take over a newer gesture.

Before preview, the app checks the complete project, shared retained animation
budget and actual portable media/file envelope. Apply requires pause, one fresh
plan and exact candidate/consent, repeats the independent operation and admission,
cleans up, checks for reentrant project/selection/review changes, then commits
through the existing portable project/history boundary. Same-source mask Apply
invalidates the old full-animation analysis snapshot as required.

This slice passed **203 tests in 12 focused files plus 17 runner checks**,
build/typecheck, lint and diff hygiene. The new 23 app tests use actual stores,
portable serialization and the production analysis admission/controller; only
the bounded analysis service result is supplied as a cache fixture. They cover
temporary preview, ordinary values, one-entry Apply/undo/redo, same-clip session
invalidation, backward range cleanup, 14 stale-context routes, reentrant cleanup,
preview arbitration, scoped cancellation, fresh schedule/dimension checks,
content-bound replacement and missing portable media envelopes. Existing real
10-million-character file/history tests were also included, but a dedicated
mask-tracking near-cap fixture and browser flow remain open.

Command:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/app/maskMotionTrackingController.test.ts src/app/motionTrackingController.test.ts src/domain/maskTracking.test.ts src/domain/motionTracking.test.ts src/domain/motionTrackingOperations.test.ts src/state/transportStore.test.ts src/state/motionTrackingDocumentStore.test.ts src/app/maskEditingController.test.ts src/app/previewController.test.ts src/app/animationAdmission.test.ts src/app/animationFileBoundary.test.ts src/test/architecture.test.ts --maxWorkers=2
```

Logs: `.tmp/issue198-tracking-app-final-{tests,build,lint}.log`. Initial runs
failed only because two new tests called nonexistent store setters; they now
exercise the actual `setClipSelection` and `setIsPlaying` APIs. Both failed logs
and the corrected narrow run remain separate. No production check was weakened.

The controller slice is committed as `05bb72b5f00f5bf26b92bd890247fe07bab0325d`.
The Inspector does not yet expose these commands.

## Shared schema 23 and preview integration

Under the parent's explicit direction, exact shared title/animation checkpoint
`4340f9675ad56aa320f2498cf107fd55f8819568` was merged after committing the app slice.
Its integration evidence was read. The only source merge conflict was the
effect-document preview owner union and its common input type. The resolution
retains color grading, mask gestures, animation gestures and mask tracking under
the same existing activation-order arbitration, using the shared narrow preview
input type. No sibling owner or setter was dropped.

The new mask planner now uses canonical `isProceduralTitleClip`, covering legacy,
supported and opaque future titles. Source applicability consumes the integrated
motion-tracking authority. New domain and app checks reject these title targets
even when stale connected media facts are present. The combined preview test
also proves animation-gesture precedence and restoration through all four owners.

Combined focused checks passed **220 tests in 15 files plus 17 runner checks**;
the actual `animationEditingController.test.ts` then passed **25 tests plus 17
runner checks**. The first command had named a nonexistent
`animationEditorController.test.ts`, which Vitest ignored; it is not counted in
the 15-file result. The separate correct-path run closes that validation gap.
Build/typecheck, lint and diff hygiene passed, with the existing Vite chunk
advisory only. Logs: `.tmp/issue198-tracking-schema23-first-{tests,build,lint}.log`
and `.tmp/issue198-tracking-schema23-animation-controller-tests.log`.

The parent independently accepted pure source `9c3cb54` with 50 checks in four
files plus 17 runner checks. App source and this combined checkpoint are now
ready for parent review. No combined tracking browser or performance claim is made.

## Remaining gates

- Add dedicated tracking near-cap portable admission and remaining source/loss
  cases alongside the final Inspector slice.
- Inspector must expose separate transform/mask targets and exact owned-lane
  replacement consent, preserve the self-transform prohibition, and disclose
  ordinary post-Apply interpolation/endpoint hold and box extents without rotation.
- Quiet real-browser preview/Apply/undo, save/reopen/export/playback parity, full
  suite/audit and measured 4K resource/retention gates remain open. No heavy slot
  was requested or used for this pure slice, and no whole-issue completion is claimed.
