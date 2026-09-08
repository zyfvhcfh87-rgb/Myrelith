# Issue #198 independent pure foundation

The orchestrator approved the plan at `0c0ab7b` and explicitly moved pure path
commands/geometry ahead of shared integration. This gate introduces six domain
source/test files. It changes no existing shader/pixel stage, UI, schema,
ClipAnimation or SourceTimeMap traversal. These modules are not yet in the normal
production import graph. The issue is not complete.

## Public APIs offered to #199 and later #198 integration

`domain/maskPathAnimation.ts` owns:

- `EffectPathAnimationKeyframe` and `EffectPathAnimationTrack`: exact held-string
  envelope, local frame/source intent, effect/parameter/type/version identities.
- `effectPathAnimationTrackBoundsError` and
  `effectPathAnimationTracksBoundsError`: structural/portable validation. Pass
  `requireSourceTicks = true` at portable boundaries. Unknown/malformed bounded
  values remain intact; syntax availability is a separate concern. Mixed scalar
  versus path target conflicts remain the shared traversal's responsibility.
- `cloneEffectPathAnimationTrack`: bounded defensive clone preserving future
  values, exact source intent and optional absence. Whole-candidate admission
  must precede any batch of clones.
- `prepareEffectPathAnimationTrack`: semantic target/version/path validation
  once per immutable descriptor+track, yielding a small immutable value index.
  A bad path invalidates the complete path track; unsupported targets and
  rectangle/ellipse dormant tracks return described unavailable status.
- `evaluatePreparedEffectPathAnimationTrack`: binary-search held selection,
  including before-first/after-last boundaries; no parsing, interpolation,
  allocations or retained geometry during sample selection. The caller still
  validates the final effect descriptor through the existing registry.
- `maskPathAnimationSnapshotBudget`: project/clipboard path totals. A snapshot
  is a bounded array of existing track references collected by the shared
  traversal; do not clone values to construct it. Check per-clip track counts
  as well as this aggregate. All dormant sequences and opaque strings count.
- `maskPathAnimationRetentionError`: requires candidate, current, past, future,
  attribute clipboard and key clipboard (explicit null when absent). Check it
  before changing history/clipboard or clearing redo. It deduplicates only the
  identical immutable snapshot/track object; equal strings in distinct tracks
  are charged separately. Removal preserves survivor track identities so both
  history branches can remain intact without artificial payload growth. A no-op
  returns before making a new snapshot. Cloning all survivor tracks unnecessarily
  spends this allowance, even if the current document got smaller. This identity
  accounting detail makes the approved zero-growth policy concrete without
  relying on string interning or lowering the 32 MiB cap.

The shared owner must also enforce the existing 100,000-key, effect-string and
serialized-project ceilings, complete ID reminting and traversal preservation.
These helpers do not import a document/store, traverse history themselves,
allocate a clipboard or clear redo. No shared timing code is duplicated here.
Frame magnitude is the approved 1e9; #199 should bind that to its shared timing
authority when consuming these types.

`domain/maskPathEdit.ts` owns pure immutable point/control moves, numeric point
entry, de Casteljau segment insertion, anchor removal, closing an open draft,
part lookup and six-decimal serialization. Closure aliases the start endpoint;
anchor groups use one constrained delta to preserve their control offsets.
Unchanged/subprecision edits preserve the original path string. Point insertion
preserves cubic geometry within rounding; unchanged raster pixels are not
promised after a subdivision-count change in the legacy fixed-subdivision stage.

`domain/maskGeometry.ts` owns project-mask/local inverses, CSS monitor/project
inverses, bounded box move/resize and validated immutable source projection.
Source facts use the existing centered anchor/scale/flip/rotation model. Crop
affects visibility only. Current transforms use nonnegative scale; legacy signed
scales first migrate to explicit flips. Source lens intent, zero scale,
unrepresentable inverse precision and malformed dimensions/crop are unavailable.
The inverse guard reserves conservative floating-point headroom of a quarter
source pixel and probes four corners/center. Direct project-mask math needs no
lens inverse. Runtime functions/resources never enter portable project data.

## Proof and limits

- Curve samples before/after insertion; closure through every anchor deletion;
  adjacent-control/anchor movement, numeric/delta parity, immutable input,
  exact string preservation, invalid indices/values, maximum segment count and
  preflight-before-payload traversal.
- Six-decimal worst-case sample error at an 8x box on 3840x2160 is below 0.018
  project pixels. This is geometric roundoff, not encoded-video pixel tolerance.
- Monitor/local round trips include fractional CSS bounds and responsive sizes;
  backing resolution/DPR are intentionally absent from the pure CSS contract.
- 2,420 source grid round trips cover five rotations, both flip axes,
  noncentral anchors, nonuniform scale and crop. An independent quarter-turn
  fixture asserts an exact projected point `(645,220)`, not just self-inversion.
- Held-path boundary/topology, prepared ownership, opaque preservation and
  same-target version collisions. Small reference frames run through the
  unchanged mask pixel executor with exact byte equality.
- Exact 4,096-key / 1,048,576-character caps; malformed Unicode value/identity
  accounting; preflight before oversized key access; all six retention inputs,
  immutable redo and the 32 MiB limit.

This proves pure contracts only. UI gestures, real responsive layout, adaptive
presentation, tracking/loss/lens integration, timeline timing mutations, shared
history admission, large/4K raster timings, playback/export and cleanup acceptance
remain later gates. No browser or full-suite claim is made. Full suites and heavy
timing still need the orchestrator's exclusive slot.

## Commands

All ran in the isolated `.worktrees/issue198` directory with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`.

```text
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/maskPathEdit.test.ts src/domain/maskGeometry.test.ts src/domain/maskPathAnimation.test.ts src/test/architecture.test.ts --maxWorkers=1
npm run build
npm run lint
git diff --cached --check
```

Final focus: **4 files / 49 tests passed, plus all 17 runner checks**.
Build/typecheck and lint passed on the final source. The committed SHA is in the
worker report; it cannot be embedded in its own commit.
Initial progression passed 35 and then 47 focused tests plus 17 runner checks;
the final rerun adds defensive-clone and shared-retention removal proofs.
Build/typecheck and lint passed,
with 5,013 modules and the existing large-chunk advisory. No new dependencies,
audit exposure or production bundle changes are introduced by this isolated gate.
