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

## Remaining gates

- App dispatch must reuse existing analysis/cache/decode provenance, exact admitted
  dimensions/schedule and conservative whole-animation source snapshots.
- App lifecycle must bind target connection/selection/project/generation, own a
  named effect-document preview, clear outside the accepted range and on staleness,
  preflight full project/file/history/clipboard admission, then freshly plan and
  commit once. Same-clip Apply invalidates the old analysis session.
- Inspector must expose separate transform/mask targets and exact owned-lane
  replacement consent, preserve the self-transform prohibition, and disclose
  ordinary post-Apply interpolation/endpoint hold and box extents without rotation.
- Quiet real-browser preview/Apply/undo, save/reopen/export/playback parity, full
  suite/audit and measured 4K resource/retention gates remain open. No heavy slot
  was requested or used for this pure slice, and no whole-issue completion is claimed.
